#!/usr/bin/env node
// One-shot supervisor self-upgrade (the supervisor can't restart itself —
// something external must). Spawned detached right before a backend restart:
// waits until the supervisor reports a backend pid DIFFERENT from the old one
// (proof the backend respawned on the new dist), then POSTs /api/_super/stop,
// waits for the port to go silent, and immediately spawns a fresh supervisor
// running the latest scripts/supervisor.mjs. Total frontend outage ~seconds;
// the watchdog task is the backstop if this script dies.
// Usage: node scripts/finish-upgrade.mjs <oldBackendPid>
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = Number(process.env.DEVIN_WEB_PUBLIC_PORT) || 7791;
const DATA = process.env.DEVIN_WEB_HOME || path.join(os.homedir(), ".devin-web");
const OLD_PID = Number(process.argv[2]) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (p, method = "GET") => new Promise((res) => {
  const r = http.request({ host: "127.0.0.1", port: PUB, path: p, method, timeout: 3000 }, (x) => {
    let b = ""; x.on("data", (c) => b += c); x.on("end", () => res({ status: x.statusCode, body: b }));
  });
  r.on("timeout", () => { r.destroy(); res(null); });
  r.on("error", () => res(null));
  r.end();
});
const log = (m) => { try { fs.appendFileSync(path.join(DATA, "supervisor.log"), `${new Date().toISOString()} finish-upgrade: ${m}\n`); } catch {} };

const deadline = Date.now() + 5 * 60_000;
while (Date.now() < deadline) {
  const s = await call("/api/_super/status");
  if (s?.status === 200) {
    try {
      const st = JSON.parse(s.body);
      if (st.state === "up" && st.pid && st.pid !== OLD_PID) break; // new backend is serving
    } catch {}
  }
  await sleep(1500);
}
log(`new backend observed (old pid ${OLD_PID}) — stopping old supervisor`);
await call("/api/_super/stop", "POST");
for (let i = 0; i < 40 && (await call("/api/_super/status")) !== null; i++) await sleep(500); // wait silent
try { fs.unlinkSync(path.join(DATA, "supervisor.stopped")); } catch {} // old code may not write it; clear either way
fs.mkdirSync(DATA, { recursive: true });
const fd = fs.openSync(path.join(DATA, "supervisor.log"), "a");
spawn(process.execPath, [path.join(ROOT, "scripts", "supervisor.mjs")],
  { cwd: ROOT, detached: true, windowsHide: true, stdio: ["ignore", fd, fd], env: process.env }).unref();
log("new supervisor spawned — done");
