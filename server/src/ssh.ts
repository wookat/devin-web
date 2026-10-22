/**
 * ssh.ts — SSH host records, auth resolution, and the ssh2-backed transport.
 *
 * Two auth lanes:
 *  - `auth: "agent"` (default) → the OpenSSH binary (`spawn("ssh", …)`) so the
 *    user's own ~/.ssh/config, agent keys, and ControlMaster all apply. No
 *    password support — OpenSSH won't take one non-interactively.
 *  - `auth: "password" | "key"` → the bundled ssh2 client. Passwords/keys come
 *    from the host record (prefs.sshHosts — plaintext in dw.json; the web UI
 *    never echoes them back, only a hasPassword flag).
 *
 * `sshSpawn` returns a ChildProcess-shaped object over an ssh2 exec channel so
 * acp.ts / terminal.ts / ws-term treat remote sessions exactly like local
 * children. Filesystem ops ride sftp on a small pooled control connection.
 */
import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from "ssh2";

export interface SshHost {
  /** Display label; falls back to `target` in the UI. */
  name?: string;
  /** `[user@]host[:port]` or an OpenSSH config alias. */
  target: string;
  /** Default remote working directory (POSIX path, may start with ~). */
  cwd?: string;
  /** agent → OpenSSH binary; password/key → ssh2. Default: agent. */
  auth?: "agent" | "password" | "key";
  password?: string;
  /** Private-key file for `auth: "key"` (~ allowed). Passphrase optional. */
  keyPath?: string;
  passphrase?: string;
}

/* ---------------- host registry ---------------- */

let hostResolver: () => SshHost[] = () => [];

/** Called once at server setup: the resolver reads prefs.sshHosts (cached
 *  dw.json) so every later lookup sees current records. */
export function setSshHostResolver(fn: () => SshHost[]) {
  hostResolver = fn;
}

function sshHosts(): SshHost[] {
  try { return hostResolver() ?? []; } catch { return []; }
}

export function sshHostFor(target: string | null | undefined): SshHost | null {
  if (!target) return null;
  return sshHosts().find((h) => h.target === target) ?? null;
}

/** Public shape — never leak passwords/passphrases to the web UI. */
export function publicSshHost(h: SshHost) {
  return {
    name: h.name, target: h.target, cwd: h.cwd,
    auth: h.auth ?? "agent", keyPath: h.keyPath,
    hasPassword: !!h.password, hasPassphrase: !!h.passphrase,
  };
}

/** True when the record can't be served by the OpenSSH binary. */
function needsSsh2(host: SshHost | null): boolean {
  if (!host) return false;
  return host.auth === "password" || host.auth === "key" || !!host.password || !!host.keyPath;
}

/* ---------------- connect ---------------- */

function parseTarget(target: string): { username?: string; host: string; port?: number } {
  let rest = target.trim();
  let username: string | undefined;
  const at = rest.lastIndexOf("@");
  if (at >= 0) { username = rest.slice(0, at); rest = rest.slice(at + 1); }
  let port: number | undefined;
  const m = rest.match(/^(.*):(\d{1,5})$/);
  if (m && !/^\[.*\]$/.test(m[1])) { rest = m[1]; port = Number(m[2]); }
  return { username, host: rest.replace(/^\[|\]$/g, ""), port };
}

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function connectConfig(host: SshHost): ConnectConfig {
  const { username, host: hostname, port } = parseTarget(host.target);
  const cfg: ConnectConfig = {
    host: hostname,
    port: port ?? 22,
    username: username ?? process.env.USER ?? os.userInfo().username,
    readyTimeout: 15000,
    keepaliveInterval: 10000,
    keepaliveCountMax: 3,
    tryKeyboard: true,
  };
  if (host.auth === "password" || host.password) cfg.password = host.password ?? "";
  if (host.auth === "key" || host.keyPath) {
    const kp = expandHome(host.keyPath || "~/.ssh/id_rsa");
    cfg.privateKey = fs.readFileSync(kp);
    if (host.passphrase) cfg.passphrase = host.passphrase;
  }
  return cfg;
}

function connect(host: SshHost): Promise<Client> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const onReady = () => { cleanup(); resolve(conn); };
    const onErr = (e: Error) => { cleanup(); try { conn.end(); } catch {} reject(e); };
    const cleanup = () => { conn.off("ready", onReady); conn.off("error", onErr); };
    conn.once("ready", onReady).once("error", onErr);
    if (host.auth === "password" || host.password) {
      conn.on("keyboard-interactive", (_n, _i, _l, _p, fin) => fin([host.password ?? ""]));
    }
    conn.connect(connectConfig(host));
  });
}

/* ---------------- pooled control connection (fs ops) ---------------- */

const pool = new Map<string, { conn: Client; lastUse: number }>();
const IDLE_MS = 120_000;

async function pooledConn(host: SshHost): Promise<Client> {
  const cur = pool.get(host.target);
  if (cur) { cur.lastUse = Date.now(); return cur.conn; }
  const conn = await connect(host);
  pool.set(host.target, { conn, lastUse: Date.now() });
  conn.on("close", () => { if (pool.get(host.target)?.conn === conn) pool.delete(host.target); });
  conn.on("error", () => { if (pool.get(host.target)?.conn === conn) pool.delete(host.target); });
  return conn;
}

setInterval(() => {
  const now = Date.now();
  for (const [t, e] of pool) {
    if (now - e.lastUse > IDLE_MS) { pool.delete(t); try { e.conn.end(); } catch {} }
  }
}, 30_000).unref();

function withConn<T>(target: string, fn: (conn: Client) => Promise<T>): Promise<T> {
  const host = sshHostFor(target);
  if (!host) return Promise.reject(new Error(`ssh target not configured: ${target}`));
  return pooledConn(host).then(fn);
}

function sftpOf(conn: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => conn.sftp((e, s) => (e ? reject(e) : resolve(s))));
}

/* ---------------- exec / spawn ---------------- */

function execRaw(conn: Client, cmd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (e, chan) => {
      if (e) return reject(e);
      let stdout = "", stderr = "";
      chan.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
      chan.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
      let code: number | null = null;
      chan.on("exit", (c) => { code = c ?? null; });
      chan.on("close", () => resolve({ code, stdout, stderr }));
      chan.on("error", reject);
    });
  });
}

/** One-shot remote command on the pooled connection. */
async function sshExec(target: string, cmd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return withConn(target, (conn) => execRaw(conn, cmd));
}

/** ChildProcess-shaped wrapper around an ssh2 channel. acp.ts needs
 *  stdin/stdout/stderr streams + 'exit'/'error' + kill(); terminal.ts wants
 *  the same — the shape is duck-compatible, cast at the call site. */
class SshChildProc extends EventEmitter {
  stdin!: Writable;
  stdout!: Readable;
  stderr!: Readable;
  stdio!: [Writable, Readable, Readable];
  pid = 0;
  killed = false;
  exitCode: number | null = null;
  private exited = false;

  constructor(private chan: ClientChannel, private conn: Client) {
    super();
    this.stdin = chan as unknown as Writable;
    this.stdout = chan as unknown as Readable;
    this.stderr = chan.stderr as unknown as Readable;
    this.stdio = [this.stdin, this.stdout, this.stderr];
    let code: number | null = null;
    let sig: string | null = null;
    chan.on("exit", (c: number | null, s?: string) => { code = c ?? null; sig = s ?? null; this.exitCode = code; });
    const finish = () => {
      if (this.exited) return;
      this.exited = true;
      try { conn.end(); } catch {}
      this.emit("exit", code, sig);
    };
    chan.once("close", finish);
    conn.once("close", finish);
    chan.stderr.on("error", () => {});
    conn.on("error", (e: Error) => this.emit("error", e));
  }

  kill(): boolean {
    this.killed = true;
    try { this.chan.close(); } catch {}
    try { this.conn.end(); } catch {}
    return true;
  }
}

function spawnViaSsh2(host: SshHost, cmd: string): Promise<ChildProcessByStdio<Writable, Readable, Readable>> {
  return connect(host).then(
    (conn) =>
      new Promise((resolve, reject) => {
        conn.exec(cmd, (e, chan) => {
          if (e) { try { conn.end(); } catch {} return reject(e); }
          resolve(new SshChildProc(chan, conn) as unknown as ChildProcessByStdio<Writable, Readable, Readable>);
        });
      }),
  );
}

/** Spawn `cmd` on the target — OpenSSH binary for `auth:"agent"`/unresolved
 *  hosts (user's own keys/config), ssh2 for password/key records. */
export async function sshSpawn(
  target: string,
  cmd: string,
  opts: Parameters<typeof spawn>[2] = {},
): Promise<ChildProcessByStdio<Writable, Readable, Readable>> {
  const host = sshHostFor(target);
  if (host && needsSsh2(host)) return spawnViaSsh2(host, cmd);
  return spawn("ssh", [target, cmd], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, ...opts }) as ChildProcessByStdio<Writable, Readable, Readable>;
}

/** Interactive pty shell for /ws/term — ssh2 for password/key hosts. */
export async function sshInteractive(target: string): Promise<ChildProcessByStdio<Writable, Readable, Readable>> {
  const host = sshHostFor(target);
  if (host && needsSsh2(host)) {
    const conn = await connect(host);
    return new Promise((resolve, reject) => {
      conn.shell({ term: "xterm-256color" }, (e, chan) => {
        if (e) { try { conn.end(); } catch {} return reject(e); }
        resolve(new SshChildProc(chan, conn) as unknown as ChildProcessByStdio<Writable, Readable, Readable>);
      });
    });
  }
  return spawn("ssh", ["-tt", target], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }) as ChildProcessByStdio<Writable, Readable, Readable>;
}

/* ---------------- remote filesystem ---------------- */

interface SshEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  mtime: number;
}

const HOME_CACHE = new Map<string, { home: string; at: number }>();

async function remoteHome(target: string): Promise<string> {
  const hit = HOME_CACHE.get(target);
  if (hit && Date.now() - hit.at < 300_000) return hit.home;
  const home = (await withConn(target, async (conn) => {
    const sftp = await sftpOf(conn);
    return new Promise<string>((res, rej) => sftp.realpath(".", (e, p) => (e ? rej(e) : res(p))));
  })).replace(/\\/g, "/").replace(/\/+$/, "");
  HOME_CACHE.set(target, { home, at: Date.now() });
  return home;
}

/** Expand `~`/empty to the remote home dir; POSIX-normalize the result. */
async function sshResolveDir(target: string, p: string): Promise<string> {
  const home = await remoteHome(target);
  let out = (p || "~").trim();
  if (out === "~" || out === "") out = home;
  else if (out.startsWith("~/")) out = home + out.slice(1);
  // normalize . / .. (posix — remote hosts are unix-likes)
  const parts: string[] = [];
  for (const seg of out.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}

async function sftpList(conn: Client, dir: string): Promise<SshEntry[]> {
  const sftp = await sftpOf(conn);
  return new Promise((resolve, reject) => {
    sftp.readdir(dir, (e, list) => {
      if (e) return reject(e);
      resolve(
        (list ?? [])
          .filter((f) => f.filename !== "." && f.filename !== "..")
          .map((f) => ({
            name: f.filename,
            path: `${dir.replace(/\/+$/, "")}/${f.filename}`,
            dir: f.attrs.isDirectory(),
            size: f.attrs.size,
            mtime: f.attrs.mtime * 1000,
          }))
          .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)),
      );
    });
  });
}

/** Dir listing for the remote picker's browse mode — same shape as
 *  /api/admin/fs/dirs so the UI is shared. */
export async function sshListDirs(target: string, p: string) {
  const dir = await sshResolveDir(target, p);
  const entries = await withConn(target, (conn) => sftpList(conn, dir));
  const parent = dir === "/" ? null : dir.replace(/\/[^/]+$/, "") || "/";
  return { cwd: dir, parent, dirs: entries.filter((e) => e.dir).map((e) => ({ name: e.name, path: e.path })) };
}

export type SshFsOp =
  | { op: "list"; path?: string }
  | { op: "mkdir"; path: string }
  | { op: "rename"; path: string; to: string }
  | { op: "delete"; path: string }
  | { op: "write"; path: string; content: string }
  | { op: "read"; path: string };

/** Remote file management — mkdir/rename/delete/write/read/list. `delete`
 *  removes files AND directories (recursive via `rm -rf` — sftp has no rmdir
 *  tree walk). All paths are confined by nothing but the user's account. */
export async function sshFs(target: string, req: SshFsOp): Promise<unknown> {
  switch (req.op) {
    case "list": {
      const dir = await sshResolveDir(target, req.path ?? "~");
      const entries = await withConn(target, (conn) => sftpList(conn, dir));
      return { cwd: dir, entries };
    }
    case "mkdir": {
      const p = await sshResolveDir(target, req.path);
      await withConn(target, (conn) => sftpOf(conn).then((s) => new Promise<void>((res, rej) => s.mkdir(p, (e) => (e ? rej(e) : res())))));
      return { ok: true, path: p };
    }
    case "rename": {
      const from = await sshResolveDir(target, req.path);
      const to = await sshResolveDir(target, req.to);
      await withConn(target, (conn) => sftpOf(conn).then((s) => new Promise<void>((res, rej) => s.rename(from, to, (e) => (e ? rej(e) : res())))));
      return { ok: true };
    }
    case "delete": {
      const p = await sshResolveDir(target, req.path);
      const r = await sshExec(target, `rm -rf -- '${p.replace(/'/g, `'\\''`)}'`);
      if (r.code) throw new Error(r.stderr.trim() || `rm exited ${r.code}`);
      return { ok: true };
    }
    case "write": {
      const p = await sshResolveDir(target, req.path);
      await withConn(target, async (conn) => {
        const sftp = await sftpOf(conn);
        await new Promise<void>((res, rej) => {
          const w = sftp.createWriteStream(p);
          w.on("error", rej);
          w.on("close", () => res());
          w.end(Buffer.from(req.content, "utf8"));
        });
      });
      return { ok: true, path: p };
    }
    case "read": {
      const p = await sshResolveDir(target, req.path);
      return withConn(target, async (conn) => {
        const sftp = await sftpOf(conn);
        const stat = await new Promise<{ size: number }>((res, rej) => sftp.stat(p, (e, s) => (e ? rej(e) : res(s))));
        if (stat.size > 2 * 1024 * 1024) throw new Error("file too large (>2MB)");
        const buf = await new Promise<Buffer>((res, rej) => {
          const chunks: Buffer[] = [];
          const r = sftp.createReadStream(p);
          r.on("data", (d: Buffer) => chunks.push(d));
          r.on("error", rej);
          r.on("end", () => res(Buffer.concat(chunks)));
        });
        return { path: p, size: stat.size, content: buf.toString("utf8") };
      });
    }
  }
}

/** Connectivity probe for the settings UI — runs `echo` on the target. */
export async function sshTest(target: string): Promise<{ ok: boolean; ms: number; error?: string; whoami?: string }> {
  const host = sshHostFor(target);
  if (!host) return { ok: false, ms: 0, error: "not configured" };
  const at = Date.now();
  try {
    const conn = await connect(host);
    try {
      const r = await execRaw(conn, "whoami 2>/dev/null || echo ok");
      return { ok: r.code === 0, ms: Date.now() - at, whoami: r.stdout.trim() || undefined };
    } finally {
      conn.end();
    }
  } catch (e) {
    return { ok: false, ms: Date.now() - at, error: e instanceof Error ? e.message : String(e) };
  }
}
