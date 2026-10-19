/**
 * localwb — workbench-frontend compatibility layer.
 *
 * devin-workbench-v2's frontend speaks the Cloudflare Worker/D1 API of
 * devin2.zalize.com. This module serves the same endpoints and payload shapes
 * from local state: ACP sessions via the manager, the session-update log, and
 * a small registry file (wb.json) for titles/folders/pins/dashboards.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ApiContext } from "./routes.js";
import type { DevinAcp } from "./acp.js";
import { stageUpload, uploadPath, MIME } from "./uploads.js";
import { streamScreen } from "./screen.js";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { loadReg, saveReg, meta, noteLastUsed, type WbRegistry } from "./wbstore.js";
import {
  noteUpdate, persistTail, snapshotItems, buildMessages, buildTimeline,
  readDiskTail, tailSnapshot, tlCache, tlReset, snippet,
  type WbItem,
} from "./wbtimeline.js";
import {
  loadedOn, sessionHost, hostFor,
  isSessionPinned, captureLoadResponse, loadInflight, ensureLoaded, acpForId, restartSession,
  sessionConfig, recordTerminal, inflight, resolveUpload, dispatchPrompt,
  sessionStatus, interruptedTurn, listSubagents, subagentTimeline, subPingActive, listLocalSessions,
  snippetFromLog, responseCfg, terminalBuf, cloudVersionToModel,
  type ListedSession, type SessionConfig, type SubagentInfo, type ConfigOption,
} from "./sessionio.js";

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


// ---------------------------------------------------------------------------
// sub:<rootSessionId>:<agentId> — a subagent presented as a first-class child
// session (cloud parity): nested under the parent in the sidebar tree, opens
// as a full session page (own timeline + composer + controls). Its data lives
// in the ROOT session's log, tagged cognition.ai/subagent_context.
// ---------------------------------------------------------------------------
function parseSubId(id: string): { parent: string; aid: string } | null {
  if (!id.startsWith("sub:")) return null;
  const rest = id.slice(4);
  const i = rest.indexOf(":");
  if (i <= 0) return null;
  return { parent: rest.slice(0, i), aid: rest.slice(i + 1) };
}

/** Session cwd resolver — a sub session shares its parent's workspace. */
function cwdFor(ctx: ApiContext, id: string): string {
  return ctx.sessionCwd.get(parseSubId(id)?.parent ?? id) ?? ctx.primaryCwd;
}

function subStatusEnum(a: { status: string; agentId?: string; resumable?: boolean } | undefined | null, aid: string): string {
  if (a?.status === "running") return a.resumable === false ? "stopped" : "working";
  if (subPingActive(aid)) return "working";
  if (a?.status === "failed") return "stopped";
  return "finished";
}

interface SubTreeRow {
  devin_id: string; title: string; status_enum: string; activity_status: string | null;
  updated_at: string | null; created_at: string | null; snippet: string;
  folder: null; is_unread: boolean; is_pinned: boolean;
  cwd: string | undefined; is_locked: boolean; loaded_here: boolean;
  children: SubTreeRow[]; total_children: number;
  /** false = the acp registry dropped this handle (restart/replay) — the
   * sidebar greys it and the child page offers respawn instead of relay. */
  resumable?: boolean;
}

// A never-loaded session's subagents live only on DISK — memory get() is
// empty. The `.subs.jsonl` journal holds just the spawn/lifecycle lines (a
// multi-GB log must never be fully re-parsed for a sidebar row); the first
// miss kicks a background scan and children appear on the next poll.
const subListCache = new Map<string, { m: number | null; lastSeq: number; rows: SubagentInfo[] }>();
function subsAny(ctx: ApiContext, id: string, scope?: string): SubagentInfo[] {
  const mem = ctx.sessionLog.get(id);
  // Memory is authoritative only when the ring still covers the whole current
  // generation — clear()+replay restarts seq at 0, so mem[0].seq === 0 means
  // nothing was evicted. A truncated window misses early spawn events and
  // must be unioned with the journal (dedupe on seq).
  if (mem.length && mem[0].seq === 0) return listSubagents(ctx, id, scope);
  if (ctx.sessionLog.subFilesStale(id)) ctx.sessionLog.ensureSubFiles(id);
  const key = `${id}${scope ?? ""}`;
  const im = ctx.sessionLog.subsJournalMtime(id);
  const lastSeq = mem.length ? mem[mem.length - 1].seq ?? -1 : -1;
  const hit = subListCache.get(key);
  if (hit && hit.m === im && im != null && hit.lastSeq === lastSeq) return hit.rows;
  const idx = ctx.sessionLog.readSubsJournal(id) ?? [];
  const seen = new Set(idx.map((e) => e.seq));
  const rows = listSubagents(ctx, id, scope, mem.length ? [...idx, ...mem.filter((e) => !seen.has(e.seq))] : idx);
  // The journal carries no content lines, so cold rows lack a last-text
  // snippet — recover it from a bounded tail read of the child's sidechain.
  for (const r of rows) {
    if (!r.lastText && !r.agentId.startsWith("spawn:")) r.lastText = ctx.sessionLog.subTailText(id, r.agentId);
  }
  if (im != null) subListCache.set(key, { m: im, lastSeq, rows });
  return rows;
}

/** Subagent → sidebar tree row (nested under the parent session). */
function subTreeRow(ctx: ApiContext, rootId: string, cwd: string | undefined, a: SubagentInfo, depth = 1): SubTreeRow {
  const subId = `sub:${rootId}:${a.agentId}`;
  const m = meta(ctx, subId);
  // Depth cap: malformed tags (an agent tagged as its own parent) would
  // otherwise recurse forever building nested children.
  const kids = depth >= 8 ? [] : subsAny(ctx, rootId, a.agentId);
  return {
    devin_id: subId,
    title: m.title ?? a.title ?? "Subagent",
    status_enum: m.archived ? "archived" : subStatusEnum(a, a.agentId),
    activity_status: a.status === "running" ? "working" : "idle",
    updated_at: a.finishedAt ?? a.startedAt,
    created_at: a.startedAt,
    snippet: a.lastText || a.task,
    folder: null, is_unread: false, is_pinned: false,
    cwd, is_locked: false, loaded_here: a.status === "running" && a.resumable !== false,
    children: kids.map((k) => subTreeRow(ctx, rootId, cwd, k, depth + 1)),
    total_children: kids.length,
    resumable: a.resumable,
  };
}

function treeSession(ctx: ApiContext, s: ListedSession) {
  const m = meta(ctx, s.id);
  const st = sessionStatus(ctx, s.id);
  const subs = subsAny(ctx, s.id, "root");
  return {
    devin_id: s.id,
    title: m.title ?? s.title,
    status_enum: m.archived ? "archived" : st.status,
    activity_status: st.activity,
    updated_at: s.updated,
    created_at: s.created,
    snippet: snippetFromLog(ctx, s.id),
    folder: m.folder ?? null,
    is_unread: false,
    is_pinned: !!m.pinned,
    // Project context for grouping + the header cwd chip.
    cwd: s.cwd,
    // Lock: devin says some acp holds it; `loaded_here` means that holder is
    // this workbench (harmless) — otherwise it's another app (desktop/CLI).
    is_locked: s.locked,
    loaded_here: ctx.sessionLog.get(s.id).length > 0 || loadInflight.has(s.id) || inflight.has(s.id),
    children: subs.map((a) => subTreeRow(ctx, s.id, s.cwd, a)),
    total_children: subs.length,
  };
}

// ---------------------------------------------------------------------------
// shared per-session subroutes — identical semantics on admin and share paths.
// A sub+method present here is served by this table in BOTH branches; keep
// share-only sanitized variants (timeline/messages/todos/changes) and
// admin-only mutations out of it.
// ---------------------------------------------------------------------------

const sessionSubs: Record<string, (ctx: ApiContext, id: string, req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>> = {
  "message:POST": async (ctx, id, req, res) => {
    const body = await readJson(req);
    const text = String(body.message ?? body.text ?? "").trim();
    const attachments = Array.isArray(body.attachments)
      ? body.attachments as { url: string; name?: string; mime?: string; size?: number }[]
      : [];
    if (!text && !attachments.length) { json(res, 400, { error: "empty message" }); return; }
    dispatchPrompt(ctx, id, text, attachments);
    json(res, 200, { ok: true });
  },
  "upload:POST": async (ctx, _id, req, res, url) => {
    json(res, 200, await stageUpload(req, ctx.store, url.searchParams.get("filename")));
  },
  "file-contents:POST": async (ctx, id, req, res) => {
    const body = await readJson(req);
    const keys = (body.keys ?? body.ids) as string[] | undefined;
    const files: Record<string, string> = {};
    const cwd = cwdFor(ctx, id);
    for (const k of keys ?? []) {
      const p = k.startsWith("path:") ? decodeURIComponent(k.slice(5)) : k;
      const full = path.isAbsolute(p) ? p : path.join(cwd, p);
      try {
        const data = fs.readFileSync(full);
        files[k] = data.length > 512 * 1024 ? data.subarray(0, 512 * 1024).toString("utf8") : data.toString("utf8");
      } catch { files[k] = ""; }
    }
    json(res, 200, { files, error: null });
  },
  "file-raw:GET": async (ctx, id, _req, res, url) => {
    // Raw workspace file bytes (images read by the agent, etc.) — same path
    // resolution as file-contents but streams the real mime type.
    const p = url.searchParams.get("path") ?? "";
    const cwd = cwdFor(ctx, id);
    const full = path.isAbsolute(p) ? p : path.join(cwd, p);
    try {
      const data = fs.readFileSync(full);
      if (data.length > 25 * 1024 * 1024) {
        json(res, 413, { error: "too large" });
        return;
      }
      res.writeHead(200, {
        "content-type": MIME[path.extname(full).toLowerCase()] ?? "application/octet-stream",
        "content-length": data.length,
        "cache-control": "private, max-age=60",
      });
      res.end(data);
    } catch {
      json(res, 404, { error: "not found" });
    }
  },
  "dashboard:GET": async (ctx, id, _req, res) => {
    json(res, 200, { dashboard: loadReg(ctx).dashboards[id] ?? null });
  },
};
sessionSubs["upload-stage:POST"] = sessionSubs["upload:POST"];

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown) {
  const buf = Buffer.from(JSON.stringify(body));
  const headers: Record<string, string | number> = { "content-type": "application/json" };
  // Big responses (timelines reach several MB uncompressed) get gzip when the
  // client accepts it — cuts transfer and parse pressure on LAN clients.
  const ae = String(res.req?.headers?.["accept-encoding"] ?? "");
  if (buf.length > 4096 && /\bgzip\b/.test(ae)) {
    headers["content-encoding"] = "gzip";
    res.writeHead(status, headers).end(zlib.gzipSync(buf));
    return;
  }
  res.writeHead(status, headers).end(buf);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 50 * 1024 * 1024) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const buf = await readBody(req);
  return buf.length ? (JSON.parse(buf.toString("utf8")) as Record<string, unknown>) : {};
}

const UNSUPPORTED = { error: "not supported on local workbench" };

/**
 * Sub-session dispatch — `sub:<parent>:<agentId>` resolves to a child agent's
 * own view of the parent's log. Returns true when the sub was answered; the
 * caller falls through to the generic per-session handlers otherwise (the
 * file/workspace routes already resolve a sub's cwd through cwdFor).
 */
async function handleSubSession(
  ctx: ApiContext, ref: { parent: string; aid: string }, subId: string,
  sub: string, m: string, req: IncomingMessage, res: ServerResponse, url: URL,
): Promise<boolean> {
  const { parent, aid } = ref;
  const info = () => subsAny(ctx, parent).find((r) => r.agentId === aid) ?? null;
  const statusOf = (a: SubagentInfo | null) => subStatusEnum(a ?? undefined, aid);

  // GET /session/sub:.. — detail. Same shape as a real session's, plus
  // parent/subagent metadata the header renders as breadcrumbs and pills.
  if (!sub && m === "GET") {
    const a = info();
    const items = subagentTimeline(ctx, parent, aid);
    const mm = meta(ctx, subId);
    json(res, 200, {
      session: {
        id: subId, devin_session_id: subId,
        title: mm.title ?? a?.title ?? "Subagent",
        devin_title: a?.title ?? "Subagent",
        permission: mm.permission ?? "detailed",
        archived: mm.archived ? 1 : 0,
        status: statusOf(a), status_enum_raw: statusOf(a), status_message: null,
        current_devin_version: a?.model || null,
        pull_requests: [], repos: [cwdFor(ctx, parent)],
        cwd: cwdFor(ctx, parent),
        is_locked: false,
        loaded_here: ctx.sessionLog.get(parent).length > 0,
        context_usage: null,
        parent_devin_id: parent,
        parent_title: meta(ctx, parent).title ?? titleFromLog(ctx, parent) ?? "Parent session",
        subagent: {
          agentId: aid, profile: a?.profile ?? "", model: a?.model ?? "",
          task: a?.task ?? "", isBackground: a?.isBackground ?? false,
          live: a?.live ?? false, resumable: a?.resumable ?? false,
        },
      },
      messages: buildMessages(items.slice(-60)),
      share_url: null, dashboard_url: null, media_token: "local",
    });
    return true;
  }

  if (sub === "timeline" && m === "GET") {
    // The sub's events live in the PARENT's log — loading must target it.
    // peek=1 stays memory/disk-only, same as normal sessions.
    const peek = url.searchParams.get("peek") === "1";
    if (!peek) void ensureLoaded(ctx, parent);
    const items = subagentTimeline(ctx, parent, aid);
    json(res, 200, {
      items, next_cursor: null, error: null, queue: [],
      activity: statusOf(info()) === "working" ? { text: "working" } : null,
    });
    return true;
  }

  // POST message → relay to the subagent (desktop parity: a message to a
  // finished/live sub resumes it via run_subagent(resume=aid) on the lead).
  if (sub === "message" && m === "POST") {
    const body = await readJson(req);
    const text = String(body.message ?? body.text ?? "").trim();
    if (!text) { json(res, 400, { error: "empty message" }); return true; }
    if (aid.startsWith("spawn:")) { json(res, 400, { error: "subagent transcript not replayed; cannot message" }); return true; }
    const a = info();
    // respawn:1 spawns a SUCCESSOR carrying the dead agent's context —
    // allowed precisely because the handle is gone (normal resume can't work).
    if (body.respawn) {
      dispatchPrompt(ctx, parent, text, [], aid, {
        title: a?.title ?? "Subagent successor",
        task: a?.task ?? "",
        profile: a?.profile ?? "",
      });
      json(res, 200, { ok: true, respawned: true });
      return true;
    }
    // A dead handle can't be resumed — refuse here rather than burn a lead
    // turn that only comes back "doesn't exist in my current session".
    if (!a || a.resumable === false) {
      json(res, 409, { error: "该子代理句柄已失效（宿主进程已重启/重放），不能续聊 — 可派生新子代理继续", dead: true });
      return true;
    }
    dispatchPrompt(ctx, parent, text, [], aid);
    json(res, 200, { ok: true });
    return true;
  }

  // POST control {action} — foreground/background/cancel on the live agent.
  // `end`/`cancel`/`pause`/`stop` all map to cancel (a sub session's stop IS
  // the subagent's cancel); `resume` is a no-op ok (nothing to resume — the
  // composer relays a message instead).
  if (sub === "resume" && m === "POST") { await readBody(req); json(res, 200, { ok: true }); return true; }
  if ((sub === "control" || sub === "end" || sub === "cancel" || sub === "pause" || sub === "stop") && m === "POST") {
    const body = sub === "control" ? await readJson(req) : {};
    const action = sub === "control" ? String(body.action ?? "") : "cancel";
    if (!["cancel", "foreground", "background"].includes(action)) { json(res, 400, { error: "bad action" }); return true; }
    if (aid.startsWith("spawn:")) { json(res, 200, { ok: false, error: "subagent not live (replayed)" }); return true; }
    try {
      const acp = await acpForId(ctx, parent);
      await acp.subagentControl(parent, aid, action as "cancel" | "foreground" | "background");
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  // The sub's own children (nested subagents spawned inside its stream).
  if (sub === "subagents" && m === "GET") {
    json(res, 200, { subagents: subsAny(ctx, parent, aid) });
    return true;
  }

  if (sub === "changes" && m === "GET") {
    const files = new Map<string, { path: string; added: number; removed: number; firstPrevKey?: string; lastKey?: string; actionType?: string }>();
    for (const it of subagentTimeline(ctx, parent, aid)) {
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
    const last = [...subagentTimeline(ctx, parent, aid)].reverse().find((i) => i.kind === "todo" && i.todos?.length);
    json(res, 200, { todos: last?.todos ?? [] });
    return true;
  }

  if (sub === "messages" && m === "GET") {
    json(res, 200, { messages: buildMessages(subagentTimeline(ctx, parent, aid).slice(-60)) });
    return true;
  }

  // Config: the sub runs on the lead's model — expose the parent's config for
  // the pill, but writes are a no-op (spawn profile/model is fixed).
  if (sub === "config" && m === "GET") {
    const cfg = sessionConfig(ctx, parent);
    json(res, 200, { options: cfg.options, mode: cfg.mode, commands: cfg.commands, model: cfg.model });
    return true;
  }
  if (sub === "config" && m === "POST") { await readBody(req); json(res, 200, { ok: true }); return true; }

  // Stubs the session page polls — keep shapes, no semantics.
  if (sub === "queue" && m === "GET") { json(res, 200, { queue: [] }); return true; }
  if (sub === "queue-op" && m === "POST") { await readBody(req); json(res, 200, { ok: true }); return true; }
  if (sub === "sidechains" && m === "GET") { json(res, 200, { threads: [] }); return true; }
  if (sub === "resources" && m === "GET") { json(res, 200, { rules: null, skills: null, subagentProfiles: null, plans: null, hooks: null, config: null }); return true; }
  if (sub === "version" && m === "POST") { await readBody(req); json(res, 200, { ok: false, error: "subagent model fixed at spawn" }); return true; }
  if (sub === "restart" && m === "POST") { await readBody(req); json(res, 200, { ok: false, error: "restart the parent session" }); return true; }
  if (sub === "share" && m === "POST") { await readBody(req); json(res, 200, { ok: false, error: "subagents cannot be shared" }); return true; }
  if (sub === "env" && m === "GET") { json(res, 200, { env: null }); return true; }
  if ((sub === "keep-alive" || sub === "feedback" || sub === "reset-token" || sub === "editor" || sub === "queue-clear") ) {
    if (m === "POST") await readBody(req);
    json(res, 200, { ok: true });
    return true;
  }

  return false; // fall through: files/file/file-raw/file-contents/uploads/terminal…
}

/** Serve the devin-workbench-v2 frontend API contract from local state. */
export async function handleLocalWb(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const m = req.method ?? "GET";
  const p = url.pathname;
  const parts = p.split("/").filter(Boolean);

  const isAdmin = parts[1] === "admin";
  const isShare = parts[1] === "share";
  const isMedia = parts[1] === "media";
  if (!isAdmin && !isShare && !isMedia && !(p.startsWith("/api/session/") || p.startsWith("/api/devin-coach"))) return false;

  try {
    // ---- share-side media is cloud-only; nothing stored remotely ----
    if (isMedia) {
      json(res, 404, { error: "no cloud media locally" });
      return true;
    }

    // POST /api/session/:id/dashboard — dashboard writes (widget storage)
    if (parts[1] === "session" && parts[3] === "dashboard" && m === "POST") {
      const body = await readJson(req);
      loadReg(ctx).dashboards[decodeURIComponent(parts[2])] = body;
      saveReg();
      json(res, 200, { ok: true });
      return true;
    }

    // POST /api/devin-coach/precheck — cloud-only coach
    if (parts[1] === "devin-coach") {
      json(res, 200, { findings: [] });
      return true;
    }

    // ============================ admin tree ============================
    if (isAdmin) {
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

      // POST /api/admin/restart — respawn the server as-is.
      // POST /api/admin/redeploy — npm run build, THEN respawn. A process
      // can't replace itself mid-flight, so both spawn a DETACHED helper
      // (scripts/respawn.mjs, pure node — no cmd/start/powershell fragility)
      // that waits for the port to free, cleans orphaned acp children, and
      // starts a fresh node with logs in <dataDir>/. Build failure aborts the
      // respawn so the old server keeps serving; before exiting it waits for
      // in-flight prompts to drain — activity-aware: keeps waiting while a
      // session still emits events, gives up after 60s quiet or 15min total.
      if ((p === "/api/admin/restart" || p === "/api/admin/redeploy") && m === "POST") {
        json(res, 202, { ok: true });
        // Repo root from the module path, not process.cwd() — the server may
        // have been launched from any directory.
        const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
        const pi = process.argv.indexOf("--port");
        const port = pi > 0 ? process.argv[pi + 1] : "7791";
        const respawn = () => {
          // Graceful handoff: wait for in-flight prompts however long they
          // take — a deploy must never cut a turn off mid-stream, and a wedged
          // turn is the user's call to end (End session in the UI releases the
          // drain), not ours to kill. Logs a heartbeat so the wait is visible.
          const tick = () => {
            if (inflight.size) {
              console.error(`[respawn] waiting on ${inflight.size} inflight prompt(s): ${[...inflight].join(", ")}`);
              setTimeout(tick, 30_000);
              return;
            }
            spawn(process.execPath,
              [path.join(repoRoot, "scripts", "respawn.mjs"), repoRoot, port, ctx.store.dataDir],
              { cwd: repoRoot, detached: true, stdio: "ignore", windowsHide: true }).unref();
            setTimeout(() => process.exit(0), 400);
          };
          tick();
        };
        if (p === "/api/admin/redeploy") {
          const b = spawn("cmd.exe", ["/c", "npm", "run", "build"], {
            cwd: repoRoot, stdio: "inherit", windowsHide: true,
          });
          b.on("exit", (code) => { if (code === 0) respawn(); else console.error(`[redeploy] build failed (${code}) — staying up`); });
        } else respawn();
        return true;
      }

      // GET /api/admin/screen/live — MJPEG stream of the real host desktop.
      // Admin-only: the workbench has no auth, so the screen stays out of
      // the share tree. Read-only by design (see screen.ts).
      if (p === "/api/admin/screen/live" && m === "GET") {
        await streamScreen(res);
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

      // GET/POST /api/admin/prefs — server-side workbench preferences
      // (wb.json `prefs`). autoResume drives the boot-time open-turns sweep.
      if (p === "/api/admin/prefs" && m === "GET") {
        json(res, 200, { prefs: loadReg(ctx).prefs ?? {} });
        return true;
      }
      if (p === "/api/admin/prefs" && m === "POST") {
        const body = await readJson(req);
        const r = loadReg(ctx);
        if (typeof body.autoResume === "boolean") (r.prefs ??= {}).autoResume = body.autoResume;
        saveReg();
        json(res, 200, { ok: true, prefs: r.prefs });
        return true;
      }

      if (p === "/api/admin/mirror/indexed-paths" && m === "GET") {
        // @file mention source: index the session's workspace files. Bounded
        // BFS — heavy dirs skipped — cached briefly per workspace.
        const sid = url.searchParams.get("session") ?? "";
        const cwd = (sid && ctx.sessionCwd.get(parseSubId(sid)?.parent ?? sid)) || ctx.primaryCwd;
        const paths = indexWorkspace(cwd);
        json(res, 200, { paths });
        return true;
      }
      if (p === "/api/admin/mirror/precheck" && m === "POST") {
        json(res, 200, { findings: [] });
        return true;
      }
      if ((p === "/api/admin/mirror/transcribe" || p === "/api/admin/mirror/translate") && m === "POST") {
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
      if (p === "/api/admin/sessions/new" && m === "POST") {
        const body = await readJson(req);
        const cwd = String(body.cwd ?? ctx.primaryCwd);
        const acp = await ctx.manager.get(cwd);
        const s = await acp.newSession(cwd);
        ctx.sessionCwd.set(s.sessionId, cwd);
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
        if (task) dispatchPrompt(ctx, s.sessionId, task);
        json(res, 200, { ok: true, id: s.sessionId, devin_session_id: s.sessionId });
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
        json(res, 200, { commands, skills: scanLocalSkills(ctx), playbooks: [], secrets: [], macros: [], repos, sessions, primary_cwd: ctx.primaryCwd, cfg, last_config: loadReg(ctx).lastConfig ?? {} });
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
          if (!isAdmin) { json(res, 404, { error: "not found" }); return true; }
          if (await handleSubSession(ctx, subRef, id, sub, m, req, res, url)) return true;
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
            error: null, queue: [],
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
          });
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
          json(res, 200, { queue: [] });
          return true;
        }
        if (sub === "queue-op" && m === "POST") {
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

        if (sub === "cancel" && m === "POST") {
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
            if (agentId.startsWith("spawn:")) { json(res, 400, { error: "subagent transcript not replayed; cannot message" }); return true; }
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
          await Promise.race([loadInflight.get(id) ?? Promise.resolve(), new Promise((r) => setTimeout(r, 2500))]);
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
    }

    // ============================ share tree ============================
    if (isShare && parts.length >= 3) {
      const id = decodeURIComponent(parts[2]);
      const sub = parts[3] ?? "";

      // Enforce the visitor permission tier server-side — the UI caps alone
      // are cosmetic; anyone with the share URL can call these directly.
      // readonly: no writes. chat/basic: message yes, upload no (canUpload is
      // detailed-only in capsFor). detailed/full: everything.
      if (m === "POST") {
        const perm = meta(ctx, id).permission ?? "detailed";
        const writeSub = sub === "message" || sub === "upload" || sub === "upload-stage";
        if ((perm === "readonly" && writeSub) || (perm !== "detailed" && perm !== "full" && sub.startsWith("upload"))) {
          json(res, 403, { error: `visitor permission "${perm}" forbids ${sub}` });
          return true;
        }
      }

      const sharedH = sessionSubs[`${sub}:${m}`];
      if (sharedH) { await sharedH(ctx, id, req, res, url); return true; }

      if (sub === "meta" && m === "GET") {
        const mm = meta(ctx, id);
        json(res, 200, {
          title: mm.title ?? titleFromLog(ctx, id) ?? "Devin session",
          permission: mm.permission ?? "detailed",
          status: sessionStatus(ctx, id).status,
          pull_request: null, pull_requests: [],
        });
        return true;
      }
      if (sub === "timeline" && m === "GET") {
        void ensureLoaded(ctx, id);
        const loading = loadInflight.has(id);
        const { items: live, gen } = buildTimeline(ctx, id);
        const snap = (loading || !live.length) ? snapshotItems(ctx, id) : null;
        const serveSnap = !!(loading && snap);
        const all = serveSnap ? snap : live;
        const reset = !serveSnap && tlReset.delete(id);
        const items = loading && !snap ? [] : all.slice(-300);
        json(res, 200, { items, next_cursor: null, error: null, queue: [], reset: reset || undefined, gen: serveSnap ? 0 : gen, activity: loading ? { text: "Loading history…" } : null });
        return true;
      }
      if (sub === "messages" && m === "GET") {
        void ensureLoaded(ctx, id);
        json(res, 200, { messages: buildMessages(buildTimeline(ctx, id).items) });
        return true;
      }
      if (sub === "todos" && m === "GET") {
        json(res, 200, { todos: [] });
        return true;
      }
      if (sub === "changes" && m === "GET") {
        json(res, 200, { files: [], truncated: false, error: null });
        return true;
      }
      if ((sub === "screenshot" || sub === "attachment" || sub === "file" || sub === "terminal") && m === "GET") {
        json(res, 404, { error: "no cloud media locally" });
        return true;
      }
      json(res, 200, UNSUPPORTED);
      return true;
    }

    return false;
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    json(res, status, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }
}

function titleFromLog(ctx: ApiContext, id: string): string | null {
  const log = ctx.sessionLog.get(id);
  for (const e of log) {
    const u = e.update as Record<string, unknown>;
    if (u.sessionUpdate === "session_info_update" && typeof u.title === "string") return u.title;
    if (u.sessionUpdate === "user_message_chunk") {
      const t = (u.content as { text?: string } | undefined)?.text;
      if (t) return t.slice(0, 60);
    }
  }
  return null;
}

/** Latest root-chain usage_update: context window fill + token counters. */
function lastContextUsage(ctx: ApiContext, id: string) {
  const log = ctx.sessionLog.get(id);
  for (let i = log.length - 1; i >= 0; i--) {
    const u = log[i].update as Record<string, unknown>;
    if (u.sessionUpdate !== "usage_update") continue;
    const m = u._meta as Record<string, unknown> | undefined;
    if (m?.["cognition.ai/subagent_context"]) continue; // root chain only
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return {
      used: num(u.used),
      size: num(u.size),
      inputTokens: num(m?.["cognition.ai/inputTokens"]),
      outputTokens: num(m?.["cognition.ai/outputTokens"]),
      cachedReadTokens: num(m?.["cognition.ai/cachedReadTokens"]),
      totalAcuCost: num(m?.["cognition.ai/totalAcuCost"]),
      ts: log[i].ts,
    };
  }
  return null;
}

