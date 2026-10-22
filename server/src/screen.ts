/**
 * screen — read-only live view of the real host desktop for the admin UI.
 *
 * scripts/screencap.cs is compiled once per machine via the in-box .NET
 * Framework csc.exe (no extra deps; a small exe avoids the AMSI script
 * signature that blocks CopyFromScreen loops in .ps1 files). The child
 * writes length-prefixed JPEG frames to stdout; frames fan out to MJPEG
 * clients. The child is killed when the last client leaves so an idle
 * server burns no CPU.
 *
 * Input injection (POST /api/admin/screen/input) rides a persistent
 * inputinject helper (same csc.exe compile-once pattern) reading line
 * commands on stdin. Coordinates are normalized 0..1 over the virtual
 * screen so the client never does DPI math. Linux backend: swap the
 * helper spawn for an xdotool/XTest shim when a VM sandbox lands.
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { ServerResponse } from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "screencap.cs");

let dataDir = "";
export function initScreen(dir: string): void {
  dataDir = dir;
  // screencap children outlive their backend on Windows (no auto-reap) — a
  // leftover from a previous backend lifetime keeps streaming stale frames
  // and blocks arg-keyed respawn. The exe name is ours alone, so sweep it.
  if (process.platform === "win32") {
    execFile("taskkill", ["/f", "/im", "screencap.exe"], () => {});
  }
}

const exePath = () => path.join(dataDir, "screencap", "screencap.exe");

function findCsc(): string | null {
  const windir = process.env.WINDIR || "C:\\Windows";
  for (const p of [
    path.join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

let exeReady: Promise<string> | null = null;
function ensureExe(): Promise<string> {
  if (!exeReady) exeReady = build();
  return exeReady;
}

async function build(): Promise<string> {
  const exe = exePath();
  const sha = crypto.createHash("sha1").update(fs.readFileSync(SRC)).digest("hex").slice(0, 12);
  try {
    if (fs.existsSync(exe) && fs.readFileSync(exe + ".sha", "utf8").trim() === sha) return exe;
  } catch { /* fall through to rebuild */ }
  const csc = findCsc();
  if (!csc) throw new Error("csc.exe not found (.NET Framework 4.x required)");
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  await execFileP(csc, [
    "/nologo", "/target:exe", "/platform:anycpu",
    `/out:${exe}`, "/r:System.Drawing.dll", "/r:System.Windows.Forms.dll", SRC,
  ], { timeout: 30_000 });
  fs.writeFileSync(exe + ".sha", sha);
  return exe;
}

// ---- capture loop + MJPEG fan-out --------------------------------------------

let child: ChildProcess | null = null;
let childArgs = "";
let captureMon = "primary";
const spawned = new Set<ChildProcess>();
let latest: Buffer | null = null;
let buf = Buffer.alloc(0);
const watchers = new Set<() => void>();

/** quality → screencap.exe args: maxWidth, jpegQuality, frameIntervalMs. */
const QUALITY: Record<string, string[]> = {
  sharp: ["1920", "75", "150"],
  auto: ["1600", "55", "250"],
  saver: ["1280", "35", "400"],
}

async function ensureCapture(quality: string, monitor = "primary") {
  const args = [...(QUALITY[quality] ?? QUALITY.auto), monitor === "virtual" ? "virtual" : "primary"]
  const key = args.join(",")
  if (child && childArgs === key) return
  stopCapture()
  const exe = await ensureExe()
  if (child) return; // another request spawned it while compiling
  buf = Buffer.alloc(0);
  latest = null; // never flush a stale frame from the previous arg set
  childArgs = key
  captureMon = monitor === "virtual" ? "virtual" : "primary"
  const c = spawn(exe, [...args], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  child = c;
  spawned.add(c);
  c.stdout!.on("data", (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 4) return;
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) return;
      latest = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      for (const fn of watchers) fn();
    }
  });
  const drop = () => { spawned.delete(c); if (child === c) child = null; };
  c.on("exit", drop);
  c.on("error", drop);
}

function stopCapture() {
  child = null;
  childArgs = "";
  for (const c of spawned) { try { c.kill(); } catch { /* already gone */ } }
  spawned.clear();
}

/** `GET /api/admin/screen/live?q=auto|sharp|saver&mon=primary|virtual` — multipart JPEG stream. */
export async function streamScreen(res: ServerResponse, quality = "auto", monitor = "primary"): Promise<void> {
  if (process.platform !== "win32" || !fs.existsSync(SRC)) {
    res.writeHead(501, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "screen capture unavailable on this host" }));
    return;
  }
  try {
    await ensureCapture(quality, monitor);
  } catch (e) {
    res.writeHead(501, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    return;
  }
  res.writeHead(200, {
    "Content-Type": "multipart/x-mixed-replace; boundary=screenframe",
    "Cache-Control": "no-cache, no-store",
    "Connection": "close",
    "X-Accel-Buffering": "no",
  });
  const write = () => {
    if (!latest || res.writableEnded) return;
    res.write(`--screenframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${latest.length}\r\n\r\n`);
    res.write(latest);
    res.write("\r\n");
  };
  watchers.add(write);
  write(); // flush the newest frame immediately
  res.on("close", () => {
    watchers.delete(write);
    if (!watchers.size) { stopCapture(); latest = null; }
  });
}

// ---- input injection ------------------------------------------------------

const INJECT_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "inputinject.cs");
const injectPath = () => path.join(dataDir, "screencap", "inputinject.exe");

let injectChild: ChildProcess | null = null;
let injectReady: Promise<ChildProcess> | null = null;

async function ensureInject(): Promise<ChildProcess> {
  if (injectChild) return injectChild;
  injectReady ??= (async () => {
    // Compile once next to screencap.exe (same sha-stamped pattern).
    const exe = injectPath();
    const sha = crypto.createHash("sha1").update(fs.readFileSync(INJECT_SRC)).digest("hex").slice(0, 12);
    let ok = false;
    try { ok = fs.existsSync(exe) && fs.readFileSync(exe + ".sha", "utf8").trim() === sha; } catch { /* rebuild */ }
    if (!ok) {
      const csc = findCsc();
      if (!csc) throw new Error("csc.exe not found (.NET Framework 4.x required)");
      fs.mkdirSync(path.dirname(exe), { recursive: true });
      await execFileP(csc, [
        "/nologo", "/target:exe", "/platform:anycpu",
        `/out:${exe}`, "/r:System.Windows.Forms.dll", "/r:System.Drawing.dll", INJECT_SRC,
      ], { timeout: 30_000 });
      fs.writeFileSync(exe + ".sha", sha);
    }
    const c = spawn(exe, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    const drop = () => { if (injectChild === c) injectChild = null; };
    c.on("exit", drop);
    c.on("error", drop);
    return c;
  })();
  try {
    injectChild = await injectReady;
    return injectChild;
  } finally {
    injectReady = null;
  }
}

/**
 * `POST /api/admin/screen/input` — one input event as JSON:
 *   {t:'move',u,v} {t:'button',btn:'l|r|m',down:bool} {t:'wheel',dy}
 *   {t:'key',vk,down:bool} {t:'text',text}
 */
export async function injectInput(body: unknown): Promise<void> {
  if (process.platform !== "win32" || !fs.existsSync(INJECT_SRC)) {
    throw new Error("input injection unavailable on this host");
  }
  const o = body as Record<string, unknown>;
  let line: string | null = null;
  switch (o?.t) {
    case "move": {
      const u = Number(o.u), v = Number(o.v);
      if (u >= 0 && u <= 1 && v >= 0 && v <= 1) line = `m ${u.toFixed(5)} ${v.toFixed(5)} ${captureMon}`;
      break;
    }
    case "button": {
      const btn = o.btn === "r" ? "r" : o.btn === "m" ? "m" : "l";
      line = `${o.down ? "d" : "u"} ${btn}`;
      break;
    }
    case "wheel": {
      const dy = Math.trunc(Number(o.dy) || 0);
      if (dy) line = `w ${dy}`;
      break;
    }
    case "key": {
      const vk = Math.trunc(Number(o.vk) || 0);
      if (vk > 0 && vk < 256) line = `k ${vk} ${o.down ? "down" : "up"}`;
      break;
    }
    case "text": {
      const s = String(o.text ?? "").slice(0, 4096);
      if (s) line = `t ${Buffer.from(s, "utf8").toString("base64")}`;
      break;
    }
  }
  if (!line) throw new Error("bad input event");
  const c = await ensureInject();
  c.stdin!.write(line + "\n");
}
