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
 *     {ev:"prompt-start", id, sessionId, reqId, brokerReqId, ts}
 *         — a session/prompt request was forwarded to an acp's stdin
 *     {ev:"prompt-done", id, sessionId, reqId, brokerReqId, ok, errMsg?, ts}
 *         — its response came back on stdout (the prompt ledger cleared).
 *         `reqId` is the CLIENT-side id (stringified) — what the backend
 *         journaled — so consumers correlate without knowing the remux.
 *
 *   Data channel — after the {"attach"} line the broker replies
 *   {"ok":true,"pid":P,"exited":B,"bytesOut":N} then the socket goes RAW:
 *   buffered stdout frames newer than `after` are replayed first, then live
 *   frames; inbound bytes go to the child's stdin through an id
 *   remultiplexer (see feedStdin). Buffering + forwarding is at line
 *   boundaries — a re-attach never lands mid-frame. The ring holds the
 *   last ~4MB of stdout so a seconds-scale backend restart loses nothing.
 *
 * Id remux: JSON-RPC ids are per-connection counters — a re-attaching
 * backend reuses ids that may still be outstanding from the dead
 * connection. The broker rewrites every client→agent REQUEST id onto a
 * per-acp global counter (a.nextReq) and remembers the mapping, then
 * rewrites the matching agent→client RESPONSE id back before the frame
 * enters the ring/forwarding. Ids on the agent's wire are therefore
 * collision-free across backend lifetimes while each backend sees only
 * its own ids.
 *
 * Orphan safety: spawned pids are journaled to <dataDir>/broker-state.json;
 * on boot the broker kills any pid it recorded whose own parent chain died —
 * a crashed broker can never leave lock-holding acp corpses behind.
 */
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import crypto from "node:crypto";
import { dataDir as resolveDataDir, acpMemScanMs, acpCommitMaxMb, acpCommitBusyMaxMb, commitEmergencyMb } from "./env.mjs";

const dataDir = resolveDataDir();
const sockPath = process.platform === "win32"
  ? `\\\\.\\pipe\\devin-web-acp-${crypto.createHash("sha1").update(dataDir).digest("hex").slice(0, 10)}`
  : path.join(dataDir, "acp-broker.sock");
const stateFile = path.join(dataDir, "broker-state.json");

// Local trust token — the socket is a spawn-as-me surface: on a multi-user
// box any local process could connect and run commands as this user. Every
// header must carry this token; the file lives in dataDir (0600) so only
// processes running as this user can read it.
const TOKEN = (() => {
  const f = path.join(dataDir, "broker.token");
  try { return fs.readFileSync(f, "utf8").trim(); } catch {}
  fs.mkdirSync(dataDir, { recursive: true });
  const t = crypto.randomBytes(24).toString("hex");
  try { fs.writeFileSync(f, t, { mode: 0o600 }); } catch { fs.writeFileSync(f, t); }
  return t;
})();

const RING_CAP = 4 << 20;
/** acpId → {proc, meta, ring: Buffer[], ringBytes, bytesOut, attached} */
const acps = new Map();
let seq = 0;
const ctls = new Set();

/** Broadcast a ctl event to every attached control socket — ndjson on the
 *  ctl channel ONLY, never onto a per-acp raw data channel. */
function ctlEvent(obj) {
  const line = `${JSON.stringify(obj)}\n`;
  for (const c of ctls) c.write(line);
}

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
/** The journal survives reboots — a recycled pid could belong to anything.
 *  Verify the CommandLine actually looks like an acp process (or matches
 *  the journaled cmd) before killing; unverifiable → leave it alone. */
function pidIsAcp(pid, cmd) {
  try {
    const out = process.platform === "win32"
      ? execSync(`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`, { stdio: ["ignore", "pipe", "ignore"] }).toString()
      : execSync(`ps -p ${pid} -o args=`, { stdio: ["ignore", "pipe", "ignore"] }).toString();
    return /\bacp\b/i.test(out) || (!!cmd && out.includes(cmd));
  } catch { return false; }
}
// Sweep journal entries left by a previous broker life: if the pid still
// exists it is an orphan (its parent — the old broker — is gone).
for (const [id, rec] of Object.entries(journalLoad())) {
  if (rec?.pid && pidAlive(rec.pid)) {
    if (pidIsAcp(rec.pid, rec.cmd)) {
      console.error(`[acp-broker] killing orphan acp ${id} pid ${rec.pid} from previous broker`);
      killTree(rec.pid);
    } else {
      console.error(`[acp-broker] pid ${rec.pid} (${id}) alive but does not look like an acp — leaving it (pid reuse?)`);
    }
  }
}

// ---------------------------------------------------------------------------
// acp registry
// ---------------------------------------------------------------------------
function pushRing(a, chunk) {
  // Split at newline boundaries; only complete frames enter the ring so a
  // re-attach replays whole ndjson messages, never a torn line. Returns the
  // complete-frame bytes — response ids already remapped back to the
  // client-side values — so live attaches forward exactly what the ring
  // stores and replay/live delivery can never diverge.
  a.pending = Buffer.concat([a.pending, chunk]);
  let cut = 0;
  for (;;) {
    const nl = a.pending.indexOf(0x0a, cut);
    if (nl < 0) break;
    cut = nl + 1;
  }
  if (!cut) return Buffer.alloc(0);
  let framed = a.pending.subarray(0, cut);
  a.pending = a.pending.subarray(cut);
  // Index agent→client frames by id BEFORE the bytes enter the ring or the
  // live forward. `end` is the enclosing chunk's byte position — the same
  // granularity ring replay uses, so the attach dedup rule is exact
  // (end > after ⟹ the ring already covers it). Two kinds:
  //   id+method          → agent→client REQUEST the backend must answer
  //                        (permission/fs/terminal) — replayed on re-attach.
  //                        Agent-side id space is never remapped.
  //   id+result|error    → agent→client RESPONSE — clears the prompt ledger,
  //                        and via idMap restores the client-side request id
  //                        in place (ring feeds replay, so stored bytes must
  //                        already carry the restored id).
  const freshReqs = [];
  if (framed.includes(ID_TAG)) {
    const lines = framed.toString("utf8").split("\n");
    let dirty = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes('"id"')) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; } // non-json content line
      if (m == null || m.id == null) continue;
      if (typeof m.method === "string") {
        freshReqs.push([String(m.id), Buffer.from(line + "\n")]);
      } else if ("result" in m || "error" in m) {
        const key = String(m.id); // broker-side id — what the agent saw
        const done = a.prompts.get(key);
        if (done) {
          a.prompts.delete(key);
          // Event-driven settle evidence: a re-attached backend's turn
          // watchers consume prompt-done in milliseconds instead of
          // polling the ledger / waiting out a silence floor. reqId is
          // the CLIENT-side id the backend journaled — the idMap restore
          // below rewrites the wire bytes, the event already names it.
          ctlEvent({
            ev: "prompt-done", id: a.id, sessionId: done.sessionId,
            reqId: String(done.clientReqId), brokerReqId: done.brokerReqId,
            ok: "result" in m,
            ...("error" in m ? { errMsg: String(m.error?.message ?? "request failed").slice(0, 300) } : {}),
            ts: Date.now(),
          });
        }
        if (a.idMap.has(key)) {
          m.id = a.idMap.get(key); // raw client id — preserves number/string type
          a.idMap.delete(key);
          lines[i] = JSON.stringify(m);
          dirty = true;
        }
      }
    }
    if (dirty) framed = Buffer.from(lines.join("\n"), "utf8");
  }
  a.ring.push(framed);
  a.ringBytes += framed.length;
  a.bytesOut += framed.length;
  for (const [id, frame] of freshReqs) a.reqs.set(id, { frame, end: a.bytesOut });
  while (a.ringBytes > RING_CAP) a.ringBytes -= a.ring.shift().length;
  return framed;
}

const METHOD_TAG = Buffer.from('"method"');
const ID_TAG = Buffer.from('"id"');

/** Client→agent stdin demux — RETURNS the bytes to write to the child's
 *  stdin: complete lines only, request ids already remapped. A trailing
 *  partial line stays buffered in `a.inBuf` until its newline arrives —
 *  acp frames are newline-delimited, so nothing downstream can act on a
 *  torn line anyway (and a partial from a dead connection must never be
 *  glued onto the next attach's first write). */
function feedStdin(a, chunk) {
  a.inBuf = Buffer.concat([a.inBuf, chunk]);
  const out = [];
  for (;;) {
    const nl = a.inBuf.indexOf(0x0a);
    if (nl < 0) break;
    const line = a.inBuf.subarray(0, nl + 1);
    a.inBuf = a.inBuf.subarray(nl + 1);
    out.push(remapRequest(a, line));
  }
  return Buffer.concat(out);
}

/** One complete client→agent line (newline included) → the line to forward.
 *  Three roles:
 *  - id+method REQUEST → remap the id onto the per-acp `nextReq` counter so
 *    a re-attached backend's fresh per-connection counter can never collide
 *    with requests still outstanding from the dead connection; journal
 *    brokerId→clientId in `a.idMap`. `session/prompt` also opens a
 *    prompt-ledger entry (the turn ledger a re-attaching backend consults
 *    to tell live turns from dead ones).
 *  - id-only response  → answers an agent→client request in `a.reqs`.
 *    Agent-side ids are never remapped, so the ledger key is verbatim.
 *  - anything else     → forwarded verbatim (notifications, non-JSON). */
function remapRequest(a, line) {
  if (!line.includes(ID_TAG)) return line;
  let m;
  try { m = JSON.parse(line.toString("utf8")); } catch { return line; }
  if (m == null || m.id == null) return line;
  if (typeof m.method !== "string") { a.reqs.delete(String(m.id)); return line; }
  const clientId = m.id;
  const brokerId = a.nextReq++;
  // Store the RAW client id — the ACP SDK matches response ids by strict
  // equality, so a numeric client id must go back on the wire as a number.
  a.idMap.set(String(brokerId), clientId);
  m.id = brokerId;
  if (m.method === "session/prompt") {
    const sid = m.params?.sessionId;
    a.prompts.set(String(brokerId), {
      sessionId: typeof sid === "string" ? sid : null, ts: Date.now(),
      clientReqId: clientId, brokerReqId: brokerId,
    });
    // Send-side twin of prompt-done — stamps the moment the broker saw the
    // prompt go out (ledger opens here; consumers may use it to prove a
    // turn really reached the agent's pipe).
    ctlEvent({
      ev: "prompt-start", id: a.id,
      sessionId: typeof sid === "string" ? sid : null,
      reqId: String(clientId), brokerReqId: brokerId, ts: Date.now(),
    });
  }
  return Buffer.from(`${JSON.stringify(m)}\n`, "utf8");
}

function spawnAcp(spec) {
  const acpId = `a${++seq}_${Date.now().toString(36)}`;
  const isWin = process.platform === "win32";
  const child = spec.shell && isWin
    ? spawn(spec.cmdline, { cwd: spec.cwd, env: { ...process.env, ...spec.env }, shell: true, windowsHide: true, detached: false, stdio: ["pipe", "pipe", "pipe"] })
    : spawn(spec.command, spec.args ?? [], { cwd: spec.cwd, env: { ...process.env, ...spec.env }, windowsHide: true, detached: !isWin, stdio: ["pipe", "pipe", "pipe"] });
  const a = {
    id: acpId,
    proc: child,
    meta: { cwd: spec.cwd, cmd: spec.cmdline ?? `${spec.command} ${(spec.args ?? []).join(" ")}`, key: spec.key ?? null, account: spec.account ?? null, startedAt: Date.now() },
    pending: Buffer.alloc(0),
    ring: [], ringBytes: 0, bytesOut: 0,
    // Protocol awareness — agent→client requests (id+method) the attached
    // backend has not answered. Re-emitted on re-attach so a request that
    // died on the old byte stream (dead-window permission/fs/terminal)
    // reaches the new backend instead of wedging devin forever.
    reqs: new Map(),
    // Client→agent request id remux: every forwarded request is renumbered
    // onto `nextReq` (monotonic for the acp's whole life), so a re-attached
    // backend's fresh per-connection counter can never collide with requests
    // still outstanding from the dead connection. `idMap` (brokerId → raw
    // client id) lets pushRing restore the response id before it is stored
    // or forwarded.
    nextReq: 1,
    idMap: new Map(),
    // Turn ledger — client→agent session/prompt requests (brokerReqId →
    // {sessionId, ts, clientReqId, brokerReqId}) whose agent→client response
    // this broker has not seen. Exposed in ctl `list` so a re-attaching
    // backend settles dead turns deterministically instead of waiting out a
    // silence window.
    prompts: new Map(),
    inBuf: Buffer.alloc(0), // client→agent partial line — held back until complete
    attached: null, exited: false, exitCode: null,
  };
  acps.set(acpId, a);
  child.stderr?.on("data", () => { /* drain — same reason as backend */ });
  child.stdout.on("data", (chunk) => {
    // Live clients receive exactly what the ring stored — complete frames
    // with response ids already restored to the client-side value.
    const out = pushRing(a, chunk);
    if (out.length && a.attached && !a.attached.destroyed) a.attached.write(out);
  });
  child.on("exit", (code) => {
    a.exited = true; a.exitCode = code;
    a.reqs.clear();
    a.prompts.clear();
    a.idMap.clear();
    ctlEvent({ ev: "exit", acpId, code });
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
// commit watchdog — upstream `devin acp` builds ≤3000.11.92 leak committed
// memory (VirtualAlloc'd regions never freed — ~194k regions / 26GB in 2.5h,
// mostly never touched: the PTY-per-tool-call leak fixed upstream in
// 3000.11.205). The leak charges the SYSTEM commit limit, not just the
// process, so a fat enough acp crashes unrelated apps (virtual-memory
// exhaustion → Edge/WeChat/system hangs — observed on this box). The broker
// owns the children and outlives backend restarts, so it bounds the damage:
// poll each child's committed bytes and recycle it past a threshold. Kill is
// turn-safe by design — ev:exit fires, open turns replay via auto-resume,
// loaded sessions re-attach on a fresh acp.
// ---------------------------------------------------------------------------
const MEM = {
  scanMs: acpMemScanMs(),          // DEVIN_WEB_ACP_MEM_SCAN_MS, 0 disables
  maxMb: acpCommitMaxMb(),         // DEVIN_WEB_ACP_COMMIT_MAX_MB (idle acp)
  maxBusyMb: acpCommitBusyMaxMb(), // DEVIN_WEB_ACP_COMMIT_BUSY_MAX_MB (in-flight turn)
  emergencyFreeMb: commitEmergencyMb(), // DEVIN_WEB_COMMIT_EMERGENCY_MB
};
const busyOf = (a) => a.prompts.size + a.reqs.size;

/** Snapshot each pid's committed MB + system-wide free commit MB (one
 *  powershell spawn per scan on win32; /proc on posix). Missing/failed
 *  entries are simply absent — callers must tolerate nulls. */
function measureCommit(pids) {
  const procs = new Map();
  let sysFreeMB = null;
  if (process.platform === "win32") {
    const script =
      "$cs=@((Get-Counter '\\Memory\\Committed Bytes','\\Memory\\Commit Limit' -ErrorAction SilentlyContinue).CounterSamples);" +
      "$cb=($cs|Where-Object{$_.Path -match 'ommitted Bytes'}|Select-Object -First 1).CookedValue;" +
      "$cl=($cs|Where-Object{$_.Path -match 'ommit Limit'}|Select-Object -First 1).CookedValue;" +
      "if(-not $cb -and $cs.Count -ge 2){$cb=$cs[0].CookedValue;$cl=$cs[1].CookedValue};" +
      `$ps=@(Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | Select-Object Id,PagedMemorySize64);` +
      "Write-Output (@{free=$(if($cl){[math]::Round(($cl-$cb)/1MB)}else{$null});procs=$ps}|ConvertTo-Json -Compress -Depth 3)";
    const out = execSync(`powershell -NoProfile -Command "${script}"`, { stdio: ["ignore", "pipe", "ignore"], timeout: 15000, windowsHide: true }).toString();
    const j = JSON.parse(out.trim().split("\n").pop());
    sysFreeMB = j.free ?? null;
    for (const p of [].concat(j.procs ?? [])) procs.set(p.Id, Math.round(p.PagedMemorySize64 / 1048576));
  } else {
    try {
      const mi = fs.readFileSync("/proc/meminfo", "utf8");
      const ca = Number(mi.match(/Committed_AS:\s+(\d+)/)?.[1]);
      const cl = Number(mi.match(/CommitLimit:\s+(\d+)/)?.[1]);
      if (ca && cl) sysFreeMB = Math.round((cl - ca) / 1024);
    } catch { /* no /proc */ }
    for (const pid of pids) {
      try {
        const st = fs.readFileSync(`/proc/${pid}/status`, "utf8");
        const v = Number(st.match(/VmSize:\s+(\d+)/)?.[1]);
        if (v) procs.set(pid, Math.round(v / 1024));
      } catch { /* dead between list and read */ }
    }
  }
  return { procs, sysFreeMB };
}

function memScan() {
  const live = [...acps.values()].filter((a) => !a.exited && a.proc?.pid);
  if (!live.length) return;
  let m;
  try { m = measureCommit(live.map((a) => a.proc.pid)); } catch { return; }
  for (const a of live) {
    const mb = m.procs.get(a.proc.pid);
    if (mb != null) a.lastCommitMb = mb;
  }
  // Emergency: the whole box is out of commit — recycle the fattest child
  // now or unrelated apps start failing allocations within minutes. One per
  // scan: the next pass re-evaluates and takes the next biggest if needed.
  if (m.sysFreeMB != null && m.sysFreeMB < MEM.emergencyFreeMb) {
    const big = live.reduce((x, y) => ((m.procs.get(y.proc.pid) ?? 0) > (m.procs.get(x.proc.pid) ?? 0) ? y : x));
    const mb = m.procs.get(big.proc.pid) ?? 0;
    console.error(`[acp-broker] EMERGENCY system free commit ${m.sysFreeMB}MB < ${MEM.emergencyFreeMb}MB — recycling largest acp ${big.id} (pid ${big.proc.pid}, ${mb}MB, busy=${busyOf(big)})`);
    ctlEvent({ ev: "mem-recycle", id: big.id, pid: big.proc.pid, commitMb: mb, reason: "system-emergency", ts: Date.now() });
    killAcp(big.id);
    return;
  }
  for (const a of live) {
    const mb = m.procs.get(a.proc.pid);
    if (mb == null) continue;
    const busy = busyOf(a);
    const cap = busy ? MEM.maxBusyMb : MEM.maxMb;
    if (mb <= cap) continue;
    console.error(`[acp-broker] recycling acp ${a.id} (pid ${a.proc.pid}): commit ${mb}MB > ${cap}MB (busy=${busy})`);
    ctlEvent({ ev: "mem-recycle", id: a.id, pid: a.proc.pid, commitMb: mb, reason: busy ? "over-busy-cap" : "over-cap", ts: Date.now() });
    killAcp(a.id);
  }
}
if (MEM.scanMs > 0) {
  const t = setInterval(memScan, MEM.scanMs);
  t.unref?.();
}

// ---------------------------------------------------------------------------
// socket server
// ---------------------------------------------------------------------------
function handleCtl(sock, head, rest) {
  ctls.add(sock);
  sock.on("close", () => ctls.delete(sock));
  // Buffer framing, NOT utf8-accumulate: a multi-byte char split across
  // chunks corrupts the line → JSON.parse fails → the request silently
  // drops and the caller's req-promise hangs (real bug on non-ASCII cwd).
  let buf = rest;
  const drain = () => {
    let i;
    while ((i = buf.indexOf(0x0a)) >= 0) {
      const l = buf.subarray(0, i).toString("utf8"); buf = buf.subarray(i + 1);
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
            startedAt: a.meta.startedAt, commitMb: a.lastCommitMb ?? null,
            // reqId is the CLIENT-side id (what the backend's turn journal
            // recorded, compared as a string); brokerReqId is what actually
            // went on the agent's wire — kept for forensics.
            pendingPrompts: [...a.prompts.values()].map((p) => ({
              reqId: String(p.clientReqId), brokerReqId: p.brokerReqId,
              sessionId: p.sessionId, ts: p.ts,
            })),
          })) });
        }
        else reply({ ok: false, error: `unknown op ${m.op}` });
      } catch (e) { reply({ ok: false, error: String(e?.message ?? e) }); }
    }
  };
  drain(); // `rest` may already hold request lines that arrived with the header
  sock.on("data", (d) => { buf = Buffer.concat([buf, d]); drain(); });
}

function handleAttach(sock, head, rest) {
  const a = acps.get(head.attach);
  if (!a) { sock.write(`${JSON.stringify({ ok: false, error: "no such acp" })}\n`); sock.end(); return; }
  if (a.attached && !a.attached.destroyed) a.attached.destroy(); // latest wins
  a.attached = sock;
  // A torn client→agent line left by the dead connection can never validly
  // complete — its tail died with the socket. Drop it so the new backend's
  // first line isn't glued onto the corpse.
  a.inBuf = Buffer.alloc(0);
  sock.write(`${JSON.stringify({ ok: true, pid: a.proc.pid, exited: a.exited, bytesOut: a.bytesOut })}\n`);
  // Replay buffered frames newer than `after` (byte offsets count only
  // complete frames — after=0 replays the whole ring). A partial trailing
  // frame stays in `a.pending` until it completes, then flows through
  // pushRing like any other complete frame — writing it raw here would
  // duplicate those bytes when the completed frame lands, and could leak
  // an un-restored response id.
  let off = a.bytesOut - a.ringBytes;
  for (const f of a.ring) {
    const end = off + f.length;
    if (end > (head.after ?? 0)) sock.write(f);
    off = end;
  }
  if (a.exited) { sock.end(); return; }
  // Re-emit agent→client requests the previous backend never answered — a
  // pending frame older than `after` is invisible to ring replay and would
  // otherwise leave devin blocked on a dead stream forever (zombie turn).
  // Frames inside the replay window already arrived via the ring.
  for (const r of a.reqs.values()) if (r.end <= (head.after ?? 0)) sock.write(r.frame);
  // `rest` is bytes the client wrote before the header newline — they belong
  // to the child's stdin just like every later chunk. feedStdin returns the
  // bytes to write: complete lines only, request ids remapped.
  if (rest.length) { try { a.proc.stdin.write(feedStdin(a, rest)); } catch { /* dead */ } }
  sock.on("data", (d) => { try { a.proc.stdin.write(feedStdin(a, d)); } catch { /* dead */ } });
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
    // Every channel requires the local token — the socket is otherwise a
    // spawn-as-me surface for any process on this machine.
    if (head.token !== TOKEN) { sock.destroy(); return; }
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
