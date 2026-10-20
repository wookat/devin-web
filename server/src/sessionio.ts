/**
 * sessionio — session→acp resolution, history loading, live config,
 * attachments, prompt dispatch, subagents, session listing.
 * Extracted from localwb.ts (mechanical move, behavior unchanged).
 */
import fs from "node:fs";
import path from "node:path";
import type { ApiContext } from "./routes.js";
import type { DevinAcp } from "./acp.js";
import { uploadPath, MIME } from "./uploads.js";
import { isRateLimitError, retryAfterSeconds } from "./accounts.js";
import { catalogInfo } from "./modelcat.js";
import { loadReg, saveReg, meta, noteLastUsed } from "./wbstore.js";
import {
  noteUpdate, persistTail, buildTimeline, buildTimelineFrom, snippet, tlCache,
  tailSnapshot,
  type WbItem, type LogEntry,
} from "./wbtimeline.js";

// ---------------------------------------------------------------------------
// session helpers
// ---------------------------------------------------------------------------

/** acp instance → sessions already `session/load`ed on it (dies with the process). */
const loadedOn = new WeakMap<object, Set<string>>();

/** sessionId → the acp process that has it loaded. Once a session is open on a
 * process it is LOCKED to it — later ops must reuse this host even if
 * sessionCwd gets rewritten by session/list (otherwise the pooled acp for the
 * *other* cwd tries to load it and devin reports session_locked). */
const sessionHost = new Map<string, DevinAcp>();
/** Server boot — the acp subagent registry is process-local, so any agent
 * spawned before this process started has no live handle by definition. */
const BOOT_TS = Date.now();
/** sessionId → when its acp-side subagent registry was last emptied — every
 * successful session/load resets it (post-replay resumes answer "doesn't
 * exist in my current session"). Failed loads keep the old registry, so the
 * stamp is only written on success inside doLoad. */
const loadEpoch = new Map<string, number>();
/** `parent:agentId` — a resume already failed with a missing-handle error
 * for these; short-circuits further relays instead of burning a turn each
 * time the user retries a dead child. */
const deadSubs = new Set<string>();
export function markSubagentDead(parent: string, aid: string) {
  deadSubs.add(`${parent}:${aid}`);
}
/** sessionId → the acp process that holds its session/load lock. Exported so
 * the generic routes never rewrite a pinned session's cwd mapping. */

function isSessionPinned(id: string): boolean {
  const host = sessionHost.get(id);
  return !!host && !host.exited;
}

/** sessionId → config returned in the session/new / session/load RESPONSE
 * (modes + configOptions). Devin emits these in the response, not always as
 * streamed notifications, so capture them here and merge into sessionConfig. */
const responseCfg = new Map<string, {
  configOptions?: ConfigOption[] | null;
  modes?: { currentModeId: string; availableModes?: { id: string; name?: string }[] } | null;
  commands?: { name: string; description?: string; input?: { hint?: string } }[] | null;
  /** Time of the most recent authoritative echo (load or setConfigOption).
   * Logged config_option_update notifications older than this are stale. */
  echoTs?: number;
}>();

/** Last non-empty config seen from ANY session — model/mode option lists are
 * agent-level capabilities (identical for every session on the same CLI), so
 * old sessions whose loadSession response omits config can still show them. */
let lastAgentCfg: {
  configOptions?: ConfigOption[];
  modes?: { currentModeId: string; availableModes?: { id: string; name?: string }[] };
} | null = null;

/** Last non-empty slash-command list seen from ANY session — the set is
 * agent-level (same CLI binary advertises the same commands), so a session
 * whose replay hasn't reached its commands_update yet still gets the list. */
let lastAgentCommands: SessionConfig["commands"] | null = null;

function captureLoadResponse(id: string, r: unknown) {
  if (!r || typeof r !== "object") return;
  const res = r as { configOptions?: ConfigOption[]; modes?: { currentModeId: string; availableModes?: { id: string; name?: string }[] }; availableCommands?: SessionConfig["commands"] };
  responseCfg.set(id, { configOptions: res.configOptions ?? undefined, modes: res.modes ?? undefined, commands: res.availableCommands ?? undefined, echoTs: Date.now() });
  if (res.availableCommands?.length) lastAgentCommands = res.availableCommands;
  if (res.configOptions?.length || res.modes) {
    lastAgentCfg = {
      ...(res.configOptions?.length ? { configOptions: res.configOptions } : {}),
      ...(res.modes ? { modes: res.modes } : {}),
    };
  }
}

/** devin returns errorKind `session_locked` when a session is still open in a
 * dying/other acp process. It advertises `retryable: true` — retry briefly to
 * ride out the lock release, then give up. */
function isSessionLocked(e: unknown): boolean {
  const s = String((e as Error)?.message ?? e);
  return /already open in another process|session_locked/i.test(s);
}

async function loadWithRetry(acp: { loadSession(id: string, cwd: string): Promise<unknown> }, id: string, cwd: string, tries = 5): Promise<unknown> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await acp.loadSession(id, cwd);
    } catch (e) {
      lastErr = e;
      if (!isSessionLocked(e) || i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

/** sessionId → in-flight history replay. Opening a session page fires several
 * endpoints at once (detail/timeline/config/todos/…); without dedup EACH of
 * them started its own `session/load`, replaying the same history N times —
 * the main reason cold opens felt so slow. */
const loadInflight = new Map<string, Promise<void>>();

/** Post-replay echo guard: devin re-pushes the tail of the last streamed
 * message as live deltas right after session/load. Two signatures:
 *  - `ids`: streamingMessageIds this session already saw live — the echo
 *    reuses them (the replayed copy lacks smid entirely).
 *  - `since`: the reload's start time — an echo re-emits with its ORIGINAL
 *    `cognition.ai/timestamp`, which predates `since`, while any genuinely
 *    new chunk stamps ≈now. This catches echoes even when the pre-load log
 *    was already in replayed form and the id harvest came up empty.
 * Never dedup by text — consecutive identical replies are legitimate; the
 * id/timestamp pair is what separates an echo from a new turn. */
const replayGuard = new Map<string, { ids: Set<string>; since: number }>();

/** True when `update` is a live re-emission of a message this session already
 * had before its last reload — drop it before it lands in the log. Only
 * smid-bearing chunks are checked: replayed entries carry no streaming id,
 * so the timestamp cutoff can never eat the replay itself. */
export function isReplayEcho(sessionId: string, update: Record<string, unknown>): boolean {
  const g = replayGuard.get(sessionId);
  if (!g) return false;
  const meta = (update._meta ?? {}) as Record<string, unknown>;
  const smid = meta["cognition.ai/streamingMessageId"];
  if (typeof smid !== "string") return false;
  if (g.ids.has(smid)) return true;
  const ts = Date.parse(String(meta["cognition.ai/timestamp"] ?? ""));
  return !Number.isNaN(ts) && ts < g.since;
}

/** Replay history onto `acp` (clears + rebuilds the in-memory log). */
async function doLoad(ctx: ApiContext, acp: DevinAcp, id: string, cwd: string): Promise<void> {
  // Reloading onto a fresh process replays the whole history — clear the
  // in-memory log first so entries don't duplicate. (New user messages are
  // appended by dispatchPrompt before this call; loadSession's replay does
  // not contain them, so keep them by re-appending after the load.)
  const pendingUser = ctx.sessionLog.get(id)
    .filter((e) => (e.update as { sessionUpdate?: string; _local?: boolean }).sessionUpdate === "user_message_chunk"
      && (e.update as { _local?: boolean })._local);
  const logWasFull = ctx.sessionLog.get(id).length > pendingUser.length;
  if (logWasFull) {
    // Keep the outgoing log as the display snapshot — the replay streams
    // oldest→newest, so without it the page would watch mid-history scroll
    // past until the newest entries finally arrive.
    const preLoad = ctx.sessionLog.get(id).slice();
    tailSnapshot.set(id, preLoad);
    // Arm the echo guard before the log is cleared: union any live-stream
    // ids the pre-load log still has, and stamp `since` with the reload
    // start. Post-load echoes of stored messages get dropped via
    // isReplayEcho (id match, or original meta timestamp predating `since`
    // — the only signature left once preLoad is entirely replayed form).
    {
      const g = replayGuard.get(id) ?? { ids: new Set<string>(), since: 0 };
      for (const e of preLoad) {
        const smid = ((e.update._meta ?? {}) as Record<string, unknown>)["cognition.ai/streamingMessageId"];
        if (typeof smid === "string") g.ids.add(smid);
      }
      g.since = Date.now();
      replayGuard.set(id, g);
    }
    ctx.sessionLog.clear(id);
    let replayed = false;
    try {
      captureLoadResponse(id, await loadWithRetry(acp, id, cwd));
      // A successful reload rebuilt session state from the store — its
      // subagent registry is fresh: agents spawned before this moment have
      // no live handle even though their transcripts replay fine.
      loadEpoch.set(id, Date.now());
      replayed = true;
      persistTail(ctx, id);
      ctx.sessionLog.dropBackup(id);
    } finally {
      tailSnapshot.delete(id);
      const postLog = ctx.sessionLog.get(id);
      if (!replayed || (postLog.length === 0 && preLoad.length > 0)) {
        // The replay never ran (session_locked / dead process) — clear()
        // already moved the disk log aside, so put EVERYTHING back: file via
        // rename (full history, byte-exact), memory via restoreMemory (the
        // ring window). Without this a failed reload permanently erases the
        // transcript — the "message + reply gone after refresh" bug.
        ctx.sessionLog.restoreFile(id);
        ctx.sessionLog.restoreMemory(id, preLoad);
      } else {
        // Replay delivered the real twins of our optimistic prompts — don't
        // re-append `_local` copies that would duplicate (and shift ids).
        const replayedUser = new Set(
          postLog
            .filter((e) => {
              const u = e.update as { sessionUpdate?: string; _local?: boolean; content?: { text?: string } };
              return u.sessionUpdate === "user_message_chunk" && !u._local;
            })
            .map((e) => (e.update as { content?: { text?: string } }).content?.text),
        );
        // devin's store snapshot can lag the stream it just sent us by a turn —
        // anything in the pre-load log AFTER the last entry the replay covered
        // is the unreplayed tail: re-append it or that exchange vanishes.
        // Anchors are identity-stable units (user text, toolCallId); an
        // ordinal suffix keeps repeated identical texts unambiguous.
        const keyOf = (u: Record<string, unknown>) => {
          const t = (u.content as { text?: string } | undefined)?.text;
          if (u.sessionUpdate === "user_message_chunk" && t) return `U|${t}`;
          if (u.sessionUpdate === "tool_call" && u.toolCallId) return `TC|${u.toolCallId}`;
          return null;
        };
        const ordinals = (entries: LogEntry[]) => {
          const seen = new Map<string, number>();
          return entries.map((e) => {
            const k = keyOf(e.update);
            if (!k) return null;
            const n = (seen.get(k) ?? 0) + 1;
            seen.set(k, n);
            return `${k}#${n}`;
          });
        };
        const postKeys = new Set(ordinals(postLog));
        const preKeys = ordinals(preLoad);
        let anchor = -1;
        for (let i = preLoad.length - 1; i >= Math.max(0, preLoad.length - 2000); i--) {
          const k = preKeys[i];
          if (k && postKeys.has(k)) { anchor = i; break; }
        }
        // Anchors bound the tail but can't cover agent message chunks (no
        // stable key) — a settled last turn anchors on its user message and
        // the reply lands in "tail" even though the replay HAS it. Concat
        // all message-stream text instead: chunk boundaries differ between
        // live stream and replay, but the concatenated stream is identical.
        const streamText = (entries: LogEntry[]) => {
          let s = "";
          for (const e of entries) {
            const u = e.update as { sessionUpdate?: string; content?: { text?: string } };
            const k = u.sessionUpdate;
            if (k === "agent_message_chunk" || k === "agent_thought_chunk" || k === "user_message_chunk") {
              s += String(u.content?.text ?? "");
            }
          }
          return s;
        };
        const tailEntries = anchor >= 0 ? preLoad.slice(anchor + 1) : [];
        const tailStream = streamText(tailEntries);
        const covered = !tailStream || streamText(postLog).includes(tailStream);
        const kept = new Set<LogEntry>();
        if (tailEntries.length && !covered) {
          for (const e of tailEntries) {
            const u = e.update as { sessionUpdate?: string; _local?: boolean; content?: { text?: string } };
            if (u._local && u.sessionUpdate === "user_message_chunk" && replayedUser.has(u.content?.text)) continue;
            ctx.sessionLog.append(id, e.update);
            kept.add(e);
          }
        }
        for (const e of pendingUser) {
          const t = (e.update as { content?: { text?: string } }).content?.text;
          if (!kept.has(e) && !replayedUser.has(t)) ctx.sessionLog.append(id, e.update);
        }
      }
    }
  } else {
    captureLoadResponse(id, await loadWithRetry(acp, id, cwd));
    loadEpoch.set(id, Date.now());
    persistTail(ctx, id);
  }
}

function loadOnce(ctx: ApiContext, acp: DevinAcp, id: string, cwd: string): Promise<void> {
  let p = loadInflight.get(id);
  if (!p) {
    p = doLoad(ctx, acp, id, cwd).finally(() => loadInflight.delete(id));
    loadInflight.set(id, p);
  }
  return p;
}

/** Resolve the acp process that owns (or should own) this session — the single
 * canonical resolver shared by every route layer. Order: dedicated
 * single-session process → sessionHost pin for loaded sessions → cwd-keyed
 * pool. `cwdHint` lets the native API disambiguate never-seen sessions. */
async function hostFor(ctx: ApiContext, id: string, cwdHint?: string): Promise<{ acp: DevinAcp; set: Set<string>; cwd: string }> {
  const dedicated = ctx.manager.forSession(id);
  const host = sessionHost.get(id);
  const pinned = host && !host.exited ? host : undefined;
  const cwd = dedicated?.cwd ?? pinned?.cwd ?? cwdHint ?? ctx.sessionCwd.get(id) ?? ctx.primaryCwd;
  const acp = dedicated ?? pinned ?? await ctx.manager.get(cwd);
  ctx.sessionCwd.set(id, cwd);
  let set = loadedOn.get(acp);
  if (!set) loadedOn.set(acp, (set = new Set()));
  return { acp, set, cwd };
}

/** Failed replays get a cooldown — sessions locked by desktop/CLI
 * (`session_locked`) would otherwise burn a 5-attempt loadWithRetry on every
 * background poll, forever. Real ops go through acpForId and always retry. */
const loadCooldown = new Map<string, number>();

/** Kick off / await a history replay. Safe to call from any endpoint; read
 * endpoints call this without awaiting so pages fill progressively. */
async function ensureLoaded(ctx: ApiContext, id: string): Promise<void> {
  const { acp, set, cwd } = await hostFor(ctx, id);
  if (set.has(id)) return;
  const cool = loadCooldown.get(id);
  if (cool && Date.now() - cool < 60_000) return;
  try {
    await loadOnce(ctx, acp, id, cwd);
    set.add(id);
    sessionHost.set(id, acp);
    loadCooldown.delete(id);
  } catch {
    loadCooldown.set(id, Date.now());
    /* history may be unavailable; timeline comes back empty */
  }
}

async function acpForId(ctx: ApiContext, id: string) {
  const { acp, set, cwd } = await hostFor(ctx, id);
  if (!set.has(id)) {
    await loadOnce(ctx, acp, id, cwd);
    // A concurrent caller may have run the shared replay on a different
    // process — if the session landed there, use that host instead of
    // falsely marking ours.
    const pinned = sessionHost.get(id);
    if (!set.has(id) && pinned && pinned !== acp && !(pinned as DevinAcp).exited) return pinned;
    set.add(id);
    sessionHost.set(id, acp);
  }
  return acp;
}

/** Local analog of the cloud "reboot": kill the acp process hosting this
 * session (pooled or dedicated) so the next operation respawns it and
 * replays history via session/load. Other sessions pinned to a killed pooled
 * process heal automatically — hostFor's `!pinned.exited` check re-pools them.
 * No-op when the session has no live host. */
function restartSession(ctx: ApiContext, id: string): void {
  const acp = sessionHost.get(id) ?? ctx.manager.forSession(id);
  sessionHost.delete(id);
  if (!acp || acp.exited) return;
  loadedOn.get(acp)?.delete(id);
  ctx.manager.killProcess(acp);
}

// ---------------------------------------------------------------------------
// live session config (config_option_update / mode / commands / terminal)
// ---------------------------------------------------------------------------

interface ConfigOption { id?: string; name?: string; currentValue?: string; options?: { value: string; name?: string; description?: string }[] }
interface SessionConfig {
  options: ConfigOption[];
  mode: string | null;
  commands: { name: string; description?: string; input?: { hint?: string } }[];
  model: { id: string; current: string; currentName: string; options: { value: string; name?: string; efforts?: string[]; effortCtl?: boolean; family?: string; fast?: boolean; ctx1m?: boolean }[] } | null;
}

function sessionConfig(ctx: ApiContext, id: string): SessionConfig {
  const out: SessionConfig = { options: [], mode: null, commands: [], model: null };
  // Base: config from this session's new|load response; fall back to the
  // agent-level config last seen (old sessions get no config on load).
  const base = responseCfg.get(id) ?? lastAgentCfg ?? undefined;
  const own = responseCfg.get(id);
  const echoTs = own?.echoTs ?? 0;
  if (base?.configOptions) out.options = base.configOptions;
  // Mode is per-session — only trust this session's own response/log, never the
  // agent-level fallback's currentModeId (that's another session's mode).
  if (own?.modes) out.mode = own.modes.currentModeId ?? null;
  // Overlay: latest streamed config updates win. Scan newest→oldest but only
  // take option ids a newer event hasn't already covered — otherwise the
  // oldest logged update (e.g. the load-time push) would clobber fresh
  // setSessionConfigOption echoes stored in responseCfg.
  const log = ctx.sessionLog.get(id);
  const cfgCovered = new Set<string>();
  for (let i = log.length - 1; i >= 0; i--) {
    const u = log[i].update as Record<string, unknown>;
    const k = u.sessionUpdate;
    if (k === "config_option_update") {
      if (log[i].ts < echoTs) continue; // predates the authoritative write echo
      const upd = (u.configOptions as ConfigOption[]) ?? [];
      // Merge by id — an update may carry only the changed option(s).
      const byId = new Map(out.options.map((o) => [String(o.id ?? ""), o]));
      for (const o of upd) {
        const oid = String(o.id ?? "");
        if (cfgCovered.has(oid)) continue;
        byId.set(oid, o);
        cfgCovered.add(oid);
      }
      out.options = [...byId.values()];
    } else if (k === "current_mode_update" && !out.mode) {
      out.mode = (u.currentModeId as string) ?? null;
    } else if (k === "available_commands_update" && !out.commands.length) {
      out.commands = (u.availableCommands as SessionConfig["commands"]) ?? [];
    }
  }
  // Commands are agent-level: remember the newest non-empty set, fall back to
  // it (or this session's own load-response copy) when the replay window
  // hasn't delivered a commands_update yet.
  if (out.commands.length) lastAgentCommands = out.commands;
  else out.commands = (responseCfg.get(id)?.commands?.length ? responseCfg.get(id)!.commands! : lastAgentCommands ?? []);
  // Expose ACP modes as a synthetic `_mode` config group when the agent hasn't
  // already surfaced one itself.
  const hasModeOpt = out.options.some((o) => o.id === "mode" || /mode/i.test(String(o.id ?? "")));
  if (!hasModeOpt && base?.modes?.availableModes?.length) {
    out.options.push({
      id: "_mode",
      name: "Mode",
      currentValue: out.mode ?? "",
      options: base.modes.availableModes.map((m) => ({ value: m.id, name: m.name ?? m.id })),
    });
  }
  const modelOpt = out.options.find((o) => o.id === "model" || /model/i.test(String(o.id ?? "")));
  if (modelOpt) {
    const cur = String(modelOpt.currentValue ?? "");
    const name = modelOpt.options?.find((o) => o.value === cur)?.name ?? cur;
    out.model = {
      id: String(modelOpt.id ?? "model"),
      current: cur,
      currentName: name,
      options: (modelOpt.options ?? []).map((o) => {
        // Per-family data decoded from the local model catalog — ACP only
        // exposes global thought_level/speed groups; fast/ctx1m gate whether
        // the desktop-style flyout shows Speed / 1M Context sections.
        const info = catalogInfo(o.value);
        return {
          value: o.value,
          name: o.name,
          efforts: info?.efforts ?? [],
          effortCtl: info?.effortCtl ?? false,
          family: info?.family,
          fast: info?.fast ?? false,
          ctx1m: info?.ctx1m ?? false,
        };
      }),
    };
  }
  return out;
}

/** cloud version pill strings → local model config values */
function cloudVersionToModel(version: string, opts: { value: string; name?: string }[]): string | null {
  const has = (v: string) => opts.some((o) => o.value === v);
  const pick = (...cands: string[]) => cands.find(has) ?? null;
  switch (version) {
    case "devin-auto":
    case "devin-auto-fast":
      return pick("adaptive", "swe-2-high");
    case "devin-ultra":
      return pick("swe-2-high", "adaptive");
    case "devin-2-5":
      return pick("swe-1-7-medium", "swe-2-high", "adaptive");
    case "devin-fast-opus":
      return pick("swe-1-7-lightning-medium", "swe-1-7-medium");
    case "devin_lite":
      return pick("swe-1-7-lightning-medium", "swe-1-7-medium");
    case "devin-swe-1-7":
      return pick("swe-1-7-medium");
    case "devin-swe-1-7-lightning":
      return pick("swe-1-7-lightning-medium");
    default:
      return has(version) ? version : pick("adaptive");
  }
}

/** terminalId → accumulated output (fed by index.ts onTerminalOutput). */
const terminalBuf = new Map<string, { sessionId: string; text: string }>();
function recordTerminal(terminalId: string, sessionId: string, data: string) {
  const e = terminalBuf.get(terminalId) ?? { sessionId, text: "" };
  e.sessionId = sessionId;
  e.text = (e.text + data).slice(-512 * 1024);
  terminalBuf.set(terminalId, e);
}

/** sessions with a prompt currently in flight (drives status/composer state) */
const inflight = new Set<string>();

// ---------------------------------------------------------------------------
// Message queue — Ctrl+Enter while working parks a prompt here; the queue is
// flushed FIFO in dispatchPrompt's settle path. In-memory only (a restart
// drops queued drafts, same as the desktop's session-bound queue).
// ---------------------------------------------------------------------------

export interface QueuedMsg {
  id: string;
  text: string;
  attachments?: { url: string; name?: string; mime?: string; size?: number }[];
  /** Subagent relay context — queueing must not silently retarget the
   * message to the main chain. */
  subagentId?: string;
  respawnRow?: { title: string; task: string; profile: string };
}
const promptQueues = new Map<string, QueuedMsg[]>();
let queueSeq = 0;

export function queueList(id: string): QueuedMsg[] {
  return promptQueues.get(id) ?? [];
}

/** Enqueue a message; callers GET the list back for the queue band. */
export function queueAdd(ctx: ApiContext, id: string, text: string, attachments: QueuedMsg["attachments"] = [], extra?: Pick<QueuedMsg, "subagentId" | "respawnRow">): QueuedMsg {
  const m: QueuedMsg = { id: `q${(++queueSeq).toString(36)}${Date.now().toString(36)}`, text, ...(attachments?.length ? { attachments } : {}), ...extra };
  const q = promptQueues.get(id) ?? [];
  q.push(m);
  promptQueues.set(id, q);
  noteUpdate(ctx, id);
  return m;
}

export function queueRemove(ctx: ApiContext, id: string, qid: string): boolean {
  const q = promptQueues.get(id);
  if (!q) return false;
  const i = q.findIndex((m) => m.id === qid);
  if (i < 0) return false;
  q.splice(i, 1);
  if (!q.length) promptQueues.delete(id);
  noteUpdate(ctx, id);
  return true;
}

/** Dispatch the next queued prompt if nothing is in flight. */
function queueFlush(ctx: ApiContext, id: string) {
  if (inflight.has(id)) return;
  const q = promptQueues.get(id);
  const next = q?.shift();
  if (!next) return;
  if (q && !q.length) promptQueues.delete(id);
  dispatchPrompt(ctx, id, next.text, next.attachments ?? [], next.subagentId, next.respawnRow);
}

// ---------------------------------------------------------------------------
// interrupted-turn recovery — a prompt that never settled is recoverable
// evidence, not silent loss. dispatchPrompt records the outgoing message in
// <dataDir>/open-turns.json at send time and clears it when the prompt
// resolves; an entry still present at boot means THIS server died mid-turn.
// A successful settle also appends a `wb_turn_end` marker to the session log
// (errors append `wb_notice`), so replayed/restored logs keep a durable
// turn boundary to test the tail against.
// ---------------------------------------------------------------------------

interface OpenTurn {
  text: string;
  ts: number;
  attachments?: { url: string; name?: string; mime?: string; size?: number }[];
  /** 'continue' = the turn reached the agent → a "继续" nudge resumes it;
   * 'resend' = the prompt died before any echo → resend the original text. */
  kind?: "continue" | "resend";
  /** Auto-resume attempts already made — caps a resume→crash→resume loop. */
  resumeCount?: number;
}

const openTurns = new Map<string, OpenTurn>();
let openTurnsLoaded = false;

function openTurnsLoad(ctx: ApiContext) {
  if (openTurnsLoaded) return;
  openTurnsLoaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ctx.store.dataDir, "open-turns.json"), "utf8")) as Record<string, OpenTurn>;
    for (const [id, t] of Object.entries(raw)) if (t && typeof t.text === "string") openTurns.set(id, t);
  } catch { /* no file / corrupt — nothing to recover */ }
}

function openTurnsSave(ctx: ApiContext) {
  try {
    fs.writeFileSync(path.join(ctx.store.dataDir, "open-turns.json"), JSON.stringify(Object.fromEntries(openTurns)));
  } catch { /* best-effort */ }
}

/** The session's last turn if it never reached a settled state and nothing
 * is running now: open-turns evidence first (process died mid-prompt), else
 * a log tail whose last user message has no turn boundary after it — but
 * only when the log actually contains markers (feature was live for an
 * earlier turn) or the tail is unambiguously mid-turn (ends on a bare
 * tool_call / thought — a finished turn always ends on a message). */
export function interruptedTurn(ctx: ApiContext, id: string): OpenTurn | null {
  if (inflight.has(id) || loadInflight.has(id)) return null;
  openTurnsLoad(ctx);
  const open = openTurns.get(id);
  if (open) return { ...open, kind: open.kind ?? "continue" };
  const log = ctx.sessionLog.get(id);
  let userAt = -1;
  for (let i = log.length - 1; i >= Math.max(0, log.length - 800); i--) {
    const k = String(log[i].update.sessionUpdate ?? "");
    if (k === "wb_turn_end" || k === "wb_notice") break; // a settled boundary sits above the last user message
    if (k === "user_message_chunk") { userAt = i; break; }
  }
  if (userAt < 0) return null;
  const text = String((log[userAt].update.content as { text?: string } | undefined)?.text ?? "");
  let atts = Array.isArray(log[userAt].update.attachments) ? log[userAt].update.attachments as OpenTurn["attachments"] : undefined;
  if (!atts?.length) {
    // The echoed user chunk carries no attachments — the `_local` original a
    // few entries earlier does.
    for (let i = userAt - 1; i >= Math.max(0, userAt - 30); i--) {
      const u = log[i].update;
      if (u.sessionUpdate !== "user_message_chunk" || !u._local) continue;
      if (Array.isArray(u.attachments) && u.attachments.length) { atts = u.attachments as OpenTurn["attachments"]; break; }
    }
  }
  // `_local` means the prompt was dispatched but never echoed by devin — it
  // never reached the agent, so resend beats a bare "继续".
  const kind: OpenTurn["kind"] = log[userAt].update._local ? "resend" : "continue";
  if (userAt === log.length - 1) return { text, ts: log[userAt].ts, attachments: atts, kind }; // prompt died before ANY event
  const sawMarker = log.slice(Math.max(0, userAt - 400), userAt).some((e) => {
    const k = String(e.update.sessionUpdate ?? "");
    return k === "wb_turn_end" || k === "wb_notice";
  });
  if (sawMarker) return { text, ts: log[userAt].ts, attachments: atts, kind };
  // Pre-marker logs: flag only tails a finished turn can't end on.
  for (let i = log.length - 1; i > userAt; i--) {
    const k = String(log[i].update.sessionUpdate ?? "");
    if (k === "usage_update" || k === "session_info_update" || k === "current_mode_update" || k === "config_option_update" || k === "available_commands_update") continue;
    if (k === "tool_call" || k === "agent_thought_chunk" || k === "plan") return { text, ts: log[userAt].ts, attachments: atts, kind };
    break;
  }
  return null;
}

/** Boot-time recovery: for every turn left open by a crashed/killed server,
 * resume it with "继续" — session/load replays the partial turn and the
 * agent picks the work back up. Gated by the 会话自动继续 pref and capped
 * at 2 attempts per turn (a resume that itself crashes can't loop). */
export async function autoResumeInterrupted(ctx: ApiContext) {
  openTurnsLoad(ctx);
  // DEVIN_REMOTE_NO_AUTORESUME: a second instance sharing the data dir must
  // not double-drive interrupted turns — each boot would otherwise re-send
  // "继续" into sessions the primary instance already resumed.
  if (process.env.DEVIN_REMOTE_NO_AUTORESUME || !loadReg(ctx).prefs?.autoResume || !openTurns.size) return;
  // A resume triggers session/load, which replays the FULL transcript back
  // through the update stream — on multi-GB logs that replay alone saturates
  // the loop and balloons the heap for minutes. Gate huge histories to
  // manual resume (the interrupted banner still offers it), and stagger the
  // rest so N replays never run at once.
  const HUGE = 256 << 20;
  let first = true;
  for (const [id, t] of [...openTurns]) {
    if ((t.resumeCount ?? 0) >= 2) continue;
    const size = ctx.sessionLog.diskSize(id);
    if (size > HUGE) {
      console.error(`[auto-resume] ${id}: ${(size / (1 << 20)).toFixed(0)}MB log — skipping auto-resume (manual 继续 still works)`);
      continue;
    }
    if (!first) await new Promise((r) => setTimeout(r, 5000));
    first = false;
    t.resumeCount = (t.resumeCount ?? 0) + 1;
    openTurnsSave(ctx);
    console.error(`[auto-resume] ${id}: interrupted turn → "继续" (attempt ${t.resumeCount})`);
    try { dispatchPrompt(ctx, id, "继续"); } catch (e) { console.error(`[auto-resume] ${id} failed`, e); }
  }
}

const TEXTISH = /^text\/|\/(json|xml|javascript|typescript|x-yaml)$/i;
const TEXT_EXT = new Set([".txt", ".md", ".json", ".jsonc", ".yaml", ".yml", ".xml", ".csv", ".tsv", ".log", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".hpp", ".cs", ".rb", ".php", ".sh", ".bash", ".zsh", ".ps1", ".bat", ".cmd", ".sql", ".html", ".htm", ".css", ".scss", ".less", ".vue", ".svelte", ".toml", ".ini", ".cfg", ".conf", ".env", ".gitignore", ".dockerfile", ".swift", ".kt", ".lua", ".r", ".dart", ".ex", ".exs", ".erl", ".hs", ".ml", ".clj", ".scala", ".gradle", ".cmake", ".proto", ".tf"]);

/** Resolve a staged `/api/uploads/<id>` url to its on-disk file + mime. */
function resolveUpload(ctx: ApiContext, url: string): { file: string; mime: string; name: string } | null {
  const m = /^\/api\/uploads\/([^/?#]+)/.exec(url);
  if (!m) return null;
  const file = uploadPath(ctx.store, decodeURIComponent(m[1]));
  if (!fs.existsSync(file)) return null;
  const name = path.basename(file).replace(/^[0-9a-f-]{36}-/, "");
  return { file, name, mime: MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream" };
}

/** Turn staged uploads into real ACP prompt blocks: images inline as
 *  base64 (devin advertises image:true), readable text embedded as a
 *  `resource` (embeddedContext:true), everything else a `file://`
 *  resource_link the local agent can open itself. */
async function attachmentBlocks(ctx: ApiContext, attachments: { url: string; name?: string }[]): Promise<Record<string, unknown>[]> {
  const blocks: Record<string, unknown>[] = [];
  for (const a of attachments) {
    const r = resolveUpload(ctx, a.url);
    if (!r) continue;
    const uri = `file:///${r.file.replace(/\\/g, "/")}`;
    try {
      const stat = fs.statSync(r.file);
      if (r.mime.startsWith("image/")) {
        blocks.push({ type: "image", data: fs.readFileSync(r.file).toString("base64"), mimeType: r.mime, uri });
      } else if ((TEXTISH.test(r.mime) || TEXT_EXT.has(path.extname(r.file).toLowerCase())) && stat.size <= 512 * 1024) {
        blocks.push({ type: "resource", resource: { uri, mimeType: r.mime, text: fs.readFileSync(r.file, "utf8") } });
      } else {
        blocks.push({ type: "resource_link", uri, name: a.name ?? r.name, mimeType: r.mime, size: stat.size });
      }
    } catch { /* file vanished between stage and send — skip */ }
  }
  return blocks;
}

/** Fire-and-forget prompt with rate-limit → rotate → auto-resend recovery. */
/** Send a prompt with ONE automatic rate-limit retry — the single retry policy
 * shared by the wb /message route and the native /prompt route: cool the
 * account the failing acp actually runs on, rotate (kills pooled processes so
 * the next spawn uses a fresh key), re-resolve the host via getAcp, resend.
 * Throws a status-429 error when every account is cooling. */
async function promptWithRetry<T>(
  ctx: ApiContext,
  id: string,
  getAcp: () => Promise<DevinAcp>,
  act: (acp: DevinAcp) => Promise<T>,
): Promise<T> {
  for (let retried = false; ; retried = true) {
    const acp = await getAcp();
    try {
      return await act(acp);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!isRateLimitError(msg) || retried) throw err;
      // acp.account = the key injected at spawn (real attribution); the
      // cred-file lookup covers keyless spawns (all accounts were cooling);
      // pick() is the last resort only.
      const name = acp.account ?? ctx.accounts.accountForCredFile() ?? ctx.accounts.pick();
      if (name) {
        ctx.accounts.markLimited(name, retryAfterSeconds(msg));
        ctx.hub.broadcast({ type: "account_limited", account: name, sessionId: id, message: msg });
      }
      const next = ctx.rotate("rate-limit");
      ctx.sessionLog.append(id, {
        sessionUpdate: "wb_notice",
        notice: next ? `已切换到账号 ${next}，重新发送` : "全部账号限速中",
      });
      noteUpdate(ctx, id);
      if (!next) throw Object.assign(err instanceof Error ? err : new Error(msg), {
        status: 429,
        details: { rateLimited: true, limitedAccount: name, retryAfter: ctx.accounts.nextRecoveryAt() },
      });
    }
  }
}

function dispatchPrompt(ctx: ApiContext, id: string, text: string, attachments: { url: string; name?: string; mime?: string; size?: number }[] = [], subagentId?: string, respawnRow?: { title: string; task: string; profile: string }) {
  // U+FFFD in the text means the body arrived corrupted (bad client encoding)
  // or the source text was already broken — log so we can tell "browser-side
  // corrupt" from "downstream corrupt" without reproducing.
  if (text.includes("�")) {
    console.warn(`[prompt] U+FFFD replacement chars in ${subagentId ? `subagent ${subagentId} relay` : `session ${id}`} text — input was already corrupted upstream: ${JSON.stringify(text.slice(0, 120))}`);
  }
  // Structured attachments ride on the log entry itself — the timeline item
  // exposes them as item.attachments (legacy ATTACHMENT: markers in old
  // persisted tails are still parsed client-side).
  ctx.sessionLog.append(id, {
    sessionUpdate: "user_message_chunk", content: { type: "text", text }, _local: true,
    ...(attachments.length ? { attachments } : {}),
    // A subagent-addressed message echoes into that agent's stream (same
    // subagent_context tag as real events) so it stays out of the main flow.
    ...(subagentId ? { _meta: { "cognition.ai/subagent_context": { parentAgentId: subagentId } } } : {}),
  });
  noteUpdate(ctx, id);
  inflight.add(id);
  openTurnsLoad(ctx);
  openTurns.set(id, { text, ts: Date.now(), ...(attachments.length ? { attachments } : {}), resumeCount: openTurns.get(id)?.resumeCount ?? 0 });
  openTurnsSave(ctx);
  const run = async () => {
    const blocks = await attachmentBlocks(ctx, attachments);
    const ctxMeta = subagentId
      ? {
          "cognition.ai/subagent_context": { agentId: subagentId, parentAgentId: subagentId },
          // A subagent's chain is keyed by its agent id (Chain::Side(id)) —
          // without this the prompt lands on the main chain.
          "cognition.ai/chain": { side: subagentId },
        }
      : undefined;
    // There is no client→subagent prompt route on this agent build: chain/
    // subagent_context prompt metas are ignored and the desktop only ever
    // reaches a subagent through the lead — which resumes it via
    // run_subagent(resume="<agentId>"). So a "message to subagent" is sent as
    // an explicit relay instruction on the main chain; the lead performs the
    // resume and the reply lands in the child stream. (A *running* subagent
    // cannot be resumed — the lead reports that, same as desktop.)
    // The wording is imperative and the user text is JSON-quoted: a loose
    // "relay this" phrasing lets the lead misread the message body as a task
    // for itself (observed: it went off debugging the content instead of
    // calling the tool).
    if (subagentId) subPing.set(subagentId, Date.now());
    // respawnRow: the old handle is dead — the lead spawns a SUCCESSOR
    // (fresh agent, same profile, prior task+tail as context) instead of
    // resuming. The successor lands as a NEW child row; the dead one stays.
    const tail = respawnRow ? ctx.sessionLog.subTailText(id, subagentId!).slice(-1500) : "";
    const promptText = subagentId
      ? respawnRow
        ? `[Subagent relay] Subagent "${subagentId}" is permanently dead (its host process was recycled) — do NOT resume it. Call run_subagent(title=${JSON.stringify(respawnRow.title || "Subagent successor")}, profile=${JSON.stringify(respawnRow.profile || "subagent_general")}, task=<task>) now to spawn a SUCCESSOR agent — this is your ONLY task. Compose <task> as: "You continue the work of a previous subagent. Original task: ${JSON.stringify(respawnRow.task.slice(0, 600))}. Its last output before the handle died: ${JSON.stringify(tail)}. New instruction from the user: ${JSON.stringify(text)}"`
        : `[Subagent relay] Call run_subagent(resume="${subagentId}", task=<message>) now and pass the user's message verbatim — this is your ONLY task, do not do anything else first. If the subagent is still running and cannot be resumed, just say so. User message: ${JSON.stringify(text)}`
      : text;
    const textBlock = ctxMeta ? { type: "text", text: promptText, _meta: ctxMeta } : { type: "text", text: promptText };
    return promptWithRetry(ctx, id, () => acpForId(ctx, id), (acp) => acp.prompt(id, [textBlock, ...blocks] as never, ctxMeta));
  };
  void run()
    .then(() => {
      // Durable turn boundary — survives log replay via the tail re-append,
      // so interruptedTurn can tell "finished turn" from "cut turn".
      ctx.sessionLog.append(id, { sessionUpdate: "wb_turn_end" });
      ctx.hub.broadcast({ type: "prompt_done", sessionId: id, result: null });
      persistTail(ctx, id);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.sessionLog.append(id, {
        sessionUpdate: "wb_notice",
        notice: `错误: ${msg.slice(0, 200)}`,
      });
      noteUpdate(ctx, id);
    })
    .finally(() => {
      inflight.delete(id);
      if (openTurns.delete(id)) openTurnsSave(ctx);
      queueFlush(ctx, id);
    });
}

function sessionStatus(ctx: ApiContext, id: string): { status: string; activity: string } {
  if (inflight.has(id)) return { status: "working", activity: "working" };
  // 'blocked' = "awaiting instructions" with an enabled composer; the
  // workbench treats 'waiting' as a transient "reverting checkpoint" state.
  return { status: "blocked", activity: "idle" };
}

// ---------------------------------------------------------------------------
// subagents — events tagged cognition.ai/subagent_context.parentAgentId=agentId
// ---------------------------------------------------------------------------

interface SubagentInfo {
  /** real agentId when known; `spawn:<toolCallId>` pseudo-id for replayed
   * spawns whose lifecycle meta was stripped — those can't be messaged or
   * controlled (`live:false`). */
  agentId: string;
  /** whether direct message/control calls are possible (real agentId seen live) */
  live: boolean;
  title: string;
  task: string;
  profile: string;
  model: string;
  isBackground: boolean;
  depth: number;
  status: "running" | "completed" | "failed";
  summary: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** count of that agent's own stream events (thoughts/messages/tool calls) */
  updates: number;
  lastText: string;
  /** ts of the event proving CURRENT-registry membership (spawn call /
   * subagent_started / completed resume), as the event's cognition.ai
   * timestamp — replayed copies keep their original stamp so a replay can
   * never fake liveness. Internal; feeds `resumable`. */
  liveTs?: number;
  /** Minted by a run_subagent(resume=…) call for an agent no row owns —
   * the registry may already have dropped it, so it is NOT resumable until
   * a lifecycle/result event re-proves it. */
  resumeMinted?: boolean;
  /** false once the process/registry holding the handle is gone (server
   * restart, session replay, exited host) or a resume already failed —
   * the UI greys the row and the message endpoint refuses the relay
   * instead of burning a lead turn to learn "doesn't exist". */
  resumable?: boolean;
}

/** Fresh-ping window: a "message subagent" relay makes the sub page's status
 * pill read Working immediately, before the resumed agent's own
 * subagent_started echo arrives. Cleared by subagent_completed. */
const subPing = new Map<string, number>();
function subPingActive(aid: string): boolean {
  const t = subPing.get(aid) ?? 0;
  if (Date.now() - t > 60_000) { subPing.delete(aid); return false; }
  return true;
}

function listSubagents(ctx: ApiContext, id: string, scope?: string, entries?: LogEntry[]): SubagentInfo[] {
  // Rows keyed by real agentId (live) or `spawn:<toolCallId>` (replay —
  // lifecycle meta is stripped so the real id never shows). A live
  // subagent_started adopts the oldest unclaimed spawn row FIFO — spawns and
  // starts arrive in matching order. `scope` restricts to agents spawned
  // inside one stream ('root' = the lead stream, an agentId = nested children
  // of that agent) — the sub-session page uses it for its own child list.
  const rows: (SubagentInfo & { toolId?: string; originTag?: string })[] = [];
  const byAgent = new Map<string, SubagentInfo & { toolId?: string; originTag?: string }>();
  const blank = (agentId: string, toolId?: string): SubagentInfo & { toolId?: string; originTag?: string } => ({
    agentId, live: !agentId.startsWith("spawn:"), title: "", task: "", profile: "", model: "",
    isBackground: false, depth: 1, status: "running", summary: null,
    startedAt: null, finishedAt: null, updates: 0, lastText: "", toolId,
  });
  const add = (r: SubagentInfo & { toolId?: string; originTag?: string }) => { rows.push(r); if (!r.agentId.startsWith("spawn:")) byAgent.set(r.agentId, r); };
  for (const e of entries ?? ctx.sessionLog.get(id)) {
    const u = e.update;
    const m = (u._meta ?? {}) as Record<string, unknown>;
    // The stream an event belongs to: "root" = the lead agent, an agentId =
    // that agent's own stream. NOTE an agent's lifecycle events are tagged
    // with ITS OWN id — parentage comes from the spawn call's tag below.
    const tag = (m["cognition.ai/subagent_context"] as { parentAgentId?: string } | undefined)?.parentAgentId ?? "root";
    const iso = new Date(e.ts).toISOString();
    // The event's ORIGINAL creation stamp — cognition.ai/timestamp survives
    // replays, while e.ts is our append time (fresh on every re-replay and
    // would fake liveness). Unstamped lines arriving DURING a replay can't
    // prove anything → 0.
    const ct = m["cognition.ai/timestamp"];
    const evTs = typeof ct === "number" ? ct : (loadInflight.has(id) ? 0 : e.ts);
    const toolId = String(u.toolCallId ?? "");
    const isSpawn = m?.["cognition.ai/inferenceToolName"] === "run_subagent";
    const st = m["cognition.ai/subagent_started"] as Record<string, unknown> | undefined;
    const dn = m["cognition.ai/subagent_completed"] as Record<string, unknown> | undefined;

    // Seed from the spawn call itself — its rawInput survives replays. The
    // same tool_call can re-arrive (ACP resends it mid-call): reuse the row.
    if (isSpawn && u.sessionUpdate === "tool_call" && toolId) {
      const args = (u.rawInput ?? u.arguments ?? {}) as Record<string, unknown>;
      const resumeId = typeof args.resume === "string" ? args.resume : "";
      // Resume calls belong to the existing agent — merge, don't mint a row.
      // A resume of an agent no row owns mints a TENTATIVE one (liveTs=0 —
      // the handle may be gone; only its own result/started can re-prove it).
      const cur = resumeId
        ? (byAgent.get(resumeId) ?? (() => {
            const r = blank(resumeId, toolId);
            r.live = false;
            r.resumeMinted = true;
            r.title = String(args.title ?? `Resumed subagent ${resumeId}`);
            add(r);
            return r;
          })())
        : (rows.find((r) => r.toolId === toolId) ?? (() => { const r = blank(`spawn:${toolId}`, toolId); rows.push(r); return r })());
      cur.originTag ??= tag;
      cur.title = String(args.title ?? cur.title);
      cur.task = String(args.task ?? cur.task);
      cur.profile = String(args.profile ?? cur.profile);
      cur.isBackground = Boolean(args.is_background);
      cur.startedAt ??= iso;
      // A spawn call means the agent is being registered NOW; a resume call
      // proves nothing until it succeeds.
      if (!resumeId) cur.liveTs ??= evTs;
    }
    // Lifecycle meta (live only, toolCallId = agentId — NOT the spawn's id).
    if (st) {
      const aid = String(st.agentId ?? toolId);
      // Resume re-emits subagent_started for an existing agent — merge by id
      // first, else it would adopt a stale spawn row into a duplicate row.
      // Otherwise adopt the NEWEST unclaimed spawn row within a freshness
      // window: harness-internal spawns (READY pings) never emit lifecycle
      // meta, so their rows would sit unclaimed forever and steal the
      // adoption meant for the spawn that actually precedes this started.
      const spawnRow = [...rows].reverse().find((r) => r.agentId.startsWith("spawn:") && r.startedAt && Math.abs(Date.parse(iso) - Date.parse(r.startedAt)) < 60_000);
      const cur = byAgent.get(aid) ?? spawnRow ?? (() => { const r = blank(aid, toolId || undefined); add(r); return r })();
      if (cur.agentId.startsWith("spawn:")) { cur.agentId = aid; byAgent.set(aid, cur); }
      cur.live = true;
      cur.liveTs = evTs; // started re-emits on a successful resume — that IS current-registry proof
      cur.title = String(st.title ?? cur.title);
      cur.task = String(st.task ?? cur.task);
      cur.profile = String(st.profile ?? cur.profile);
      cur.model = String(st.model ?? cur.model);
      cur.isBackground = Boolean(st.isBackground);
      cur.depth = Number(st.depth ?? 1);
      cur.startedAt ??= iso;
      cur.status = "running";
    }
    if (dn) {
      const aid = String(dn.agentId ?? toolId);
      subPing.delete(aid);
      const cur = byAgent.get(aid);
      if (cur) {
        cur.status = dn.success === false ? "failed" : "completed";
        cur.summary = String(dn.summary ?? "");
        cur.finishedAt = iso;
      }
    }
    // A spawn call's own update completing — only meaningful for replayed
    // rows; a live row's real status comes from subagent_completed (a
    // background spawn call returns while the agent is still running).
    if (isSpawn && u.sessionUpdate === "tool_call_update" && toolId && !dn) {
      const cur = rows.find((r) => r.toolId === toolId && (r.agentId.startsWith("spawn:") || r.resumeMinted));
      if (cur) {
        const s2 = String(u.status ?? "");
        if (s2 === "completed") {
          cur.status = "completed"; cur.finishedAt ??= iso;
          // A resume call that completed proves the handle existed — the
          // resumed agent is registered in the CURRENT process.
          if (cur.resumeMinted) cur.liveTs = evTs;
        } else if (s2 === "failed") {
          cur.status = "failed"; cur.finishedAt ??= iso;
          // A failed resume means the handle is gone — refuse future relays.
          const text = JSON.stringify(u.rawOutput ?? u.content ?? "");
          if (/doesn'?t exist|no longer found|no subagent found|not found/i.test(text)) deadSubs.add(`${id}:${cur.agentId}`);
        }
      }
    }
    const cx = (m["cognition.ai/subagent_context"] as { parentAgentId?: string } | undefined)?.parentAgentId;
    if (cx && cx !== "root") {
      const cur = byAgent.get(cx) ?? (() => { const r = blank(cx); add(r); return r })();
      cur.updates++;
      const text = (u.content as { text?: string } | undefined)?.text;
      if (text) cur.lastText = text.replace(/\s+/g, " ").slice(0, 160);
    }
  }
  // Replay strips lifecycle meta, so a reloaded session leaves `spawn:` orphan
  // rows for agents whose real id arrived in an earlier generation. An orphan
  // sharing a live row's title is that agent's earlier-generation spawn card —
  // drop the duplicate (a wrong title match only hides a cosmetic extra row).
  // Resumability: the acp registry is process-local and emptied by every
  // session/load replay — only an agent whose registering event is newer
  // than the last epoch (and whose host process is alive, and which no
  // failed resume already condemned) can take run_subagent(resume=…).
  const epoch = loadEpoch.get(id) ?? BOOT_TS;
  const hostDead = (() => { const h = sessionHost.get(id); return !h || h.exited; })();
  for (const r of rows) {
    r.resumable = !r.agentId.startsWith("spawn:")
      && !hostDead
      && !deadSubs.has(`${id}:${r.agentId}`)
      && (r.liveTs ?? 0) >= epoch;
  }
  const liveTitles = new Set(rows.filter((r) => !r.agentId.startsWith("spawn:")).map((r) => r.title));
  return rows
    // scope = "children of stream S": the spawn call must originate in S's
    // stream (originTag), and the agent itself is never its own child.
    .filter((r) => scope === undefined || ((r.originTag ?? "root") === scope && r.agentId !== scope))
    .filter((r) => !r.agentId.startsWith("spawn:") || !liveTitles.has(r.title))
    .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
}

/** The subagent's own event stream as a timeline — same item shape as the
 * main /timeline endpoint so the frontend can reuse its rendering. The disk
 * log holds the full history when the memory window has already evicted it.
 * Disk reads use a substring needle (the agentId appears in every event of
 * its stream) and an mtime cache — a full parse of a 500MB log per poll
 * would OOM the process. */
const subTlCache = new Map<string, { m: number | null; lastSeq: number; items: WbItem[] }>();
function subagentTimeline(ctx: ApiContext, id: string, agentId: string): WbItem[] {
  const key = `${id}${agentId}`;
  const mem = ctx.sessionLog.get(id);
  const forAgent = (e: LogEntry) => {
    const c = (e.update._meta as Record<string, unknown> | undefined)?.["cognition.ai/subagent_context"] as { parentAgentId?: string } | undefined;
    return c?.parentAgentId === agentId || e.update.toolCallId === agentId;
  };
  // Full coverage test: replay restarts seq at 0, so a ring whose first
  // entry is seq 0 was never truncated. A truncated window must be unioned
  // with the disk index or early subagent events vanish.
  if (mem.length && mem[0].seq === 0) return buildTimelineFrom(mem.filter(forAgent), agentId, id);
  // Cold parent → serve from the child's sidechain file. Cache keyed on the
  // SIDECAR's mtime (the main log's mtime churns during live writes and would
  // defeat the cache, re-parsing the stream on every poll).
  const im = ctx.sessionLog.subStreamMtime(id, agentId);
  const lastSeq = mem.length ? mem[mem.length - 1].seq ?? -1 : -1;
  const hit = subTlCache.get(key);
  if (hit && hit.m === im && im != null && hit.lastSeq === lastSeq) return hit.items;
  if (ctx.sessionLog.subFilesStale(id)) ctx.sessionLog.ensureSubFiles(id);
  const idx = ctx.sessionLog.readSubStream(id, agentId) ?? [];
  const seen = new Set(idx.map((e) => e.seq));
  const items = buildTimelineFrom((mem.length ? [...idx, ...mem.filter((e) => !seen.has(e.seq))] : idx).filter(forAgent), agentId, id);
  // Cache only a settled read — a missing stream means the scan is still
  // running and the empty result must not stick or the transcript never fills.
  if (im != null) subTlCache.set(key, { m: im, lastSeq, items });
  return items;
}

interface ListedSession {
  id: string;
  title: string;
  updated: string;
  cwd: string;
  /** devin's `_meta["cognition.ai/isLocked"]` — held open by SOME acp
   *  process (ours included). Pair with `loaded_here` to tell "在别处占用"
   *  apart from "本工作台已加载". */
  locked: boolean;
  created: string | null;
}

async function listLocalSessions(ctx: ApiContext): Promise<ListedSession[]> {
  const out: ListedSession[] = [];
  let dirty = false;
  try {
    const acp = await ctx.manager.get(ctx.primaryCwd);
    let cursor: string | undefined;
    do {
      const page = await acp.listSessions(cursor);
      for (const s of page.sessions) {
        // Pinned sessions keep their loaded host — session/list reporting a
        // different cwd must not bounce them to another pooled process.
        if (!isSessionPinned(s.sessionId)) ctx.sessionCwd.set(s.sessionId, s.cwd);
        const m = meta(ctx, s.sessionId);
        // devin returns camelCase `updatedAt` (may be absent) — persist it so
        // restarts/list outages keep real times; NEVER fall back to now(),
        // which made every session look freshly updated on each poll.
        const seen = (s as { updatedAt?: string; updated_at?: string }).updatedAt
          ?? (s as { updated_at?: string }).updated_at ?? null;
        if (seen && seen !== m.updatedAt) { m.updatedAt = seen; dirty = true; }
        const lm = ((s as { _meta?: Record<string, unknown> })._meta ?? {}) as Record<string, unknown>;
        out.push({
          id: s.sessionId,
          title: m.title ?? s.title ?? "Untitled session",
          updated: seen ?? m.updatedAt ?? "1970-01-01T00:00:00.000Z",
          cwd: s.cwd,
          locked: lm["cognition.ai/isLocked"] === true,
          created: (lm["cognition.ai/createdAt"] as string | undefined) ?? null,
        });
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor && out.length < 2000);
  } catch { /* devin list may be down; show registry-only */ }
  if (dirty) saveReg();
  const known = new Set(out.map((s) => s.id));
  for (const [id, m] of Object.entries(loadReg(ctx).sessions)) {
    if (!known.has(id) && !m.archived) {
      out.push({ id, title: m.title ?? "Untitled session", updated: m.updatedAt ?? "1970-01-01T00:00:00.000Z", cwd: ctx.sessionCwd.get(id) ?? ctx.primaryCwd, locked: false, created: null });
    }
  }
  return out;
}

/** Last message text, scanning only the tail of the log — the sidebar list
 * calls this for every session on every poll, so it must not buildTimeline. */
function snippetFromLog(ctx: ApiContext, id: string): string {
  const log = ctx.sessionLog.get(id);
  for (let i = log.length - 1; i >= 0 && i > log.length - 100; i--) {
    const u = log[i].update as { sessionUpdate?: string; content?: { text?: string } };
    if ((u.sessionUpdate === "agent_message_chunk" || u.sessionUpdate === "user_message_chunk") && u.content?.text) {
      return u.content.text.replace(/\s+/g, " ").slice(0, 140);
    }
  }
  return "";
}


export {
  loadedOn, sessionHost, isSessionPinned,
  responseCfg, lastAgentCfg, captureLoadResponse, isSessionLocked,
  loadWithRetry, loadInflight, loadOnce, hostFor, loadCooldown,
  ensureLoaded, acpForId, restartSession,
  type ConfigOption, type SessionConfig, sessionConfig, cloudVersionToModel,
  terminalBuf, recordTerminal, inflight, resolveUpload, attachmentBlocks,
  promptWithRetry, dispatchPrompt, sessionStatus,
  queueFlush,
  type SubagentInfo, listSubagents, subagentTimeline, subPingActive,
  type ListedSession, listLocalSessions, snippetFromLog,
};
