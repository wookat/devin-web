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
 * Read-only by design: the workbench has no auth, so remote mouse/keyboard
 * control of the host desktop is deliberately NOT offered here — the
 * interactive surface is the dedicated CDP browser (localbrowser.ts).
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
let latest: Buffer | null = null;
let buf = Buffer.alloc(0);
const watchers = new Set<() => void>();

async function ensureCapture() {
  if (child) return;
  const exe = await ensureExe();
  if (child) return; // another request spawned it while compiling
  buf = Buffer.alloc(0);
  child = spawn(exe, ["1600", "55", "250"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  child.stdout!.on("data", (d: Buffer) => {
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
  const drop = () => { child = null; };
  child.on("exit", drop);
  child.on("error", drop);
}

function stopCapture() {
  const c = child;
  child = null;
  try { c?.kill(); } catch { /* already gone */ }
}

/** `GET /api/admin/screen/live` — multipart/x-mixed-replace JPEG stream. */
export async function streamScreen(res: ServerResponse): Promise<void> {
  if (process.platform !== "win32" || !fs.existsSync(SRC)) {
    res.writeHead(501, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "screen capture unavailable on this host" }));
    return;
  }
  try {
    await ensureCapture();
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
