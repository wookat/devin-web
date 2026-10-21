/**
 * Client side of scripts/acp-broker.mjs. When DEVIN_WEB_ACP_BROKER names a
 * socket path (injected by the supervisor), acp children live under the
 * broker process instead of the backend — backend restarts then leave agent
 * processes and in-flight turns running. Unset → every helper returns
 * null/false and callers fall back to direct spawn (dev mode, bare `run`).
 *
 * Wire shape (see acp-broker.mjs header): one persistent ndjson control
 * channel for spawn/kill/list + exit events, and one raw duplex data channel
 * per acp whose first line is {"attach":...} and whose remaining bytes ARE
 * the child's stdin/stdout.
 */
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import type { Writable, Readable } from "node:stream";

const SOCK = process.env.DEVIN_WEB_ACP_BROKER || "";
export const brokerEnabled = !!SOCK;

export function brokerSockPath(dataDir: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\devin-web-acp-${crypto.createHash("sha1").update(dataDir).digest("hex").slice(0, 10)}`
    : path.join(dataDir, "acp-broker.sock");
}

export interface BrokerAcpInfo {
  acpId: string; pid: number; cwd: string; cmd: string; key: string | null;
  /** Pool account the process was spawned with — journaled so adoption
   *  restores real attribution instead of "(account ?)". */
  account: string | null;
  exited: boolean; exitCode: number | null; bytesOut: number; startedAt: number;
}

// ---------------------------------------------------------------------------
// control channel
// ---------------------------------------------------------------------------
interface Ctl {
  call: (msg: Record<string, unknown>) => Promise<Record<string, unknown>>;
  onExit: (fn: (acpId: string, code: number | null) => void) => () => boolean;
  close: () => void;
}
let ctlPromise: Promise<Ctl | null> | null = null;

function connectCtl(): Promise<Ctl | null> {
  if (ctlPromise) return ctlPromise;
  ctlPromise = new Promise((resolve) => {
    const sock = net.createConnection(SOCK);
    const pending = new Map<number, { res: (v: Record<string, unknown>) => void; rej: (e: Error) => void }>();
    const exitFns = new Set<(acpId: string, code: number | null) => void>();
    let req = 0;
    let buf = "";
    let ready = false;
    const fail = (e: Error) => {
      for (const p of pending.values()) p.rej(e);
      pending.clear();
    };
    // Ready on CONNECT, not first data: the broker's ctl channel never speaks
    // unsolicited — waiting for a first line deadlocks every call behind the
    // 5s timer and reports a live broker as "unavailable".
    sock.once("connect", () => {
      sock.write(`${JSON.stringify({ ctl: 1 })}\n`);
      ready = true;
      resolve({ call, onExit, close });
    });
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1);
        let m: Record<string, unknown>; try { m = JSON.parse(l); } catch { continue; }
        if (m.ev === "exit") { for (const f of exitFns) f(String(m.acpId), m.code as number | null); continue; }
        const p = pending.get(m.req as number);
        if (!p) continue;
        pending.delete(m.req as number);
        m.ok ? p.res(m) : p.rej(new Error(String(m.error ?? "broker error")));
      }
    });
    const dead = () => { fail(new Error("broker control channel closed")); if (!ready) resolve(null); ctlPromise = null; };
    sock.once("error", dead);
    sock.once("close", dead);
    const call = (msg: Record<string, unknown>) => new Promise<Record<string, unknown>>((res, rej) => {
      const id = ++req;
      pending.set(id, { res, rej });
      sock.write(`${JSON.stringify({ req: id, ...msg })}\n`);
    });
    const onExit = (fn: (acpId: string, code: number | null) => void) => { exitFns.add(fn); return () => exitFns.delete(fn); };
    const close = () => sock.destroy();
    setTimeout(() => { if (!ready) { sock.destroy(); resolve(null); } }, 5000);
  });
  return ctlPromise;
}

export async function brokerList(): Promise<BrokerAcpInfo[]> {
  const ctl = await connectCtl();
  if (!ctl) return [];
  const r = await ctl.call({ op: "list" }).catch(() => ({ acps: [] }));
  return (r.acps as BrokerAcpInfo[]) ?? [];
}

export interface BrokerSpawnSpec {
  cwd: string; command: string; args: string[];
  env: Record<string, string>; shell: boolean; cmdline?: string;
  /** Manager pool key (`agent:cwd` / `agent:ssh:target:cwd`) — lets a fresh
   *  backend re-map a surviving acp to its pool slot on adoption. */
  key?: string;
  /** Pool account whose key was injected into env — journaled by the broker
   *  so adoption restores `acp.account` attribution. */
  account?: string | null;
}

export async function brokerSpawn(spec: BrokerSpawnSpec): Promise<{ acpId: string; pid: number }> {
  const ctl = await connectCtl();
  if (!ctl) throw new Error("broker unavailable");
  const r = await ctl.call({ op: "spawn", cwd: spec.cwd, command: spec.command, args: spec.args, env: spec.env, shell: spec.shell, cmdline: spec.cmdline, key: spec.key, account: spec.account });
  return { acpId: String(r.acpId), pid: r.pid as number };
}

export async function brokerKill(acpId: string): Promise<void> {
  const ctl = await connectCtl();
  if (!ctl) return;
  await ctl.call({ op: "kill", acpId }).catch(() => {});
}

// ---------------------------------------------------------------------------
// data channel — a net.Socket posing as the acp's stdio, plus a ChildProcess-
// shaped facade for the parts DevinAcp touches (pid/exit/error/kill/stdin/out).
// ---------------------------------------------------------------------------
/** Minimal ChildProcess-shaped surface DevinAcp touches — satisfied by a real
 *  ChildProcess (direct spawn) or a broker attach socket (duplex). Declared
 *  structurally rather than extending EventEmitter: ChildProcess's `on`
 *  overloads are narrower than the generic emitter signature. */
export interface ProcHandle {
  pid?: number;
  stdin: Writable;
  stdout: Readable;
  stderr?: Readable;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown;
  emit(event: string, ...args: unknown[]): boolean;
  kill: (signal?: number | NodeJS.Signals) => boolean;
  /** Bytes received over the attach socket since connect — persisted on
   *  graceful exit so the next backend re-attaches at the exact stream
   *  position (broker replays only the death-gap frames). */
  bytesReceived?: () => number;
}

export async function brokerAttach(acpId: string, after: number): Promise<{ proc: ProcHandle; sock: net.Socket; pid: number; exited: boolean; bytesOut: number }> {
  const sock = net.createConnection(SOCK);
  return new Promise((resolve, reject) => {
    let headBuf = Buffer.alloc(0);
    // Seed at `after` so bytesReceived() reports the absolute stream position
    // — the graceful-exit journal persists it for the NEXT attach, and a
    // session-relative count would replay from ~0 (duplicate frames).
    let received = after;
    const proc = new EventEmitter() as unknown as ProcHandle;
    proc.stdin = sock as unknown as Writable;
    proc.stdout = sock as unknown as Readable;
    proc.kill = () => { void brokerKill(acpId); sock.destroy(); return true; };
    proc.bytesReceived = () => received;
    const onHead = (d: Buffer) => {
      headBuf = Buffer.concat([headBuf, d]);
      const nl = headBuf.indexOf(0x0a);
      if (nl < 0) return;
      sock.removeListener("data", onHead);
      let head: Record<string, unknown>;
      try { head = JSON.parse(headBuf.subarray(0, nl).toString("utf8")); } catch { sock.destroy(); return reject(new Error("broker attach: bad header")); }
      if (!head.ok) { sock.destroy(); return reject(new Error(String(head.error ?? "attach failed"))); }
      proc.pid = head.pid as number;
      // Live-edge join (crash adoption, after > everything buffered): clamp
      // the counter to the real stream position so the next journal write
      // is a valid offset rather than an ever-growing skip-everything flag.
      if (received > (head.bytesOut as number)) received = head.bytesOut as number;
      sock.pause();
      // Count every post-header byte — ring replay, the partial-frame tail,
      // and live chunks all flow through 'data'.
      sock.on("data", (c: Buffer) => { received += c.length; });
      resolve({ proc, sock, pid: proc.pid!, exited: !!head.exited, bytesOut: head.bytesOut as number });
      // Resume AFTER resolve so the caller wires 'data'/'readable' first —
      // nothing buffered in `rest` is lost (socket replay follows the header).
      const rest = headBuf.subarray(nl + 1);
      if (rest.length) sock.emit("data", rest);
      sock.resume();
    };
    sock.on("data", onHead);
    sock.once("error", (e) => { reject(e); proc.emit("error", e); });
    sock.once("close", () => proc.emit("exit", null));
    sock.write(`${JSON.stringify({ attach: acpId, after })}\n`);
  });
}

/** Subscribe to broker exit events; returns an unsubscribe fn. */
export async function brokerOnExit(fn: (acpId: string, code: number | null) => void): Promise<() => void> {
  const ctl = await connectCtl();
  return ctl?.onExit(fn) ?? (() => {});
}

// ---------------------------------------------------------------------------
// offset journal — how many broker bytes each acp stream had delivered before
// a graceful restart, so adoption replays exactly the death-gap frames.
// ---------------------------------------------------------------------------
export function offsetsFile(dataDir: string): string {
  return path.join(dataDir, "acp-offsets.json");
}
export function readOffsets(dataDir: string): Record<string, number> {
  try { return JSON.parse(fs.readFileSync(offsetsFile(dataDir), "utf8")); } catch { return {}; }
}
export function writeOffsets(dataDir: string, m: Record<string, number>): void {
  try { fs.writeFileSync(offsetsFile(dataDir), JSON.stringify(m)); } catch { /* best-effort */ }
}
/** The offset journal is single-use: a graceful exit writes the consumed
 *  positions, the next boot's adoption reads them — then MUST delete them.
 *  Otherwise a subsequent hard crash leaves stale low offsets on disk and
 *  the next attach replays already-consumed frames (duplicate updates,
 *  ghost RPC responses, re-executed agent→client requests). */
export function clearOffsets(dataDir: string): void {
  try { fs.rmSync(offsetsFile(dataDir), { force: true }); } catch { /* best-effort */ }
}
