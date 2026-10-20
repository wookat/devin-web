// Detached respawn helper — spawned by POST /api/admin/redeploy|restart right
// before the server exits. Waits for :port to free, kills orphaned devin acp
// children (they hold session locks), then starts a fresh server detached.
// Every step lands in <dataDir>/respawn.log and the server's own stdout/stderr
// goes to <dataDir>/server.log — a silent respawn chain was impossible to
// diagnose last time it failed.
// Usage: node scripts/respawn.mjs [repoRoot] [port] [dataDir] — all optional;
// dataDir falls back to the same env/home resolution as the Store.
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const [repoArg, portArg, dataDirArg] = process.argv.slice(2);
const repoRoot = repoArg || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(portArg) || 7791;
const dataDir = dataDirArg || process.env.DEVIN_WEB_HOME || process.env.DEVIN_REMOTE_HOME || process.env.DEVIN_CONSOLE_HOME || path.join(os.homedir(), ".devin-web");
const logDir = dataDir || repoRoot;
const log = (m) => {
  try { fs.appendFileSync(path.join(logDir, "respawn.log"), `${new Date().toISOString()} ${m}\n`); } catch { /* nowhere to report */ }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const portFree = () => new Promise((resolve) => {
  const s = net.connect({ port, host: "127.0.0.1" });
  const done = (v) => { s.destroy(); resolve(v); };
  s.once("connect", () => done(false));
  s.once("error", () => done(true));
  s.setTimeout(1000, () => done(true));
});

log(`respawn start pid=${process.pid} repo=${repoRoot} port=${port}`);

// 1. wait for the old listener to release the port (max ~90s)
const deadline = Date.now() + 90_000;
while (Date.now() < deadline && !(await portFree())) await sleep(250);
log(`port ${port} free=${await portFree()}`);

// 2. kill orphaned devin.exe acp children — their parent (the old server) is
// gone and they hold session locks.
await new Promise((r) =>
  execFile("powershell", ["-NoProfile", "-Command",
    "Get-CimInstance Win32_Process -Filter \"name='devin.exe'\" | Where-Object { $_.CommandLine -match 'acp' -and -not (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"],
    { timeout: 20000 }, (e) => { if (e) log(`acp cleanup: ${e.message}`); r(); }));

// 3. start the fresh server detached; stdout/stderr → server.log (rotated past
// 4MB) so a startup crash leaves the reason on disk.
const serverLog = path.join(logDir, "server.log");
try { if (fs.statSync(serverLog).size > 4 * 1024 * 1024) fs.renameSync(serverLog, serverLog + ".old"); } catch {}
const fd = fs.openSync(serverLog, "a");
const child = spawn(process.execPath, [
  path.join(repoRoot, "dist", "server", "index.js"),
  "--host", "0.0.0.0", "--port", String(port),
], { cwd: repoRoot, detached: true, stdio: ["ignore", fd, fd], windowsHide: true });
child.on("error", (e) => log(`server spawn error: ${e.message}`));
child.unref();
log(`server spawned pid=${child.pid}`);
