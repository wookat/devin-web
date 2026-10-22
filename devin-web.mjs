#!/usr/bin/env node
// devin-web — cross-platform service CLI (the single entrypoint, like
// `caddy run|start` / `ollama serve`). Manages the supervisor BIOS process,
// which in turn manages the backend.
//
//   node devin-web.mjs run         foreground supervisor (dev mode, like `caddy run`)
//   node devin-web.mjs start       detached supervisor, waits until healthy
//   node devin-web.mjs stop        stop supervisor + backend
//   node devin-web.mjs restart [--build]   smart restart (see deploy.bat routing)
//   node devin-web.mjs status      supervisor + backend + persistence state
//   node devin-web.mjs install     platform persistence:
//                                    linux  → systemd --user unit (Restart=always, linger)
//                                    darwin → launchd LaunchAgent (KeepAlive)
//                                    win32  → Scheduled Tasks (onlogon + 1-min watchdog)
//   node devin-web.mjs uninstall   remove persistence
//   node devin-web.mjs deploy      build + install + restart (deploy.bat wraps this)
//   node devin-web.mjs logs [file] tail supervisor.log / server.log
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const SUP = path.join(ROOT, "scripts", "supervisor.mjs");
const PUB = Number(process.env.DEVIN_WEB_PUBLIC_PORT) || 7791;
const DATA = process.env.DEVIN_WEB_HOME || path.join(os.homedir(), ".devin-web");
const HOSTS = process.env.DEVIN_WEB_ALLOWED_HOSTS
  || "192.168.6.251:7791,devin.zalize.com,devin-web.zalize.com";

const call = (p, method = "GET", timeout = 4000) => new Promise((resolve) => {
  const req = http.request({ host: "127.0.0.1", port: PUB, path: p, method, timeout }, (res) => {
    let b = "";
    res.on("data", (c) => { b += c; });
    res.on("end", () => resolve({ status: res.statusCode, body: b }));
  });
  req.on("timeout", () => { req.destroy(); resolve(null); });
  req.on("error", () => resolve(null));
  req.end();
});
const probeSupervisor = async () => (await call("/api/_super/status"))?.status === 200;
// /api/health is the real liveness probe; /api/accounts fallback detects a
// bare pre-health build so `restart` can still hand it to the supervisor.
const probeBackend = async () =>
  (await call("/api/health"))?.status === 200 || (await call("/api/accounts"))?.status === 200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opt = {}) => new Promise((res, rej) =>
  execFile(cmd, args, { ...opt }, (e, out, err) => e ? rej(new Error(`${cmd}: ${e.message} ${err}`)) : res(out)));

function spawnSupervisor(stdio) {
  const child = spawn(process.execPath, [SUP], {
    cwd: ROOT, detached: true, windowsHide: true, stdio, env: process.env,
  });
  child.unref();
  return child;
}

async function waitUp(what, fn, timeoutMs = 40_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (await fn()) return true; await sleep(400); }
  console.error(`timed out waiting for ${what} — see ${path.join(DATA, "supervisor.log")}`);
  return false;
}

async function cmdStart() {
  if (await probeSupervisor()) { console.log("supervisor already running on :" + PUB); return; }
  fs.mkdirSync(DATA, { recursive: true });
  const fd = fs.openSync(path.join(DATA, "supervisor.log"), "a");
  const c = spawnSupervisor(["ignore", fd, fd]);
  console.log(`supervisor spawned pid=${c.pid}`);
  if (await waitUp("supervisor", probeSupervisor)) {
    const s = JSON.parse((await call("/api/_super/status")).body);
    console.log(`up — backend pid=${s.pid} state=${s.state} → http://127.0.0.1:${PUB}`);
  }
}

async function cmdStop() {
  if (await probeSupervisor()) {
    await call("/api/_super/stop", "POST");
    console.log("stop sent — supervisor + backend shutting down");
    return;
  }
  console.log("no supervisor on :" + PUB);
}

async function cmdRestart(build) {
  if (build) {
    console.log("build…");
    await new Promise((res, rej) => {
      const b = process.platform === "win32"
        ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm run build"], { cwd: ROOT, stdio: "inherit" })
        : spawn("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
      b.on("exit", (c) => (c === 0 ? res() : rej(new Error("build failed"))));
    });
  }
  if (await probeSupervisor()) {
    await call("/api/_super/restart", "POST");
    console.log("supervisor restarting backend (hard restart — prefer /api/admin/restart for graceful drain)");
  } else if (await probeBackend()) {
    await call("/api/admin/restart", "POST");
    console.log("restart sent — unsupervised backend exits and the supervisor respawns it on :", PUB);
  } else {
    console.log("nothing on :" + PUB + " — cold start");
    await cmdStart();
    return;
  }
  await waitUp("backend", probeBackend) && console.log("backend healthy");
}

async function cmdStatus() {
  const sup = await call("/api/_super/status");
  if (sup?.status === 200) {
    const s = JSON.parse(sup.body);
    console.log(`supervisor: up  pid=${s.supervisorPid}`);
    console.log(`backend:    ${s.state}  pid=${s.pid ?? "-"} port=${s.backendPort} uptime=${s.uptime}s recentExits=${s.recentExits}`);
  } else {
    console.log(`supervisor: DOWN on :${PUB}` + (await probeBackend() ? " (bare backend answering)" : ""));
  }
  // Persistence state per platform
  if (process.platform === "linux") {
    console.log("persist:    " + (fs.existsSync(path.join(os.homedir(), ".config/systemd/user/devin-web.service")) ? "systemd --user unit installed" : "not installed"));
  } else if (process.platform === "darwin") {
    console.log("persist:    " + (fs.existsSync(path.join(os.homedir(), "Library/LaunchAgents/ai.zalize.devin-web.plist")) ? "LaunchAgent installed" : "not installed"));
  } else if (process.platform === "win32") {
    try { execFileSync("schtasks", ["/query", "/tn", "devin-web-supervisor"], { stdio: "pipe" }); console.log("persist:    Scheduled Tasks installed"); }
    catch { console.log("persist:    not installed"); }
  }
}

// ---- persistence install ---------------------------------------------------
async function cmdInstall() {
  if (process.platform === "win32") {
    const q = (s) => `"${s}"`;
    await sh("schtasks", ["/create", "/tn", "devin-web-supervisor", "/sc", "onlogon",
      "/tr", `${q(process.execPath)} ${q(SUP)}`, "/f"]);
    // The watchdog fires every minute — a bare node.exe task flashes a conhost
    // window each tick. Run it through a generated .vbs launcher (window style
    // 0 = fully hidden) so the per-minute probe is invisible.
    fs.mkdirSync(DATA, { recursive: true });
    const vbsPath = path.join(DATA, "watchdog.vbs");
    fs.writeFileSync(vbsPath,
      `CreateObject("Wscript.Shell").Run """${process.execPath}"" ""${path.join(ROOT, "scripts", "watchdog.mjs")}""", 0, False\r\n`);
    const wscript = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe");
    await sh("schtasks", ["/create", "/tn", "devin-web-watchdog", "/sc", "minute", "/mo", "1",
      "/tr", `${q(wscript)} ${q(vbsPath)}`, "/f"]);
    console.log("installed Scheduled Tasks: devin-web-supervisor (onlogon) + devin-web-watchdog (1min)");
    return;
  }
  if (process.platform === "linux") {
    const dir = path.join(os.homedir(), ".config", "systemd", "user");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "devin-web.service"), `[Unit]
Description=devin-web supervisor (local Devin web workbench)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${ROOT}
ExecStart=${process.execPath} ${SUP}
Restart=always
RestartSec=3
Environment=DEVIN_WEB_ALLOWED_HOSTS=${HOSTS}

[Install]
WantedBy=default.target
`);
    await sh("systemctl", ["--user", "daemon-reload"]);
    await sh("systemctl", ["--user", "enable", "--now", "devin-web.service"]);
    try { await sh("loginctl", ["enable-linger", os.userInfo().username]); } catch { console.log("note: enable-linger failed — service starts at login only"); }
    console.log("installed systemd --user unit devin-web.service (Restart=always)");
    return;
  }
  if (process.platform === "darwin") {
    const dir = path.join(os.homedir(), "Library", "LaunchAgents");
    fs.mkdirSync(dir, { recursive: true });
    const plist = path.join(dir, "ai.zalize.devin-web.plist");
    fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ai.zalize.devin-web</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string><string>${SUP}</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>EnvironmentVariables</key><dict><key>DEVIN_WEB_ALLOWED_HOSTS</key><string>${HOSTS}</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${DATA}/supervisor.log</string>
  <key>StandardErrorPath</key><string>${DATA}/supervisor.log</string>
</dict></plist>
`);
    const domain = `gui/${os.userInfo().uid}`;
    try { await sh("launchctl", ["bootout", domain, plist]); } catch {}
    await sh("launchctl", ["bootstrap", domain, plist]);
    console.log("installed LaunchAgent ai.zalize.devin-web (RunAtLoad+KeepAlive)");
    return;
  }
  throw new Error(`unsupported platform ${process.platform}`);
}

async function cmdUninstall() {
  if (process.platform === "win32") {
    for (const t of ["devin-web-watchdog", "devin-web-supervisor"])
      try { await sh("schtasks", ["/delete", "/tn", t, "/f"]); } catch {}
    console.log("Scheduled Tasks removed");
    return;
  }
  if (process.platform === "linux") {
    try { await sh("systemctl", ["--user", "disable", "--now", "devin-web.service"]); } catch {}
    try { fs.unlinkSync(path.join(os.homedir(), ".config/systemd/user/devin-web.service")); } catch {}
    await sh("systemctl", ["--user", "daemon-reload"]).catch(() => {});
    console.log("systemd unit removed");
    return;
  }
  if (process.platform === "darwin") {
    const plist = path.join(os.homedir(), "Library/LaunchAgents/ai.zalize.devin-web.plist");
    try { await sh("launchctl", ["bootout", `gui/${os.userInfo().uid}`, plist]); } catch {}
    try { fs.unlinkSync(plist); } catch {}
    console.log("LaunchAgent removed");
    return;
  }
}

function cmdLogs(file) {
  const name = ["supervisor", "server", "broker"].includes(file) ? file : "supervisor";
  const f = path.join(DATA, `${name}.log`);
  if (!fs.existsSync(f)) { console.log(`${f} missing`); return; }
  const buf = fs.readFileSync(f);
  console.log(buf.subarray(Math.max(0, buf.length - 32 * 1024)).toString("utf8"));
}

// ---- dispatch ---------------------------------------------------------------
const [cmd, ...rest] = process.argv.slice(2);
try {
  switch (cmd) {
    case "run": { // foreground — dev mode
      const c = spawn(process.execPath, [SUP], { cwd: ROOT, stdio: "inherit", env: process.env });
      c.on("exit", (code) => process.exit(code ?? 0));
      break;
    }
    case "start": await cmdStart(); break;
    case "stop": await cmdStop(); break;
    case "restart": await cmdRestart(rest.includes("--build")); break;
    case "status": await cmdStatus(); break;
    case "install": await cmdInstall(); break;
    case "uninstall": await cmdUninstall(); break;
    case "deploy": await cmdInstall(); await cmdRestart(true); break;
    case "logs": cmdLogs(rest[0]); break;
    default:
      console.log(`usage: node devin-web.mjs <run|start|stop|restart [--build]|status|install|uninstall|deploy|logs [supervisor|server|broker]>`);
      process.exitCode = cmd ? 1 : 0;
  }
} catch (e) {
  console.error(`${cmd || "devin-web"} failed: ${e.message}`);
  process.exitCode = 1;
}
