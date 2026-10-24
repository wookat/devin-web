import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import child_process, { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeHeapSnapshot } from "node:v8";
import { AcpManager } from "./manager.js";
import { AccountPool, isRateLimitError, retryAfterSeconds } from "./accounts.js";
import { agentsCheck, devinCheck, setAgentsDir } from "./agents.js";
import { Store } from "./store.js";
import { WsHub } from "./ws.js";
import { WebSocketServer } from "ws";
import { SessionLog } from "./sessionlog.js";
import { handleApi, type ApiContext } from "./routes.js";
import { handleLocalWb } from "./lweb/index.js";
import { recordTerminal } from "./sessionview.js";
import { autoResumeInterrupted, setCfgCacheDir } from "./sessionload.js";
import { adoptBrokerAcps, resolveTurnByReq } from "./sessionadopt.js";
import { notePromptReq } from "./sessionturns.js";
import { watchSubRateLimit } from "./sessionsub.js";
import { loadInflight, sessionHost } from "./sessionplace.js";
import { touchSessionActivity, markGracefulExit } from "./sessionlive.js";
import { brokerEnabled } from "./acpbroker.js";
import { meta } from "./dwstore.js";
import { sshInteractive } from "./ssh.js";
import { edition } from "./edition.js";
import { adminKeyRequired } from "./authn.js";
import { adminKey, allowedHostsRaw } from "./env.js";
import { serveStatic } from "./static.js";
import { startAutomations } from "./automations.js";
import { resumeScans } from "./security.js";
import { noteUpdate } from "./dwtimeline.js";
import { initLocalBrowser, attachBrowserWs } from "./localbrowser.js";
import { initScreen } from "./screen.js";
import type { WsServerEvent } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A stray async rejection must not kill the process — Node ≥15 exits on
// unhandledRejection by default, and a long-lived server has fire-and-forget
// paths (auto-resume, broker calls) whose failures are per-request, not
// fatal. Log loudly; the supervisor still restarts us on a REAL exit.
process.on("unhandledRejection", (e) => {
  console.error("[unhandledRejection]", e instanceof Error ? e.stack ?? e.message : e);
});

// ---- args ----------------------------------------------------------------
const args = process.argv.slice(2);
function argValue(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
const PORT = Number(argValue("--port") ?? process.env.PORT ?? 7781);
const HOST = argValue("--host") ?? "127.0.0.1";
const wantOpen = args.includes("--open") || (!args.includes("--no-open") && !!process.stdout.isTTY && !process.env.SSH_CONNECTION);
const wantVersion = args.includes("--version") || args.includes("-v");
const wantHelp = args.includes("--help") || args.includes("-h");

const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"),
) as { version: string };

if (wantVersion) {
  console.log(`devin-web ${pkg.version}`);
  process.exit(0);
}
if (wantHelp) {
  console.log(`devin-web — a browser console for the Devin CLI (ACP)

Usage: devin-web [options]

Options:
  --port <port>   Port to bind (default 7781, env PORT)
  --host <host>   Host to bind (default 127.0.0.1)
  --open          Open the browser once listening
  --no-open       Do not open the browser
  --version       Print version
  --help          Show this help

Requires: devin CLI on PATH and a completed 'devin auth login'.
Data:   ~/.devin-web (override with DEVIN_WEB_HOME)
Env:    DEVIN_WEB_ALLOWED_HOSTS — comma-separated extra hostnames allowed
        by the CSRF/DNS-rebinding guard (reverse proxies, tailscale serve, …)`);
  process.exit(0);
}

// ---- CSRF / DNS-rebinding guard --------------------------------------------
// Without this, any web page could fire fetch()/WebSocket at 127.0.0.1:7781
// and drive Devin (send prompts, blind-approve permission requests).
// Host check (rebinding): allowlisted names or IP literals only. Origin check
// (CSRF): must match the request Host — including the port when both sides
// state one, so an app on another port of the same machine can't drive this
// one — or be explicitly allowlisted via DEVIN_WEB_ALLOWED_HOSTS (for
// Host-rewriting reverse proxies and tunnels).

/** Lowercased {hostname, explicit port} of a bare host, host:port, or origin — null if unparseable. */
function hostParts(value: string | undefined): { host: string; port: string } | null {
  if (!value) return null;
  let v = value.trim().toLowerCase();
  if (!v) return null;
  const hadScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(v);
  if (!hadScheme) v = `http://${v}`;
  try {
    const u = new URL(v);
    // For real origins resolve the scheme's default port; a bare Host header
    // keeps "" (its scheme is unknowable behind a TLS-terminating proxy).
    const port = u.port || (hadScheme ? (u.protocol === "https:" ? "443" : "80") : "");
    return { host: u.hostname.replace(/^\[|\]$/g, ""), port };
  } catch {
    return null;
  }
}

const allowedHostnames = new Set(["localhost", "127.0.0.1", "::1", os.hostname().toLowerCase()]);
{
  const bound = hostParts(HOST);
  if (bound && bound.host !== "0.0.0.0" && bound.host !== "::") allowedHostnames.add(bound.host);
}
/** User-declared proxy/tunnel names: valid as Host and as a non-matching Origin. */
const extraAllowedHostnames = new Set<string>();
for (const extra of allowedHostsRaw().split(",")) {
  const p = hostParts(extra);
  if (p) {
    allowedHostnames.add(p.host);
    extraAllowedHostnames.add(p.host);
  }
}

function isAllowedRequest(req: http.IncomingMessage): boolean {
  const host = hostParts(req.headers.host);
  if (!host) return false;
  // IP-literal Hosts can't be a DNS-rebinding vector (the attack needs the
  // attacker's DNS name in Host); other names must be explicitly allowed.
  if (!allowedHostnames.has(host.host) && net.isIP(host.host) === 0) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true; // same-origin fetch / non-browser client
  const o = hostParts(String(origin));
  if (!o) return false; // includes "Origin: null"
  if (extraAllowedHostnames.has(o.host)) return true;
  if (o.host !== host.host) return false;
  // Portless Host (behind a proxy) accepts the default-port origin forms;
  // an explicit Host port must match the origin's exactly.
  if (host.port === "") return o.port === "80" || o.port === "443";
  return o.port === host.port;
}


// ---- wiring ----------------------------------------------------------------
const store = new Store();
setAgentsDir(store.dataDir);
const sessionLog = new SessionLog(path.join(store.dataDir, "log"));
const sessionCwd = new Map<string, string>();
const sessionSsh = new Map<string, string>();
const permissionOwner = new Map<string, import("./acp.js").DevinAcp>();
const primaryCwd = process.cwd();
const accounts = new AccountPool(store.dataDir);

const httpServer = http.createServer();
// Node's 5s default closes pooled sockets the browser still considers alive —
// a 3s poll interval then occasionally lands on a dead socket → ECONNRESET →
// "Failed to fetch" → false "Connection lost" banners. 75s (> browser idle
// ~60s) means the client always closes first. headersTimeout must exceed it.
httpServer.keepAliveTimeout = 75_000;
httpServer.headersTimeout = 76_000;

/** WS key gate shared by every endpoint: with DEVIN_WEB_ADMIN_KEY set a
 *  socket needs the key too — the hub broadcast carries full session
 *  traffic to every client, and term/browser are full-power surfaces.
 *  Browsers can't send headers on WS, so ?key= is accepted alongside the
 *  x-admin-key header (same channel the frontend api.ts uses). */
function wsKeyAllowed(req: http.IncomingMessage): boolean {
  if (!adminKeyRequired()) return true;
  const k = adminKey();
  if (req.headers["x-admin-key"] === k) return true;
  try { return new URL(req.url ?? "", "http://x").searchParams.get("key") === k; } catch { return false; }
}

const hub = new WsHub(
  httpServer,
  () => ({
    type: "config",
    app: { name: "devin-web", version: pkg.version },
    settings: store.settings,
  }),
  { verifyOrigin: (req) => isAllowedRequest(req) && wsKeyAllowed(req) },
);

// Interactive session terminal — one shell per WS connection, spawned in the
// session's cwd. JSON frames: out {d} / in {d} / kill. noServer + manual
// upgrade routing so /ws and /ws/term coexist (see WsHub).
const termWss = new WebSocketServer({ noServer: true });
const browserWss = new WebSocketServer({ noServer: true });
initLocalBrowser(path.join(store.dataDir, "browser-profile"));
initScreen(store.dataDir);
httpServer.on("upgrade", (req, socket, head) => {
  let pathname = "";
  try { pathname = new URL(req.url ?? "", "http://x").pathname; } catch { socket.destroy(); return; }
  if (pathname !== "/ws/term" && pathname !== "/ws/browser") return;
  if (!isAllowedRequest(req)) { socket.destroy(); return; }
  // Interactive endpoints are full-power surfaces (a shell in the session
  // cwd, CDP control of a real browser) — same key gate as the hub.
  if (!wsKeyAllowed(req)) { socket.destroy(); return; }
  const wss = pathname === "/ws/term" ? termWss : browserWss;
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
browserWss.on("connection", (ws) => attachBrowserWs(ws));
termWss.on("connection", (ws, req) => {
  const q = new URL(req.url ?? "", "http://x").searchParams;
  const sid = q.get("session") ?? "";
  const cwd = (sid && sessionCwd.get(sid.startsWith("sub:") ? sid.slice(4).split(":")[0] : sid)) || primaryCwd;
  // run=ssh|forward + arg — spawn `devin` subcommands instead of the shell.
  // Cloud-session ops: user supplies the session id/URL; lifecycle is bound
  // to the WS (close ⇒ kill ⇒ tunnel down).
  const run = q.get("run");
  const arg = (q.get("arg") ?? "").trim();
  let command = process.platform === "win32" ? "cmd.exe" : (process.env.SHELL ?? "sh");
  let args: string[] = process.platform === "win32" ? [] : ["-i"];
  // SSH-hosted session → the interactive shell IS an ssh login on the target.
  const baseId = sid.startsWith("sub:") ? sid.slice(4).split(":")[0] : sid;
  const sessSsh = (baseId && (sessionSsh.get(baseId) ?? meta(ctx, baseId).ssh)) || null;
  const sshArgOk = /^[A-Za-z0-9_.:/@-]{1,200}$/.test(arg);
  if (run === "ssh" && sshArgOk) {
    command = "devin"; args = ["ssh", arg];
  } else if (!sessSsh && run === "forward" && sshArgOk) {
    const ports = (q.get("ports") ?? "").split(/[\s,]+/).filter((x) => /^\d{1,5}(:\d{1,5})?$/.test(x));
    if (ports.length) { command = "devin"; args = ["forward", arg, ...ports]; }
  }
  // Backpressure: a suspended tab still ACKs at the protocol level — its JS
  // never drains, and a build-log flood queues unboundedly (the backend RSS
  // watchdog's recurring restarts). Over the cap the peer is unreachable;
  // terminate → reconnect respawns the shell.
  const send = (o: unknown) => {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > 8 * 1024 * 1024) { try { ws.terminate(); } catch {} return; }
    ws.send(JSON.stringify(o));
  };
  // proc may arrive async (ssh2 password/key hosts connect first) — buffer
  // keystrokes sent before it exists and flush on wire().
  const early: string[] = [];
  let proc: child_process.ChildProcess | null = null;
  let killed = false;
  const wire = (p: child_process.ChildProcess) => {
    proc = p;
    p.stdout?.on("data", (d: Buffer) => send({ d: d.toString("utf8") }));
    p.stderr?.on("data", (d: Buffer) => send({ d: d.toString("utf8") }));
    p.stdin?.on("error", () => {});
    p.on("exit", (code) => { send({ exit: code }); try { ws.close(); } catch {} });
    for (const d of early.splice(0)) { try { p.stdin?.write(d); } catch {} }
  };
  ws.on("message", (raw) => {
    try {
      const m = JSON.parse(String(raw));
      if (typeof m.d === "string") { if (proc) { try { proc.stdin?.write(m.d); } catch {} } else early.push(m.d); }
      if (m.kill) { killed = true; try { proc?.kill(); } catch {} }
    } catch {}
  });
  ws.on("close", () => { killed = true; try { proc?.kill(); } catch {} });
  send({ d: `\x1b[90m[${cwd}]\x1b[0m\r\n` });
  if (sessSsh && !(run === "ssh" && sshArgOk)) {
    // sshInteractive: `ssh -tt` for agent-auth hosts, ssh2 pty for
    // password/key records — same ChildProcess shape either way.
    sshInteractive(String(sessSsh)).then((p) => {
      if (killed || ws.readyState !== ws.OPEN) { try { p.kill(); } catch {} return; }
      wire(p);
    }).catch((e) => {
      send({ d: `\r\n\x1b[31m[ssh] ${e instanceof Error ? e.message : e}\x1b[0m\r\n` });
      try { ws.close(); } catch {}
    });
  } else {
    try { wire(child_process.spawn(command, args, { cwd, env: process.env })); }
    catch (e) { send({ d: `\r\n[spawn] ${e instanceof Error ? e.message : e}\r\n` }); try { ws.close(); } catch {} }
  }
});

const manager = new AcpManager({
  onSessionUpdate: (sessionId, update) => {
    // A replayed dupe needs no fan-out — during a session/load stream this
    // is the hot path (tens of thousands of updates), so skip broadcast,
    // rate-limit watch and update bookkeeping entirely.
    if (!sessionLog.append(sessionId, update as Record<string, unknown>)) return;
    watchSubRateLimit(ctx, sessionId, update as Record<string, unknown>);
    hub.broadcast({ type: "session_update", sessionId, update });
    touchSessionActivity(sessionId);
    noteUpdate(ctx, sessionId);
  },
  onAgentLog: (sessionId, channel, message, level) => {
    hub.broadcast({ type: "agent_log", sessionId, channel, message, level });
  },
  onPermissionRequest: (requestId, sessionId, toolCall, options) => {
    sessionLog.append(sessionId, { sessionUpdate: "permission_request", requestId, toolCall, options });
    hub.broadcast({ type: "permission_request", requestId, sessionId, toolCall, options });
    noteUpdate(ctx, sessionId);
  },
  onPermissionOwner: (requestId, owner) => {
    permissionOwner.set(requestId, owner);
  },
  onPermissionResolved: (requestId) => {
    // Timed out or the process died — tell clients so stale cards disappear.
    permissionOwner.delete(requestId);
    hub.broadcast({ type: "permission_resolved", requestId });
  },
  onTerminalOutput: (terminalId, sessionId, data) => {
    recordTerminal(terminalId, sessionId, data);
    hub.broadcast({ type: "terminal_output", terminalId, sessionId, data });
  },
  onTerminalExit: (terminalId, sessionId, exitCode, signal) => {
    hub.broadcast({ type: "terminal_exit", terminalId, sessionId, exitCode, signal });
  },
  onExit: (cwd, code, agent, sessionId) => {
    hub.broadcast({ type: "process_status", cwd, status: "exited", code, agent, sessionId });
  },
  onRateLimited: (account, sessionId, message) => {
    // Replayed log lines re-emit old rate-limit text during session/load —
    // only mark/rotate for live failures or every reload poisons the pool.
    if (loadInflight.has(sessionId)) return;
    const name = account ?? accounts.accountForCredFile() ?? accounts.pick();
    if (name) {
      accounts.markLimited(name, retryAfterSeconds(message));
      hub.broadcast({ type: "account_limited", account: name, sessionId, message });
    }
    rotate("rate-limit");
  },
  // Wire sniffer → turn journal: the prompt's JSON-RPC id rides open-turns
  // so a response replayed/arriving after a restart still correlates.
  onPromptRequest: (acp, sessionId, requestId) => {
    notePromptReq(sessionId, requestId, acp.brokerId);
  },
  onPromptResponse: (acp, requestId, sessionId, ok, errorMessage) => {
    resolveTurnByReq(ctx, acp, requestId, sessionId, ok, errorMessage);
  },
});

// Inject the current pool account's key into every spawned devin acp process.
manager.envFor = (agent) => {
  if (agent.id !== "devin") return { env: { ...(agent.env ?? {}) }, account: null };
  const account = accounts.pick();
  const key = accounts.apiKey();
  const env: Record<string, string> = { ...(agent.env ?? {}) };
  if (key) env.WINDSURF_API_KEY = key;
  return { env, account };
};

/** Rotate to the next healthy account and recycle pooled processes so the
 *  next spawn picks up the new key. Killing is unconditional: a rate-limit
 *  mark can push pick() onto the rotate target BEFORE rotate() runs, making
 *  next===from look like a no-op while the failed process is still alive —
 *  which is exactly how "switched but didn't switch" happened. Processes
 *  already on the new account are spared. */
function rotate(reason: string, target?: string): string | null {
  const from = accounts.currentName;
  const next = accounts.rotate(target);
  if (!next) return null;
  manager.killPooled("devin", next);
  hub.broadcast({ type: "account_rotated", from, to: next, reason, accounts: accounts.status() });
  console.log(`[accounts] rotated [${reason}]: ${from} -> ${next}`);
  return next;
}

// (subCalls + watchSubRateLimit moved to sessionsub.ts — the subagent
//  domain module; index.ts only wires the call into onAgentLog.)

const ctx: ApiContext = {
  store,
  manager,
  accounts,
  rotate,
  hub,
  sessionLog,
  appVersion: pkg.version,
  primaryCwd,
  devinCheck,
  agentsCheck,
  sessionCwd,
  sessionSsh,
  permissionOwner,
};

httpServer.on("request", (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      if (!isAllowedRequest(req)) {
        res.writeHead(403, { "content-type": "application/json" }).end(
          JSON.stringify({
            error: "forbidden origin/host — set DEVIN_WEB_ALLOWED_HOSTS for reverse proxies and tunnels",
          }),
        );
        return;
      }
      // Supervisor liveness probe — must be free of any store/acp/db touch so a
      // wedged subsystem can't make a live server look dead (or vice versa).
      if (url.pathname === "/api/health") {
        res.writeHead(200, { "content-type": "application/json" }).end(`{"ok":true,"edition":"${edition}","keyRequired":${adminKeyRequired()}}`);
        return;
      }
      void (async () => {
        if (!(await handleLocalWb(ctx, req, res, url))) await handleApi(ctx, req, res, url);
      })();
    } else {
      serveStatic(req, res, url);
    }
  } catch {
    // Malformed requests (bad % escapes, bogus Host) must never take down the
    // process — an uncaught throw in this handler kills the whole server.
    if (!res.headersSent) res.writeHead(400).end("bad request");
    else res.destroy();
  }
});

// ---- go --------------------------------------------------------------------
httpServer.listen(PORT, HOST, async () => {
  const addr = `http://${HOST}:${PORT}`;
  console.log(`devin-web ${pkg.version} listening on ${addr}`);
  const check = await devinCheck();
  if (!check.installed) {
    console.warn("⚠  devin CLI not found on PATH — install it first: https://docs.devin.ai/cli");
  } else if (!check.authed) {
    console.warn("⚠  devin CLI is not logged in — run: devin auth login");
  }
  if (wantOpen) {
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    execFile(opener, [addr], () => {});
  }
  // Broker mode: acp children survived under the broker — re-attach and
  // rebuild the pool/session maps BEFORE anything else resolves sessions.
  // In-flight turns keep streaming (settle is silence-inferred); the orphan
  // sweep + auto-resume only handle what adoption couldn't (crashes).
  // Restore the persisted agent-level model/mode/commands cache BEFORE
  // adoption/resume — broker adoption skips session/load (the only writer),
  // so without this every picker blanks until a lucky session reloads.
  setCfgCacheDir(store.dataDir);
  const adopted = adoptBrokerAcps(ctx).catch((e) => { console.error("[adopt]", e); });
  // Auto-resume turns left open by a crashed/killed predecessor — gated by
  // the 会话自动继续 pref. Delayed so the acp pool settles first. Orphaned
  // acp children (SIGKILL/crash paths skip killAll) are swept FIRST so their
  // dead locks don't block the replays.
  setTimeout(() => {
    void Promise.resolve(adopted) // adoption first — adoptedTurns must be populated before resume decides
      .then(() => import("./diagnose.js")).then(d => d.killOrphans())
      .then(r => { if (r !== "none found") console.error(`[boot] orphan acp sweep: ${r}`); })
      .catch(() => {})
      .then(() => autoResumeInterrupted(ctx)) // AFTER the sweep — dead locks cleared first
      .catch((e) => console.error("[auto-resume]", e));
  }, 4000);
  startAutomations(ctx);
  resumeScans(ctx);
  // RSS watchdog — native allocator retention (sqlite churn, buffers) can
  // hold RSS far above the JS heap on Windows and never returns it. Past
  // the cap, take the same graceful exit a restart uses: markGracefulExit
  // journals broker offsets + open turns, the supervisor respawns cleanly.
  const rssLimitMb = Number(process.env.DEVIN_WEB_RSS_LIMIT_MB ?? 1536);
  if (rssLimitMb > 0) {
    setInterval(() => {
      const mu = process.memoryUsage();
      const rss = mu.rss / 1048576;
      if (rss > rssLimitMb) {
        // Leave a heap snapshot + the usage breakdown in the log before
        // exiting — "restart for memory reclaim" without evidence is a
        // mitigation, not a diagnosis. The .heapsnapshot loads in DevTools.
        const mb = (n: number) => Math.round(n / 1048576);
        console.error(`[watchdog] rss ${Math.round(rss)}MB > ${rssLimitMb}MB — graceful restart for memory reclaim ` +
          `(heapUsed ${mb(mu.heapUsed)} / heapTotal ${mb(mu.heapTotal)} / external ${mb(mu.external)} / arrayBuffers ${mb(mu.arrayBuffers ?? 0)})`);
        try {
          const snap = path.join(store.dataDir, `heap-${new Date().toISOString().replace(/[:.]/g, "-")}.heapsnapshot`);
          writeHeapSnapshot(snap);
          console.error(`[watchdog] heap snapshot → ${snap}`);
        } catch (e) { console.error("[watchdog] heap snapshot failed:", e); }
        try { markGracefulExit(); } catch {}
        process.exit(0);
      }
    }, 60_000).unref();
  }
  // One-time migration sweep: import every legacy .jsonl mirror into the
  // SQLite event store (per-file imports also fire lazily on first touch —
  // this just makes it eager so no session waits on a cold import later).
  // Runs after listen; each file is a one-off cost (~10s per GB-scale log).
  setTimeout(() => {
    try {
      const logDir = path.join(store.dataDir, "log");
      let done = 0;
      const t0 = Date.now();
      for (const f of fs.readdirSync(logDir)) {
        // `<id>.jsonl` only — skip `.jsonl.bak` and the `.sub.*`/`.subs.jsonl`
        // sidecars (both contain ".jsonl." mid-name).
        if (!f.endsWith(".jsonl") || f.includes(".jsonl.")) continue;
        try {
          sessionLog.ensureImported(decodeURIComponent(f.slice(0, -6)));
          done++;
        } catch { /* leave for lazy import */ }
      }
      if (done) console.log(`[sessionlog] migrated ${done} log file(s) into sessionlog.db in ${Date.now() - t0}ms`);
    } catch { /* log dir missing — nothing to migrate */ }
  }, 100);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    markGracefulExit(ctx); // keep open-turns entries → auto-resume on next boot
    if (brokerEnabled) manager.killHelpers(); // acp live under the broker
    else manager.killAll();
    store.flush();
    process.exit(0);
  });
}
