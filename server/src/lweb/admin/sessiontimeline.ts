/**
 * lweb/admin/sessiontimeline — the per-session transcript surface under
 * /api/admin/session/:id: timeline/index/changes/todos read models, the
 * parked-prompt queue (queue/queue-op), sidechat threads, terminal output,
 * and the live-desktop cloud stub.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ApiContext } from "../../routes.js";
import type { LogEntry } from "../../sessiondb.js";
import { buildTimeline, tlReset } from "../../dwtimeline.js";
import { meta, saveReg } from "../../dwstore.js";
import { snapshotItems } from "../../dwtailsnap.js";
import { ensureLoaded, acpForId, interruptedTurn, hostFor } from "../../sessionload.js";
import { sessionStatus, terminalText } from "../../sessionview.js";
import { dispatchPrompt } from "../../sessionprompt.js";
import { queueList, queueAdd, queueRemove, queueFlush } from "../../sessionqueue.js";
import { loadInflight, markLoadedOn, sessionHost } from "../../sessionplace.js";
import { captureLoadResponse } from "../../sessioncfg.js";
import { openTurns, openTurnsLoad, clearOpenTurns } from "../../sessionturns.js";
import { titleFromLog } from "../session.js";
import { inflight, isDraining } from "../../sessionlive.js";
import { personaState } from "../../persona.js";
import { json, readJson } from "../../httputil.js";
import { remapLegacyCwd } from "../../store.js";

// ── Sidechat (sidechain) threads ─────────────────────────────────────────
// devin stamps `cognition.ai/sidechain` meta on every update belonging to a
// sidechat thread (requested via loadSession update_meta; new replies come
// from `_cognition.ai/sidechain/request`). The meta names its thread's
// anchor event — every field is read in camelCase AND snake_case since
// devin's casing drifted across builds. The client anchors side chats on
// TimelineItem.id (`e<seq>` / `t<toolCallId>`), NOT the real devin eventId,
// so GET emits `e<seq>` when the anchor event is still stored and the POSTs
// translate it back via the entry's cognition.ai/eventId meta.

interface SidechainMsg {
  role: "user" | "assistant" | "thinking" | "action";
  content: string;
  ts: string;
  request_id?: string;
  pending?: boolean;
  error?: string;
  event_id: string;
  timestampMs?: number;
}
interface SidechainThread {
  anchor_event_id: string;
  anchor_ts: number;
  label: string;
  messages: SidechainMsg[];
  pending_request_id?: string;
}

const pickStr = (o: Record<string, unknown>, ...ks: string[]) => {
  for (const k of ks) { const v = o[k]; if (typeof v === "string" && v) return v; }
  return undefined;
};
const pickNum = (o: Record<string, unknown>, ...ks: string[]) => {
  for (const k of ks) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v) {
      const n = Number(v); if (Number.isFinite(n)) return n;
      const t = Date.parse(v); if (Number.isFinite(t)) return t;
    }
  }
  return undefined;
};

/** Text for a sidechain row: tool_call takes content.title; content arrays
 * join their text/resource_link blocks; bare strings pass through. Falls
 * back to the update's top-level title when nothing else produced text. */
function sidechainText(u: Record<string, unknown>, msg: Record<string, unknown>): string {
  const block = (b: unknown): string => {
    if (typeof b === "string") return b;
    if (!b || typeof b !== "object") return "";
    const o = b as Record<string, unknown>;
    if (o.type === "resource_link") return pickStr(o, "name", "uri") ?? "";
    if (typeof o.text === "string") return o.text;
    const inner = o.content as Record<string, unknown> | undefined; // ACP {type:'content',content:{type:'text'}}
    if (inner && typeof inner.text === "string") return inner.text;
    return "";
  };
  const c = (msg.content ?? u.content) as unknown;
  const joined = typeof c === "string" ? c
    : Array.isArray(c) ? c.map(block).join("")
    : c && typeof c === "object" ? (pickStr(c as Record<string, unknown>, "title", "text") ?? block(c))
    : "";
  return joined || pickStr(u, "title") || "";
}

/** `e<seq>` timeline ids → their stored entry (real devin event ids and
 * `t<toolCallId>` rows return undefined — they pass through untouched). */
function anchorEntry(ctx: ApiContext, id: string, raw: string): LogEntry | undefined {
  const m = /^e(\d+)$/.exec(raw);
  if (!m) return undefined;
  return ctx.sessionLog.get(id).find((e) => e.seq === Number(m[1]));
}

/** The client sends TimelineItem.id (`e<seq>`); the agent needs the real
 * devin eventId stamped on that entry's cognition.ai/eventId meta. When the
 * entry or stamp is missing (this devin build leaves eventId unset), the
 * raw client value goes through — the agent answers honestly either way. */
function anchorEventId(ctx: ApiContext, id: string, raw: string): string {
  const ev = (anchorEntry(ctx, id, raw)?.update._meta as Record<string, unknown> | undefined)?.["cognition.ai/eventId"];
  return typeof ev === "string" && ev ? ev : raw;
}

/** Group stored updates stamped with `cognition.ai/sidechain` into threads
 * keyed on the meta's anchor event id. Read-only projection off
 * sessionLog.get (lazy disk tail hydrate — never kicks a session/load). */
function sidechainThreads(ctx: ApiContext, id: string): SidechainThread[] {
  const entries = ctx.sessionLog.get(id);
  // eventId→seq index so threads can expose the `e<seq>` anchor id the
  // client timeline uses (threads.find matches it against TimelineItem.id).
  const evToSeq = new Map<string, number>();
  for (const e of entries) {
    if (e.seq == null) continue;
    const ev = pickStr((e.update._meta ?? {}) as Record<string, unknown>, "cognition.ai/eventId");
    if (ev) evToSeq.set(ev, e.seq);
  }
  const threads = new Map<string, { t: SidechainThread; seen: Set<string> }>();
  for (const e of entries) {
    const u = e.update;
    const meta = (u._meta ?? {}) as Record<string, unknown>;
    const smRaw = meta["cognition.ai/sidechain"];
    if (smRaw == null || smRaw === false) continue;
    const sm = (typeof smRaw === "object" ? smRaw : {}) as Record<string, unknown>;
    const anchor = pickStr(sm, "anchorEventId", "anchor_event_id", "anchor")
      ?? (typeof smRaw === "string" ? smRaw : undefined);
    if (!anchor) continue; // unanchorable — can't be threaded or replied to
    const msg = (u.message ?? {}) as Record<string, unknown>; // official events nest {role,kind,content}
    const roleMeta = pickStr(sm, "role") ?? pickStr(u, "role") ?? pickStr(msg, "role");
    const kind0 = pickStr(msg, "kind") ?? pickStr(u, "sessionUpdate") ?? "";
    const error = pickStr(sm, "error") ?? pickStr(u, "error") ?? pickStr(msg, "error");
    // 'stopped' markers are noise unless they carry the failure itself.
    if ((sm.stopped === true || roleMeta === "stopped" || kind0 === "stopped") && !error) continue;
    // Official role mapping: request→user · action→action ·
    // agent_thought→thinking · else assistant. The ACP-native kinds cover
    // builds that stamp the meta on ordinary sessionUpdates.
    const role: SidechainMsg["role"] =
      roleMeta === "request" || roleMeta === "user" || kind0 === "user_message_chunk" ? "user"
      : roleMeta === "action" || kind0 === "tool_call" || kind0 === "tool_call_update" ? "action"
      : kind0 === "agent_thought" || kind0 === "agent_thought_chunk" || roleMeta === "thinking" ? "thinking"
      : "assistant";
    const content = sidechainText(u, msg);
    // Replay generations echo each event — dedupe like tlPush does, keyed on
    // the event id when stamped else a kind|stamp|role|content digest.
    const evId = pickStr(meta, "cognition.ai/eventId");
    const dedupK = `${evId ?? ""}|${kind0}|${pickStr(meta, "cognition.ai/timestamp") ?? ""}|${role}|${content.slice(0, 96)}`;
    let rec = threads.get(anchor);
    if (!rec) {
      rec = { t: { anchor_event_id: anchor, anchor_ts: pickNum(sm, "anchorTs", "anchor_ts") ?? 0, label: "", messages: [] }, seen: new Set() };
      threads.set(anchor, rec);
    }
    if (rec.seen.has(dedupK)) continue;
    rec.seen.add(dedupK);
    const request_id = pickStr(sm, "requestId", "request_id");
    rec.t.messages.push({
      role, content,
      ts: new Date(e.ts).toISOString(),
      timestampMs: e.ts,
      event_id: evId ?? `e${e.seq ?? "?"}`,
      ...(request_id ? { request_id } : {}),
      ...(sm.pending === true || u.pending === true || msg.pending === true ? { pending: true } : {}),
      ...(error ? { error } : {}),
    });
  }
  const out: SidechainThread[] = [];
  for (const rec of threads.values()) {
    const t = rec.t;
    const seq = evToSeq.get(t.anchor_event_id);
    if (seq != null) t.anchor_event_id = `e${seq}`; // the id the client anchor carries
    if (!t.anchor_ts) {
      t.anchor_ts = (seq != null ? entries.find((e) => e.seq === seq)?.ts : undefined)
        ?? t.messages[0]?.timestampMs ?? Date.now();
    }
    const firstUser = t.messages.find((m2) => m2.role === "user" && m2.content.trim());
    t.label = (firstUser?.content ?? t.messages.find((m2) => m2.content.trim())?.content ?? "").slice(0, 60);
    // A user request with no agent message after it is still awaiting a
    // reply — expose its requestId so the client can offer cancel.
    const last = t.messages[t.messages.length - 1];
    if (last?.role === "user") {
      last.pending = true;
      if (last.request_id) t.pending_request_id = last.request_id;
    }
    out.push(t);
  }
  return out;
}

// ── Local sidechat fallback ──────────────────────────────────────────────
// This devin build answers `_cognition.ai/sidechain/*` with Method not
// found, so a sidechat thread instead runs as a DEDICATED devin session —
// the persona pattern: every thread shares one sidecar cwd
// (<dataDir>/sidechat → a single pooled acp hosts all of them, so a
// sidechat can never dirty the user's workspace), each anchor→chatId
// mapping is journaled on the PARENT meta (`sidechats[anchor]`), and chat
// sessions carry meta.hidden so they never list in the sessions sidebar.
// The first send seeds the thread with the anchor context; GET projects
// the chat session's own log (sessionLog.get is lazy — never kicks a
// session/load) into the same SidechainThread shape the client renders.

/** Latched when the official `_cognition.ai/sidechain/request` call reports
 * unimplemented — later sends skip the probe (and its session/load). */
let sidechainExtBroken = false;

/** devin's surface for an unimplemented ext method: a -32601 RequestError
 * ("Method not found": …), "unknown method", or the same text wrapped in a
 * result body. ONLY these trip the local fallback — locked/offline/429 are
 * real errors the client must see, not fall back through. */
function isMethodNotFound(e: unknown): boolean {
  if ((e as { code?: number } | null | undefined)?.code === -32601) return true;
  return /method not found|unknown method|no such method|not implemented|unsupported/i.test(String((e as Error)?.message ?? e));
}

const SIDECHAT_AGENTS = `# 侧聊问答助手

你是某个主工作会话的「侧聊」问答后端 —— 用户带着主对话的上下文向你提问。

## 只做
- 解释主对话里 agent 的行为、代码、报错、决策
- 基于提供的上下文回答「为什么 / 是什么 / 怎么办」

## 不做
- 不修改、创建、删除任何文件
- 不执行命令（此目录里也没有任何可动的东西）
- 不把问题当成新的开发任务去执行

## 风格
- 直接、先给结论；上下文里没有的信息就如实说，不要编
`;

/** The shared sidecar cwd — one pooled acp hosts every sidechat session of
 * every parent (a dedicated acp per thread would orphan a devin process
 * per anchor). */
function sidechatCwd(ctx: ApiContext): string {
  const dir = path.join(ctx.store.dataDir, "sidechat");
  try {
    fs.mkdirSync(dir, { recursive: true });
    const am = path.join(dir, "AGENTS.md");
    if (!fs.existsSync(am)) fs.writeFileSync(am, SIDECHAT_AGENTS);
  } catch { /* best-effort */ }
  return dir;
}

/** Get-or-create the dedicated devin session backing one anchor thread.
 * Concurrent first-sends share the create via `sidechatCreating`. */
const sidechatCreating = new Map<string, Promise<string>>();
async function ensureSidechat(ctx: ApiContext, id: string, anchorRaw: string): Promise<string> {
  const mm = meta(ctx, id);
  const cwd = sidechatCwd(ctx);
  const existing = mm.sidechats?.[anchorRaw];
  if (existing) {
    // sessionCwd is memory-only — reseed after a restart so hostFor
    // resolves the sidechat pool instead of falling back to primaryCwd
    // (a load there would re-bind the thread to the USER's workspace).
    if (ctx.sessionCwd.get(existing) !== cwd) ctx.sessionCwd.set(existing, cwd);
    return existing;
  }
  const key = `${id}${anchorRaw}`;
  const cur = sidechatCreating.get(key);
  if (cur) return cur;
  const p = (async () => {
    const acp = await ctx.manager.get(cwd);
    const s = await acp.newSession(cwd);
    ctx.sessionCwd.set(s.sessionId, cwd);
    captureLoadResponse(s.sessionId, s, acp.agent?.id ?? "devin");
    markLoadedOn(s.sessionId, acp);
    const cm = meta(ctx, s.sessionId);
    cm.title = "💬 侧聊"; cm.folder = ".persona"; cm.hidden = true; cm.sidechatFor = id;
    (meta(ctx, id).sidechats ??= {})[anchorRaw] = s.sessionId;
    saveReg();
    return s.sessionId;
  })().finally(() => { sidechatCreating.delete(key); });
  sidechatCreating.set(key, p);
  return p;
}

/** Display text of one stored log row (for seed/context purposes). */
function ctxRow(e: LogEntry): { k: string; t: string; toolId?: string } {
  const u = e.update;
  const kind = String(u.sessionUpdate ?? "");
  if (kind === "user_message_chunk" || kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
    return { k: kind === "user_message_chunk" ? "user" : kind === "agent_message_chunk" ? "agent" : "thought", t: sidechainText(u, (u.message ?? {}) as Record<string, unknown>) };
  }
  if (kind === "tool_call" || kind === "tool_call_update") {
    return { k: "tool", t: pickStr(u, "title") ?? "", toolId: String(u.toolCallId ?? "") };
  }
  return { k: "", t: "" };
}
const CTX_LABEL: Record<string, string> = { user: "用户: ", agent: "Devin: ", thought: "[思考] ", tool: "[操作] " };

/** The anchor row plus a compact window of surrounding conversation — the
 * context a dedicated sidechat session needs to answer against. An
 * unresolvable anchor falls back to the transcript tail. */
function anchorContext(ctx: ApiContext, id: string, raw: string): string {
  const entries = ctx.sessionLog.get(id);
  if (!entries.length) return "";
  const at = (() => {
    const em = /^e(\d+)$/.exec(raw);
    if (em) return entries.findIndex((e) => e.seq === Number(em[1]));
    if (raw.startsWith("t")) return entries.findIndex((e) => String(e.update.toolCallId ?? "") === raw.slice(1));
    return -1;
  })();
  const lo = at >= 0 ? Math.max(0, at - 50) : Math.max(0, entries.length - 60);
  const hi = at >= 0 ? Math.min(entries.length - 1, at + 10) : entries.length - 1;
  const lines: string[] = [];
  let cur: { k: string; t: string; toolId?: string; anchor: boolean } | null = null;
  const flush = () => {
    if (!cur?.t) return;
    lines.push(`${cur.anchor ? "【锚点行】" : ""}${CTX_LABEL[cur.k] ?? ""}${cur.t}`);
    cur = null;
  };
  for (let i = lo; i <= hi; i++) {
    const r = ctxRow(entries[i]);
    if (!r.t) continue;
    // Streamed chunks of one message share the kind — join them.
    if (cur && r.k === cur.k && r.k !== "tool" && cur.k !== "tool") { cur.t += r.t; cur.anchor ||= i === at; continue; }
    // tool_call_update echoes the same call — latest title wins.
    if (cur && r.k === "tool" && cur.k === "tool" && r.toolId && r.toolId === cur.toolId) { cur.t = r.t; cur.anchor ||= i === at; continue; }
    flush();
    cur = { ...r, anchor: i === at };
  }
  flush();
  const joined = lines.join("\n");
  return joined.length > 9000 ? joined.slice(-9000) : joined;
}

// The seeded wrapper is journaled into the chat session's own log; display
// re-derives the bare question by cutting at the LAST question marker.
const SEED_SIG = "侧边问答助手";
const SEED_Q = "⟦用户提问⟧";

/** First-send text: role brief + anchor context + the question. Later sends
 * go to the thread bare — session/load replays the whole transcript, so
 * context persists for the chat session's life. */
function sidechatSeed(ctx: ApiContext, id: string, anchorRaw: string, message: string): string {
  const title = meta(ctx, id).title ?? titleFromLog(ctx, id) ?? id;
  const cwd = ctx.sessionCwd.get(id) ?? ctx.primaryCwd;
  const ctxText = anchorContext(ctx, id, anchorRaw);
  return [
    `你是主会话「${title}」的${SEED_SIG} —— 用户在侧栏就主对话内容向你提问。主会话工作目录：${cwd}。`,
    `只回答与主对话相关的问题：解释、分析、给建议。不要修改任何文件、不要执行命令、不要把问题当成新任务执行；上下文里没有的信息就如实说明。`,
    ctxText ? `\n用户发起侧聊时选中的锚点行（【锚点行】）及附近对话：\n\n${ctxText}` : "",
    `\n${SEED_Q}\n${message}`,
  ].filter(Boolean).join("\n");
}

/** Cut the seeded first-user row down to the bare question for display. */
function stripSeed(text: string): string {
  if (!text.includes(SEED_SIG)) return text;
  const i = text.lastIndexOf(SEED_Q);
  return i >= 0 ? text.slice(i + SEED_Q.length).replace(/^\s+/, "") : text;
}

/** One raw message row while projecting a chat session's log. */
interface LocalMsg {
  role: "user" | "assistant";
  text: string;
  local: boolean;
  /** _meta streaming/clientMessageId — streamed chunks of one message share
   * it; a NEW id on an adjacent same-role row means a new message. */
  mid?: string;
  seq?: number;
  ts: number;
  error?: string;
}

/** Project one journaled sidechat thread from its dedicated session's log.
 * Only user + assistant rows survive — tool/thought/usage noise is dropped,
 * streamed agent chunks re-merge into one bubble, and the optimistic
 * `_local` user row graduates in place when devin's echo lands. */
function localSidechatThread(ctx: ApiContext, id: string, anchor: string, chatId: string): SidechainThread {
  const t: SidechainThread = {
    anchor_event_id: anchor,
    anchor_ts: anchorEntry(ctx, id, anchor)?.ts ?? 0,
    label: "", messages: [],
  };
  const raw: LocalMsg[] = [];
  for (const e of ctx.sessionLog.get(chatId)) {
    const u = e.update;
    const k = String(u.sessionUpdate ?? "");
    if (k === "dw_notice") {
      // Turn-level failure markers (rate-limit, dead host) surface as an
      // error bubble — the thread shows WHY a send produced no reply.
      const n = String(u.notice ?? "");
      if (n) raw.push({ role: "assistant", text: n, local: false, seq: e.seq, ts: e.ts, error: /^错误/.test(n) ? n : undefined });
      continue;
    }
    if (k !== "user_message_chunk" && k !== "agent_message_chunk") continue;
    const c = u.content as { type?: string; text?: string } | undefined;
    if (c?.type !== "text" || typeof c.text !== "string") continue; // non-text blocks don't render here
    const role = k === "user_message_chunk" ? "user" as const : "assistant" as const;
    const mid = pickStr((u._meta ?? {}) as Record<string, unknown>, "cognition.ai/streamingMessageId", "cognition.ai/clientMessageId");
    const last = raw[raw.length - 1];
    if (u._local) { raw.push({ role, text: c.text, local: true, mid, seq: e.seq, ts: e.ts }); continue; }
    if (last && last.role === role) {
      if (last.local) {
        // devin's echo of the optimistic row — the twin graduates in place.
        if (role === "user" && (c.text === last.text || last.text.startsWith(c.text) || c.text.startsWith(last.text))) {
          last.text = c.text; last.local = false; last.mid = mid ?? last.mid; last.seq = e.seq; last.ts = e.ts;
        } else raw.push({ role, text: c.text, local: false, mid, seq: e.seq, ts: e.ts });
        continue;
      }
      // Same-role adjacency merges streamed chunks — but a different
      // streaming/clientMessageId means a genuinely NEW message (two replies
      // separated only by a skipped tool row must not fuse into one bubble).
      if (mid && last.mid && mid !== last.mid) { raw.push({ role, text: c.text, local: false, mid, seq: e.seq, ts: e.ts }); continue; }
      if (role === "user" && c.text === last.text) { last.seq = e.seq; continue; } // replay-residue dupe
      last.text += c.text; last.mid = last.mid ?? mid; last.seq = e.seq; last.ts = e.ts;
      continue;
    }
    raw.push({ role, text: c.text, local: false, mid, seq: e.seq, ts: e.ts });
  }
  let seedStripped = false;
  for (const r of raw) {
    if (r.role === "user" && !seedStripped) { r.text = stripSeed(r.text); seedStripped = true; }
    t.messages.push({
      role: r.role, content: r.text,
      ts: new Date(r.ts).toISOString(), timestampMs: r.ts,
      event_id: `l${r.seq ?? "?"}`,
      ...(r.error ? { error: r.error } : {}),
    });
  }
  // The turn is live while the send is in flight or its open-turn entry
  // still journals (crash survivor) — the client renders a spinner + cancel.
  const lastMsg = t.messages[t.messages.length - 1];
  if (lastMsg?.role === "user" && (inflight.has(chatId) || openTurns.has(chatId))) {
    lastMsg.pending = true;
    lastMsg.request_id = `sidechat-${chatId}`;
    t.pending_request_id = lastMsg.request_id;
  }
  t.label = (t.messages.find((m2) => m2.role === "user" && m2.content.trim())?.content
    ?? t.messages.find((m2) => m2.content.trim())?.content ?? "").slice(0, 60);
  if (!t.anchor_ts) t.anchor_ts = t.messages[0]?.timestampMs ?? 0;
  return t;
}

/** All journaled local threads for a parent session — anchors already
 * covered by an official thread win (defensive; a build can't serve both). */
function localSidechatThreads(ctx: ApiContext, id: string, covered: Set<string>): SidechainThread[] {
  const sc = meta(ctx, id).sidechats;
  if (!sc) return [];
  openTurnsLoad(ctx);
  const out: SidechainThread[] = [];
  for (const [anchor, chatId] of Object.entries(sc)) {
    if (!covered.has(anchor)) out.push(localSidechatThread(ctx, id, anchor, chatId));
  }
  return out;
}

/** Parent archived → shelf the thread backends too (the map stays so an
 * un-archive restores them; the SHARED sidechat acp is never killed —
 * other parents' threads live on it). */
export function archiveSidechats(ctx: ApiContext, id: string) {
  const sc = meta(ctx, id).sidechats;
  if (!sc) return;
  for (const chatId of Object.values(sc)) meta(ctx, chatId).archived = true;
}

export async function handleSessionTimeline(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL, m: string, sub: string, id: string): Promise<boolean> {
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
    // The session log is the single source of truth (hydration merges every
    // mirror by journaled seq). The snapshot's only role is a paint while
    // `live` is torn — ONE invariant: serve whichever is richer. Serving
    // the snapshot unconditionally during load REGRESSED below live when
    // the replay had already streamed past the snapshot's persist point
    // (snap is only written at settle, so a mid-replay snap is always
    // older). Ties go to live — the authoritative gen.
    const snap = snapshotItems(ctx, id);
    const serveSnap = !!snap && snap.length > live.length;
    const all = serveSnap ? snap : live;
    // Consume the reset flag only when actually serving new-gen items.
    const reset = !loading && !serveSnap && tlReset.delete(id);
    // Page from the END (newest). `limit` items per page; `cursor` is the
    // eidx (log seq) of the OLDEST item already served — a content address
    // that survives rebuilds, ring trims, and snapshot↔live window swaps.
    // (Positional-index paging silently sliced whatever array was current:
    // every rebuild moved the indexes mid-scroll → back-fetches landed on
    // the wrong window → "pull to load history" flashed blank.)
    const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get("limit") ?? "300", 10) || 300));
    const cursor = url.searchParams.get("cursor");
    if (url.searchParams.get("raw") === "1") {
      json(res, 200, { entries: ctx.sessionLog.get(id) });
      return true;
    }
    let page: typeof all;
    if (cursor !== null) {
      const c = parseInt(cursor, 10);
      const eligible = Number.isFinite(c) ? all.filter((it) => (it.eidx ?? -1) < c) : all;
      page = eligible.slice(-limit);
    } else {
      page = all.slice(-limit);
    }
    const items = loading && !snap ? [] : page;
    // Items are seq-ordered — the first eidx-bearing row is the page's
    // minimum; eidx-less synthesized rows can't serve as a boundary and
    // would stall the chain if they happened to lead the page.
    const boundary = page.find((it) => typeof it.eidx === "number")?.eidx;
    const hasMore = boundary != null && all.some((it) => (it.eidx ?? -1) < boundary);
    const st = sessionStatus(ctx, id);
    json(res, 200, {
      items,
      // Frozen while a replay is in flight (the live array is mid-write)
      // and withheld in peek mode — back-scrolling is real-read intent,
      // so the client's cursor-less loadOlder graduates to a real load.
      next_cursor: !loading && !peek && hasMore ? String(boundary) : null,
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
      // original message so the client can offer one-click resend. While a
      // load/replay is in flight the tail is mid-write — a verdict drawn
      // from it flickers (banner appears then vanishes). Report only once
      // the stream settles.
      interrupted: loading ? undefined : interruptedTurn(ctx, id) ?? undefined,
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
        // fileUpdates carry spawn-time absolute paths — the repo moved, so
        // remap the legacy segment or every old file links to a dead dir.
        const fp = remapLegacyCwd(f.file_path);
        const cur = files.get(fp) ?? { path: fp, added: 0, removed: 0 };
        cur.added += f.lines_added ?? 0;
        cur.removed += f.lines_removed ?? 0;
        cur.lastKey = f.fileId;
        files.set(fp, cur);
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
    // Read-only projection of the stored log — a sidechat request's user
    // message and its replies all land as updates stamped with the meta.
    const threads = sidechainThreads(ctx, id);
    // …plus LOCAL threads: dedicated per-anchor sessions this build falls
    // back to (devin answers Method not found for the ext request).
    threads.push(...localSidechatThreads(ctx, id, new Set(threads.map((t) => t.anchor_event_id))));
    json(res, 200, { threads, error: null });
    return true;
  }
  if (sub === "sidechain" && m === "POST") {
    const body = (await readJson(req)) as { anchor_event_id?: unknown; anchor_ts?: unknown; message?: unknown };
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const anchorRaw = typeof body.anchor_event_id === "string" ? body.anchor_event_id : "";
    if (!message) { json(res, 400, { error: "empty message" }); return true; }
    if (!anchorRaw) { json(res, 400, { error: "missing anchor_event_id" }); return true; }
    if (isDraining()) { json(res, 503, { error: "server restarting" }); return true; }
    // Official ext first — until it proves unimplemented on this devin
    // build (-32601 / "Method not found"); the latch then skips the probe
    // (and its session/load) for every later send. Nothing else falls back:
    // a real failure (locked, offline, 429) must surface, not fork a thread.
    if (!sidechainExtBroken) {
      try {
        const acp = await acpForId(ctx, id); // replies need a live, loaded session
        const requestId = `sidechain-${randomUUID()}`;
        const eventId = `sidechain-ev-${randomUUID()}`;
        const r = await acp.sidechainRequest({
          sessionId: id, requestId, eventId,
          anchorEventId: anchorEventId(ctx, id, anchorRaw),
          anchorTs: pickNum(body, "anchor_ts", "anchorTs") ?? anchorEntry(ctx, id, anchorRaw)?.ts ?? Date.now(),
          message, ensureAwake: true,
        });
        // Some builds wrap ext failures INSIDE the result object.
        const errText = pickStr((r ?? {}) as Record<string, unknown>, "error", "message");
        if (errText && /method not found|unknown method|not implemented/i.test(errText)) {
          throw Object.assign(new Error(errText), { code: -32601 });
        }
        json(res, 200, { ok: true, requestId });
        return true;
      } catch (e) {
        if (!isMethodNotFound(e)) {
          json(res, 200, { ok: false, error: String((e as Error)?.message ?? e) });
          return true;
        }
        sidechainExtBroken = true;
      }
    }
    // Local fallback — one dedicated devin session per anchor thread.
    try {
      const chatId = await ensureSidechat(ctx, id, anchorRaw);
      const mm = meta(ctx, id);
      // Seeded once: first send carries the anchor context; the log scan
      // covers a flag lost to a dw.json rollback.
      const seeded = mm.sidechatSeeded?.[anchorRaw] === true
        || ctx.sessionLog.get(chatId).some((e) => e.update.sessionUpdate === "user_message_chunk"
          && String((e.update.content as { text?: string } | undefined)?.text ?? "").includes(SEED_SIG));
      const text = seeded ? message : sidechatSeed(ctx, id, anchorRaw, message);
      if (!seeded) { (mm.sidechatSeeded ??= {})[anchorRaw] = true; saveReg(); }
      if (inflight.has(chatId) || queueList(chatId).length) {
        // A turn is still live — park the follow-up; dispatchPrompt's
        // settle path flushes it FIFO like the main composer queue.
        const m2 = queueAdd(ctx, chatId, text);
        if (!inflight.has(chatId)) queueFlush(ctx, chatId);
        json(res, 200, { ok: true, requestId: `sidechat-${chatId}`, local: true, queued: m2.id });
        return true;
      }
      dispatchPrompt(ctx, chatId, text);
      json(res, 200, { ok: true, requestId: `sidechat-${chatId}`, local: true });
    } catch (e) {
      json(res, 200, { ok: false, error: String((e as Error)?.message ?? e) });
    }
    return true;
  }
  if (sub === "sidechain/cancel" && m === "POST") {
    const body = (await readJson(req)) as { anchor_event_id?: unknown; request_id?: unknown };
    const reqId = typeof body.request_id === "string" ? body.request_id : "";
    const anchorRaw = typeof body.anchor_event_id === "string" ? body.anchor_event_id : "";
    // A LOCAL thread owns the cancel — resolve its backend session via the
    // anchor (the client always echoes thread.anchor_event_id) or a
    // `sidechat-<chatId>` request id; only journaled chat sessions qualify
    // so a crafted request_id can never reach the parent session.
    const sc = meta(ctx, id).sidechats ?? {};
    const chatId = (anchorRaw && sc[anchorRaw]) ||
      (reqId.startsWith("sidechat-") && Object.values(sc).includes(reqId.slice(9)) ? reqId.slice(9) : undefined);
    if (chatId) {
      const host = sessionHost.get(chatId);
      if (host && !host.exited) {
        try { await host.cancel(chatId); } catch { /* not running */ }
      } else {
        // No live host — a journaled-but-dead turn would sit pending
        // forever; drop the marker so the thread stops spinning.
        openTurnsLoad(ctx);
        if (openTurns.has(chatId)) clearOpenTurns(ctx, chatId);
      }
      json(res, 200, { ok: true });
      return true;
    }
    try {
      const acp = await acpForId(ctx, id);
      await acp.extMethod(id, "_cognition.ai/sidechain/cancel", {
        sessionId: id,
        requestId: reqId || undefined,
        anchorEventId: anchorEventId(ctx, id, anchorRaw),
      });
      json(res, 200, { ok: true });
    } catch (e) {
      json(res, 200, { ok: false, error: String((e as Error)?.message ?? e) });
    }
    return true;
  }

  // POST .../term-agent {text, model?, note?} — the terminal "agent" input:
  // natural-language intent → a shell command, via devin's real NL→command
  // extension `_cognition.ai/command/revise` (params {sessionId, command,
  // note} — all required, non-empty; result {command}). Verified live on
  // this build: {command:"list files", note:"shell command"} →
  // {"command":"ls"}. The session's main agent is NOT involved — this is
  // a separate one-shot inference. `text` → `command`; `note` defaults to
  // a shell hint (PowerShell locally on win32, POSIX shell otherwise and for
  // ssh-hosted sessions). `model` is forwarded verbatim — the installed
  // build's CommandReviseParams has exactly those 3 fields and ignores
  // extras, so the pick is stored client-side and sent for forward-compat
  // only (no model choice on this build — document, don't fake).
  // The route only translates: the client executes the returned command
  // in the terminal itself. hostFor (no session/load) first — sessions
  // created on the cwd pool already answer; "Session not found"/"not
  // live" (pre-restart session on a foreign acp) → one retry via
  // acpForId, which loads it for real.
  if (sub === "term-agent" && m === "POST") {
    const body = (await readJson(req)) as { text?: string; model?: string; note?: string };
    const text = String(body.text ?? "").trim();
    if (!text) { json(res, 400, { error: "empty text" }); return true; }
    const note = String(body.note ?? "").trim()
      || (meta(ctx, id).ssh || process.platform !== "win32" ? "shell command" : "powershell command");
    const params: Record<string, unknown> = { sessionId: id, command: text, note };
    if (body.model) params.model = String(body.model);
    try {
      let result: unknown;
      try {
        const { acp } = await hostFor(ctx, id);
        result = await acp.extMethod(id, "_cognition.ai/command/revise", params);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/not found|not live/i.test(msg)) throw e;
        result = await (await acpForId(ctx, id)).extMethod(id, "_cognition.ai/command/revise", params);
      }
      const cmd = String((result as Record<string, unknown> | null)?.command ?? "");
      json(res, 200, cmd ? { ok: true, command: cmd } : { ok: false, error: "empty revision", result });
    } catch (err) {
      json(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (sub === "terminal" && m === "GET") {
    const pid = url.searchParams.get("pid") ?? "";
    const buf = terminalText(pid);
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

  return false;
}
