#!/usr/bin/env node
// devin-web watchdog — scheduled probe (Task Scheduler on win32; a 1-min cron
// or systemd timer works the same elsewhere). Exits instantly when the
// supervisor answers /api/_super/status; otherwise spawns a fresh detached
// supervisor. Pure node — no shell quoting, no batch-file fragility.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = Number(process.env.DEVIN_WEB_PUBLIC_PORT) || 7791;
const DATA = process.env.DEVIN_WEB_HOME || path.join(os.homedir(), ".devin-web");

// An intentional `devin-web.mjs stop` leaves this marker — respect it; the
// watchdog must NOT resurrect a service the operator asked to keep down.
if (fs.existsSync(path.join(DATA, "supervisor.stopped"))) process.exit(0);

const req = http.get({ host: "127.0.0.1", port: PUB, path: "/api/_super/status", timeout: 3000 }, (res) => {
  res.resume();
  process.exit(res.statusCode === 200 ? 0 : 1);
});
// A wedged supervisor keeps holding :7791 — a naive respawn then dies on
// EADDRINUSE forever. Read the pidfile and kill the corpse first.
const killStale = () => {
  try {
    const pid = Number(fs.readFileSync(path.join(DATA, "supervisor.pid"), "utf8").trim());
    if (!pid) return;
    try { process.kill(pid, 0); } catch { return; } // already gone — nothing to kill
    const fd = fs.openSync(path.join(DATA, "supervisor.log"), "a");
    fs.writeSync(fd, `${new Date().toISOString()} watchdog: killing wedged supervisor pid=${pid}\n`);
    fs.closeSync(fd);
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    else process.kill(pid, "SIGKILL");
  } catch {}
};
const revive = () => {
  try {
    killStale();
    fs.mkdirSync(DATA, { recursive: true });
    const fd = fs.openSync(path.join(DATA, "supervisor.log"), "a");
    fs.writeSync(fd, `${new Date().toISOString()} watchdog: supervisor silent — respawning\n`);
    spawn(process.execPath, [path.join(ROOT, "scripts", "supervisor.mjs")], {
      cwd: ROOT, detached: true, windowsHide: true, stdio: ["ignore", fd, fd], env: process.env,
    }).unref();
  } catch {}
  process.exit(0);
};
req.on("timeout", () => req.destroy());
req.on("error", revive);
req.on("close", () => {});
setTimeout(revive, 5000).unref();
