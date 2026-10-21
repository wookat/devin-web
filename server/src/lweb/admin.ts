/**
 * lweb/admin — the /api/admin/* route tree: modules diagnostics, CLI proxy,
 * workspace index + skills, agents/accounts/prefs/automations/wiki/security/
 * PR routes, the per-session subroutes, and the deploy/restart controls.
 * Called only when isAdmin (auth already enforced by the index shell).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { ApiContext } from "../routes.js";
import { brokerEnabled } from "../acpbroker.js";
import { stageUpload } from "../uploads.js";
import { streamScreen, injectInput } from "../screen.js";
import { loadReg, saveReg, meta, noteLastUsed, type DwAutomation } from "../dwstore.js";
import { remapLegacyCwd } from "../store.js";
import { noteUpdate, snapshotItems, buildMessages, buildTimeline, tlReset, snippet } from "../dwtimeline.js";
import { hostFor, ensureLoaded, acpForId, restartSession, interruptedTurn } from "../sessionload.js";
import { sessionConfig, sessionStatus, listLocalSessions, terminalBuf, cloudVersionToModel } from "../sessionview.js";
import { subagentTimeline } from "../sessionsub.js";
import { dispatchPrompt, sendPreflight } from "../sessionprompt.js";
import { queueList, queueAdd, queueRemove, queueFlush } from "../sessionqueue.js";
import { recentSendErrors } from "../sendhealth.js";
import { loadedOn, sessionHost, loadInflight } from "../sessionplace.js";
import { inflight, beginDrain, isDraining, drainSince, markGracefulExit } from "../sessionlive.js";
import { responseCfg, captureLoadResponse, type ConfigOption } from "../sessioncfg.js";
import { personaState, personaMode, askPersona, decisionsTail } from "../persona.js";
import { agentById, listAgents, probeAgent, saveUserAgents } from "../agents.js";
import { handlePrRoute, runReviewAgent } from "../pr.js";
import { cronNext, runAutomation } from "../automations.js";
import { handleWikiRoute } from "../wiki.js";
import { handleSecurityRoute } from "../security.js";
import { sshFs, sshHostFor, sshListDirs, sshTest, publicSshHost, type SshHost } from "../ssh.js";
import { json, readBody, readJson, UNSUPPORTED, gitStatusCache } from "./common.js";
import {
  sessionSubs, handleSubSession, parseSubId, cwdFor, confined,
  subsAny, subTreeRow, treeSession, summarizeForFork, titleFromLog, lastContextUsage,
} from "./session.js";

// ---------------------------------------------------------------------------
// CLI proxy — spawn `devin <args>` with a hard whitelist (see /api/admin/cli/run)
// ---------------------------------------------------------------------------

function runCli(argv: string[], cwd: string): Promise<{ ok: boolean; code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(DEFAULT_CLI, argv, { cwd, env: process.env, windowsHide: true });
    let out = "";
    const cap = () => { if (out.length > 256 * 1024) { proc.kill(); } };
    proc.stdout?.on("data", (d) => { out += String(d); cap(); });
    proc.stderr?.on("data", (d) => { out += String(d); cap(); });
    const timer = setTimeout(() => { proc.kill(); reject(new Error("cli timed out (30s)")); }, 30_000);
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
    proc.on("exit", (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, output: out }); });
  });
}

// Resolved once — same binary the acp pool spawns (agents.ts devin.command).
const DEFAULT_CLI = process.env.DEVIN_CLI_BIN || "devin";


// ---------------------------------------------------------------------------
// workspace file index (@file mentions) + local skills (@skills) + last-used
// ---------------------------------------------------------------------------

const INDEX_SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "out", ".next", ".nuxt", "target", "vendor", "__pycache__", ".venv", "venv", ".idea", ".vscode", "coverage", ".cache", "bin", "obj"]);
const wsIndexCache = new Map<string, { at: number; paths: string[] }>();
let restartPending = false; // serialized restart/redeploy — see /api/admin/restart

/** Bounded BFS of a workspace → relative forward-slash file paths (@files). */
function indexWorkspace(root: string): string[] {
  const hit = wsIndexCache.get(root);
  if (hit && Date.now() - hit.at < 60_000) return hit.paths;
  const out: string[] = [];
  const queue: string[] = [""];
  while (queue.length && out.length < 5000) {
    const rel = queue.shift()!;
    const dir = rel ? path.join(root, rel) : root;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (out.length >= 5000) break;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!INDEX_SKIP_DIRS.has(e.name) && !e.name.startsWith(".turbo")) queue.push(r);
      } else {
        out.push(r);
      }
    }
  }
  wsIndexCache.set(root, { at: Date.now(), paths: out });
  return out;
}

/** Local skills visible to the @skills mention: project + user skill dirs. */
function scanLocalSkills(ctx: ApiContext): { repo: string; name: string; description: string }[] {
  const seen = new Set<string>();
  const out: { repo: string; name: string; description: string }[] = [];
  const dirs = [
    path.join(ctx.primaryCwd, ".devin", "skills"),
    path.join(ctx.primaryCwd, ".agents", "skills"),
    path.join(os.homedir(), ".devin", "skills"),
    path.join(os.homedir(), ".agents", "skills"),
  ];
  for (const dir of dirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || seen.has(e.name)) continue;
      const md = path.join(dir, e.name, "SKILL.md");
      let desc = "";
      try {
        const head = fs.readFileSync(md, "utf8").slice(0, 4000);
        const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head)?.[1] ?? "";
        desc = /^description:\s*(.+)$/m.exec(fm)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
      } catch {
        continue; // no SKILL.md → not a skill dir
      }
      seen.add(e.name);
      out.push({ repo: dir.includes(".devin") ? "project" : "user", name: e.name, description: desc.slice(0, 200) });
    }
  }
  return out;
}



export async function handleAdminTree(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const m = req.method ?? "GET";
  const p = url.pathname;
  const parts = p.split("/").filter(Boolean);

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
        await timed("supervisor", () => process.env.DEVIN_WEB_SUPERVISED
          ? {
              detail: "supervised — auto-restart + drain-restart active",
              rows: [{ name: "DEVIN_WEB_SUPERVISED", value: process.env.DEVIN_WEB_SUPERVISED }],
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
            const raw = JSON.parse(fs.readFileSync(path.join(ctx.store.dataDir, "open-turns.json"), "utf8")) as Record<string, { ts?: number }>;
            for (const k of Object.keys(raw)) { open++; openIds.push(k); }
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

      // /api/admin/automations — scheduled-session CRUD + manual fire.
      // GET list; POST create; POST /:id patch {name?,prompt?,schedule?,cwd?,enabled?};
      // DELETE /:id; POST /:id/run → fire now (returns the new session id).
      if (parts[2] === "automations") {
        const reg = loadReg(ctx);
        reg.automations ??= {};
        const aid = parts[3] ? decodeURIComponent(parts[3]) : "";
        const one = aid ? reg.automations[aid] : null;
        if (one && parts[4] === "run" && m === "POST") {
          const sid = await runAutomation(ctx, aid).catch(() => null);
          json(res, sid ? 200 : 502, sid ? { ok: true, id: sid } : { error: "fire failed (acp unavailable?)" });
          return true;
        }
        if (m === "GET" && !aid) {
          json(res, 200, { automations: Object.values(reg.automations).sort((a, b) => a.createdAt - b.createdAt) });
          return true;
        }
        if (m === "POST" && !aid) {
          const body = await readJson(req);
          const schedule = String(body.schedule ?? "").trim();
          const next = cronNext(schedule);
          if (!String(body.name ?? "").trim() || !String(body.prompt ?? "").trim() || !next) {
            json(res, 400, { error: "name, prompt, and a valid 5-field cron schedule are required" });
            return true;
          }
          const a: DwAutomation = {
            id: `auto-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            name: String(body.name).slice(0, 120), prompt: String(body.prompt).slice(0, 20_000),
            schedule, cwd: String(body.cwd ?? ctx.primaryCwd),
            enabled: body.enabled !== false, createdAt: Date.now(), nextRun: next,
          };
          reg.automations[a.id] = a; saveReg();
          json(res, 200, { ok: true, automation: a });
          return true;
        }
        if (one && m === "POST") {
          const body = await readJson(req);
          if (body.name != null) one.name = String(body.name).slice(0, 120) || one.name;
          if (body.prompt != null) one.prompt = String(body.prompt).slice(0, 20_000);
          if (body.cwd != null) one.cwd = String(body.cwd) || one.cwd;
          if (body.schedule != null) {
            const n = cronNext(String(body.schedule));
            if (!n) { json(res, 400, { error: "invalid cron schedule" }); return true; }
            one.schedule = String(body.schedule).trim(); one.nextRun = n;
          }
          if (body.enabled != null) { one.enabled = !!body.enabled; one.nextRun = one.enabled ? (cronNext(one.schedule) ?? undefined) : undefined; }
          saveReg();
          json(res, 200, { ok: true, automation: one });
          return true;
        }
        if (one && m === "DELETE") {
          delete reg.automations[aid]; saveReg();
          json(res, 200, { ok: true });
          return true;
        }
        json(res, 404, { error: "not found" });
        return true;
      }

      // /api/admin/wiki/* — DeepWiki public-MCP backed wiki browser
      // (server/src/wiki.ts): repos CRUD, structure, page, ask.
      if (parts[2] === "wiki" && await handleWikiRoute(ctx, parts, m, req, res, url)) return true;

      // /api/admin/security/* — local code scans (server/src/security.ts):
      // scans run as real acp sessions; findings parsed from agent JSON.
      if (parts[2] === "security" && await handleSecurityRoute(ctx, parts, m, req, res, url)) return true;

      // GET /api/admin/mirror/sessions — sidebar tree
      if (p === "/api/admin/mirror/sessions" && m === "GET") {
        const sessions = (await listLocalSessions(ctx)).map((s) => treeSession(ctx, s));
        // Sort menu sends order_by=updated_at|created_at — session/list comes
        // back updated-desc already, but the created pick must actually reorder.
        const byCreated = url.searchParams.get("order_by") === "created_at";
        sessions.sort((a, b) => String((byCreated ? b.created_at : b.updated_at) ?? "").localeCompare(String((byCreated ? a.created_at : a.updated_at) ?? "")));
        const r = loadReg(ctx);
        const totals: Record<string, number> = {};
        for (const s of sessions) if (s.folder) totals[s.folder] = (totals[s.folder] ?? 0) + 1;
        json(res, 200, { sessions, folder_order: r.folderOrder, folder_totals: totals, next_cursor: null });
        return true;
      }

      // POST /api/admin/mirror/folder-* — folder management
      if (parts[2] === "mirror" && parts[3]?.startsWith("folder-") && m === "POST") {
        const body = await readJson(req);
        const r = loadReg(ctx);
        const op = parts[3];
        if (op === "folder-create") {
          const name = String(body.name ?? "").trim();
          if (name && !r.folderOrder.includes(name)) r.folderOrder.push(name);
        } else if (op === "folder-rename") {
          const from = String(body.from ?? ""), to = String(body.to ?? "").trim();
          r.folderOrder = r.folderOrder.map((f) => (f === from ? to : f));
          for (const s of Object.values(r.sessions)) if (s.folder === from) s.folder = to;
        } else if (op === "folder-delete") {
          const name = String(body.name ?? "");
          r.folderOrder = r.folderOrder.filter((f) => f !== name);
          for (const s of Object.values(r.sessions)) if (s.folder === name) s.folder = null;
        } else if (op === "folder-reorder") {
          const order = body.order;
          if (Array.isArray(order)) r.folderOrder = order.map(String);
        }
        saveReg();
        json(res, 200, { ok: true });
        return true;
      }

      // POST /api/admin/mirror/session-* — per-session flags
      if (parts[2] === "mirror" && parts[3]?.startsWith("session-") && m === "POST") {
        const body = await readJson(req);
        const id = String(body.session_id ?? body.id ?? body.devin_id ?? "");
        const mm = meta(ctx, id);
        switch (parts[3]) {
          case "session-title": mm.title = String(body.title ?? ""); break;
          case "session-folder": mm.folder = body.folder ? String(body.folder) : null; break;
          case "session-pin": mm.pinned = !!body.pinned; break;
          case "session-archive": mm.archived = !!body.archived; break;
        }
        saveReg();
        json(res, 200, { ok: true });
        return true;
      }

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
        const { diagnose } = await import("../diagnose.js");
        json(res, 200, await diagnose(ctx));
        return true;
      }
      if (p === "/api/admin/repair" && m === "POST") {
        const body = await readJson(req);
        const { repair } = await import("../diagnose.js");
        json(res, 200, await repair(ctx, body.fixes === "all" ? "all" : Array.isArray(body.fixes) ? body.fixes.map(String) : []));
        return true;
      }

      // POST /api/admin/audit — client-side action log appended to server.log
      // so UI-initiated operations (restart clicks, send failures, config
      // picks) are traceable next to the backend's own events.
      if (p === "/api/admin/audit" && m === "POST") {
        const body = await readJson(req);
        const action = String(body.action ?? "?").slice(0, 80);
        const detail = String(body.detail ?? "").slice(0, 300);
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
          if (!process.env.DEVIN_WEB_SUPERVISED && !process.env.DEVIN_WEB_NO_SUPERVISOR) {
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

      if (p === "/api/admin/mirror/session-children" && m === "GET") {
        // Lazy-load row children. `root` is a session id, or `sub:<id>:<aid>`
        // for a subagent's own nested children.
        const root = url.searchParams.get("root") ?? "";
        const ref = parseSubId(root);
        const kids = ref ? subsAny(ctx, ref.parent, ref.aid) : subsAny(ctx, root, "root");
        json(res, 200, { children: kids.map((a) => subTreeRow(ctx, ref?.parent ?? root, cwdFor(ctx, ref?.parent ?? root), a)) });
        return true;
      }
      if (p === "/api/admin/mirror/parent" && m === "GET") {
        const sid = url.searchParams.get("id") ?? url.searchParams.get("session") ?? "";
        const ref = parseSubId(sid);
        if (ref) {
          json(res, 200, { parent: { devin_id: ref.parent, title: meta(ctx, ref.parent).title ?? titleFromLog(ctx, ref.parent) ?? "Parent session" } });
        } else {
          json(res, 200, { parent: null });
        }
        return true;
      }
      if (p === "/api/admin/mirror/members" && m === "GET") {
        json(res, 200, { members: [{ user_id: "local", name: "local" }] });
        return true;
      }
      // GET /api/admin/fs/dirs?path= — directory browser for the new-session
      // workspace picker (desktop parity). Admin-only, dirs never files;
      // path=roots returns win32 drive letters ('/' on posix), empty path
      // starts at primaryCwd. A drive root's parent comes back as "roots".
      if (p === "/api/admin/fs/dirs" && m === "GET") {
        const raw = (url.searchParams.get("path") ?? "").trim();
        const listDirs = (target: string) => fs.readdirSync(target, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.startsWith("."))
          .map((d) => ({ name: d.name, path: path.join(target, d.name) }))
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, 500);
        try {
          if (raw === "roots") {
            if (process.platform === "win32") {
              const drives: { name: string; path: string }[] = [];
              for (let i = 65; i <= 90; i++) {
                const d = `${String.fromCharCode(i)}:\\`;
                try { fs.accessSync(d); drives.push({ name: d, path: d }); } catch { /* absent */ }
              }
              json(res, 200, { cwd: "", parent: null, dirs: drives });
            } else {
              json(res, 200, { cwd: "/", parent: null, dirs: listDirs("/") });
            }
            return true;
          }
          const target = path.resolve(raw || ctx.primaryCwd);
          if (!fs.statSync(target).isDirectory()) throw new Error("not a dir");
          const parent = path.dirname(target);
          json(res, 200, {
            cwd: target,
            parent: parent === target ? (process.platform === "win32" ? "roots" : null) : parent,
            dirs: listDirs(target),
          });
        } catch { json(res, 400, { error: "bad_path" }); }
        return true;
      }

      // GET /api/admin/ssh/dirs?target&path — REMOTE directory listing for the
      // draft picker's ssh mode (sftp on the pooled control connection). The
      // target must be a configured prefs.sshHosts entry.
      if (p === "/api/admin/ssh/dirs" && m === "GET") {
        const target = (url.searchParams.get("target") ?? "").trim();
        if (!sshHostFor(target)) { json(res, 400, { error: "ssh target not configured" }); return true; }
        try {
          json(res, 200, await sshListDirs(target, url.searchParams.get("path") ?? ""));
        } catch (e) {
          json(res, 400, { error: e instanceof Error ? e.message : "ssh_list_failed" });
        }
        return true;
      }

      // POST /api/admin/ssh/test {target} — connectivity probe for the
      // settings SSH panel (auth check + latency + remote whoami).
      if (p === "/api/admin/ssh/test" && m === "POST") {
        const body = await readJson(req);
        const target = String(body.target ?? "").trim();
        if (!sshHostFor(target)) { json(res, 400, { error: "ssh target not configured" }); return true; }
        json(res, 200, await sshTest(target));
        return true;
      }

      // POST /api/admin/ssh/fs {target, op, path, to?, content?} — remote file
      // management: list / mkdir / rename / delete / write / read.
      if (p === "/api/admin/ssh/fs" && m === "POST") {
        const body = await readJson(req);
        const target = String(body.target ?? "").trim();
        if (!sshHostFor(target)) { json(res, 400, { error: "ssh target not configured" }); return true; }
        try {
          json(res, 200, await sshFs(target, body as Parameters<typeof sshFs>[1]));
        } catch (e) {
          json(res, 400, { error: e instanceof Error ? e.message : "ssh_fs_failed" });
        }
        return true;
      }

      // GET/POST /api/admin/prefs — server-side web preferences
      // (dw.json `prefs`). autoResume drives the boot-time open-turns sweep.
      // sshHosts ride prefs too; secrets (password/passphrase) are stripped on
      // the way OUT — the UI only sees hasPassword/hasPassphrase flags.
      if (p === "/api/admin/prefs" && m === "GET") {
        const prefs = loadReg(ctx).prefs ?? {};
        json(res, 200, { prefs: { ...prefs, sshHosts: (prefs.sshHosts ?? []).map(publicSshHost) } });
        return true;
      }
      if (p === "/api/admin/prefs" && m === "POST") {
        const body = await readJson(req);
        const r = loadReg(ctx);
        if (typeof body.autoResume === "boolean") (r.prefs ??= {}).autoResume = body.autoResume;
        // SSH targets for the draft page's local/remote picker — shape
        // [{name?, target: "user@host", cwd?}]; only these may be used by
        // sessions/new (the web has no auth — never accept arbitrary targets).
        if (Array.isArray(body.sshHosts)) {
          const prev = new Map((r.prefs?.sshHosts ?? []).map((h) => [h.target, h]));
          const hosts = (body.sshHosts as unknown[]).flatMap((h) => {
            const r0 = h as { name?: unknown; target?: unknown; cwd?: unknown; auth?: unknown; password?: unknown; keyPath?: unknown; passphrase?: unknown };
            const target = String(r0?.target ?? "").trim();
            if (!/^[A-Za-z0-9_.@%:+-]{1,200}$/.test(target)) return [];
            const old = prev.get(target);
            // Secret merge: field absent → keep stored value; "" → cleared.
            const secret = (v: unknown, keep: string | undefined) =>
              v === undefined ? keep : typeof v === "string" ? v.slice(0, 300) || undefined : undefined;
            const auth = r0.auth === "password" || r0.auth === "key" ? r0.auth : "agent";
            const host: SshHost = {
              name: typeof r0.name === "string" && r0.name.trim() ? r0.name.trim().slice(0, 60) : undefined,
              target,
              cwd: typeof r0.cwd === "string" && r0.cwd.trim() ? r0.cwd.trim().slice(0, 300) : undefined,
              auth: auth === "agent" ? undefined : auth,
              password: secret(r0.password, old?.password),
              keyPath: typeof r0.keyPath === "string" && r0.keyPath.trim() ? r0.keyPath.trim().slice(0, 300) : undefined,
              passphrase: secret(r0.passphrase, old?.passphrase),
            };
            return [host];
          }).slice(0, 50);
          (r.prefs ??= {}).sshHosts = hosts;
        }
        saveReg();
        json(res, 200, { ok: true, prefs: { ...r.prefs, sshHosts: (r.prefs?.sshHosts ?? []).map(publicSshHost) } });
        return true;
      }

      // 分身 (persona): global default mode/webhook/cap + per-session override
      // + manual ask. The persona session itself is created lazily on first ask.
      if (p === "/api/admin/persona" && m === "GET") {
        const r = loadReg(ctx);
        json(res, 200, { cfg: r.prefs?.persona ?? {}, sessionId: r.persona?.sessionId ?? null, decisions: decisionsTail(ctx, 50) });
        return true;
      }
      if (p === "/api/admin/persona" && m === "POST") {
        const body = await readJson(req);
        const r = loadReg(ctx);
        const pcfg = (r.prefs ??= {}).persona ??= {};
        if (body.mode === "off" || body.mode === "semi" || body.mode === "auto") pcfg.mode = body.mode;
        if (typeof body.webhook === "string") pcfg.webhook = body.webhook;
        if (typeof body.maxPerHour === "number" && body.maxPerHour > 0) pcfg.maxPerHour = Math.floor(body.maxPerHour);
        saveReg();
        json(res, 200, { ok: true, cfg: pcfg });
        return true;
      }
      if (p === "/api/admin/session-persona" && m === "POST") {
        const body = await readJson(req);
        const id = String(body.id ?? "");
        const mm = meta(ctx, id);
        if (body.mode === "off" || body.mode === "semi" || body.mode === "auto") mm.personaMode = body.mode;
        else if (body.mode === "inherit" || body.mode === null) delete mm.personaMode;
        saveReg();
        json(res, 200, { ok: true, persona: personaState(ctx, id) });
        return true;
      }
      if (p === "/api/admin/session-persona-ask" && m === "POST") {
        const body = await readJson(req);
        const id = String(body.id ?? "");
        if (!id || personaMode(ctx, id) === "off") { json(res, 400, { error: "persona_off" }); return true; }
        const handled = await askPersona(ctx, id, "manual");
        json(res, 200, { ok: true, handled });
        return true;
      }

      if (p === "/api/admin/mirror/indexed-paths" && m === "GET") {
        // @file mention source: index the session's workspace files. Bounded
        // BFS — heavy dirs skipped — cached briefly per workspace.
        const sid = url.searchParams.get("session") ?? "";
        const cwdParam = url.searchParams.get("cwd");
        const cwd = (cwdParam && path.resolve(cwdParam)) || (sid && ctx.sessionCwd.get(parseSubId(sid)?.parent ?? sid)) || ctx.primaryCwd;
        const paths = indexWorkspace(cwd);
        json(res, 200, { paths });
        return true;
      }
      if (p === "/api/admin/mirror/precheck" && m === "POST") {
        json(res, 200, { findings: [] });
        return true;
      }
      if (p === "/api/admin/mirror/transcribe" && m === "POST") {
        // Voice input: proxy the multipart recording to Devin's real
        // transcribe-audio endpoint (same contract as the official webapp:
        // audio_file + start_time). The account session token rides Bearer;
        // api.devin.ai 422-verified the route exists.
        const key = ctx.accounts.apiKey();
        if (!key) { json(res, 503, { text: null, error: "no devin account available" }); return true; }
        try {
          const body = await readBody(req);
          const ct = req.headers["content-type"] ?? "multipart/form-data";
          const r = await fetch("https://api.devin.ai/transcribe-audio", {
            method: "POST",
            headers: { authorization: `Bearer ${key}`, "content-type": ct },
            body,
            signal: AbortSignal.timeout(60_000),
          });
          const raw = await r.text();
          try {
            const j = JSON.parse(raw) as { text?: string; transcript?: string; detail?: unknown };
            const text = j.text ?? j.transcript ?? null;
            json(res, r.ok ? 200 : 502, { text, error: r.ok ? null : `upstream ${r.status}: ${raw.slice(0, 160)}` });
          } catch {
            json(res, r.ok ? 200 : 502, { text: r.ok ? raw : null, error: r.ok ? null : `upstream ${r.status}: ${raw.slice(0, 160)}` });
          }
        } catch (e) {
          json(res, 502, { text: null, error: e instanceof Error ? e.message : String(e) });
        }
        return true;
      }
      if (p === "/api/admin/mirror/translate" && m === "POST") {
        json(res, 200, UNSUPPORTED);
        return true;
      }

      // GET /api/admin/sessions — classic admin list
      if (p === "/api/admin/sessions" && m === "GET") {
        const sessions = (await listLocalSessions(ctx)).map((s) => {
          const m2 = meta(ctx, s.id);
          const items = ctx.sessionLog.get(s.id).length ? buildTimeline(ctx, s.id).items : [];
          const lastMsg = [...items].reverse().find((i) => i.kind === "message");
          return {
            id: s.id, devin_session_id: s.id, title: m2.title ?? s.title, devin_title: s.title,
            permission: m2.permission ?? "detailed", archived: m2.archived ? 1 : 0, pinned: m2.pinned ? 1 : 0,
            created_at: s.updated, status: sessionStatus(ctx, s.id).status,
            status_message: null, last_message: lastMsg?.body?.slice(0, 200) ?? "",
            last_timestamp: lastMsg?.ts ?? s.updated, share_url: `/s/${s.id}?t=local`,
          };
        });
        json(res, 200, { sessions });
        return true;
      }

      // POST /api/admin/sessions — register a session id (no-op record locally)
      if (p === "/api/admin/sessions" && m === "POST") {
        const body = await readJson(req);
        const id = String(body.devin_session_id ?? body.id ?? "");
        if (!id) { json(res, 400, { error: "missing session id" }); return true; }
        if (body.title) meta(ctx, id).title = String(body.title);
        saveReg();
        json(res, 200, { ok: true, id });
        return true;
      }

      // POST /api/admin/sessions/new — create a local session (+ optional task)
      // body.agent picks the ACP agent (devin default; user registry in
      // agents.json adds generic CLIs). Agent is a session-lifetime property —
      // persisted in dw.json meta so reloads route to the right process.
      if (p === "/api/admin/sessions/new" && m === "POST") {
        if (isDraining()) { json(res, 503, { error: "server restarting" }); return true; }
        const body = await readJson(req);
        // `ssh` runs the agent on a REMOTE host — only targets configured in
        // prefs.sshHosts are accepted (the web has no auth). The cwd is then
        // a path on the remote machine.
        const sshReq = typeof body.ssh === "string" && body.ssh.trim() ? body.ssh.trim() : null;
        const sshHosts = loadReg(ctx).prefs?.sshHosts ?? [];
        const sshHost = sshReq ? sshHosts.find((h) => h.target === sshReq) ?? null : null;
        if (sshReq && !sshHost) { json(res, 400, { error: "ssh target not configured — add it in the local/remote picker" }); return true; }
        const ssh = sshHost?.target ?? null;
        const cwd = ssh ? String(body.cwd ?? sshHost?.cwd ?? "~") : String(body.cwd ?? ctx.primaryCwd);
        const agent = agentById(body.agent);
        const acp = agent.multiSession
          ? await ctx.manager.get(cwd, agent, ssh)
          : await ctx.manager.startForSession(cwd, agent, ssh);
        const s = await acp.newSession(cwd);
        if (!agent.multiSession) {
          ctx.manager.bindSession(s.sessionId, acp);
          ctx.store.addAgentSession(s.sessionId, agent.id, cwd);
        }
        ctx.sessionCwd.set(s.sessionId, ssh ? cwd : remapLegacyCwd(cwd));
        if (ssh) ctx.sessionSsh.set(s.sessionId, ssh);
        captureLoadResponse(s.sessionId, s);
        let nset = loadedOn.get(acp);
        if (!nset) loadedOn.set(acp, (nset = new Set()));
        nset.add(s.sessionId);
        // Pin the owning process or the next prompt re-loads onto a pooled
        // acp and devin rejects it ("already open in another process").
        sessionHost.set(s.sessionId, acp);
        const mm = meta(ctx, s.sessionId);
        if (body.title) mm.title = String(body.title);
        if (body.folder) mm.folder = String(body.folder);
        if (agent.id !== "devin") mm.agent = agent.id;
        if (ssh) mm.ssh = ssh;
        saveReg();
        const task = String(body.task ?? "").trim();
        // apply last-used model/mode — desktop carries the pick into new sessions
        const last = loadReg(ctx).lastConfig ?? {};
        for (const [cfgId, val] of Object.entries(last)) {
          try {
            if (cfgId === "mode" || cfgId === "_mode") await acp.setMode(s.sessionId, val);
            else await acp.setConfigOption(s.sessionId, cfgId, val);
          } catch { /* group may not exist on this profile */ }
        }
        const atts = Array.isArray(body.attachments) ? body.attachments : [];
        if (task || atts.length) dispatchPrompt(ctx, s.sessionId, task || " ", atts);
        json(res, 200, { ok: true, id: s.sessionId, devin_session_id: s.sessionId });
        return true;
      }

      // Session-less staging for the /admin/new draft composer — same raw-body
      // contract as the session-scoped upload-stage.
      if (p === "/api/admin/upload-stage" && m === "POST") {
        json(res, 200, await stageUpload(req, ctx.store, url.searchParams.get("filename")));
        return true;
      }

      // Draft-page project browser: list dirs+files / read text, same shape as
      // the session workspace endpoints but rooted anywhere the picker reached.
      if (p === "/api/admin/fs/list" && m === "GET") {
        const target = path.resolve(url.searchParams.get("path") || ctx.primaryCwd);
        try {
          const entries = fs.readdirSync(target, { withFileTypes: true })
            .filter((e) => !e.name.startsWith(".git") && e.name !== "node_modules")
            .map((e) => ({ name: e.name, dir: e.isDirectory() }))
            .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
            .slice(0, 2000);
          json(res, 200, { cwd: target, entries });
        } catch { json(res, 400, { error: "bad_path" }); }
        return true;
      }
      if (p === "/api/admin/fs/file" && m === "GET") {
        const target = path.resolve(url.searchParams.get("path") || "");
        try {
          const buf = fs.readFileSync(target);
          if (buf.length > 2 * 1024 * 1024) { json(res, 413, { error: "too large" }); return true; }
          const bin = /[\x00-\x08]/.test(buf.subarray(0, 512).toString("binary"));
          json(res, 200, { text: bin ? null : buf.toString("utf8"), binary: bin });
        } catch { json(res, 404, { error: "not found" }); }
        return true;
      }

      if (p === "/api/admin/composer-meta" && m === "GET") {
        const sessions = (await listLocalSessions(ctx)).slice(0, 30).map((s) => ({ id: s.id, title: s.title, snippet: "" }));
        // slash commands + repos from any currently-loaded session's config
        let commands: { command: string; description: string; hint?: string }[] = [];
        const repos = (ctx.store.workspaces() ?? []).map((w) => ({ name: String(w).split(/[\\/]/).pop() || String(w), org: String(w) }));
        // best-effort: pull commands from the most recently-active logged session
        let newest = 0;
        for (const s of sessions) {
          const log = ctx.sessionLog.get(s.id);
          const last = log[log.length - 1]?.ts ?? 0;
          if (last > newest) { newest = last; }
        }
        for (const s of sessions) {
          const log = ctx.sessionLog.get(s.id);
          if ((log[log.length - 1]?.ts ?? 0) === newest && newest) {
            commands = sessionConfig(ctx, s.id).commands.map((c) => ({ command: c.name, description: c.description ?? "", hint: c.input?.hint }));
            break;
          }
        }
        // No session replayed its commands yet this boot — the agent-level
        // fallback inside sessionConfig (last load-response / last seen set)
        // still resolves against any known session id.
        if (!commands.length && sessions[0]) {
          commands = sessionConfig(ctx, sessions[0].id).commands.map((c) => ({ command: c.name, description: c.description ?? "", hint: c.input?.hint }));
        }
        // Draft-page cfg: agent-level modes/configOptions/model so the
        // /admin/new composer shows the real mode+model pills before any
        // session exists (same lastAgentCfg fallback sessionConfig uses).
        const cfg = sessionConfig(ctx, sessions[0]?.id ?? "");
        // Enabled agents for the draft picker's dropdown (disabled entries
        // stay hidden — their existing sessions still run via meta.agent).
        const agents = listAgents().filter((a) => !a.disabled).map((a) => ({ id: a.id, label: a.label }));
        json(res, 200, { commands, skills: scanLocalSkills(ctx), playbooks: [], secrets: [], macros: [], repos, sessions, primary_cwd: ctx.primaryCwd, cfg, last_config: loadReg(ctx).lastConfig ?? {}, agents, ssh_hosts: (loadReg(ctx).prefs?.sshHosts ?? []).map(publicSshHost) });
        return true;
      }

      // Agent registry: GET lists every entry (builtin + user) with install
      // probe status; PUT rewrites the user layer (agents.json) wholesale.
      if (p === "/api/admin/agents" && m === "GET") {
        const probe = url.searchParams.get("probe") === "1";
        const rows = await Promise.all(listAgents().map(async (a) => ({
          id: a.id,
          label: a.label,
          command: a.command,
          args: a.args,
          multiSession: a.multiSession,
          versionArgs: a.versionArgs,
          env: a.env,
          shell: a.shell === true,
          custom: !!a.custom,
          enabled: !a.disabled,
          installed: probe ? (await probeAgent(a)) : null,
        })));
        json(res, 200, { agents: rows });
        return true;
      }
      if (p === "/api/admin/agents" && m === "PUT") {
        const body = await readJson(req);
        const list = Array.isArray(body?.agents) ? body.agents : [];
        const r = saveUserAgents(list);
        json(res, 200, r);
        return true;
      }

      // Multi-level agent resources: global (~/.devin, ~/.agents) + project
      // (<cwd>/.devin, <cwd>/.agents). Enumerate rules/skills for /settings.
      if (parts[2] === "resources" && m === "GET") {
        const scopes = [
          { scope: "project" as const, dir: path.join(ctx.primaryCwd, ".devin") },
          { scope: "project" as const, dir: path.join(ctx.primaryCwd, ".agents") },
          { scope: "global" as const, dir: path.join(os.homedir(), ".devin") },
          { scope: "global" as const, dir: path.join(os.homedir(), ".agents") },
        ];
        const rules: { scope: string; name: string; path: string }[] = [];
        const skills: { scope: string; name: string; description: string; path: string }[] = [];
        const seenSkill = new Set<string>();
        const listMd = (dir: string, scope: string, rel: string) => {
          try {
            for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
              const p = path.join(dir, rel, e.name);
              if (e.isDirectory()) listMd(dir, scope, rel ? `${rel}/${e.name}` : e.name);
              else if (/\.(md|txt|mdc)$/i.test(e.name)) rules.push({ scope, name: e.name, path: p });
            }
          } catch { /* missing dir */ }
        };
        for (const { scope, dir } of scopes) {
          listMd(dir, scope, "rules");
          try {
            for (const e of fs.readdirSync(path.join(dir, "skills"), { withFileTypes: true })) {
              if (!e.isDirectory() || seenSkill.has(e.name)) continue;
              const md = path.join(dir, "skills", e.name, "SKILL.md");
              let desc = "";
              try {
                const head = fs.readFileSync(md, "utf8").slice(0, 4000);
                const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head)?.[1] ?? "";
                desc = /^description:\s*(.+)$/m.exec(fm)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
              } catch { continue; }
              seenSkill.add(e.name);
              skills.push({ scope, name: e.name, description: desc.slice(0, 200), path: md });
            }
          } catch { /* no skills dir */ }
        }
        // AGENTS.md / CLAUDE.md at the project root count as project rules.
        for (const f of ["AGENTS.md", "CLAUDE.md", ".windsurfrules", ".cursorrules"]) {
          const p = path.join(ctx.primaryCwd, f);
          if (fs.existsSync(p)) rules.push({ scope: "project", name: f, path: p });
        }
        json(res, 200, { cwd: ctx.primaryCwd, rules, skills });
        return true;
      }

      // /api/admin/resource-file?path= — read/write files under the resource
      // roots only (project .devin/.agents + global ~/.devin/~/.agents + the
      // project-root agent files). Confined exactly like session /file ops.
      if (parts[2] === "resource-file") {
        const roots = [
          path.join(ctx.primaryCwd, ".devin"), path.join(ctx.primaryCwd, ".agents"),
          path.join(os.homedir(), ".devin"), path.join(os.homedir(), ".agents"),
        ];
        const extra = ["AGENTS.md", "CLAUDE.md", ".windsurfrules", ".cursorrules"].map((f) => path.resolve(ctx.primaryCwd, f));
        const raw = m === "GET" ? url.searchParams.get("path") : String((await readJson(req)).path ?? "");
        const rp = raw ? path.resolve(raw) : "";
        const ok = !!rp && (roots.some((r) => rp === path.resolve(r) || rp.startsWith(path.resolve(r) + path.sep)) || extra.includes(rp));
        if (!ok) { json(res, 403, { error: "outside resource roots" }); return true; }
        if (m === "GET") {
          try {
            const buf = fs.readFileSync(rp);
            json(res, 200, { text: buf.toString("utf8"), binary: /[\x00-\x08]/.test(buf.subarray(0, 512).toString("binary")) });
          } catch { json(res, 404, { error: "not found" }); }
          return true;
        }
        if (m === "POST") {
          const body = await readJson(req);
          try {
            fs.mkdirSync(path.dirname(rp), { recursive: true });
            fs.writeFileSync(rp, String(body.text ?? ""), "utf8");
            json(res, 200, { ok: true });
          } catch (e) { json(res, 500, { error: e instanceof Error ? e.message : "write failed" }); }
          return true;
        }
        json(res, 405, { error: "method" });
        return true;
      }

      // /api/admin/resolve/<hex> — official-link resolution has no cloud meaning locally
      if (parts[2] === "resolve") {
        json(res, 404, { error: "no upstream session" });
        return true;
      }

      // ======================= per-session routes =======================
      if (parts[2] === "session" && parts.length >= 4) {
        const id = decodeURIComponent(parts[3]);
        // Multi-segment subpath: "subagent/<aid>/timeline" etc.
        const sub = parts.slice(4).join("/");

        // sub:<parent>:<agentId> — a subagent as a first-class child session
        // (cloud parity: child sessions open as full session pages). Data
        // lives in the parent's log; unhandled subs fall through to the
        // generic handlers (files/file/file-raw work via cwdFor → parent cwd).
        const subRef = parseSubId(id);
        if (subRef) {
          
          if (await handleSubSession(ctx, subRef, id, sub, m, req, res, url)) return true;
        }

        // PR review endpoints (PrPanel) — GitHub data via `gh api`; the panel
        // sends pr_url, not the session's repo, so this stays session-agnostic
        // data plumbing inside the admin tree.
        if (sub === "pr" || sub.startsWith("pr-")) {
          if (await handlePrRoute(ctx, sub, m, req, res, url)) return true;
        }

        // GET /api/admin/session/:id — detail (slim or full). Memory-only:
        // this is also hit by sidebar prefetch; triggering a history replay
        // here would bump the session's updatedAt on every hover.
        if (!sub && m === "GET") {
          const items = buildTimeline(ctx, id).items;
          const mm = meta(ctx, id);
          const st = sessionStatus(ctx, id);
          const cfg = sessionConfig(ctx, id);
          json(res, 200, {
            session: {
              id, devin_session_id: id,
              title: mm.title ?? titleFromLog(ctx, id) ?? "Untitled session",
              devin_title: titleFromLog(ctx, id) ?? "Untitled session",
              permission: mm.permission ?? "detailed",
              archived: mm.archived ? 1 : 0,
              status: st.status, status_message: null,
              current_devin_version: cfg.model?.currentName ?? null,
              pull_requests: [], repos: [cwdFor(ctx, id)],
              cwd: cwdFor(ctx, id),
              is_locked: false,
              loaded_here: ctx.sessionLog.get(id).length > 0 || loadInflight.has(id) || inflight.has(id),
              context_usage: lastContextUsage(ctx, id),
              // Owning ACP agent — the client degrades devin-private UI
              // (share/end-session/subagents) for other agents' sessions.
              agent: mm.agent ?? ctx.store.agentSession(id)?.agent ?? "devin",
              // Fork = native session/fork or transcript-seed fallback; only
              // dedicated single-session agents can't host a second session.
              canFork: agentById(mm.agent ?? ctx.store.agentSession(id)?.agent).multiSession,
            },
            // Detail is polled every few seconds — the frontend only needs a
            // presence check / composer hint, not the whole transcript.
            messages: buildMessages(items.slice(-60)),
            share_url: `/s/${id}?t=local`,
            dashboard_url: `/api/session/${id}/dashboard?token=local`,
            media_token: "local",
          });
          return true;
        }

        const sharedH = sessionSubs[`${sub}:${m}`];
        if (sharedH) { await sharedH(ctx, id, req, res, url); return true; }

        // Editor write/ops — ADMIN ONLY (never in sessionSubs: share links must
        // not write). All paths confined inside the session cwd.
        if (sub === "file-write" && m === "POST") {
          const body = await readJson(req);
          const cwd = cwdFor(ctx, id);
          const full = confined(cwd, body.path);
          if (!full) { json(res, 400, { error: "path escapes cwd" }); return true; }
          try {
            fs.mkdirSync(path.dirname(full), { recursive: true });
            const buf = typeof body.base64 === "string" ? Buffer.from(body.base64, "base64") : Buffer.from(String(body.text ?? ""), "utf8");
            if (buf.length > 50 * 1024 * 1024) { json(res, 413, { error: "too large" }); return true; }
            fs.writeFileSync(full, buf);
            json(res, 200, { ok: true, size: buf.length });
          } catch (e) { json(res, 500, { error: (e as Error).message }); }
          return true;
        }
        if (sub === "file-ops" && m === "POST") {
          const body = await readJson(req);
          const cwd = cwdFor(ctx, id);
          const full = confined(cwd, body.path);
          if (!full) { json(res, 400, { error: "path escapes cwd" }); return true; }
          const dest = typeof body.to === "string" ? confined(cwd, body.to) : null;
          const needDest = body.op === "rename" || body.op === "move" || body.op === "copy";
          if (needDest && !dest) { json(res, 400, { error: "destination escapes cwd" }); return true; }
          try {
            switch (body.op) {
              case "rename": fs.renameSync(full, dest!); break;
              case "move": fs.renameSync(full, path.join(dest!, path.basename(full))); break;
              case "copy": fs.cpSync(full, dest!, { recursive: true }); break;
              case "mkdir": fs.mkdirSync(full, { recursive: true }); break;
              case "newfile": if (fs.existsSync(full)) { json(res, 409, { error: "exists" }); return true; } fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, ""); break;
              case "delete": fs.rmSync(full, { recursive: true, force: true }); break;
              default: json(res, 400, { error: `unknown op ${body.op}` }); return true;
            }
            json(res, 200, { ok: true });
          } catch (e) { json(res, 500, { error: (e as Error).message }); }
          return true;
        }

        // GET file-git — VSCode-style git status map for the workspace tree.
        // {git:false} for non-repo cwds; otherwise map relpath→status letter.
        if (sub === "file-git" && m === "GET") {
          const cwd = cwdFor(ctx, id);
          const cache = (gitStatusCache.get(id) ?? { at: 0, body: { git: false, map: {} } }) as { at: number; body: unknown };
          if (Date.now() - cache.at < 8000) { json(res, 200, cache.body); return true; }
          let body: { git: boolean; map: Record<string, string> } = { git: false, map: {} };
          try {
            const r = spawnSync("git", ["status", "--porcelain=v1", "-z", "--ignored=no"], { cwd, encoding: "buffer", timeout: 5000, windowsHide: true });
            if (r.status === 0 && r.stdout) {
              const map: Record<string, string> = {};
              const segs = r.stdout.toString("utf8").split("\0");
              for (let i = 0; i + 0 < segs.length; i++) {
                const line = segs[i];
                if (!line) continue;
                const x = line[0], y = line[1];
                const rel = line.slice(3);
                const st = y !== " " ? y : x;
                map[rel.replace(/\\/g, "/")] = st === "?" ? "U" : (st || "M");
                if (x === "R" || x === "C") i++; // rename/copy: skip the source path field
              }
              body = { git: true, map };
            }
          } catch { /* git absent or not a repo */ }
          gitStatusCache.set(id, { at: Date.now(), body });
          json(res, 200, body);
          return true;
        }

        if (sub === "timeline" && m === "GET") {
          // Kick off the replay but DON'T await it. While it runs, serve the
          // snapshot (pre-reload log / persisted tail) so the UI sits on the
          // newest messages instead of watching mid-history stream by; cold
          // sessions with no snapshot get a clean loading state rather than
          // old entries mislabeled as newest.
          // peek=1 — lazy read: serve snapshot/memory WITHOUT kicking off a
          // session/load (devin counts loads as activity and bumps the
          // session's updatedAt; casual browsing must stay free). The client
          // graduates to a real fetch on dwell/interaction.
          const peek = url.searchParams.get("peek") === "1";
          if (!peek) void ensureLoaded(ctx, id);
          const loading = !peek && loadInflight.has(id);
          const { items: live, gen } = buildTimeline(ctx, id);
          const snap = (loading || peek || !live.length) ? snapshotItems(ctx, id) : null;
          // During replay serve ONLY the old-gen snapshot; afterwards ONLY
          // the rebuilt live items — never mix generations. In peek mode the
          // snapshot wins unless the live log already holds more (newer) data.
          const serveSnap = !!snap && (loading || (peek && snap.length >= live.length));
          const all = serveSnap ? snap : live;
          // Consume the reset flag only when actually serving new-gen items.
          const reset = !loading && !serveSnap && tlReset.delete(id);
          // Page from the END (newest). `limit` items per page; `cursor` is the
          // exclusive upper index of the next-older page, so clients paging
          // backwards pass it back verbatim. Frozen (null) while a replay is
          // in flight — indexes shift mid-replay, so back-paging then would
          // land on misaligned slices.
          const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get("limit") ?? "300", 10) || 300));
          const cursor = url.searchParams.get("cursor");
          if (url.searchParams.get("raw") === "1") {
            json(res, 200, { entries: ctx.sessionLog.get(id) });
            return true;
          }
          const end = cursor !== null ? Math.min(all.length, Math.max(0, parseInt(cursor, 10) || 0)) : all.length;
          const start = Math.max(0, end - limit);
          const items = loading && !snap ? [] : all.slice(start, end);
          const st = sessionStatus(ctx, id);
          json(res, 200, {
            items,
            // Peek pages can't back-page: snapshot indexes don't line up with
            // the live log, so older history needs a real (loading) fetch.
            next_cursor: !loading && !peek && start > 0 ? String(start) : null,
            error: null, queue: queueList(id),
            // `reset` tells clients the log was rebuilt (replay / disk
            // re-seed): merge must be replaced wholesale or stale-window
            // items linger next to their seq-id twins.
            reset: reset || undefined,
            // Generation of the items actually served (0 = snapshot);
            // timeline_delta events carry the same marker.
            gen: serveSnap ? 0 : gen,
            peek: peek || undefined,
            activity: loading ? { text: "Loading history…" } : st.status === "working" ? { text: "working" } : null,
            // A turn that died mid-flight (server crash / killed acp) — the
            // original message so the client can offer one-click resend.
            interrupted: interruptedTurn(ctx, id) ?? undefined,
            persona: personaState(ctx, id),
          });
          return true;
        }

        // GET .../index — full-history session index (official historySkeleton
        // parity): every user message + PR event across the whole log, not
        // just the loaded window. Fields mirror what the client indexEntries
        // merge needs (id/ts/kind/body/pr) with body truncated server-side.
        if (sub === "index" && m === "GET") {
          const { items } = buildTimeline(ctx, id);
          const entries = items
            .filter((it) => (it.kind === "message" && it.role === "user") || (it.kind === "git" && it.raw_type === "pr_created"))
            .map((it) => ({
              id: it.id, ts: it.ts, kind: it.kind, raw_type: it.raw_type,
              role: it.role,
              body: it.body ? it.body.slice(0, 1200) : undefined,
            }));
          json(res, 200, { entries });
          return true;
        }

        if (sub === "changes" && m === "GET") {
          // Memory-only panel data — replay is already driven by /timeline.
          const items = buildTimeline(ctx, id).items;
          const files = new Map<string, { path: string; added: number; removed: number; firstPrevKey?: string; lastKey?: string; actionType?: string }>();
          for (const it of items) {
            if (it.kind !== "edit") continue;
            for (const f of it.fileUpdates ?? []) {
              const cur = files.get(f.file_path) ?? { path: f.file_path, added: 0, removed: 0 };
              cur.added += f.lines_added ?? 0;
              cur.removed += f.lines_removed ?? 0;
              cur.lastKey = f.fileId;
              files.set(f.file_path, cur);
            }
          }
          json(res, 200, { files: [...files.values()], truncated: false, error: null });
          return true;
        }

        if (sub === "todos" && m === "GET") {
          const items = buildTimeline(ctx, id).items;
          const last = [...items].reverse().find((i) => i.kind === "todo" && i.todos?.length);
          json(res, 200, { todos: last?.todos ?? [] });
          return true;
        }

        if (sub === "queue" && m === "GET") {
          json(res, 200, { queue: queueList(id) });
          return true;
        }
        // POST .../queue {message} — park a prompt while a turn is in flight;
        // dispatchPrompt's settle path flushes it FIFO (queueFlush).
        if (sub === "queue" && m === "POST") {
          const body = (await readJson(req)) as { message?: string };
          const text = (body.message ?? "").trim();
          if (!text) { json(res, 400, { error: "empty message" }); return true; }
          if (isDraining()) { json(res, 503, { error: "server restarting" }); return true; }
          if (!inflight.has(id) && !queueList(id).length) {
            dispatchPrompt(ctx, id, text, []);
            json(res, 200, { ok: true, sent: true });
            return true;
          }
          const m2 = queueAdd(ctx, id, text);
          if (!inflight.has(id)) queueFlush(ctx, id); // idle + stale queue → keep FIFO moving
          json(res, 200, { ok: true, id: m2.id });
          return true;
        }
        if (sub === "queue-op" && m === "POST") {
          const body = (await readJson(req)) as { op?: string; id?: string; ids?: string[]; message?: string };
          const q = queueList(id);
          switch (body.op) {
            case "remove": queueRemove(ctx, id, body.id ?? ""); break;
            case "clear": for (const m2 of [...q]) queueRemove(ctx, id, m2.id); break;
            case "edit": { const m2 = q.find((x) => x.id === body.id); if (m2 && body.message) m2.text = body.message; break; }
            case "reorder": {
              if (Array.isArray(body.ids)) {
                const byId = new Map(q.map((x) => [x.id, x]));
                const next = body.ids.map((x) => byId.get(x)).filter((x): x is NonNullable<typeof x> => !!x);
                q.splice(0, q.length, ...next);
              }
              break;
            }
            case "send_now": {
              if (isDraining()) break;
              // Two shapes: {id} pulls a queued row; {message} is the
              // draft-free "send immediately" path. Busy → cancel the live
              // turn so settle→queueFlush fires the front item right away
              // ("立即发送" really interrupts); idle → dispatch directly.
              const i = q.findIndex((x) => x.id === body.id);
              let armed = false;
              if (i >= 0) {
                const [m2] = q.splice(i, 1);
                q.unshift(m2);
                armed = true;
              } else if (typeof body.message === "string" && body.message.trim()) {
                const m2 = queueAdd(ctx, id, body.message.trim());
                q.splice(q.indexOf(m2), 1);
                q.unshift(m2);
                armed = true;
              }
              if (!armed) break;
              if (inflight.has(id)) {
                try { (await acpForId(ctx, id)).cancel(id); } catch { /* not running */ }
              } else {
                queueFlush(ctx, id);
              }
              break;
            }
            default: break; // hold/unhold are client-side edit state
          }
          json(res, 200, { ok: true });
          return true;
        }

        if (sub === "sidechains" && m === "GET") {
          json(res, 200, { threads: [] });
          return true;
        }
        if ((sub === "sidechain" || sub === "sidechain/cancel") && m === "POST") {
          json(res, 200, sub === "sidechain" ? UNSUPPORTED : { ok: true });
          return true;
        }

        // Wake/resume on a main session is a UI no-op — nothing sleeps
        // server-side; the next message just dispatches on the live acp.
        if (sub === "resume" && m === "POST") { await readBody(req); json(res, 200, { ok: true }); return true; }

        // Stop button posts /pause, End session posts /end — locally both
        // mean turn cancel (session/cancel settles the prompt RPC as
        // outcome:cancelled; settle → inflight clear → queueFlush runs).
        if ((sub === "cancel" || sub === "pause" || sub === "stop" || sub === "end") && m === "POST") {
          try { (await acpForId(ctx, id)).cancel(id); } catch { /* not running */ }
          json(res, 200, { ok: true });
          return true;
        }

        if (sub === "subagents" && m === "GET") {
          json(res, 200, { subagents: subsAny(ctx, id, "root") });
          return true;
        }

        // GET .../resources — agent-level context: rules, skills catalog,
        // spawnable subagent profiles, plans, hooks, agent config. Uses the
        // pooled host WITHOUT session/load (reads are agent-scoped, not
        // transcript-scoped — no replay cost, no updatedAt bump).
        if (sub === "resources" && m === "GET") {
          const { acp, cwd } = await hostFor(ctx, id);
          const errors: Record<string, string> = {};
          // ext methods disagree on scope: some take {sessionId,cwd}, some are
          // agent-scoped ({cwd}) or take nothing at all — walk the candidates.
          const call = (key: string, method: string, shapes: Record<string, unknown>[]) =>
            (async () => {
              let last: unknown = null;
              for (const params of shapes) {
                try { return (await acp.extMethod(id, method, params) as Record<string, unknown>) ?? {} } catch (e) { last = e }
              }
              errors[key] = last instanceof Error ? last.message : String(last ?? "failed");
              return null;
            })();
          const [rules, skills, profiles, plans, hooks, config] = await Promise.all([
            call("rules", "_cognition.ai/rules/list", [{ sessionId: id, cwd }, { cwd }, {}]),
            call("skills", "_cognition.ai/skills/list", [{ sessionId: id, cwd }, { cwd }]),
            call("subagentProfiles", "_cognition.ai/subagents/list", [{ sessionId: id, cwd }, { cwd }]),
            call("plans", "_cognition.ai/plans/list", [{ sessionId: id, cwd }, { cwd }, {}]),
            call("hooks", "_cognition.ai/hooks/list", [{ sessionId: id, cwd }, { cwd }, {}]),
            call("config", "_cognition.ai/config/read", [{ sessionId: id }, {}]),
          ]);
          json(res, 200, {
            rules: rules?.rules ?? null,
            skills: skills?.skills ?? null,
            subagentProfiles: profiles?.subagents ?? profiles?.profiles ?? null,
            plans: plans?.plans ?? null,
            hooks: hooks?.hooks ?? null,
            config: config?.config ?? null,
            ...(Object.keys(errors).length ? { errors } : {}),
          });
          return true;
        }

        // Debug: raw extension-method passthrough — POST {method, params}.
        // Uses hostFor (NO session/load): this is a probe console, replay must
        // not run. Pass load:1 in the body for methods that need a loaded
        // session.
        if (sub === "ext" && m === "POST") {
          const body = await readJson(req);
          const method = String(body.method ?? "");
          if (!/^_?cognition\.ai\//.test(method)) { json(res, 400, { error: "ext methods only" }); return true; }
          try {
            const acp = body.load ? await acpForId(ctx, id) : (await hostFor(ctx, id)).acp;
            const result = await acp.extMethod(id, method, body.params as Record<string, unknown> | undefined);
            json(res, 200, { ok: true, result });
          } catch (err) {
            json(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) });
          }
          return true;
        }

        const subMatch = /^subagent\/([^/]+)\/(timeline|message|control)$/.exec(sub);
        if (subMatch) {
          const agentId = decodeURIComponent(subMatch[1]);
          const act = subMatch[2];
          if (act === "timeline" && m === "GET") {
            json(res, 200, { items: subagentTimeline(ctx, id, agentId) });
            return true;
          }
          if (act === "message" && m === "POST") {
            const body = await readJson(req);
            const text = String(body.message ?? body.text ?? "").trim();
            if (!text) { json(res, 400, { error: "empty message" }); return true; }
            if (isDraining()) { json(res, 503, { error: "server restarting" }); return true; }
            if (agentId.startsWith("spawn:")) { json(res, 400, { error: "subagent transcript not replayed; cannot message" }); return true; }
            // Busy → park like the main message path: concurrent dispatches
            // would overwrite each other's open-turns entry (it's a per-
            // session map slot, not per-turn).
            if (inflight.has(id) || queueList(id).length) {
              const m2 = queueAdd(ctx, id, text, [], { subagentId: agentId });
              if (!inflight.has(id)) queueFlush(ctx, id);
              json(res, 200, { ok: true, queued: m2.id });
              return true;
            }
            dispatchPrompt(ctx, id, text, [], agentId);
            json(res, 200, { ok: true });
            return true;
          }
          if (act === "control" && m === "POST") {
            const body = await readJson(req);
            const action = String(body.action ?? "");
            if (!["cancel", "foreground", "background"].includes(action)) {
              json(res, 400, { error: "bad action" });
              return true;
            }
            if (agentId.startsWith("spawn:")) { json(res, 200, { ok: false, error: "subagent not live (replayed)" }); return true; }
            try {
              const acp = await acpForId(ctx, id);
              await acp.subagentControl(id, agentId, action as "cancel" | "foreground" | "background");
              json(res, 200, { ok: true });
            } catch (err) {
              json(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) });
            }
            return true;
          }
        }

        if (sub === "permission-response" && m === "POST") {
          const body = await readJson(req);
          const rid = String(body.request_id ?? "");
          const approved = body.approved !== false;
          const owner = ctx.permissionOwner.get(rid);
          if (!owner) { json(res, 200, { ok: false }); return true; }
          // Recover the original option list from the logged request so we can
          // pick a real optionId (allow_once/allow_always/reject_*).
          let optionId: string | null = null;
          const log = ctx.sessionLog.get(id);
          for (let i = log.length - 1; i >= 0; i--) {
            const u = log[i].update as Record<string, unknown>;
            if (u.sessionUpdate === "permission_request" && String(u.requestId) === rid) {
              const opts = (u.options as { optionId: string; kind?: string; name?: string }[] | undefined) ?? [];
              const find = (pred: (k: string) => boolean) => opts.find((o) => pred(o.kind ?? o.name ?? o.optionId))?.optionId;
              optionId = approved
                ? (body.bypass_all_future
                  ? find((k) => /always|always_allow|bypass/i.test(k)) ?? find((k) => /allow/i.test(k))
                  : find((k) => /allow_once|once|allow|proceed|yes/i.test(k))) ?? opts[0]?.optionId ?? null
                : find((k) => /reject|deny|no/i.test(k)) ?? null;
              break;
            }
          }
          const ok = owner.resolvePermission(rid, optionId);
          ctx.permissionOwner.delete(rid);
          ctx.hub.broadcast({ type: "permission_resolved", requestId: rid });
          ctx.sessionLog.append(id, { sessionUpdate: "permission_resolved", requestId: rid, optionId });
          noteUpdate(ctx, id);
          json(res, 200, { ok });
          return true;
        }

        // GET /api/admin/session/:id/config — real ACP config options (mode/model).
        // NEVER starts a session/load (browsing must not bump updatedAt);
        // only waits for one already in flight, briefly, before falling back
        // to the agent-level config. POST /config does load — that's a real op.
        if (sub === "config" && m === "GET") {
          await Promise.race([loadInflight.get(id)?.p ?? Promise.resolve(), new Promise((r) => setTimeout(r, 2500))]);
          const cfg = sessionConfig(ctx, id);
          if (url.searchParams.get("raw") === "1") {
            const cfgUpdates = ctx.sessionLog.get(id)
              .map((e) => e.update as { sessionUpdate?: string; configOptions?: { id?: string; currentValue?: string }[]; currentModeId?: string })
              .filter((u) => u.sessionUpdate === "config_option_update" || u.sessionUpdate === "current_mode_update")
              .slice(-6);
            json(res, 200, { cfg, responseCfg: responseCfg.get(id), cfgUpdates });
          } else {
            json(res, 200, { options: cfg.options, mode: cfg.mode, commands: cfg.commands, model: cfg.model });
          }
          return true;
        }
        if (sub === "config" && m === "POST") {
          const body = await readJson(req);
          const acp = await acpForId(ctx, id);
          const configId = String(body.configId);
          const value = String(body.value);
          // `mode` is dual-exposed by devin: a modes state (set via
          // session/set_mode) AND a configOptions mirror group that only
          // refreshes when the agent repushes config. Route both ids to
          // set_mode so the change actually sticks.
          const isMode = configId === "_mode" || configId === "mode";
          const result = isMode
            ? await acp.setMode(id, value)
            : await acp.setConfigOption(id, configId, value);
          // setSessionConfigOption returns the full refreshed configOptions — keep them.
          const ropts = (result as { configOptions?: ConfigOption[] } | null)?.configOptions;
          if (ropts) responseCfg.set(id, { ...(responseCfg.get(id) ?? {}), configOptions: ropts, echoTs: Date.now() });
          if (isMode) {
            const prev = responseCfg.get(id);
            // Update both layers: modes.currentModeId AND the configOptions
            // mirror group's currentValue.
            responseCfg.set(id, {
              configOptions: (prev?.configOptions ?? []).map((o) => o.id === "mode" ? { ...o, currentValue: value } : o),
              modes: { currentModeId: value, availableModes: prev?.modes?.availableModes ?? [] },
              echoTs: Date.now(),
            });
          }
          noteLastUsed(ctx, isMode ? "mode" : configId, value);
          ctx.hub.broadcast({ type: "session_update", sessionId: id, update: { sessionUpdate: "config_option_update", configOptions: ropts ?? [] } });
          json(res, 200, result ?? { ok: true });
          return true;
        }

        // POST /api/admin/session/:id/version — cloud model pill → local model config
        if (sub === "version" && m === "POST") {
          const body = await readJson(req);
          const cfg = sessionConfig(ctx, id);
          const value = cloudVersionToModel(String(body.version ?? ""), cfg.model?.options ?? []);
          if (!value || !cfg.model) { json(res, 200, { ok: false, error: "model option unavailable" }); return true; }
          const acp = await acpForId(ctx, id);
          const result = await acp.setConfigOption(id, cfg.model.id, value);
          json(res, 200, result ?? { ok: true });
          return true;
        }

        if (sub === "permission" && m === "POST") {
          const body = await readJson(req);
          meta(ctx, id).permission = String(body.permission ?? "detailed");
          saveReg();
          json(res, 200, { ok: true });
          return true;
        }

        if (sub === "archive" && m === "POST") {
          const body = await readJson(req);
          meta(ctx, id).archived = !!body.archived;
          saveReg();
          json(res, 200, { ok: true });
          return true;
        }

        // POST .../end — desktop "End session". Verified: {_cognition.ai/
        // session/end, {sessionId, reason}} → {dispatched:true} on this build.
        if (sub === "end" && m === "POST") {
          try {
            const acp = await acpForId(ctx, id);
            const r = await acp.extMethod(id, "_cognition.ai/session/end", { sessionId: id, reason: "user" });
            json(res, 200, { ok: true, result: r });
          } catch (e) { json(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) }); }
          return true;
        }

        // POST .../share — uploads transcript to Devin cloud, returns a public
        // app.devin.ai link. Verified: {_cognition.ai/session/share,{sessionId}}
        // → {shareId,url,truncated}. Requires loaded session (acpForId).
        if (sub === "share" && m === "POST") {
          try {
            const acp = await acpForId(ctx, id);
            const r = await acp.extMethod(id, "_cognition.ai/session/share", { sessionId: id }) as Record<string, unknown> | undefined;
            json(res, 200, { ok: true, url: String(r?.url ?? ""), shareId: String(r?.shareId ?? ""), truncated: !!r?.truncated });
          } catch (e) { json(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) }); }
          return true;
        }

        // POST .../restart — kill the acp hosting this session; the next op
        // respawns + replays history (local analog of cloud "reboot VM").
        if (sub === "restart" && m === "POST") {
          restartSession(ctx, id);
          json(res, 200, { ok: true });
          return true;
        }

        // POST .../fork — clone the session. Native ACP `session/fork` when the
        // agent advertises sessionCapabilities.fork (opencode does); devin's
        // local acp has no fork, so the fallback opens a new session on the
        // same process and seeds it with a handoff prompt (model-written
        // summary when the handoff writer answers; mechanical transcript
        // extract as fallback).
        if (sub === "fork" && m === "POST") {
          const body = await readJson(req);
          // `anchor` = timeline item id ("e<seq>") to fork FROM that message.
          // ACP session/fork only clones at head, so an anchored fork always
          // takes the transcript-seed path (uniform across agents).
          const anchor = typeof body.anchor === "string" && /^e\d+$/.test(body.anchor) ? Number(body.anchor.slice(1))
            : typeof body.anchor === "number" ? body.anchor : null;
          const { acp, cwd } = await hostFor(ctx, id);
          const agent = agentById(ctx.store.agentSession(id)?.agent ?? meta(ctx, id).agent);
          if (!agent.multiSession) {
            json(res, 409, { error: "该 Agent 每进程仅承载一个会话，无法分叉" });
            return true;
          }
          // Anchored forks need source material at/before the anchor —
          // validate BEFORE creating the child session so a 409 leaks nothing.
          if (anchor !== null) {
            let any = false;
            for (const e of ctx.sessionLog.get(id)) {
              const u = e.update as { sessionUpdate?: string; content?: { text?: string } };
              if ((u.sessionUpdate === "user_message_chunk" || u.sessionUpdate === "agent_message_chunk")
                && u.content?.text && (e.seq ?? -1) <= anchor) { any = true; break; }
            }
            if (!any) { json(res, 409, { error: "该位置之前没有可分叉的消息" }); return true; }
          }
          const srcTitle = meta(ctx, id).title ?? titleFromLog(ctx, id) ?? "Untitled session";
          let newId: string | null = null;
          let forkRes: unknown = null;
          let native = false;
          if (anchor === null && acp.supportsFork) {
            const r = (await acp.forkSession(id, cwd)) as { sessionId?: string } | null;
            newId = r?.sessionId ?? null;
            forkRes = r;
            native = !!newId;
          }
          if (!newId) {
            const s = await acp.newSession(cwd);
            newId = s.sessionId;
            forkRes = s;
          }
          let nset = loadedOn.get(acp);
          if (!nset) loadedOn.set(acp, (nset = new Set()));
          nset.add(newId);
          sessionHost.set(newId, acp);
          ctx.sessionCwd.set(newId, cwd);
          captureLoadResponse(newId, forkRes);
          const mm = meta(ctx, newId);
          mm.title = `${srcTitle} (fork)`;
          (mm as Record<string, unknown>).forkedFrom = anchor !== null ? `${id}@${anchor}` : id;
          if (agent.id !== "devin") mm.agent = agent.id;
          saveReg();
          json(res, 200, { ok: true, id: newId, native: acp.supportsFork });
          // Handoff seed (fallback path only): the fork's first prompt is a
          // MODEL-WRITTEN summary of the source transcript — task, decisions,
          // files, state, next steps — the same practice as Claude Code
          // /compact and Devin handoffs. Async: the client already routed to
          // the new session. A dead writer degrades to a bare continue-task
          // directive so the fork still works.
          if (native) return true; // native clone needs no seed
          const nid = newId;
          void (async () => {
            const summary = await summarizeForFork(ctx, id, anchor, srcTitle);
            dispatchPrompt(ctx, nid, summary
              ? `[分叉自会话「${srcTitle}」${anchor !== null ? "（锚点分叉）" : ""}] 以下是原会话的交接摘要。请在此基础上继续完成相同任务：\n\n${summary}`
              : `[分叉自会话「${srcTitle}」] 请继续该会话的任务。`, []);
          })().catch((e) => console.error(`[fork] handoff seed: ${e instanceof Error ? e.message : e}`));
          return true;
        }

        if (sub === "keep-alive" || sub === "feedback" || sub === "reset-token" || sub === "env" || sub === "editor" || sub === "queue-clear") {
          if (m === "POST") await readBody(req);
          json(res, 200, sub === "env" && m === "GET" ? { env: null } : { ok: true });
          return true;
        }

        // Workspace file browser — the session's project tree mapped into the
        // panel. Confined to the session cwd; never touches acp state.
        if (sub === "files" && m === "GET") {
          const cwd = cwdFor(ctx, id);
          const rel = url.searchParams.get("path") ?? "";
          try {
            const dir = path.resolve(cwd, rel);
            const relCheck = path.relative(cwd, dir);
            if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) throw new Error("escapes workspace");
            const ents = await fs.promises.readdir(dir, { withFileTypes: true });
            const entries = ents
              .filter((e) => !e.name.startsWith(".") || url.searchParams.get("all") === "1")
              .map((e) => {
                let size = 0, mtime = "";
                try { const s = fs.statSync(path.join(dir, e.name)); size = s.size; mtime = s.mtime.toISOString(); } catch { /* gone */ }
                return { name: e.name, dir: e.isDirectory(), size, mtime };
              })
              .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
            json(res, 200, { cwd, path: relCheck.replace(/\\/g, "/"), entries, error: null });
          } catch (e) {
            json(res, 200, { cwd, path: rel, entries: [], error: e instanceof Error ? e.message : String(e) });
          }
          return true;
        }
        if (sub === "file" && m === "GET") {
          const cwd = cwdFor(ctx, id);
          const rel = url.searchParams.get("path") ?? "";
          try {
            const file = path.resolve(cwd, rel);
            const relCheck = path.relative(cwd, file);
            if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) throw new Error("escapes workspace");
            const stat = fs.statSync(file);
            if (stat.isDirectory()) throw new Error("is a directory");
            if (stat.size > 2 * 1024 * 1024) { json(res, 200, { path: rel, text: null, truncated: false, tooLarge: true, size: stat.size }); return true; }
            const buf = fs.readFileSync(file);
            const text = buf.includes(0) ? null : buf.toString("utf8");
            json(res, 200, { path: rel, text, truncated: stat.size > 512 * 1024 ? true : false, binary: text === null, size: stat.size });
          } catch (e) {
            json(res, 200, { path: rel, text: null, error: e instanceof Error ? e.message : String(e) });
          }
          return true;
        }

        if (sub === "presign" && m === "POST") {
          json(res, 200, { urls: {} });
          return true;
        }

        if (sub === "terminal" && m === "GET") {
          const pid = url.searchParams.get("pid") ?? "";
          const buf = terminalBuf.get(pid);
          // fall back to the latest shell output embedded in the tool update
          let text = buf?.text ?? null;
          if (!text) {
            const items = buildTimeline(ctx, id).items;
            const shell = [...items].reverse().find((i) => i.kind === "shell" && i.processId === pid);
            text = shell?.output ?? null;
          }
          json(res, 200, { text, next_cursor: null });
          return true;
        }
        if (sub === "live-desktop" && m === "GET") {
          json(res, 200, { error: null, url: null });
          return true;
        }

        // cloud-only endpoints: PR review, env suggestions, translations…
        if (m === "POST") await readBody(req);
        json(res, 200, UNSUPPORTED);
        return true;
      }
  return false;
}
