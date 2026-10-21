/**
 * sessionload — the load/recovery engine: session→acp resolution (hostFor),
 * session/load with replay dedup (doLoad/loadOnce/replayGuard), placement
 * marks, the interrupted-turn evidence reader, broker adoption + adopted-turn
 * watchers, auto-resume, and the durable-state boot hook. This is the top of
 * the session module stack: it binds the queue/prompt injections so no leaf
 * ever imports a consumer.
 */
import type { ApiContext } from "./routes.js";
import type { DevinAcp } from "./acp.js";
import { brokerEnabled, brokerList, readOffsets, clearOffsets } from "./acpbroker.js";
import { agentById, DEFAULT_AGENT } from "./agents.js";
import { remapLegacyCwd } from "./store.js";
import { loadReg, meta, noteLastUsed } from "./dwstore.js";
import { noteUpdate, persistTail, tlCache, tailSnapshot, type LogEntry } from "./dwtimeline.js";
import { initCfgState, isSessionLocked, loadWithRetry, captureLoadResponse } from "./sessioncfg.js";
import { queueList, queueFlush, restoreQueues, bindQueueDeps, queuedSessions } from "./sessionqueue.js";
import { restoreSendErrors } from "./sendhealth.js";
import { dispatchPrompt, releaseBusy, bindPromptDeps } from "./sessionprompt.js";
import { openTurns, openTurnsLoad, openTurnsSave, type OpenTurn } from "./sessionturns.js";
import {loadedOn, sessionHost, loadEpoch, loadInflight, markLoadedOn } from "./sessionplace.js";
import { inflight, adoptedTurns, lastActivity, touchSessionActivity, isDraining } from "./sessionlive.js";
import { pingSubagent } from "./sessionsub.js";
import { sessionStatus } from "./sessionview.js";

/** Config caches + durable-state primitives live in sessioncfg.ts — imported
 * above as live bindings (responseCfg is shared state, lastAgentCfg a `let`).
 * setCfgCacheDir is this module's public boot hook: initCfgState restores
 * the cfg file, then the queue/error files owned below. */
export function setCfgCacheDir(dir: string) {
  initCfgState(dir);
  restoreQueues(dir);
  restoreSendErrors(dir);
}

/** loadInflight moved to sessionplace.ts (placement leaf). */

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

/** Await the shared replay for `id`; resolves to the acp that ran it — not
 * necessarily the `acp` arg (a concurrent caller may have started the load
 * on another pool). */
export function loadOnce(ctx: ApiContext, acp: DevinAcp, id: string, cwd: string): Promise<DevinAcp> {
  let rec = loadInflight.get(id);
  if (!rec) {
    // A replay is live work too — mark the acp busy so rotation/restart
    // defers its kill instead of cutting the replay mid-flight.
    acp.busySessions.add(id);
    const p = doLoad(ctx, acp, id, cwd).finally(() => {
      releaseBusy(ctx, acp, id);
      if (loadInflight.get(id) === rec) loadInflight.delete(id);
    });
    rec = { acp, p };
    loadInflight.set(id, rec);
  }
  return rec.p.then(() => rec.acp);
}


/** Resolve the acp process that owns (or should own) this session — the single
 * canonical resolver shared by every route layer. Order: dedicated
 * single-session process → sessionHost pin for loaded sessions → cwd-keyed
 * pool. `cwdHint` lets the native API disambiguate never-seen sessions. */
export async function hostFor(ctx: ApiContext, id: string, cwdHint?: string): Promise<{ acp: DevinAcp; set: Set<string>; cwd: string }> {
  const dedicated = ctx.manager.forSession(id);
  const host = sessionHost.get(id);
  const pinned = host && !host.exited ? host : undefined;
  // Which agent CLI owns this session — dedicated agents record it in
  // store.agentSessions; pooled agents remember it in dw.json meta.
  const agent = agentById(ctx.store.agentSession(id)?.agent ?? meta(ctx, id).agent);
  if (!agent.multiSession && !dedicated) {
    throw Object.assign(
      new Error(`this ${agent.label} session has ended — its history stays readable, but start a new session to continue`),
      { status: 409 },
    );
  }
  // SSH-hosted sessions pool per `ssh:<target>:cwd` — resolve the target from
  // the live map first, then persisted meta (survives restarts).
  const ssh = ctx.sessionSsh.get(id) ?? meta(ctx, id).ssh ?? null;
  if (ssh) ctx.sessionSsh.set(id, ssh);
  const cwd = dedicated?.cwd ?? pinned?.cwd ?? cwdHint ?? ctx.sessionCwd.get(id) ?? ctx.primaryCwd;
  const acp = dedicated ?? pinned ?? await ctx.manager.get(ssh ? cwd : remapLegacyCwd(cwd), agent, ssh);
  ctx.sessionCwd.set(id, cwd);
  let set = loadedOn.get(acp);
  if (!set) loadedOn.set(acp, (set = new Set()));
  return { acp, set, cwd };
}

/** Failed replays get a cooldown — sessions locked by desktop/CLI
 * (`session_locked`) would otherwise burn a 5-attempt loadWithRetry on every
 * background poll, forever. Real ops go through acpForId and always retry. */
export const loadCooldown = new Map<string, number>();

/** Kick off / await a history replay. Safe to call from any endpoint; read
 * endpoints call this without awaiting so pages fill progressively. */
export async function ensureLoaded(ctx: ApiContext, id: string): Promise<void> {
  const { acp, set, cwd } = await hostFor(ctx, id);
  if (set.has(id)) return;
  const cool = loadCooldown.get(id);
  if (cool && Date.now() - cool < 60_000) return;
  try {
    // Pin the host that RAN the load — ours may have only joined a replay
    // already in flight on another pool.
    markLoadedOn(id, await loadOnce(ctx, acp, id, cwd));
    loadCooldown.delete(id);
  } catch {
    loadCooldown.set(id, Date.now());
    /* history may be unavailable; timeline comes back empty */
  }
}

export async function acpForId(ctx: ApiContext, id: string) {
  const { acp, set, cwd } = await hostFor(ctx, id);
  if (!set.has(id)) {
    // Same cross-pool guard: the load may have lived on another acp — pin to
    // it instead of falsely marking ours (the "Session not found" wedge).
    return markLoadedOn(id, await loadOnce(ctx, acp, id, cwd));
  }
  return acp;
}

/** Local analog of the cloud "reboot": kill the acp process hosting this
 * session (pooled or dedicated) so the next operation respawns it and
 * replays history via session/load. Other sessions pinned to a killed pooled
 * process heal automatically — hostFor's `!pinned.exited` check re-pools them.
 * No-op when the session has no live host. */
export function restartSession(ctx: ApiContext, id: string): void {
  const acp = sessionHost.get(id) ?? ctx.manager.forSession(id);
  sessionHost.delete(id);
  if (!acp || acp.exited) return;
  loadedOn.get(acp)?.delete(id);
  if (acp.busySessions.size && !acp.busySessions.has(id)) {
    // The host is mid-turn for OTHER sessions (a pooled acp is shared) — a
    // hard kill would cut those turns off, including the caller's own when
    // an agent "restarts" a poolmate (observed: it killed its own process
    // and the turn died with ACP connection closed). Unpin + unpool so this
    // session's next op respawns fresh; the process retires on idle.
    ctx.manager.unpool(acp, id);
    acp.retireAfterIdle = true;
    return;
  }
  ctx.manager.killProcess(acp);
}

/** Liveness state (inflight/draining/adoptedTurns/lastActivity/gracefulExit)
 * lives in sessionlive.ts — volatile runtime state, a leaf module. */

// ---------------------------------------------------------------------------
// Message queue — module lives in sessionqueue.ts (imported above). The
// flush's downstream needs (busy predicate + dispatchPrompt) are injected
// here — storage must not import its consumers.
// ---------------------------------------------------------------------------
bindQueueDeps({
  isBusy: (id) => inflight.has(id) || isDraining(),
  dispatch: (ctx, id, m) => dispatchPrompt(ctx, id, m.text, m.attachments ?? [], m.subagentId, m.respawnRow),
});

// sessionprompt needs three callbacks that live HERE (host resolver, the
// status read behind its settle broadcast, and the subagent liveness ping) —
// injected for the same reason: it must not import its consumer.
bindPromptDeps({
  resolveAcp: (ctx, id) => acpForId(ctx, id),
  statusOf: (ctx, id) => sessionStatus(ctx, id),
  pingSubagent: (aid) => { pingSubagent(aid); },
});

// ---------------------------------------------------------------------------
// interrupted-turn recovery — a prompt that never settled is recoverable
// evidence, not silent loss. dispatchPrompt records the outgoing message in
// <dataDir>/open-turns.json at send time and clears it when the prompt
// resolves; an entry still present at boot means THIS server died mid-turn.
// A successful settle also appends a `dw_turn_end` marker to the session log
// (errors append `dw_notice`), so replayed/restored logs keep a durable
// turn boundary to test the tail against.
// ---------------------------------------------------------------------------

/** gracefulExit + markGracefulExit moved to sessionlive.ts — restart
 * liveness is that module's domain (it owns the offset journal write). */

// ---------------------------------------------------------------------------
// Send pipeline (sendPreflight/attachments/promptWithRetry/dispatchPrompt)
// lives in sessionprompt.ts — imported above. Its engine callbacks back into
// this module's resolver/status/subagent-ping are injected below so the edge
// stays one-directional.
// ---------------------------------------------------------------------------

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
    if (k === "dw_turn_end" || k === "dw_notice") break; // a settled boundary sits above the last user message
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
    return k === "dw_turn_end" || k === "dw_notice";
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
/** Sessions whose in-flight turn SURVIVED a backend restart (broker mode):
 * the acp kept running so the turn still streams — but its prompt response
 * died on the old byte stream, so settle is inferred, not awaited. A turn's
 * update stream goes silent the moment it ends; 90s of silence is declared
 * settled (false-positive cost: a rare >90s-silent live turn looks idle —
 * a follow-up prompt may then hit devin's busy error, recoverable). */
// adoptedTurns set lives in sessionlive.ts — see imports.
const ADOPT_SILENCE_MS = 90_000;

function watchAdoptedTurn(ctx: ApiContext, id: string, acp: DevinAcp, resync = false) {
  adoptedTurns.add(id);
  inflight.add(id);
  acp.busySessions.add(id); // same protection a real prompt gets — no hard
                            // kill / unpool while the adopted turn streams
  ctx.hub.broadcast({ type: "session_status", sessionId: id, status: sessionStatus(ctx, id).status });
  const t0 = Date.now();
  touchSessionActivity(id);
  const settle = () => {
    ctx.sessionLog.append(id, { sessionUpdate: "dw_turn_end" });
    if (openTurns.delete(id)) openTurnsSave(ctx);
    persistTail(ctx, id);
    noteUpdate(ctx, id);
    queueFlush(ctx, id);
    ctx.hub.broadcast({ type: "session_status", sessionId: id, status: sessionStatus(ctx, id).status });
  };
  const iv = setInterval(() => {
    const done = (err: boolean) => {
      clearInterval(iv);
      adoptedTurns.delete(id);
      inflight.delete(id);
      releaseBusy(ctx, acp, id);
      if (err) {
        // The host died mid-adopted-turn — keep the open-turns entry so the
        // NEXT boot's auto-resume replays it (same contract as any crash).
        noteUpdate(ctx, id);
        ctx.hub.broadcast({ type: "session_status", sessionId: id, status: sessionStatus(ctx, id).status });
      } else if (resync) {
        // Crash attach (no offset): the dead window's frames are gone —
        // heal the transcript hole via a bounded session/load resync
        // BEFORE the turn-end marker, so the gap isn't fossilized under
        // dw_turn_end. Dedup machinery (replayGuard + tail-anchor merge)
        // covers the overlap.
        void Promise.race([
          loadOnce(ctx, acp, id, ctx.sessionCwd.get(id) ?? acp.cwd).catch(() => {}),
          new Promise((r) => setTimeout(r, 60_000)),
        ]).finally(settle);
      } else {
        settle();
      }
    };
    if (acp.exited) return done(true);
    const last = Math.max(lastActivity.get(id) ?? 0, t0);
    if (Date.now() - last > ADOPT_SILENCE_MS) {
      console.error(`[adopt] ${id}: turn silent ${Math.round((Date.now() - last) / 1000)}s — declaring settled`);
      done(false);
    }
  }, 5000);
  iv.unref();
}

/** Broker mode: re-attach to acp children that outlived the old backend,
 *  rebuild the pool/session maps they host, and arm settle watchers on
 *  their surviving in-flight turns. Runs before the orphan sweep (broker
 *  children are never orphans — their parent is alive). */
export async function adoptBrokerAcps(ctx: ApiContext) {
  if (!brokerEnabled) return;
  // openTurns is LAZY-loaded (sendPreflight/dispatch/autoResume trigger it) —
  // without this the `openTurns.has(sid)` check below is permanently false,
  // adopted in-flight turns get NO settle watcher, and their journal entries
  // fossilize (the forever interrupted-banner bug).
  openTurnsLoad(ctx);
  const list = await brokerList().catch(() => [] as Awaited<ReturnType<typeof brokerList>>);
  const alive = list.filter((a) => !a.exited);
  if (!alive.length) return;
  const offsets = readOffsets(ctx.store.dataDir);
  // The journal is single-use — a later hard crash must NOT replay frames
  // this boot already consumed. Delete on read; markGracefulExit rewrites
  // it on the next clean exit.
  clearOffsets(ctx.store.dataDir);
  const SKIP = Number.MAX_SAFE_INTEGER; // crash path: no offset → skip replay
  let adopted = 0, turns = 0;
  for (const a of alive) {
    // Skip acp this backend ALREADY owns — a concurrent spawn (auto-resume,
    // a user send) can land mid-adoption; attaching it again pipes a second
    // logical client onto one byte stream ("response to unknown request").
    if (ctx.manager.allAcps().some((x) => x.brokerId === a.acpId)) continue;
    const agentId = (a.key ?? "devin").split(":")[0];
    const agent = agentById(agentId) ?? DEFAULT_AGENT;
    try {
      const acp = await ctx.manager.adopt(a.cwd, agent, a.key, a.acpId, offsets[a.acpId] ?? SKIP, a.account ?? null);
      adopted++;
      // Discover sessions this process still holds: devin stamps the holder
      // pid on loaded sessions — our own acp is "locked" BY its own pid.
      try {
        let cursor: string | undefined;
        let held = 0;
        do {
          const page = await acp.listSessions(cursor);
          for (const s of page.sessions) {
            const lm = ((s as { _meta?: Record<string, unknown> })._meta ?? {}) as Record<string, unknown>;
            const sid = (s as { sessionId?: string }).sessionId;
            if (!sid) continue;
            const holder = Number(lm["cognition.ai/lockHolderPid"] ?? 0);
            if (holder === a.pid || holder === 0) {
              held++;
              // holder===0 also claims it when devin omits the pid — a
              // session listed by this acp but held elsewhere is still safe:
              // the next op's session/load is idempotent on the true owner.
              if (!loadedOn.get(acp)) loadedOn.set(acp, new Set());
              markLoadedOn(sid, acp);
              // Dedicated (single-session) agents resolve via bySession —
              // the pool path is multi-session only.
              if (!agent.multiSession) ctx.manager.bindSession(sid, acp);
              if (openTurns.has(sid) && !adoptedTurns.has(sid)) { watchAdoptedTurn(ctx, sid, acp, offsets[a.acpId] == null); turns++; }
            }
          }
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        // Redundant duplicate: another live acp already owns this pool slot
        // (concurrent spawn during adoption) and this one holds NO sessions —
        // an invisible 100MB+ idle process otherwise. Retire it at the broker.
        if (agent.multiSession && a.key && held === 0 && ctx.manager.pooledSlotTaken(a.key, acp)) {
          console.error(`[adopt] ${a.acpId}: duplicate of a live pool slot with no sessions — retiring`);
          acp.kill(); // proc.kill → brokerKill — the broker child dies, socket exits
        }
      } catch { /* list failed — lazy reload covers unpinned sessions */ }
    } catch (e) {
      console.error(`[adopt] ${a.acpId} (${a.cmd}) failed:`, e);
    }
  }
  console.error(`[adopt] ${adopted}/${alive.length} broker acp(s) re-attached, ${turns} in-flight turn(s) resumed-streaming`);
}

export async function autoResumeInterrupted(ctx: ApiContext) {
  openTurnsLoad(ctx);
  // DEVIN_WEB_NO_AUTORESUME: a second instance sharing the data dir must
  // not double-drive interrupted turns — each boot would otherwise re-send
  // "继续" into sessions the primary instance already resumed.
  // Parked-queue visibility sweep — a queued message with no open-turn and
  // no adopted-turn evidence is parked forever (queueFlush only fires on a
  // settle). Log it once at boot; manual disposition via queue-op. Never
  // auto-dispatch: the text was written for a turn context that no longer
  // exists.
  for (const sid of queuedSessions()) {
    if (!openTurns.has(sid) && !adoptedTurns.has(sid) && queueList(sid).length)
      console.error(`[boot] ${sid}: ${queueList(sid).length} queued message(s) parked with no turn evidence — left for manual queue-op`);
  }
  if (process.env.DEVIN_WEB_NO_AUTORESUME || !loadReg(ctx).prefs?.autoResume || !openTurns.size) return;
  // A resume triggers session/load, which replays the FULL transcript back
  // through the update stream — on multi-GB logs that replay alone saturates
  // the loop and balloons the heap for minutes. Normal-size turns resume
  // staggered so N replays never run at once; huge histories resume
  // SERIALLY — one replay at a time, ≤2 per boot — so a pile of giant
  // sessions can't OOM the backend. Entries past the cap stay in open-turns
  // for manual 继续 via the interrupted banner.
  const HUGE = 256 << 20;
  const normal: [string, OpenTurn][] = [];
  const huge: { id: string; t: OpenTurn; size: number }[] = [];
  for (const [id, t] of [...openTurns]) {
    // Broker-adopted turns are still RUNNING on their original acp — the
    // settle watcher owns them; a "继续" here would double-prompt a live turn.
    if (adoptedTurns.has(id)) continue;
    if ((t.resumeCount ?? 0) >= 2) continue;
    const size = ctx.sessionLog.diskSize(id);
    if (size >= HUGE) huge.push({ id, t, size });
    else normal.push([id, t]);
  }
  let first = true;
  for (const [id, t] of normal) {
    if (!first) await new Promise((r) => setTimeout(r, 5000));
    first = false;
    t.resumeCount = (t.resumeCount ?? 0) + 1;
    openTurnsSave(ctx);
    console.error(`[auto-resume] ${id}: interrupted turn → "继续" (attempt ${t.resumeCount})`);
    // Promise-bearing dispatch — a sync try would let the rejection escape
    // to unhandledRejection (which used to kill the whole backend).
    try { void Promise.resolve(dispatchPrompt(ctx, id, "继续")).catch((e) => console.error(`[auto-resume] ${id} dispatch failed`, e)); }
    catch (e) { console.error(`[auto-resume] ${id} failed`, e); }
  }
  // Huge entries fire strictly one-at-a-time AFTER every normal dispatch is
  // issued: dispatch → wait for the turn to settle (open-turns cleared OR
  // inflight cleared OR host acp dead), 10min cap per entry, ≤2 per boot.
  // Waiting on settle — not a fixed delay — is what actually bounds the
  // replay heap: the next giant session/load can't start until this one's
  // stream has drained.
  const HUGE_CAP = 2, HUGE_WAIT_MS = 10 * 60_000;
  let hugeN = 0;
  for (const { id, t, size } of huge) {
    if (hugeN >= HUGE_CAP) {
      console.error(`[auto-resume] ${id}: over the ${HUGE_CAP}/boot huge-log resume cap — left for manual 继续`);
      continue;
    }
    // The serial wait can span minutes — a manual resume/settle may have
    // claimed the entry meanwhile, and a second "继续" would double-prompt
    // a turn someone else already owns.
    if (!openTurns.has(id) || inflight.has(id)) continue;
    hugeN++;
    t.resumeCount = (t.resumeCount ?? 0) + 1;
    openTurnsSave(ctx);
    console.error(`[auto-resume] ${id}: ${(size / (1 << 20)).toFixed(0)}MB log — throttled resume (serial)`);
    try { void Promise.resolve(dispatchPrompt(ctx, id, "继续")).catch((e) => console.error(`[auto-resume] ${id} dispatch failed`, e)); }
    catch (e) { console.error(`[auto-resume] ${id} failed`, e); }
    const deadline = Date.now() + HUGE_WAIT_MS;
    while (openTurns.has(id) && inflight.has(id) && !sessionHost.get(id)?.exited && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 5000));
    if (openTurns.has(id) && inflight.has(id) && !sessionHost.get(id)?.exited)
      console.error(`[auto-resume] ${id}: still unsettled after ${HUGE_WAIT_MS / 60_000}min — moving on (turn keeps running)`);
  }
}


