/**
 * persona.ts — 分身代答: when a working session's turn ends on a question
 * aimed at the user, a dedicated persona acp session (cwd =
 * <dataDir>/persona, whose AGENTS.md is the owner's behavioral spec) answers
 * on the user's behalf. Uncertain answers come back as `[升级]` → the session
 * is flagged personaEscalated (amber banner) until a human message clears it.
 *
 * Wiring: sessionprompt's turnEndHooks (registered below on import — no import
 * cycle: persona→sessionprompt only). Routes live in lweb/admin.ts.
 */
import fs from "node:fs";
import path from "node:path";
import type { ApiContext } from "./routes.js";
import { loadReg, saveReg, meta } from "./dwstore.js";
import { acpForId } from "./sessionload.js";
import { dispatchPrompt, promptWithRetry, turnEndHooks } from "./sessionprompt.js";
import { inflight, isDraining } from "./sessionlive.js";
import { captureLoadResponse } from "./sessioncfg.js";
import { loadInflight, markLoadedOn } from "./sessionplace.js";

export type PersonaMode = "off" | "semi" | "auto";

const ANSWER_PREFIX = "[分身] ";
const ESCALATE_TAG = "[升级]";

function personaDir(ctx: ApiContext) {
  return path.join(ctx.store.dataDir, "persona");
}

function personaCfg(ctx: ApiContext) {
  return loadReg(ctx).prefs?.persona ?? {};
}

/** Effective per-session mode: meta override > global default > 'off'. */
export function personaMode(ctx: ApiContext, id: string): PersonaMode {
  const m = meta(ctx, id).personaMode;
  if (m === "off" || m === "semi" || m === "auto") return m;
  const g = personaCfg(ctx).mode;
  return g === "auto" || g === "semi" ? g : "off";
}

export function personaState(ctx: ApiContext, id: string) {
  return { mode: personaMode(ctx, id), escalated: !!meta(ctx, id).personaEscalated };
}

const SKELETON = `# 分身人设 —— 你代替用户本人回答「工作会话 agent」的提问

## 你收到的输入
工作会话 agent 在干活中途向"老板"提问。你会看到：会话标题/cwd、
它最后的提问原文、最近的对话上下文。

## 怎么答
- 先给结论，短句，不绕弯
- 有明确原则时直接拍板；方案抉择按原则选，不反问
- 永远以分身身份答，不要暴露"我是AI扮演的"

## 我的原则（往里填）
-

## 真实样例（往里填：以前遇到 X 我怎么答）
-

## 红线 —— 命中以下任何一条，只回复 \`[升级]\` 四个字面量
- 涉及钱、删除/覆盖数据、对外承诺、不可逆操作
- 给的信息不足以判断，硬答可能把活带偏
- 对方其实在问"我本人"才知道的事（日程、偏好、密码等）
`;

function ensurePersonaDir(ctx: ApiContext) {
  const dir = personaDir(ctx);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const am = path.join(dir, "AGENTS.md");
    if (!fs.existsSync(am)) fs.writeFileSync(am, SKELETON);
    const dl = path.join(dir, "decisions.log");
    if (!fs.existsSync(dl)) fs.writeFileSync(dl, "");
  } catch { /* best-effort */ }
  return dir;
}

function logDecision(ctx: ApiContext, rec: Record<string, unknown>) {
  try {
    fs.appendFileSync(path.join(ensurePersonaDir(ctx), "decisions.log"), JSON.stringify({ ts: Date.now(), ...rec }) + "\n");
  } catch { /* best-effort */ }
}

export function decisionsTail(ctx: ApiContext, n = 50): Record<string, unknown>[] {
  try {
    const lines = fs.readFileSync(path.join(personaDir(ctx), "decisions.log"), "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-n).map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return { raw: l }; } });
  } catch { return []; }
}

function notifyWebhook(ctx: ApiContext, payload: Record<string, unknown>) {
  const url = personaCfg(ctx).webhook;
  if (!url) return;
  void fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "devin-web persona", ...payload }),
    signal: AbortSignal.timeout(8000),
  }).catch((e) => console.error(`[persona] webhook failed: ${e instanceof Error ? e.message : e}`));
}

// ---------------------------------------------------------------------------
// persona session — one persistent devin session on cwd=<dataDir>/persona.
// Its own AGENTS.md makes the persona zero-config to load. The id is kept in
// dw.json `persona.sessionId`; a dead/locked one is recreated transparently.
// ---------------------------------------------------------------------------

let creating: Promise<string> | null = null;

async function ensurePersonaSession(ctx: ApiContext): Promise<string> {
  const r = loadReg(ctx);
  const existing = r.persona?.sessionId;
  if (existing && ctx.sessionCwd.get(existing) === personaDir(ctx)) return existing;
  if (creating) return creating;
  creating = (async () => {
    const cwd = ensurePersonaDir(ctx);
    const acp = await ctx.manager.get(cwd);
    const s = await acp.newSession(cwd);
    ctx.sessionCwd.set(s.sessionId, cwd);
    captureLoadResponse(s.sessionId, s);
      markLoadedOn(s.sessionId, acp);
    const mm = meta(ctx, s.sessionId);
    mm.title = "🎭 分身"; mm.folder = ".persona";
    const reg = loadReg(ctx);
    (reg.persona ??= {}).sessionId = s.sessionId;
    saveReg();
    return s.sessionId;
  })().finally(() => { creating = null; });
  return creating;
}

// ---------------------------------------------------------------------------
// detection — "the agent is asking the boss something"
// ---------------------------------------------------------------------------

const QUESTION_RE = /(请确认|需要你|你希望|是否|要不要|选哪|怎么选|确认一下|可以吗|行吗|对吗|帮我选|怎么办|do you want|would you|should i|please confirm|which (one|option)|pick one)/i;

/** Joined text of the last agent message (streaming chunks since the last
 * user/boundary entry), plus its seq — for dedup against personaLastSeq. */
function tailQuestion(ctx: ApiContext, id: string): { text: string; seq: number } | null {
  const log = ctx.sessionLog.get(id);
  const texts: string[] = [];
  let seq = 0;
  for (let i = log.length - 1; i >= 0 && i > log.length - 300; i--) {
    const u = log[i].update;
    const k = String(u.sessionUpdate ?? "");
    if (k === "user_message_chunk" || k === "dw_turn_end" || k === "dw_notice") break;
    if (k === "agent_message_chunk") {
      const t = String((u.content as { text?: string } | undefined)?.text ?? "");
      texts.unshift(t);
      if (!seq && log[i].seq) seq = log[i].seq!;
    }
  }
  const text = texts.join("").trim();
  return text ? { text, seq } : null;
}

function looksLikeQuestion(text: string) {
  const tail = text.slice(-500);
  return /[?？]\s*$/u.test(tail) || QUESTION_RE.test(tail);
}

// ---------------------------------------------------------------------------
// caps + bookkeeping (in-memory; a restart just resets the counters)
// ---------------------------------------------------------------------------

const askHistory = new Map<string, number[]>();
const asking = new Set<string>();

function capped(ctx: ApiContext, id: string): boolean {
  const max = personaCfg(ctx).maxPerHour ?? 4;
  const now = Date.now();
  const arr = (askHistory.get(id) ?? []).filter((t) => now - t < 3600_000);
  askHistory.set(id, arr);
  return arr.length >= max;
}

function noteAsked(ctx: ApiContext, id: string) {
  (askHistory.get(id) ?? askHistory.set(id, []).get(id)!).push(Date.now());
}

function broadcastState(ctx: ApiContext, id: string, state: string) {
  ctx.hub.broadcast({ type: "persona_state", sessionId: id, state });
}

// ---------------------------------------------------------------------------
// the ask
// ---------------------------------------------------------------------------

/** Core Q&A: fire the persona session at `question` and return its text. */
async function runPersona(ctx: ApiContext, pid: string, prompt: string): Promise<string> {
  // Drain gate: no new persona asks once a restart is draining — an in-flight
  // ask is registered so the drain waits for it like any other turn.
  if (isDraining()) return "";
  ctx.sessionLog.append(pid, {
    sessionUpdate: "user_message_chunk",
    content: { type: "text", text: prompt }, _local: true,
  });
  const log = ctx.sessionLog.get(pid);
  const marker = log.length - 1;
  inflight.add(pid);
  try {
    await promptWithRetry(ctx, pid, () => acpForId(ctx, pid), (acp) => acp.prompt(pid, [{ type: "text", text: prompt }] as never));
  } finally {
    inflight.delete(pid);
  }
  ctx.sessionLog.append(pid, { sessionUpdate: "dw_turn_end" });
  const out: string[] = [];
  for (let i = marker + 1; i < log.length; i++) {
    const u = log[i].update;
    if (u.sessionUpdate === "agent_message_chunk") {
      out.push(String((u.content as { text?: string } | undefined)?.text ?? ""));
    }
  }
  return out.join("").trim();
}

function personaSessionTitle(ctx: ApiContext, id: string): string {
  return meta(ctx, id).title ?? id;
}

/** Ask the persona about the session's tail question. Delivers the answer
 * back through dispatchPrompt (so queues/retry/logging stay canonical) or
 * flags escalation. Returns true when it actually took action. */
export async function askPersona(ctx: ApiContext, id: string, reason: "auto" | "manual"): Promise<boolean> {
  if (asking.has(id)) return false;
  const q = tailQuestion(ctx, id);
  if (!q || !looksLikeQuestion(q.text)) return false;
  const m = meta(ctx, id);
  if (reason === "auto" && q.seq && m.personaLastSeq === q.seq) return false;
  if (reason === "auto" && capped(ctx, id)) {
    m.personaEscalated = true; saveReg();
    broadcastState(ctx, id, "escalated");
    logDecision(ctx, { kind: "escalate", why: "rate_cap", session: id });
    return false;
  }
  asking.add(id);
  m.personaLastSeq = q.seq || m.personaLastSeq;
  saveReg();
  try {
    const pid = await ensurePersonaSession(ctx);
    if (pid === id) return false;
    const decisions = decisionsTail(ctx, 8)
      .map((d) => `- ${new Date(Number(d.ts) || 0).toISOString().slice(0, 16)} ${d.kind}: ${String(d.q ?? "").slice(0, 80)} → ${String(d.a ?? d.why ?? "").slice(0, 80)}`)
      .join("\n");
    const prompt = [
      `工作会话「${personaSessionTitle(ctx, id)}」（cwd: ${ctx.sessionCwd.get(id) ?? "?"}）的 agent 向你提问：`,
      "",
      q.text.slice(-2500),
      "",
      decisions ? `近期代答记录：\n${decisions}` : "",
      "",
      `直接输出要发回给它的答复文本。拿不准、涉及红线或需要我本人判断 → 只回 ${ESCALATE_TAG}。`,
    ].filter(Boolean).join("\n");
    const answer = await runPersona(ctx, pid, prompt);
    if (!answer || answer.includes(ESCALATE_TAG)) {
      m.personaEscalated = true; saveReg();
      broadcastState(ctx, id, "escalated");
      logDecision(ctx, { kind: "escalate", why: answer || "empty", session: id, q: q.text.slice(-400) });
      notifyWebhook(ctx, { type: "escalate", sessionId: id, title: personaSessionTitle(ctx, id), question: q.text.slice(-400) });
      return true;
    }
    noteAsked(ctx, id);
    logDecision(ctx, { kind: "answer", session: id, q: q.text.slice(-400), a: answer.slice(0, 800) });
    notifyWebhook(ctx, { type: "answer", sessionId: id, title: personaSessionTitle(ctx, id), question: q.text.slice(-400), answer: answer.slice(0, 800) });
    broadcastState(ctx, id, "answered");
    dispatchPrompt(ctx, id, ANSWER_PREFIX + answer);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[persona] ask failed for ${id}: ${msg}`);
    logDecision(ctx, { kind: "error", session: id, why: msg.slice(0, 200) });
    return false;
  } finally {
    asking.delete(id);
  }
}

/** Turn-end hook (registered in sessionprompt): auto-mode sessions get a
 * delegated answer when the agent ends on a question. */
function personaOnTurnEnd(ctx: ApiContext, id: string) {
  try {
    if (id === loadReg(ctx).persona?.sessionId) return;
    if (ctx.sessionCwd.get(id) === personaDir(ctx)) return;
    if (meta(ctx, id).hidden) return; // plumbing sessions (sidechat backends) never trigger a persona ask
    if (personaMode(ctx, id) !== "auto") return;
    if (inflight.has(id) || loadInflight.has(id)) return;
    void askPersona(ctx, id, "auto");
  } catch { /* never let persona break a turn settle */ }
}

/** Any human-originated message to the session resolves a pending
 * escalation (the composer route calls this). */
export function personaHumanMessage(ctx: ApiContext, id: string) {
  const m = meta(ctx, id);
  if (!m.personaEscalated) return;
  m.personaEscalated = false;
  saveReg();
  broadcastState(ctx, id, "idle");
}

turnEndHooks.add(personaOnTurnEnd);
