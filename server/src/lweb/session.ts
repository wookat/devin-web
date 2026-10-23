/**
 * lweb/session — the session-scoped machinery shared by the admin and
 * share trees: the sessionSubs identical-semantics subroute table, the
 * sub:* pseudo-session routes (handleSubSession), sub-agent tree rows,
 * fork/handoff helpers, cwd confinement, and the title/context read helpers.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ApiContext } from "../routes.js";
import { stageUpload, MIME } from "../uploads.js";
import { loadReg, saveReg, meta } from "../dwstore.js";
import { buildMessages, snippet } from "../dwtimeline.js";
import { hostFor, ensureLoaded, acpForId } from "../sessionload.js";
import { sessionConfig, sessionStatus, snippetFromLog, type ListedSession } from "../sessionview.js";
import { listSubagents, subagentTimeline, subPingActive, type SubagentInfo } from "../sessionsub.js";
import { dispatchPrompt } from "../sessionprompt.js";
import { queueList, queueAdd, queueFlush } from "../sessionqueue.js";
import { noteSendError } from "../sendhealth.js";
import {loadInflight, markLoadedOn } from "../sessionplace.js";
import { inflight, isDraining, drainSince } from "../sessionlive.js";
import { captureLoadResponse } from "../sessioncfg.js";
import { personaState, personaHumanMessage } from "../persona.js";
import { runReviewAgent } from "../pr.js";
import { json, readBody, readJson } from "../httputil.js";

// ---------------------------------------------------------------------------
// sub:<rootSessionId>:<agentId> — a subagent presented as a first-class child
// session (cloud parity): nested under the parent in the sidebar tree, opens
// as a full session page (own timeline + composer + controls). Its data lives
// in the ROOT session's log, tagged cognition.ai/subagent_context.
// ---------------------------------------------------------------------------
export function parseSubId(id: string): { parent: string; aid: string } | null {
  if (!id.startsWith("sub:")) return null;
  const rest = id.slice(4);
  const i = rest.indexOf(":");
  if (i <= 0) return null;
  return { parent: rest.slice(0, i), aid: rest.slice(i + 1) };
}

/** Session cwd resolver — a sub session shares its parent's workspace. */
export function cwdFor(ctx: ApiContext, id: string): string {
  return ctx.sessionCwd.get(parseSubId(id)?.parent ?? id) ?? ctx.primaryCwd;
}

/** Resolve a workspace-relative path strictly INSIDE cwd — rejects absolutes
 *  and `..` escapes, then re-checks the REAL path: a symlink/junction inside
 *  the workspace pointing outside must not escape (lexical resolve alone
 *  doesn't chase links). Returns the absolute path or null. */
export function confined(cwd: string, p: unknown): string | null {
  if (typeof p !== "string" || !p) return null;
  const full = path.resolve(cwd, p);
  const root = path.resolve(cwd);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  try {
    const real = fs.realpathSync(full);
    const realRoot = fs.realpathSync(root);
    return real === realRoot || real.startsWith(realRoot + path.sep) ? real : null;
  } catch { return null; /* doesn't exist — never read it */ }
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
const subListCache = new Map<string, { m: number | null; lastSeq: number; rows: SubagentInfo[]; at: number }>();
export function subsAny(ctx: ApiContext, id: string, scope?: string): SubagentInfo[] {
  const mem = ctx.sessionLog.peek(id) ?? [];
  // Memory is authoritative only when the ring still covers the whole current
  // generation — clear()+replay restarts seq at 0, so mem[0].seq === 0 means
  // nothing was evicted. A truncated window misses early spawn events and
  // must be unioned with the journal (dedupe on seq).
  if (mem.length && mem[0].seq === 0) return listSubagents(ctx, id, scope);
  if (ctx.sessionLog.sidecars.subFilesStale(id)) ctx.sessionLog.sidecars.ensureSubFiles(id);
  const key = `${id}${scope ?? ""}`;
  const im = ctx.sessionLog.sidecars.subsJournalMtime(id);
  const lastSeq = mem.length ? mem[mem.length - 1].seq ?? -1 : -1;
  // `resumable` ages out WITHOUT new log events (a replay bumps the epoch,
  // a failed resume fills deadSubs) — so the cache must not live longer
  // than the next poll's liveness inputs. lastSeq changes whenever new
  // events land; for a quiet log, cache only up to one heartbeat.
  const hit = subListCache.get(key);
  if (hit && hit.m === im && im != null && hit.lastSeq === lastSeq && Date.now() - hit.at < 15_000) return hit.rows;
  const idx = ctx.sessionLog.sidecars.readSubsJournal(id) ?? [];
  const seen = new Set(idx.map((e) => e.seq));
  const rows = listSubagents(ctx, id, scope, mem.length ? [...idx, ...mem.filter((e) => !seen.has(e.seq))] : idx);
  // The journal carries no content lines, so cold rows lack a last-text
  // snippet — recover it from a bounded tail read of the child's sidechain.
  for (const r of rows) {
    if (!r.lastText && !r.agentId.startsWith("spawn:")) r.lastText = ctx.sessionLog.sidecars.subTailText(id, r.agentId);
  }
  if (im != null) subListCache.set(key, { m: im, lastSeq, rows, at: Date.now() });
  return rows;
}

/** Subagent → sidebar tree row (nested under the parent session). */
export function subTreeRow(ctx: ApiContext, rootId: string, cwd: string | undefined, a: SubagentInfo, depth = 1): SubTreeRow {
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

export function treeSession(ctx: ApiContext, s: ListedSession) {
  const m = meta(ctx, s.id);
  if (m.ssh && !ctx.sessionSsh.has(s.id)) ctx.sessionSsh.set(s.id, m.ssh);
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
    // Sidebar row order: index inside dw.json sessionOrder — keyed by
    // "_pinned" / folder name / "" (unfiled). -1 = never manually ordered
    // (client sorts those to the top by updated_at).
    forder: (loadReg(ctx).sessionOrder?.[m.pinned ? "_pinned" : (m.folder ?? "")] ?? []).indexOf(s.id),
    is_unread: false,
    is_pinned: !!m.pinned,
    // Project context for grouping + the header cwd chip.
    cwd: s.cwd,
    // SSH-hosted session → the cwd is a remote path; hydrate the live map so
    // /ws/term + hostFor keep routing through ssh after a restart.
    ssh: m.ssh ?? null,
    // Lock: devin says some acp holds it; `loaded_here` means that holder is
    // this web (harmless) — otherwise it's another app (desktop/CLI).
    is_locked: s.locked,
    loaded_here: ctx.sessionLog.has(s.id) || loadInflight.has(s.id) || inflight.has(s.id),
    agent: s.agent ?? "devin",
    persona: personaState(ctx, s.id),
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

export const sessionSubs: Record<string, (ctx: ApiContext, id: string, req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>> = {
  "message:POST": async (ctx, id, req, res) => {
    const body = await readJson(req);
    const text = String(body.message ?? body.text ?? "").trim();
    const attachments = Array.isArray(body.attachments)
      ? body.attachments as { url: string; name?: string; mime?: string; size?: number }[]
      : [];
    if (!text && !attachments.length) { json(res, 400, { error: "empty message" }); return; }
    if (isDraining()) { noteSendError(id, "drain", "server restarting — send refused"); json(res, 503, { error: "server_restarting", drain: { waiting: [...inflight], elapsed_ms: Date.now() - drainSince() } }); return; }
    // Official parity: a prompt sent while a turn is in flight goes onto the
    // queue — it flushes FIFO from dispatchPrompt's settle path. Concurrent
    // session/prompt calls race the acp (errors or lost turns), so never
    // dispatch on top of an in-flight turn.
    // A human composer message resolves a pending persona escalation —
    // sent or queued, it IS the boss speaking again.
    personaHumanMessage(ctx, id);
    if (inflight.has(id) || queueList(id).length) {
      const m2 = queueAdd(ctx, id, text, attachments);
      if (!inflight.has(id)) queueFlush(ctx, id); // idle + stale queue → keep FIFO moving
      json(res, 200, { ok: true, queued: m2.id });
      return;
    }
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
      // sessionSubs is share-reachable → confine or a share link becomes an
      // arbitrary host-file read (absolutes and .. were accepted verbatim).
      const full = confined(cwd, p);
      if (!full) { files[k] = ""; continue; }
      try {
        const data = fs.readFileSync(full);
        files[k] = data.length > 512 * 1024 ? data.subarray(0, 512 * 1024).toString("utf8") : data.toString("utf8");
      } catch { files[k] = ""; }
    }
    json(res, 200, { files, error: null });
  },
  "file-raw:GET": async (ctx, id, _req, res, url) => {
    // Raw workspace file bytes (images read by the agent, produced-file chips).
    // sessionSubs is share-reachable → MUST stay confined inside the session
    // cwd; an unconstrained path here is arbitrary host-file read for any
    // share-link holder.
    const full = confined(cwdFor(ctx, id), url.searchParams.get("path"));
    if (!full) { json(res, 403, { error: "path escapes session cwd" }); return; }
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
    // dw.json entry wins; fall back to the workspace file the dashboard
    // MCP server writes (<cwd>/.devin-web-dashboard.json).
    let dashboard = loadReg(ctx).dashboards[id] ?? null;
    if (!dashboard) {
      try {
        dashboard = JSON.parse(fs.readFileSync(path.join(cwdFor(ctx, id), ".devin-web-dashboard.json"), "utf8"));
      } catch { /* no file board */ }
    }
    json(res, 200, { dashboard });
  },
};
sessionSubs["upload-stage:POST"] = sessionSubs["upload:POST"];

export // ── Fork handoff writer ─────────────────────────────────────────────────
// Industry practice for session handoff (Claude Code /compact, Devin
// handoffs) is a MODEL-WRITTEN structured summary, not a mechanical
// transcript slice. A persistent hidden session does the writing; failure
// falls back to the deterministic seed built inline in the /fork route.
let handoffCreating: Promise<string> | null = null;
async function ensureHandoffSession(ctx: ApiContext): Promise<string> {
  const existing = loadReg(ctx).forkHandoff?.sessionId;
  if (existing && ctx.sessionCwd.get(existing)) return existing;
  if (handoffCreating) return handoffCreating;
  handoffCreating = (async () => {
    const acp = await ctx.manager.get(ctx.primaryCwd);
    const s = await acp.newSession(ctx.primaryCwd);
    ctx.sessionCwd.set(s.sessionId, ctx.primaryCwd);
    captureLoadResponse(s.sessionId, s, acp.agent?.id ?? "devin");
      markLoadedOn(s.sessionId, acp);
    const mm = meta(ctx, s.sessionId);
    mm.title = "🍴 Fork 交接"; mm.folder = ".persona";
    (loadReg(ctx).forkHandoff ??= {}).sessionId = s.sessionId;
    saveReg();
    return s.sessionId;
  })().finally(() => { handoffCreating = null; });
  return handoffCreating;
}

/** Feed the source session's transcript (bigger input budget than the seed
 * itself — the writer compresses) to the handoff session and return the
 * summary it writes; "" on any failure so callers can fall back. */
export async function summarizeForFork(ctx: ApiContext, id: string, anchor: number | null, srcTitle: string): Promise<string> {
  try {
    const pid = await ensureHandoffSession(ctx);
    const rows: { seq: number; text: string }[] = [];
    for (const e of ctx.sessionLog.get(id)) {
      const u = e.update as { sessionUpdate?: string; content?: { text?: string }; title?: string };
      if (u.sessionUpdate === "tool_call" && u.title) rows.push({ seq: e.seq ?? -1, text: `[操作] ${u.title}` });
      else if ((u.sessionUpdate === "user_message_chunk" || u.sessionUpdate === "agent_message_chunk") && u.content?.text)
        rows.push({ seq: e.seq ?? -1, text: (u.sessionUpdate === "user_message_chunk" ? "用户: " : "Devin: ") + u.content.text });
    }
    const transcript = (anchor !== null ? rows.filter(r => r.seq !== -1 && r.seq <= anchor) : rows)
      .map(r => r.text).join("\n\n").slice(-40_000);
    if (!transcript.trim()) return "";
    const out = await runReviewAgent(ctx, pid, [
      `你是会话交接撰写器。下面是会话「${srcTitle}」的对话与操作记录（可能截断）。`,
      `写一份精炼的交接摘要（≤2000字），结构：`,
      `1. 任务目标\n2. 已完成工作与关键决策\n3. 涉及的主要文件/代码\n4. 当前状态与未决问题\n5. 建议的下一步`,
      `只输出摘要本身，不要寒暄、不要评论记录质量。`,
      `\n=== 记录 ===\n${transcript}`,
    ].join("\n"));
    return out.slice(0, 3000);
  } catch { return ""; }
}

/**
 * Sub-session dispatch — `sub:<parent>:<agentId>` resolves to a child agent's
 * own view of the parent's log. Returns true when the sub was answered; the
 * caller falls through to the generic per-session handlers otherwise (the
 * file/workspace routes already resolve a sub's cwd through cwdFor).
 */
export async function handleSubSession(
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
        loaded_here: ctx.sessionLog.has(parent),
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
      items, next_cursor: null, error: null, queue: queueList(parent),
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
    const row = body.respawn ? {
      title: a?.title ?? "Subagent successor",
      task: a?.task ?? "",
      profile: a?.profile ?? "",
    } : undefined;
    // A dead handle can't be resumed — refuse here rather than burn a lead
    // turn that only comes back "doesn't exist in my current session". (respawn
    // is exempt: spawning a successor is allowed precisely when it's gone.)
    if (!body.respawn && (!a || a.resumable === false)) {
      json(res, 409, { error: "该子代理句柄已失效（宿主进程已重启/重放），不能续聊 — 可派生新子代理继续", dead: true });
      return true;
    }
    if (isDraining()) { json(res, 503, { error: "server_restarting" }); return true; }
    if (inflight.has(parent) || queueList(parent).length) {
      const m2 = queueAdd(ctx, parent, text, [], { subagentId: aid, ...(row ? { respawnRow: row } : {}) });
      if (!inflight.has(parent)) queueFlush(ctx, parent); // idle + stale queue → keep FIFO moving
      json(res, 200, { ok: true, queued: m2.id });
      return true;
    }
    dispatchPrompt(ctx, parent, text, [], aid, row);
    json(res, 200, { ok: true, ...(row ? { respawned: true } : {}) });
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

/** Serve the devin-web frontend API contract from local state. */

export function titleFromLog(ctx: ApiContext, id: string): string | null {
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
export function lastContextUsage(ctx: ApiContext, id: string) {
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


