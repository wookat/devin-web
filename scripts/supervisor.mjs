// devin-web supervisor — the "BIOS" layer. A tiny always-on process that owns
// the public port, serves the static frontend itself, and reverse-proxies
// /api/* + /ws* upgrades to the backend child (dist/server/index.js) on an
// internal port. The backend can die, wedge, drain-restart — the page and the
// supervisor stay up; the health probe brings the backend back automatically.
//
//   cloudflared → :7791 supervisor → :7792 backend (127.0.0.1 only)
//
// Failure handling: child exit or 3 consecutive /api/health failures → restart
// (orphan acp cleanup in between). >5 restarts in 5min → 60s backoff. The
// backend runs with DEVIN_WEB_SUPERVISED=1 — its own drain-restart becomes a
// plain process.exit, we respawn it (immediate-exit model — no drain chain).
// Install/boot persistence lives in devin-web.mjs `install` (platform-native).
// Logs: <dataDir>/supervisor.log; backend stdout → <dataDir>/server.log.
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import process from "node:process";
import { dataDir as resolveDataDir, pubPort, backPort, adminKey, allowedHostsRaw, foreignDevinScanMs, foreignDevinMaxMb, commitEmergencyMb } from "./env.mjs";
import { psRun } from "./pshelper.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB_PORT = pubPort();
const BACK_HOST = "127.0.0.1";
const BACK_PORT = backPort();
const dataDir = resolveDataDir();
const webDir = path.join(repoRoot, "dist", "web");
try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}

const STOPPED = path.join(dataDir, "supervisor.stopped");
const logFile = path.join(dataDir, "supervisor.log");
try { // supervisor.log rotation — same 4MB rule as server.log
  if (fs.statSync(logFile).size > 4 * 1024 * 1024) fs.renameSync(logFile, logFile + ".old");
} catch {}
// A fresh start always clears an intentional-stop marker (watchdog honors it).
try { fs.unlinkSync(STOPPED); } catch {}
// Pidfile — the watchdog reads this to force-kill a wedged supervisor that
// still holds :7791 (probe fails but the process is alive → EADDRINUSE loop).
try { fs.writeFileSync(path.join(dataDir, "supervisor.pid"), String(process.pid)); } catch {}

const log = (m) => {
  const line = `${new Date().toISOString()} ${m}\n`;
  if (process.stdout.isTTY) { // interactive (`run`): console only — detached
    try { process.stdout.write(line); } catch {}   // launches already capture
    return;                                        // stdout into this file
  }
  try { fs.appendFileSync(logFile, line); } catch {}
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- acp broker child -------------------------------------------------------
// Long-lived owner of every agent (devin acp) child process. The backend
// attaches over a local socket instead of spawning directly, so backend
// restarts leave agents and in-flight turns untouched — the next backend
// re-adopts them. A dead broker orphans its acp children (dead pipes) — its
// own journal sweep kills them on the next boot; backend-side resumes cover
// the gap like any crash.
let broker = null;
const BROKER_SOCK = process.platform === "win32"
  ? `\\\\.\\pipe\\devin-web-acp-${crypto.createHash("sha1").update(dataDir).digest("hex").slice(0, 10)}`
  : path.join(dataDir, "acp-broker.sock");

function brokerLogFd() {
  const f = path.join(dataDir, "broker.log");
  try { if (fs.statSync(f).size > 4 * 1024 * 1024) fs.renameSync(f, f + ".old"); } catch {}
  return fs.openSync(f, "a");
}

function spawnBroker() {
  if (broker) return;
  const fd = brokerLogFd();
  broker = spawn(process.execPath, [path.join(repoRoot, "scripts", "acp-broker.mjs")], {
    cwd: repoRoot, detached: process.platform !== "win32", windowsHide: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env, DEVIN_WEB_DATA_DIR: dataDir, DEVIN_WEB_ACP_BROKER: BROKER_SOCK },
  });
  const b = broker;
  b.on("error", (e) => log(`broker spawn error: ${e.message}`));
  b.on("exit", (code) => {
    log(`broker exit pid=${b.pid} code=${code} — respawning (its acp orphans get swept at its boot)`);
    if (broker === b) broker = null;
    setTimeout(spawnBroker, 1500);
  });
  fs.closeSync(fd);
  log(`broker spawned pid=${broker.pid} sock=${BROKER_SOCK}`);
}

function killBroker() {
  const b = broker;
  if (!b) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(b.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
  } else {
    try { process.kill(-b.pid, "SIGKILL"); } catch { try { b.kill("SIGKILL"); } catch {} }
  }
  broker = null;
}

// ---- backend child ---------------------------------------------------------
let child = null;
let state = "starting"; // starting | up | down | restarting
let bootedAt = 0;
const exits = []; // recent exit timestamps, for crash-loop backoff
let intentionalExit = false; // backend exits after drain are expected — respawn fast

function serverLogFd() {
  const f = path.join(dataDir, "server.log");
  try { if (fs.statSync(f).size > 4 * 1024 * 1024) fs.renameSync(f, f + ".old"); } catch {}
  return fs.openSync(f, "a");
}

// Spawn-time rotation only covers restarts — a backend/broker up for months
// otherwise grows its log unboundedly. Re-check every 60s.
setInterval(() => {
  for (const f of ["server.log", "broker.log", "supervisor.log"]) {
    try {
      const full = path.join(dataDir, f);
      if (fs.statSync(full).size > 4 * 1024 * 1024) fs.renameSync(full, full + ".old");
    } catch { /* missing/racing */ }
  }
}, 60_000).unref();

// ---- foreign devin.exe sweep ------------------------------------------------
// The broker's memScan only covers ITS OWN acp children — but devin.exe can
// be spawned elsewhere (a CLI session in a terminal parents `devin.exe acp`
// children to itself; editor integrations do the same). Those leak identically
// and are invisible to the broker: three foreign acps reached 17–26GB commit
// apiece and exhausted the system commit limit (EventID 2004 → desktop session
// killed) on 2026-10-24, on a FIXED binary — the upstream leak fix is
// incomplete, so this sweep is the last line of defense for the whole box.
//   any devin.exe > DEVIN_WEB_FOREIGN_DEVIN_MAX_MB (default = busy cap, 16GB)
//     → kill — a healthy agent is <0.5GB; 16GB is the leak signature, owner
//       irrelevant (a broker child past busyCap gets the same verdict there)
//   system free commit < DEVIN_WEB_COMMIT_EMERGENCY_MB (3072MB)
//     → kill the fattest devin.exe over 2GB — minutes before unrelated apps
//       start failing VirtualAlloc
{
  const scanMs = foreignDevinScanMs();
  const maxMb = foreignDevinMaxMb();
  const emergencyMb = commitEmergencyMb();
  const killPid = (pid, why) => {
    log(`foreign-sweep: killing devin pid=${pid} (${why})`);
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    } else { try { process.kill(pid, "SIGKILL"); } catch {} }
  };
  let sweeping = false;
  const sweep = () => {
    if (sweeping) return; // never stack overlapping scans
    if (process.platform === "win32") {
      sweeping = true;
      psRun(
        "$cs=@((Get-Counter '\\Memory\\Committed Bytes','\\Memory\\Commit Limit' -ErrorAction SilentlyContinue).CounterSamples);" +
        "$cb=($cs|Where-Object{$_.Path -match 'ommitted Bytes'}|Select-Object -First 1).CookedValue;" +
        "$cl=($cs|Where-Object{$_.Path -match 'ommit Limit'}|Select-Object -First 1).CookedValue;" +
        "$ps=@(Get-Process devin -ErrorAction SilentlyContinue | Select-Object Id,PagedMemorySize64);" +
        "Write-Output (@{free=$(if($cl){[math]::Round(($cl-$cb)/1MB)}else{$null});procs=$ps}|ConvertTo-Json -Compress -Depth 3)",
        20000).then((out) => {
          let j; try { j = JSON.parse(String(out).trim().split("\n").pop()); } catch { return; }
          const rows = [].concat(j.procs ?? []).map((p) => ({ pid: p.Id, mb: Math.round((p.PagedMemorySize64 ?? 0) / 1048576) }));
          for (const p of rows) if (p.mb > maxMb) killPid(p.pid, `commit ${p.mb}MB > ${maxMb}MB cap`);
          if (j.free != null && j.free < emergencyMb) {
            const big = rows.filter((p) => p.mb > 2048).sort((a, b) => b.mb - a.mb)[0];
            if (big) killPid(big.pid, `system emergency: free commit ${j.free}MB < ${emergencyMb}MB, fattest devin ${big.mb}MB`);
          }
        }).catch((e) => log(`foreign-sweep probe: ${e.message}`)).finally(() => { sweeping = false; });
      return;
    }
    // POSIX: /proc — VmSize for commit-ish, Committed_AS vs CommitLimit for the
    // system view. `devin` process name match keeps non-agent devin binaries
    // eligible too — same leak signature, same verdict.
    try {
      const mi = fs.readFileSync("/proc/meminfo", "utf8");
      const ca = Number(mi.match(/Committed_AS:\s+(\d+)/)?.[1]);
      const cl = Number(mi.match(/CommitLimit:\s+(\d+)/)?.[1]);
      execFile("ps", ["-eo", "pid=,comm=,vsz="], { timeout: 15000 }, (e, out) => {
        if (e) return;
        const rows = String(out).split("\n").map((l) => l.trim().match(/^(\d+)\s+(\S+)\s+(\d+)$/))
          .filter((m) => m && /devin/i.test(m[2])).map((m) => ({ pid: Number(m[1]), mb: Math.round(Number(m[3]) / 1024) }));
        for (const p of rows) if (p.mb > maxMb) killPid(p.pid, `vsize ${p.mb}MB > ${maxMb}MB cap`);
        if (ca && cl && (cl - ca) / 1024 < emergencyMb) {
          const big = rows.filter((p) => p.mb > 2048).sort((a, b) => b.mb - a.mb)[0];
          if (big) killPid(big.pid, `system emergency: free commit ${Math.round((cl - ca) / 1024)}MB, fattest devin ${big.mb}MB`);
        }
      });
    } catch { /* no /proc */ }
  };
  if (scanMs > 0) { setInterval(sweep, scanMs).unref(); log(`foreign-devin sweep armed: scan=${scanMs}ms cap=${maxMb}MB emergencyFree=${emergencyMb}MB`); }
}

function killOrphanAcps() {
  // Windows: acp children orphaned by a dead backend get reparented nowhere —
  // find devin.exe 'acp' processes whose parent no longer exists and kill them.
  if (process.platform === "win32") {
    return psRun(
      "Get-CimInstance Win32_Process -Filter \"name='devin.exe'\" | Where-Object { $_.CommandLine -match 'acp' -and -not (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
      20000).catch((e) => log(`acp cleanup: ${e.message}`)).then(() => {});
  }
  // POSIX: orphans reparent to init (ppid 1) — ps scan for devin acp with
  // ppid==1. The backend's own tree is killed via its process group instead.
  return new Promise((r) =>
    execFile("ps", ["-eo", "pid=,ppid=,args="], { timeout: 15000 }, (e, out) => {
      if (e) { log(`ps scan: ${e.message}`); return r(); }
      for (const line of String(out).split("\n")) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (m && m[2] === "1" && /devin/i.test(m[3]) && /\bacp\b/.test(m[3])) {
          try { process.kill(Number(m[1]), "SIGKILL"); log(`killed orphan acp pid=${m[1]}`); } catch {}
        }
      }
      r();
    }));
}

function spawnBackend() {
  const fd = serverLogFd();
  state = "starting";
  bootedAt = Date.now();
  intentionalExit = false;
  child = spawn(process.execPath,
    [path.join(repoRoot, "dist", "server", "index.js"), "--host", BACK_HOST, "--port", String(BACK_PORT)],
    {
      // POSIX: detached → own process group, so kill(-pid) takes the WHOLE
      // backend tree (acp children included) — no orphan scan needed for it.
      cwd: repoRoot, detached: process.platform !== "win32", windowsHide: true,
      stdio: ["ignore", fd, fd],
      env: {
        ...process.env,
        DEVIN_WEB_SUPERVISED: "1",
        DEVIN_WEB_ACP_BROKER: BROKER_SOCK,
        // Explicit dataDir so the backend finds broker.token in the same
        // place the broker wrote it (never rely on homedir resolution).
        DEVIN_WEB_DATA_DIR: dataDir,
        // Task-Scheduler/boot launches have no shell env — default the known
        // public hosts so the tunnel isn't 403'd after a cold boot. deploy.bat
        // can still override by exporting its own value first.
        DEVIN_WEB_ALLOWED_HOSTS: allowedHostsRaw()
          || "192.168.6.251:7791,devin.zalize.com,devin-web.zalize.com",
      },
    });
  const c = child;
  c.on("error", (e) => log(`backend spawn error: ${e.message}`));
  c.on("exit", (code, sig) => {
    log(`backend exit pid=${c.pid} code=${code} sig=${sig}${intentionalExit ? " (drain restart)" : ""}`);
    // Only the TRACKED child may clear state — an untracked loser of a spawn
    // race must not null `child` out from under the live tracked backend.
    if (child === c) { child = null; state = "down"; }
    // code 0 = the backend's own graceful restart path (markGracefulExit +
    // process.exit(0)) — intentional, not a crash: fast respawn and don't
    // feed the crash-loop backoff counter.
    if (code === 0) intentionalExit = true;
    else exits.push(Date.now());
    void respawnSoon();
  });
  log(`backend spawned pid=${child.pid} port=${BACK_PORT}`);
}

function portHeld() {
  return new Promise((resolve) => {
    const s = net.connect(BACK_PORT, BACK_HOST);
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.setTimeout(1200, () => done(false));
  });
}

async function clearPortSquatter() {
  // BACK_PORT is exclusively our backend's. A listener while `child` is null
  // is an untracked leftover (the winner of a past spawn race) — every new
  // spawn would die EADDRINUSE and crash-loop. Verify the owner's cmdline is
  // really our dist/server/index.js before killing.
  if (!(await portHeld())) return;
  if (process.platform === "win32") {
    await psRun(
      `Get-NetTCPConnection -LocalPort ${BACK_PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$_" -ErrorAction SilentlyContinue; if ($p -and $p.CommandLine -match 'dist[\\\\/]server[\\\\/]index\\.js') { Stop-Process -Id $_ -Force; "killed $_" } }`,
      15000).then((out) => log(`port squatter: ${String(out ?? "").trim() || "none"}`))
      .catch((e) => log(`port squatter: ${e.message}`));
  } else {
    await new Promise((r) => execFile("sh", ["-c",
      `for pid in $(lsof -ti tcp:${BACK_PORT} -sTCP:LISTEN 2>/dev/null); do ps -p "$pid" -o command= 2>/dev/null | grep -q "dist/server/index.js" && kill -9 "$pid" && echo "killed $pid"; done; true`],
      { timeout: 15000 }, (e, out) => { const t = String(out ?? "").trim(); if (t) log(`port squatter: ${t}`); r(); }));
  }
  await sleep(400);
}

let spawning = false;
async function respawnSoon(fast = false) {
  // Serialize: two callers (exit handler + restart endpoint + boot) must not
  // BOTH pass the `!child` check across the async waits below — that double-
  // spawns, the loser dies EADDRINUSE, and its exit handler used to null
  // `child` out from under the winner (the crash loop this guards against).
  if (spawning || child) return;
  spawning = true;
  try {
    const cutoff = Date.now() - 5 * 60_000;
    while (exits.length && exits[0] < cutoff) exits.shift();
    const delay = fast || intentionalExit ? 250 : exits.length > 5 ? 60_000 : 1500;
    intentionalExit = false;
    await sleep(delay);
    if (child) return; // someone else already restarted it
    await killOrphanAcps();
    await clearPortSquatter();
    if (child) return;
    try { spawnBackend(); } catch (e) { log(`respawn failed: ${e}`); state = "down"; }
  } finally { spawning = false; }
}

async function killBackend() {
  const c = child;
  if (!c) return;
  state = "restarting";
  await new Promise((r) => {
    const t = setTimeout(r, 5000);
    c.once("exit", () => { clearTimeout(t); r(); });
    try { c.kill(); } catch { r(); }
  });
  if (child === c) { // still alive → hard kill the whole tree
    if (process.platform === "win32") {
      await new Promise((r) => execFile("taskkill", ["/pid", String(c.pid), "/t", "/f"], { timeout: 10000 }, () => r()));
    } else {
      try { process.kill(-c.pid, "SIGKILL"); } catch { try { c.kill("SIGKILL"); } catch {} }
    }
  }
}

// Health probe: HTTP liveness, not just "process exists" — a wedged event loop
// keeps the process alive but answers nothing.
let healthFails = 0;
function probe() {
  return new Promise((resolve) => {
    const req = http.get({ host: BACK_HOST, port: BACK_PORT, path: "/api/health", timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
  });
}
setInterval(async () => {
  if (!child) return; // respawn path owns state
  const ok = await probe();
  if (ok) { if (state !== "up") log(`backend healthy pid=${child.pid}`); state = "up"; healthFails = 0; return; }
  // Boot grace: module init (sqlite/migration) + listen can exceed the
  // 3-fail window on a cold box — don't count failures until 60s in.
  if (state === "starting" && Date.now() - bootedAt < 60_000) return;
  healthFails++;
  if (healthFails >= 3) {
    log(`backend unresponsive (${healthFails} probes) — restarting pid=${child.pid}`);
    healthFails = 0;
    await killBackend();
    if (!child) void respawnSoon(); // exit handler also fires; guard is inside
  }
}, 4000);

// ---- public HTTP: /api/* proxied, everything else static -------------------
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
  ".map": "application/json", ".webmanifest": "application/manifest+json",
  ".txt": "text/plain", ".webp": "image/webp",
};

function serveStatic(req, res, url) {
  if (!fs.existsSync(path.join(webDir, "index.html"))) {
    res.writeHead(200, { "content-type": "text/html" }).end("<h1>devin-web</h1><p>Web UI not built. Run <code>npm run build</code>.</p>");
    return;
  }
  let file = path.join(webDir, path.normalize(decodeURIComponent(url.pathname)));
  const rel = path.relative(webDir, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) { res.writeHead(403).end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(webDir, "index.html");
  const mime = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  // Cache split: /assets/* are content-hashed (immutable forever is safe);
  // everything else — index.html and the SPA fallback most of all — must
  // revalidate every load. Without this a heuristic-cached index.html keeps
  // pointing at deleted chunk hashes after a rebuild → blank page forever.
  // inAssets keys off the SERVED path (post-fallback): a missing asset URL
  // serves index.html and must NOT be marked immutable under that URL.
  const servedRel = path.relative(webDir, file);
  const inAssets = servedRel.split(/[\\/]/)[0] === "assets";
  const cache = inAssets ? "public, max-age=31536000, immutable" : "no-cache";
  const send = (p, headers) => {
    const stream = fs.createReadStream(p);
    stream.on("error", () => { if (!res.headersSent) res.writeHead(500).end(); else res.destroy(); });
    stream.once("open", () => { res.writeHead(200, { "cache-control": cache, ...headers }); stream.pipe(res); });
  };
  const accept = String(req.headers["accept-encoding"] ?? "");
  for (const [enc, suffix] of [["br", ".br"], ["gzip", ".gz"]]) {
    if (accept.includes(enc) && fs.existsSync(file + suffix)) { send(file + suffix, { "content-type": mime, "content-encoding": enc }); return; }
  }
  send(file, { "content-type": mime });
}

function badGateway(res) {
  // JSON marker the frontend can distinguish from a hard connection-refused:
  // backend down but supervisor alive → "restarting" state, not "site dead".
  // headersSent guard: when the upstream socket errors AFTER its response
  // head was already piped (backend dies mid-body), a second writeHead
  // throws ERR_HTTP_HEADERS_SENT — the stream is unsalvageable anyway.
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(502, { "content-type": "application/json" }).end(
    JSON.stringify({ error: "backend_unavailable", supervisor: state, restarting: true }));
}

function proxy(req, res) {
  if (!child || state === "down" || state === "restarting") { badGateway(res); return; }
  const up = http.request({
    host: BACK_HOST, port: BACK_PORT, path: req.url, method: req.method,
    headers: { ...req.headers, "x-forwarded-for": req.socket.remoteAddress },
    timeout: 0,
  }, (ures) => {
    res.writeHead(ures.statusCode ?? 502, ures.headers);
    ures.pipe(res);
    ures.on("error", () => res.destroy());
  });
  up.on("error", () => badGateway(res));
  req.pipe(up);
  req.on("error", () => up.destroy());
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname.startsWith("/api/_super/")) {
      // Supervisor controls are process-level powers (stop/restart/log-read)
      // on a publicly-proxied port — they need BOTH gates the backend has:
      // (a) Origin/Host match so a foreign web page can't drive the process
      //     via DNS rebinding (non-browser clients send no Origin → pass);
      // (b) the admin key when DEVIN_WEB_ADMIN_KEY is set — the key only
      //     guarded /api/admin/* before, leaving /_super wide open.
      const origin = req.headers.origin;
      if (origin) {
        let oh = "";
        try { oh = new URL(origin).host; } catch {}
        if (oh !== (req.headers.host ?? "")) { res.writeHead(403).end('{"error":"origin_mismatch"}'); return; }
      }
      const k = adminKey() || null;
      if (k && req.headers["x-admin-key"] !== k) { res.writeHead(401).end('{"error":"unauthorized"}'); return; }
    }
    if (url.pathname === "/api/_super/status") {
      let version = "?";
      try { version = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version ?? "?"; } catch {}
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        ok: true, state, pid: child?.pid ?? null, backendPort: BACK_PORT,
        uptime: child ? Math.round((Date.now() - bootedAt) / 1000) : 0,
        recentExits: exits.length, supervisorPid: process.pid,
        publicPort: PUB_PORT, version, node: process.version,
        platform: `${process.platform}/${process.arch}`,
        repoRoot, dataDir,
      }));
      return;
    }
    if (url.pathname === "/api/_super/log" && req.method === "GET") {
      // Whitelisted log tails — readable even while the backend is dead.
      const name = url.searchParams.get("file") ?? "supervisor";
      const allowed = { supervisor: "supervisor.log", server: "server.log" };
      const file = allowed[name];
      if (!file) { res.writeHead(400).end("{}"); return; }
      const lines = Math.min(Number(url.searchParams.get("tail")) || 300, 2000);
      let text = "";
      try {
        const buf = fs.readFileSync(path.join(dataDir, file));
        text = buf.subarray(Math.max(0, buf.length - 512 * 1024)).toString("utf8").split("\n").slice(-lines).join("\n");
      } catch { text = `(${file} missing)`; }
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(text);
      return;
    }
    if (url.pathname === "/api/_super/restart" && req.method === "POST") {
      res.writeHead(202, { "content-type": "application/json" }).end('{"ok":true}');
      log(`manual restart requested (${req.headers["x-forwarded-for"] ?? req.socket.remoteAddress})`);
      exits.length = 0; // a manual restart should not sit in crash-loop backoff
      void killBackend().then(() => void respawnSoon(true));
      return;
    }
    if (url.pathname === "/api/_super/stop" && req.method === "POST") {
      res.writeHead(202, { "content-type": "application/json" }).end('{"ok":true}');
      log("stop requested — shutting down backend, broker, then supervisor");
      // Marker file: the scheduled watchdog respects an INTENTIONAL stop and
      // won't revive us. Cleared on next start (above).
      try { fs.writeFileSync(STOPPED, String(Date.now())); } catch {}
      void killBackend().finally(() => { killBroker(); process.exit(0); });
      return;
    }
    if (url.pathname.startsWith("/api/")) proxy(req, res);
    else serveStatic(req, res, url);
  } catch {
    if (!res.headersSent) res.writeHead(400).end("bad request"); else res.destroy();
  }
});
server.requestTimeout = 0; // long polls (timeline streams, MJPEG) must not be cut
server.headersTimeout = 60_000;

// WS upgrades: raw TCP splice to the backend — preserves every ws subprotocol
// and the backend's own upgrade routing (/ws, /ws/term, /ws/browser).
server.on("upgrade", (req, socket, head) => {
  if (!child) { socket.destroy(); return; }
  const up = net.connect(BACK_PORT, BACK_HOST, () => {
    up.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
    for (const [k, v] of Object.entries(req.headers)) up.write(`${k}: ${Array.isArray(v) ? v.join(", ") : v}\r\n`);
    up.write("\r\n");
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

server.listen(PUB_PORT, "0.0.0.0", () => {
  const lan = [];
  try {
    for (const addrs of Object.values(os.networkInterfaces()))
      for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) lan.push(`http://${a.address}:${PUB_PORT}`);
  } catch {}
  const version = (() => { try { return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version; } catch { return "?"; } })();
  for (const line of [
    `devin-web v${version} — supervisor up`,
    `  public    http://127.0.0.1:${PUB_PORT}${lan.length ? "   lan " + lan.join("  ") : ""}`,
    `  backend   127.0.0.1:${BACK_PORT} (spawn pending)   broker ${BROKER_SOCK}`,
    `  data dir  ${dataDir}`,
    `  admin     ${adminKey() ? "protected (x-admin-key)" : "open — DEVIN_WEB_ADMIN_KEY unset"}`,
    `  pid ${process.pid} — probing /api/health every 4s; logs ${path.join(dataDir, "supervisor.log")} · server.log · broker.log`,
  ]) log(line);
  spawnBroker();          // acp owner must exist before the backend needs it
  void respawnSoon(true); // unified path — clears port squatters before spawn
});
server.on("error", (e) => { log(`listen failed :${PUB_PORT}: ${e.message}`); process.exit(1); });

process.on("uncaughtException", (e) => log(`supervisor uncaught: ${e.stack || e}`));
process.on("unhandledRejection", (e) => log(`supervisor unhandledRejection: ${e}`));
process.on("SIGTERM", () => { killBackend().finally(() => { killBroker(); process.exit(0); }); });
process.on("SIGINT", () => { killBackend().finally(() => { killBroker(); process.exit(0); }); });

