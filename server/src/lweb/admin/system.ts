/**
 * lweb/admin/system — service + host ops: the /modules diagnostics,
 * send-check, cli/run proxy, drain/diagnose/repair/audit, restart/redeploy,
 * the host screen stream, and the delegated wiki/security/resolve subtrees.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ApiContext } from "../../routes.js";
import { isSupervised, noSupervisor } from "../../env.js";
import { brokerEnabled } from "../../acpbroker.js";
import { streamScreen, injectInput } from "../../screen.js";
import { loadReg } from "../../dwstore.js";
import { sendPreflight } from "../../sessionprompt.js";
import { recentSendErrors } from "../../sendhealth.js";
import { inflight, beginDrain, isDraining, drainSince, markGracefulExit } from "../../sessionlive.js";
import { openTurns, openTurnsLoad } from "../../sessionturns.js";
import { handleWikiRoute } from "../../wiki.js";
import { handleSecurityRoute } from "../../security.js";
import { json, readJson } from "../../httputil.js";
import { runCli } from "../admin.js";

let restartPending = false; // serialized restart/redeploy — see /api/admin/restart

export async function handleSystem(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL, m: string, p: string, parts: string[]): Promise<boolean> {
  // GET /api/admin/modules — per-module health for the settings page.
  // Each check is isolated+timed; one bad module can't fail the rest.
  if (p === "/api/admin/modules" && m === "GET") {
    type Lev = "ok" | "warn" | "fail";
    interface ModRow { name: string; value: string; level?: Lev }
    interface Mod { id: string; level: Lev; detail: string; ms: number; rows?: ModRow[]; lane?: "trunk" | "branch" }
    const mods: Mod[] = [];
    const timed = async (id: string, fn: () => { level?: Lev; detail: string; rows?: ModRow[] } | Promise<{ level?: Lev; detail: string; rows?: ModRow[] }>) => {
      const t0 = Date.now();
      try {
        const r = await fn();
        mods.push({ id, level: r.level ?? "ok", detail: r.detail, ms: Date.now() - t0, rows: r.rows });
      } catch (e) {
        mods.push({ id, level: "fail", detail: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 });
      }
    };
    // Ordered as the actual send pipeline traverses them, top→down:
    // ingress → api → gate → persist → resolve → host → spawn → return.
    await timed("supervisor", () => isSupervised()
      ? {
          detail: "supervised — auto-restart + drain-restart active",
          rows: [{ name: "DEVIN_WEB_SUPERVISED", value: process.env.DEVIN_WEB_SUPERVISED ?? "" }],
        }
      : { level: "warn", detail: "unsupervised bare process — no auto-restart" });
    await timed("backend", () => ({
      detail: `pid ${process.pid} · up ${Math.round(process.uptime())}s · v${ctx.appVersion}`,
      rows: [
        { name: "pid", value: String(process.pid) },
        { name: "uptime", value: `${Math.round(process.uptime())}s` },
        { name: "node", value: process.version },
        { name: "version", value: ctx.appVersion },
        { name: "platform", value: `${process.platform}/${process.arch}` },
        { name: "dataDir", value: ctx.store.dataDir },
      ],
    }));
    await timed("dispatch", () => {
      let open = 0;
      const openIds: string[] = [];
      try {
        openTurnsLoad(ctx); // the in-memory journal is authoritative post-boot
        for (const k of openTurns.keys()) { open++; openIds.push(k); }
      } catch {}
      return {
        level: isDraining() ? "warn" : "ok",
        detail: `${isDraining() ? `DRAINING ${Math.round((Date.now() - drainSince()) / 1000)}s · ` : ""}${inflight.size} in flight · ${open} interrupted`,
        rows: [
          { name: "draining", value: String(isDraining()), level: isDraining() ? "warn" : "ok" },
          { name: "in flight", value: [...inflight].join(", ") || "0" },
          { name: "interrupted", value: openIds.join(", ") || "0", level: open ? "warn" : "ok" },
        ],
      };
    });
    await timed("sessiondb", () => {
      const s = ctx.sessionLog.dbStats();
      if (!s) return { level: "warn" as const, detail: "sqlite store not open — file-mirror only" };
      return {
        detail: `${s.events.toLocaleString()} events · ${(s.fileBytes / 1048576).toFixed(0)}MB`,
        rows: [
          { name: "sessions", value: String(s.sessions) },
          { name: "events", value: s.events.toLocaleString() },
          { name: "blobs", value: s.blobs.toLocaleString() },
          { name: "logical", value: `${(s.storedBytes / 1048576).toFixed(0)}MB` },
          { name: "file", value: `${(s.fileBytes / 1048576).toFixed(0)}MB` },
        ],
      };
    });
    await timed("uploads", () => {
      const probe = path.join(ctx.store.uploadsDir, `.probe-${process.pid}`);
      fs.writeFileSync(probe, "ok");
      fs.unlinkSync(probe);
      const n = fs.readdirSync(ctx.store.uploadsDir).length;
      return {
        detail: `writable · ${n} staged file(s)`,
        rows: [
          { name: "dir", value: ctx.store.uploadsDir },
          { name: "writable", value: "yes", level: "ok" as const },
          { name: "staged", value: String(n) },
        ],
      };
    });
    await timed("store", () => {
      const r = loadReg(ctx);
      const folders = new Set(Object.values(r.sessions).map((s) => (s as { folder?: string }).folder).filter(Boolean));
      return {
        detail: `${Object.keys(r.sessions).length} registry entries · ${ctx.store.workspaces().length} workspaces`,
        rows: [
          { name: "registry", value: String(Object.keys(r.sessions).length) },
          { name: "agent sessions", value: String(Object.keys(ctx.store.agentSessions()).length) },
          { name: "workspaces", value: ctx.store.workspaces().join(" · ") || "0" },
          { name: "folders", value: String(folders.size) },
        ],
      };
    });
    // Fan-out: resolution lands on ONE branch per registered agent — each
    // carries its own CLI, process pool and credential pool (the account
    // pool is Devin-scoped today; other agents self-manage auth).
    {
      const t0 = Date.now();
      const agentRows = (await ctx.agentsCheck()) as { id: string; label: string; installed: boolean; authed: boolean; version: string | null; detail: string }[];
      const procs = ctx.manager.status() as { agent: string; exited: boolean; sessionId?: string; cwd: string; pid: number; account: string | null; busy: number; startedAt: number }[];
      const acctRows = ctx.accounts.status();
      const picked = ctx.accounts.pick();
      const recovery = ctx.accounts.nextRecoveryAt();
      for (const a of agentRows) {
        const myProcs = procs.filter((r) => r.agent === a.id);
        const dead = myProcs.filter((r) => r.exited).length;
        const rows: ModRow[] = [{
          name: "CLI",
          value: a.installed ? `${a.version ?? "?"}${a.authed ? " · authed" : " · NOT authed"}` : `missing — ${a.detail.slice(0, 80)}`,
          level: !a.installed ? "warn" : a.authed ? "ok" : "warn",
        }];
        for (const r of myProcs) rows.push({
          name: `proc pid ${r.pid}`,
          value: `${r.exited ? "EXITED" : "alive"} · busy ${r.busy} · ${r.account ?? "no-acct"} · ${r.cwd}`,
          level: r.exited ? "fail" : "ok",
        });
        if (a.id === "devin") {
          if (!picked && recovery) rows.push({ name: "accounts recover", value: new Date(recovery * 1000).toLocaleString(), level: "warn" });
          for (const r of acctRows) rows.push({
            name: `acct ${r.name}`,
            value: `${r.current ? "active" : r.picked ? "picked" : "idle"}${r.cooling ? ` · cooling until ${new Date(r.limitedUntil * 1000).toLocaleTimeString()}` : ""}`,
            level: r.cooling ? "warn" : "ok",
          });
        }
        const level: Lev = !a.installed
          ? (a.id === "devin" ? "fail" : "warn")
          : dead ? "warn" : "ok";
        mods.push({
          id: `agent-${a.id}`,
          level,
          lane: "branch",
          detail: `${a.label} — ${a.installed ? (a.version ?? "?") : "missing"} · ${myProcs.length} proc(s)${a.id === "devin" ? ` · ${acctRows.length} acct(s)` : " · self-managed auth"}`,
          ms: Date.now() - t0,
          rows,
        });
      }
    }
    await timed("ws", () => ({
      detail: `${ctx.hub.clients()} client(s) — return channel`,
      rows: [{ name: "clients", value: String(ctx.hub.clients()) }],
    }));
    await timed("disk", () => {
      const probe = path.join(ctx.store.dataDir, `.probe-${process.pid}`);
      fs.writeFileSync(probe, "ok");
      fs.unlinkSync(probe);
      try {
        const st = fs.statfsSync(ctx.store.dataDir);
        const gb = (st.bavail * st.bsize) / 1073741824;
        return {
          level: gb < 1 ? "warn" as const : "ok" as const,
          detail: `writable · ${gb.toFixed(1)}GB free`,
          rows: [
            { name: "writable", value: "yes", level: "ok" as const },
            { name: "free", value: `${gb.toFixed(1)}GB`, level: gb < 1 ? "warn" as const : "ok" as const },
            { name: "path", value: ctx.store.dataDir },
          ],
        };
      } catch {
        return { detail: "writable", rows: [{ name: "writable", value: "yes", level: "ok" as const }] };
      }
    });
    json(res, 200, { ts: Date.now(), modules: mods, recentSendErrors: recentSendErrors() });
    return true;
  }

  // GET /api/admin/send-check?session=<id> — per-stage send preflight:
  // gate → known → busy → host → account → store → last error.
  if (p === "/api/admin/send-check" && m === "GET") {
    const id = url.searchParams.get("session") ?? "";
    if (!id) { json(res, 400, { error: "missing session" }); return true; }
    json(res, 200, { session: id, ...sendPreflight(ctx, id) });
    return true;
  }

  // /api/admin/wiki/* — DeepWiki public-MCP backed wiki browser
  // (server/src/wiki.ts): repos CRUD, structure, page, ask.
  if (parts[2] === "wiki" && await handleWikiRoute(ctx, parts, m, req, res, url)) return true;

  // /api/admin/security/* — local code scans (server/src/security.ts):
  // scans run as real acp sessions; findings parsed from agent JSON.
  if (parts[2] === "security" && await handleSecurityRoute(ctx, parts, m, req, res, url)) return true;

  // POST /api/admin/cli/run {cmd, arg?} — CLI parity: proxies whitelisted
  // `devin <subcommand>` calls (spawn, no shell → arg can't inject).
  // Read-only by default; write cmds are marked and the UI confirm-gates.
  if (p === "/api/admin/cli/run" && m === "POST") {
    const body = await readJson(req);
    const cmd = String(body.cmd ?? "");
    const arg = String(body.arg ?? "").replace(/^-+/, "");
    const TABLE: Record<string, string[]> = {
      "version": ["version"],
      "auth-status": ["auth", "status"],
      "doctor": ["doctor"],
      "models": ["models", "list"],
      "rules": ["rules", "list"],
      "rules-paths": ["rules", "paths"],
      "skills": ["skills", "list"],
      "skills-paths": ["skills", "paths"],
      "plugins": ["plugins", "list"],
      "sessions": ["list", "--format", "json"],
      "sandbox-setup": ["sandbox", "setup"],
      "desktop": ["desktop"],
      "update": ["update"],
    };
    let argv = TABLE[cmd];
    if (!argv) {
      // Commands with an optional positional arg (arg required by the CLI
      // itself for show/remove/install; migrate takes none).
      const PARAM: Record<string, string[]> = {
        "rule-show": ["rules", "show"],
        "skill-show": ["skills", "show"],
        "plugin-info": ["plugins", "info"],
        "plugin-remove": ["plugins", "remove"],
        "plugin-update": ["plugins", "update"],
        "plugin-install": ["plugins", "install"],
        "migrate-hooks": ["migrate", "hooks"],
        "migrate-workflows": ["migrate", "workflows"],
      };
      const base = PARAM[cmd];
      if (base) argv = arg ? [...base, arg] : base;
    }
    if (!argv) { json(res, 400, { error: "unknown cmd" }); return true; }
    try {
      const r = await runCli(argv, ctx.primaryCwd);
      json(res, 200, r);
    } catch (e) { json(res, 200, { ok: false, output: "", error: e instanceof Error ? e.message : String(e) }); }
    return true;
  }

  // GET /api/admin/drain — current deploy-drain state for the UI: whether
  // we're gating new work, which sessions' turns we're waiting on, and how
  // long it's been. Drives the "server restarting — waiting on X" message.
  if (p === "/api/admin/drain" && m === "GET") {
    json(res, 200, { draining: isDraining(), waiting: [...inflight], elapsed_ms: isDraining() ? Date.now() - drainSince() : 0 });
    return true;
  }

  // GET /api/admin/diagnose — whole-chain probe: supervisor, drain,
  // inflight turns, acp pool, lock-holding orphans, session locks,
  // pending replays, disk, public domain. POST /api/admin/repair runs
  // the fixable ones (kill-orphans / stop-turns / clear-open-turns /
  // restart-now) — the "one button fixes it" escape hatch.
  if (p === "/api/admin/diagnose" && m === "GET") {
    const { diagnose } = await import("../../diagnose.js");
    json(res, 200, await diagnose(ctx));
    return true;
  }
  if (p === "/api/admin/repair" && m === "POST") {
    const body = await readJson(req);
    const { repair } = await import("../../diagnose.js");
    json(res, 200, await repair(ctx, body.fixes === "all" ? "all" : Array.isArray(body.fixes) ? body.fixes.map(String) : []));
    return true;
  }

  // POST /api/admin/audit — client-side action log appended to server.log
  // so UI-initiated operations (restart clicks, send failures, config
  // picks) are traceable next to the backend's own events.
  if (p === "/api/admin/audit" && m === "POST") {
    const body = await readJson(req);
    // Strip newlines — a crafted body must not inject fake log lines.
    const action = String(body.action ?? "?").replace(/[\r\n]+/g, " ").slice(0, 80);
    const detail = String(body.detail ?? "").replace(/[\r\n]+/g, " ").slice(0, 300);
    console.error(`[audit] ${action}${detail ? ` — ${detail}` : ""}`);
    json(res, 200, { ok: true });
    return true;
  }

  // POST /api/admin/restart|redeploy — IMMEDIATE restart, no drain wait.
  // restartPending serializes concurrent requests — a second call during
  // the exit window (or a parallel redeploy build) gets a clean 409.
  // beginDrain gates NEW sends for the ~400ms exit window, markGracefulExit
  // keeps in-flight turns' open-turns entries (auto-resume replays them on
  // the next backend), manager.killAll kills acp children (frees session
  // locks — the orphan-lock send failure), then exit. The supervisor
  // respawns us on exit; bare dev runs hand :7791 to it directly.
  if ((p === "/api/admin/restart" || p === "/api/admin/redeploy") && m === "POST") {
    if (restartPending) { json(res, 409, { error: "restart already in progress" }); return true; }
    restartPending = true;
    json(res, 202, { ok: true });
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const respawn = () => {
      beginDrain();
      markGracefulExit(ctx);
      if (!isSupervised() && !noSupervisor()) {
        spawn(process.execPath, [path.join(repoRoot, "scripts", "supervisor.mjs")],
          { cwd: repoRoot, detached: true, stdio: "ignore", windowsHide: true }).unref();
      }
      // Broker mode: acp children live under the broker — only the
      // backend's own helpers die with it; turns keep streaming.
      if (brokerEnabled) ctx.manager.killHelpers();
      else ctx.manager.killAll();
      setTimeout(() => process.exit(0), 400);
    };
    if (p === "/api/admin/redeploy") {
      const b = process.platform === "win32"
        ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm run build"], { cwd: repoRoot, stdio: "inherit", windowsHide: true })
        : spawn("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
      b.on("exit", (code) => { if (code === 0) respawn(); else console.error(`[redeploy] build failed (${code}) — staying up`); });
      b.on("error", (e) => console.error(`[redeploy] build spawn failed: ${e.message} — staying up`));
    } else respawn();
    return true;
  }

  // GET /api/admin/screen/live — MJPEG stream of the real host desktop.
  // Admin-only: the web has no auth, so the screen stays out of
  // the share tree. Read-only by design (see screen.ts).
  if (p === "/api/admin/screen/live" && m === "GET") {
    await streamScreen(res);
    return true;
  }
  // POST /api/admin/screen/input — inject one pointer/keyboard event.
  if (p === "/api/admin/screen/input" && m === "POST") {
    const body = await readJson(req).catch(() => null);
    try {
      await injectInput(body);
      json(res, 200, { ok: true });
    } catch (e) {
      json(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
    return true;
  }

  // /api/admin/resolve/<hex> — official-link resolution has no cloud meaning locally
  if (parts[2] === "resolve") {
    json(res, 404, { error: "no upstream session" });
    return true;
  }

  return false;
}
