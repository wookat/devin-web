#!/usr/bin/env node
/**
 * acp-broker — the long-lived owner of `devin acp` (and other agent) child
 * processes. The devin-web backend connects over a local socket instead of
 * spawning acp itself, so a backend restart leaves agents and their in-flight
 * turns untouched: the new backend re-attaches and keeps going.
 *
 * Topology (industry-standard short-lived-control-plane / long-lived-worker):
 *   supervisor ──► backend :7792   (restartable)
 *              ──► acp-broker      (this — owns acp children)
 *                    └─ devin acp ×N
 *
 * Wire protocol (ndjson over a unix socket / named pipe):
 *   First line of every connection is a JSON header:
 *     {"ctl":1}                    → persistent control channel
 *     {"attach":"<acpId>","after":N} → data channel for one acp
 *
 *   Control channel — client sends {"req":N,"op":...}, broker replies
 *   {"req":N,...} and pushes {"ev":...} events unsolicited:
 *     {op:"spawn", cwd, command, args:[], env:{}, shell:bool}
 *         → {ok:true, acpId, pid}
 *     {op:"kill", acpId}           → {ok:true}
 *     {op:"list"}                  → {ok:true, acps:[{acpId,pid,cwd,cmd,exited,bytesOut}]}
 *     {ev:"exit", acpId, code}     — a child died
 *
 *   Data channel — after the {"attach"} line the broker replies
 *   {"ok":true,"pid":P,"exited":B,"bytesOut":N} then the socket goes RAW:
 *   buffered stdout frames newer than `after` are replayed first, then live
 *   bytes; inbound bytes go straight to the child's stdin. Buffering is at
 *   line boundaries — a re-attach never lands mid-frame. The ring holds the
 *   last ~4MB of stdout so a seconds-scale backend restart loses nothing.
 *
 * Orphan safety: spawned pids are journaled to <dataDir>/broker-state.json;
 * on boot the broker kills any pid it recorded whose own parent chain died —
 * a crashed broker can never leave lock-holding acp corpses behind.
 */
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const dataDir = process.env.DEVIN_WEB_DATA_DIR || path.join(os.homedir(), ".devin-web");
const sockPath = process.platform === "win32"
  ? `\\\\.\\pipe\\devin-web-acp-${crypto.createHash("sha1").update(dataDir).digest("hex").slice(0, 10)}`
  : path.join(dataDir, "acp-broker.sock");
const stateFile = path.join(dataDir, "broker-state.json");

const RING_CAP = 4 << 20;
/** acpId → {proc, meta, ring: Buffer[], ringBytes, bytesOut, attached} */
const acps = new Map();
let seq = 0;
const ctls = new Set();

// ---------------------------------------------------------------------------
// pid journal — broker crash ⇒ our children are parentless lock-holders
// ---------------------------------------------------------------------------
function journalLoad() {
  try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return {}; }
}
function journalWrite() {
  const out = {};
  for (const [id, a] of acps) out[id] = { pid: a.proc.pid, cmd: a.meta.cmd, account: a.meta.account ?? null, startedAt: a.meta.startedAt };
  try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(out)); } catch { /* best-effort */ }
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(-pid, "SIGKILL"); // spawned detached → own process group
    }
  } catch {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}
// Sweep journal entries left by a previous broker life: if the pid still
// exists it is an orphan (its parent — the old broker — is gone).
for (const [id, rec] of Object.entries(journalLoad())) {
  if (rec?.pid && pidAlive(rec.pid)) {
    console.error(`[acp-broker] killing orphan acp ${id} pid ${rec.pid} from previous broker`);
    killTree(rec.pid);
  }
}

// ---------------------------------------------------------------------------
// acp registry
// ---------------------------------------------------------------------------
function pushRing(a, chunk) {
  // Split at newline boundaries; only complete frames enter the ring so a
  // re-attach replays whole ndjson messages, never a torn line.
  a.pending = Buffer.concat([a.pending, chunk]);
  let cut = 0;
  for (;;) {
    const nl = a.pending.indexOf(0x0a, cut);
    if (nl < 0) break;
    cut = nl + 1;
  }
  if (!cut) return;
  const framed = a.pending.subarray(0, cut);
  a.pending = a.pending.subarray(cut);
  a.ring.push(framed);
  a.ringBytes += framed.length;
  a.bytesOut += framed.length;
  // Index agent→client JSON-RPC requests by id. `end` is the enclosing
  // chunk's byte position — the same granularity ring replay uses, so the
  // attach dedup rule is exact (end > after ⟹ the ring already covers it).
  if (framed.includes(METHOD_TAG)) {
    for (const line of framed.toString("utf8").split("\n")) {
      if (!line.includes('"id"') || !line.includes('"method"')) continue;
      try {
        const m = JSON.parse(line);
        if (m != null && m.id != null && typeof m.method === "string") {
          a.reqs.set(String(m.id), { frame: Buffer.from(line + "\n"), end: a.bytesOut });
        }
      } catch { /* non-json content line */ }
    }
  }
  while (a.ringBytes > RING_CAP) a.ringBytes -= a.ring.shift().length;
}

const METHOD_TAG = Buffer.from('"method"');
const ID_TAG = Buffer.from('"id"');

/** Tee-parse client→agent bytes: a JSON-RPC response (id, no method) clears
 *  the pending request it answers. Requests/notifications pass through. */
function feedStdin(a, chunk) {
  a.inBuf = Buffer.concat([a.inBuf, chunk]);
  for (;;) {
    const nl = a.inBuf.indexOf(0x0a);
    if (nl < 0) return;
    const line = a.inBuf.subarray(0, nl + 1);
    a.inBuf = a.inBuf.subarray(nl + 1);
    if (!line.includes(ID_TAG)) continue;
    try {
      const m = JSON.parse(line.toString("utf8"));
      if (m != null && m.id != null && m.method == null) a.reqs.delete(String(m.id));
    } catch { /* non-json content line */ }
  }
}

function spawnAcp(spec) {
  const acpId = `a${++seq}_${Date.now().toString(36)}`;
  const isWin = process.platform === "win32";
  const child = spec.shell && isWin
    ? spawn(spec.cmdline, { cwd: spec.cwd, env: { ...process.env, ...spec.env }, shell: true, windowsHide: true, detached: false, stdio: ["pipe", "pipe", "pipe"] })
    : spawn(spec.command, spec.args ?? [], { cwd: spec.cwd, env: { ...process.env, ...spec.env }, windowsHide: true, detached: !isWin, stdio: ["pipe", "pipe", "pipe"] });
  const a = {
    proc: child,
    meta: { cwd: spec.cwd, cmd: spec.cmdline ?? `${spec.command} ${(spec.args ?? []).join(" ")}`, key: spec.key ?? null, account: spec.account ?? null, startedAt: Date.now() },
    pending: Buffer.alloc(0),
    ring: [], ringBytes: 0, bytesOut: 0,
    // Protocol awareness — agent→client requests (id+method) the attached
    // backend has not answered. Re-emitted on re-attach so a request that
    // died on the old byte stream (dead-window permission/fs/terminal)
    // reaches the new backend instead of wedging devin forever.
    reqs: new Map(),
    inBuf: Buffer.alloc(0), // client→agent partial line (stdin tee parse)
    attached: null, exited: false, exitCode: null,
  };
  acps.set(acpId, a);
  child.stderr?.on("data", () => { /* drain — same reason as backend */ });
  child.stdout.on("data", (chunk) => {
    pushRing(a, chunk);
    if (a.attached && !a.attached.destroyed) a.attached.write(chunk);
  });
  child.on("exit", (code) => {
    a.exited = true; a.exitCode = code;
    a.reqs.clear();
    for (const c of ctls) c.write(`${JSON.stringify({ ev: "exit", acpId, code })}\n`);
    if (a.attached && !a.attached.destroyed) a.attached.end();
    journalWrite();
  });
  child.on("error", () => {});
  journalWrite();
  return { acpId, pid: child.pid };
}

function killAcp(acpId) {
  const a = acps.get(acpId);
  if (!a) return;
  if (!a.exited) killTree(a.proc.pid);
  acps.delete(acpId);
  journalWrite();
}

// ---------------------------------------------------------------------------
// socket server
// ---------------------------------------------------------------------------
function handleCtl(sock, head, rest) {
  ctls.add(sock);
  sock.on("close", () => ctls.delete(sock));
  let buf = rest.toString("utf8");
  const drain = () => {
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(l); } catch { continue; }
      const req = m.req;
      const reply = (o) => sock.write(`${JSON.stringify({ req, ...o })}\n`);
      try {
        if (m.op === "spawn") reply({ ok: true, ...spawnAcp(m) });
        else if (m.op === "kill") { killAcp(m.acpId); reply({ ok: true }); }
        else if (m.op === "list") {
          reply({ ok: true, acps: [...acps].map(([acpId, a]) => ({
            acpId, pid: a.proc.pid, cwd: a.meta.cwd, cmd: a.meta.cmd, key: a.meta.key, account: a.meta.account ?? null,
            exited: a.exited, exitCode: a.exitCode, bytesOut: a.bytesOut, pendingReqs: a.reqs.size,
            startedAt: a.meta.startedAt,
          })) });
        }
        else reply({ ok: false, error: `unknown op ${m.op}` });
      } catch (e) { reply({ ok: false, error: String(e?.message ?? e) }); }
    }
  };
  drain(); // `rest` may already hold request lines that arrived with the header
  sock.on("data", (d) => { buf += d.toString("utf8"); drain(); });
}

function handleAttach(sock, head, rest) {
  const a = acps.get(head.attach);
  if (!a) { sock.write(`${JSON.stringify({ ok: false, error: "no such acp" })}\n`); sock.end(); return; }
  if (a.attached && !a.attached.destroyed) a.attached.destroy(); // latest wins
  a.attached = sock;
  sock.write(`${JSON.stringify({ ok: true, pid: a.proc.pid, exited: a.exited, bytesOut: a.bytesOut })}\n`);
  // Replay buffered frames newer than `after` (byte offsets count only
  // complete frames — after=0 replays the whole ring).
  let off = a.bytesOut - a.ringBytes;
  for (const f of a.ring) {
    const end = off + f.length;
    if (end > (head.after ?? 0)) sock.write(f);
    off = end;
  }
  if (a.pending.length) sock.write(a.pending); // live partial frame tail
  if (a.exited) { sock.end(); return; }
  // Re-emit agent→client requests the previous backend never answered — a
  // pending frame older than `after` is invisible to ring replay and would
  // otherwise leave devin blocked on a dead stream forever (zombie turn).
  // Frames inside the replay window already arrived via the ring.
  for (const r of a.reqs.values()) if (r.end <= (head.after ?? 0)) sock.write(r.frame);
  // `rest` is bytes the client wrote before the header newline — they belong
  // to the child's stdin just like every later chunk.
  if (rest.length) { try { a.proc.stdin.write(rest); } catch { /* dead */ } feedStdin(a, rest); }
  sock.on("data", (d) => { try { a.proc.stdin.write(d); } catch { /* dead */ } feedStdin(a, d); });
  sock.on("close", () => { if (a.attached === sock) a.attached = null; });
  sock.on("error", () => {});
}

const server = net.createServer((sock) => {
  let headBuf = Buffer.alloc(0);
  const onHead = (d) => {
    headBuf = Buffer.concat([headBuf, d]);
    const nl = headBuf.indexOf(0x0a);
    if (nl < 0) { if (headBuf.length > 64 << 10) sock.destroy(); return; }
    sock.removeListener("data", onHead);
    const rest = headBuf.subarray(nl + 1);
    let head; try { head = JSON.parse(headBuf.subarray(0, nl).toString("utf8")); } catch { sock.destroy(); return; }
    if (head.ctl) handleCtl(sock, head, rest);
    else if (head.attach) handleAttach(sock, head, rest);
    else sock.destroy();
  };
  sock.on("data", onHead);
  sock.on("error", () => {});
});

fs.mkdirSync(dataDir, { recursive: true });
if (process.platform !== "win32") { try { fs.unlinkSync(sockPath); } catch { /* none */ } }
server.listen(sockPath, () => {
  console.error(`[acp-broker] listening on ${sockPath} (pid ${process.pid})`);
});
const shutdown = () => { for (const [id] of acps) killAcp(id); process.exit(0); };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
