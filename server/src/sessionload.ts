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
import { brokerEnabled, brokerList, brokerOnEvent, readOffsets, clearOffsets, type BrokerCtlEvent } from "./acpbroker.js";
import { agentById, DEFAULT_AGENT } from "./agents.js";
import { remapLegacyCwd } from "./store.js";
import { loadReg, meta, noteLastUsed } from "./dwstore.js";
import { noteUpdate, persistTail, tlCache, tailSnapshot, type LogEntry } from "./dwtimeline.js";
import { initCfgState, isSessionLocked, loadWithRetry, captureLoadResponse } from "./sessioncfg.js";
import { queueList, queueFlush, restoreQueues, bindQueueDeps, queuedSessions } from "./sessionqueue.js";
import { restoreSendErrors } from "./sendhealth.js";
import { dispatchPrompt, releaseBusy, bindPromptDeps } from "./sessionprompt.js";
import { openTurns, openTurnsLoad, openTurnsSave, sessionByReqId, type OpenTurn } from "./sessionturns.js";
import {loadedOn, sessionHost, loadEpoch, loadInflight, markLoadedOn } from "./sessionplace.js";
import { inflight, adoptedTurns, lastActivity, isDraining } from "./sessionlive.js";
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

/** session_locked forensics: devin's session/list can stamp the holder pid on
 * loaded sessions (`_meta["cognition.ai/lockHolderPid"]`) — the same field
 * adoption claims sessions by. The lock error itself never names the holder,
 * so read the shared registry through any live acp. Returns {pid, locked} —
 * pid 0 when devin leaves it unstamped — or null when the session isn't
 * listed. NOTE: current devin builds report `isLocked:true` but
 * `lockHolderPid:null` on EVERY locked session — "locked by someone,
 * holder unknown", NOT "unstamped ⇒ lister owns". */
async function lockHolderState(acp: DevinAcp, id: string): Promise<{ pid: number; locked: boolean } | null> {
  try {
    let cursor: string | undefined;
    for (let pages = 0; pages < 16; pages++) {
      const page = await acp.listSessions(cursor);
      const rec = page.sessions.find((s) => (s as { sessionId?: string }).sessionId === id);
      if (rec) {
        const lm = ((rec as { _meta?: Record<string, unknown> })._meta ?? {}) as Record<string, unknown>;
        return { pid: Number(lm["cognition.ai/lockHolderPid"] ?? 0), locked: lm["cognition.ai/isLocked"] === true };
      }
      cursor = page.nextCursor ?? undefined;
      if (!cursor) break;
    }
  } catch { /* listing failed — no holder intel from this acp */ }
  return null;
}

export type LockClaim = { kind: "joined"; acp: DevinAcp } | { kind: "stale" } | { kind: "foreign"; pid: number };

/** Recover a session devin refused to load (session_locked) by finding the
 * process its registry actually names:
 *   our own managed acp      → pin + join its already-loaded session (no replay)
 *   a broker acp we skipped  → adopt it late, then join
 *   a dead pid               → stale lock, devin reaps lazily ("stale" → retry)
 *   a live foreign pid       → desktop/CLI ("foreign" → hopeless, annotate)
 * Never found in any listing → "stale" (a retry costs nothing). */
export async function claimLockedHolder(ctx: ApiContext, id: string): Promise<LockClaim> {
  let holderPid = -1; // -1 = the record never surfaced in any listing
  let lockedUnstamped = false; // locked by SOMEONE but the holder pid never surfaced
  const live = ctx.manager.allAcps().filter((a) => !a.exited);
  for (const a of live) {
    const s = await lockHolderState(a, id);
    if (!s) continue;
    if (s.pid === a.pid || (s.pid === 0 && !s.locked)) { // named us, or unlocked — the lister can own it
      markLoadedOn(id, a);
      return { kind: "joined", acp: a };
    }
    if (s.pid > 0) { holderPid = s.pid; break; }
    if (s.locked) lockedUnstamped = true; // keep listing — another acp may stamp it
  }
  if (holderPid <= 0 && lockedUnstamped) {
    // Locked-but-unstamped (this devin build reports lockHolderPid:null for
    // every lock): joining the lister pins the session to an acp that only
    // answers session_not_found — the permanent wedge. Find the real owner
    // by trial instead: session/load is idempotent on the holder and fails
    // session_locked everywhere else. One shot per acp (no retry — wrong
    // candidates fail fast); a hit gets the dedup'd rebuild via loadOnce.
    const cwd = ctx.sessionCwd.get(id) ?? ctx.primaryCwd;
    for (const a of live) {
      try { await a.loadSession(id, cwd); } catch { continue; }
      const owner = await loadOnce(ctx, a, id, cwd).catch(() => a);
      markLoadedOn(id, owner);
      console.error(`[session] ${id}: lock holder unstamped — load probe found owner pid ${owner.pid}, joined`);
      return { kind: "joined", acp: owner };
    }
  }
  if (holderPid <= 0) return { kind: "stale" };
  const ours = ctx.manager.allAcps().find((a) => a.pid === holderPid && !a.exited);
  if (ours) {
    markLoadedOn(id, ours);
    return { kind: "joined", acp: ours };
  }
  if (brokerEnabled) {
    // A broker child this backend never adopted (its attach raced or failed)
    // still legally holds the lock — adopt it on the spot instead of failing.
    const info = (await brokerList().catch(() => [] as Awaited<ReturnType<typeof brokerList>>))
      .find((b) => b.pid === holderPid && !b.exited);
    if (info) {
      try {
        const agent = agentById((info.key ?? "devin").split(":")[0]) ?? DEFAULT_AGENT;
        const acp = await ctx.manager.adopt(info.cwd, agent, info.key, info.acpId, Number.MAX_SAFE_INTEGER, info.account ?? null);
        markLoadedOn(id, acp);
        if (!agent.multiSession) ctx.manager.bindSession(id, acp);
        console.error(`[session] ${id}: lock held by unadopted broker acp ${info.acpId} — adopted + joined`);
        return { kind: "joined", acp };
      } catch { /* adopt failed — fall through to the liveness probe */ }
    }
  }
  try {
    process.kill(holderPid, 0); // pid exists → a foreign holder (desktop/CLI)
    return { kind: "foreign", pid: holderPid };
  } catch {
    return { kind: "stale" }; // dead pid → devin will reap the stale record
  }
}

/** Kick off / await a history replay. Safe to call from any endpoint; read
 * endpoints call this without awaiting so pages fill progressively. */
export async function ensureLoaded(ctx: ApiContext, id: string): Promise<void> {
  const { acp, set, cwd } = await hostFor(ctx, id);
  if (set.has(id)) {
    // Devin-side "loaded" ≠ our memory has the history — a backend restart
    // drops the in-memory log while adoption still pins the session, and the
    // early-return used to leave every read path staring at an EMPTY
    // transcript (blank page). Hydrate the ring from the disk mirror — far
    // cheaper than a session/load replay.
    if (!ctx.sessionLog.get(id).length) {
      try {
        const disk = ctx.sessionLog.readDiskTail(id);
        if (disk.length) ctx.sessionLog.restoreMemory(id, disk);
      } catch { /* mirror unreadable — pages degrade to empty, not broken */ }
    }
    return;
  }
  const cool = loadCooldown.get(id);
  if (cool && Date.now() - cool < 60_000) return;
  try {
    // Pin the host that RAN the load — ours may have only joined a replay
    // already in flight on another pool.
    markLoadedOn(id, await loadOnce(ctx, acp, id, cwd));
    loadCooldown.delete(id);
  } catch (e) {
    // Locked by ANOTHER of our acp (or a broker child we skipped) is not a
    // history failure — pin to the real holder so the page fills instead of
    // sitting out the cooldown on an empty transcript.
    if (isSessionLocked(e)) {
      const claim = await claimLockedHolder(ctx, id).catch(() => null);
      if (claim?.kind === "joined") { loadCooldown.delete(id); return; }
      // Stale dead-pid records clear soon; a live foreign holder won't —
      // give the reaper a short retry window instead of the full cooldown.
      loadCooldown.set(id, Date.now() - (claim?.kind === "stale" ? 50_000 : 0));
      return;
    }
    loadCooldown.set(id, Date.now());
    /* history may be unavailable; timeline comes back empty */
  }
}

export async function acpForId(ctx: ApiContext, id: string) {
  const { acp, set, cwd } = await hostFor(ctx, id);
  if (set.has(id)) return acp;
  try {
    // Same cross-pool guard: the load may have lived on another acp — pin to
    // it instead of falsely marking ours (the "Session not found" wedge).
    return markLoadedOn(id, await loadOnce(ctx, acp, id, cwd));
  } catch (e) {
    if (!isSessionLocked(e)) throw e;
    const claim = await claimLockedHolder(ctx, id).catch(() => ({ kind: "stale" }) as LockClaim);
    if (claim.kind === "joined") return claim.acp;
    if (claim.kind === "foreign") {
      if (e instanceof Error) e.message = `${e.message} (lock holder: pid ${claim.pid})`;
      throw e;
    }
    // Stale lock (dead pid / unstamped): devin reaps lazily — keep probing
    // for a bounded window instead of failing the send inside ~10s.
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        return markLoadedOn(id, await loadOnce(ctx, acp, id, cwd));
      } catch (e2) {
        if (!isSessionLocked(e2) || Date.now() > deadline) throw e2;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
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

/** Early-settle hooks for adopted turns — armed by watchAdoptedTurn, fired
 *  by resolveTurnByReq when the turn's terminal prompt response is sniffed
 *  on the wire (instant settle instead of the silence heuristic). */
const adoptedSettle = new Map<string, (ok: boolean, errMsg?: string) => void>();

/** Prompt responses sniffed on the wire BEFORE/without an adopted-turn
 *  watcher armed (ring replay floods in during init, ahead of the adoption
 *  scan's session discovery). Stashed so the watcher consumes them at arm
 *  time — its done() path keeps the crash-attach resync — and flushed on a
 *  bounded delay for sessions the adoption scan never re-discovers.
 *  `turn` pins the exact open-turn entry the response belonged to: a live
 *  dispatch replacing the entry makes the stash stale. */
const sniffedSettles = new Map<string, { ok: boolean; errMsg?: string; turn: OpenTurn }>();
let sniffedSettleTimer: NodeJS.Timeout | null = null;
const SNIFF_SETTLE_DELAY_MS = 30_000;

/** Shared settle for a recovered turn — durable turn boundary + open-turn
 *  journal clear + tail persist + queued-message flush + status push.
 *  ok=false means the prompt RPC itself errored — mark like a failed
 *  dispatch (dw_notice) rather than a clean dw_turn_end. */
function settleRecoveredTurn(ctx: ApiContext, id: string, ok = true, errMsg?: string) {
  ctx.sessionLog.append(id, ok
    ? { sessionUpdate: "dw_turn_end" }
    : { sessionUpdate: "dw_notice", notice: `错误[prompt]: ${(errMsg ?? "prompt request failed").slice(0, 200)}` });
  if (openTurns.delete(id)) openTurnsSave(ctx);
  persistTail(ctx, id);
  noteUpdate(ctx, id);
  queueFlush(ctx, id);
  ctx.hub.broadcast({ type: "session_status", sessionId: id, status: sessionStatus(ctx, id).status });
  // prompt_done too — the open page's WS handler refetches detail on it,
  // so the status pill flips instantly instead of waiting out the 3s poll.
  ctx.hub.broadcast({ type: "prompt_done", sessionId: id, result: null });
}

/** Settle every stashed dead-window response that still has live evidence —
 *  armed watchers get the early-settle (resync-aware) path; journaled turns
 *  nothing claimed settle directly. Called on the stash delay AND at the
 *  end of adoptBrokerAcps (sessions its scan never re-discovered). */
function flushSniffedSettles(ctx: ApiContext) {
  sniffedSettleTimer = null;
  for (const [id, s] of [...sniffedSettles]) {
    sniffedSettles.delete(id);
    const early = adoptedSettle.get(id);
    if (early) { early(s.ok, s.errMsg); continue; }
    if (inflight.has(id) || !openTurns.has(id) || openTurns.get(id) !== s.turn) continue;
    console.error(`[wire] ${id}: dead-window prompt response ${s.ok ? "ok" : "error"} — settling instantly`);
    settleRecoveredTurn(ctx, id, s.ok, s.errMsg);
  }
}

/** Instant-settle entry for the acp wire sniffer. `sessionId` non-null means
 *  the response answers a request THIS connection sent — a live
 *  dispatchPrompt already owns that settle (nothing to do). `sessionId`
 *  null means the id matched no pending request on the connection — a
 *  dead-window response for a turn journaled before a restart, correlated
 *  back through the open-turn reqId (notePromptReq). */
export function resolveTurnByReq(
  ctx: ApiContext,
  acp: DevinAcp,
  reqId: number | string,
  sessionId: string | null,
  ok: boolean,
  errMsg?: string,
): void {
  openTurnsLoad(ctx);
  let id = sessionId;
  if (!id) {
    id = sessionByReqId(reqId, acp.brokerId);
    if (!id) return;
    // The response can only belong to a session this acp hosts — a turn
    // already re-pinned elsewhere is that host's business.
    const host = sessionHost.get(id) ?? ctx.manager.forSession(id);
    if (host && host !== acp) return;
  }
  const early = adoptedSettle.get(id);
  if (early) { early(ok, errMsg); return; }
  // A live dispatchPrompt owns the settle — the SDK resolves its prompt
  // promise; writing the boundary here too would duplicate dw_turn_end.
  if (inflight.has(id)) return;
  const t = openTurns.get(id);
  if (!t) return;
  // No watcher armed yet — stash so watchAdoptedTurn can consume the
  // response through its bookkeeping path when the adoption scan reaches
  // the session; the flush timer covers sessions never re-discovered.
  sniffedSettles.set(id, { ok, errMsg, turn: t });
  if (!sniffedSettleTimer) {
    sniffedSettleTimer = setTimeout(() => flushSniffedSettles(ctx), SNIFF_SETTLE_DELAY_MS);
    sniffedSettleTimer.unref();
  }
}

/** Broker prompt-event settle — the ctl channel's `prompt-done` says the
 *  broker saw this prompt's response on the acp's byte stream (it may have
 *  transited while this backend was dead, or died on the old attach).
 *  Correlation: a journaled reqId must match so an older prompt's answer
 *  can't eat a re-dispatched turn's open entry; with no reqId journaled,
 *  the acp the journal names is the disambiguator. An armed adopted-turn
 *  watcher gets the same done() path the wire sniffer uses; nobody armed
 *  → stash like a sniffed dead-window response (a later arming watcher
 *  consumes it with resync intact, the bounded flush settles the rest). */
function onBrokerPromptEvt(ctx: ApiContext, e: BrokerCtlEvent) {
  if (e.ev !== "prompt-done") return; // prompt-start is emitted but unused
  const id = typeof e.sessionId === "string" && e.sessionId ? e.sessionId : null;
  if (!id) return;
  openTurnsLoad(ctx);
  const t = openTurns.get(id);
  if (t?.reqId != null && String(t.reqId) !== String(e.reqId)) return;
  if (t != null && t.reqId == null && t.acpId != null && e.id != null && t.acpId !== e.id) return;
  const ok = e.ok !== false;
  const early = adoptedSettle.get(id);
  if (early) { early(ok, e.errMsg); return; }
  // A live dispatchPrompt owns the settle — the response arrives on its own
  // data channel right behind the ctl event and the SDK resolves normally.
  if (!t || inflight.has(id)) return;
  sniffedSettles.set(id, { ok, errMsg: e.errMsg, turn: t });
  if (!sniffedSettleTimer) {
    sniffedSettleTimer = setTimeout(() => flushSniffedSettles(ctx), SNIFF_SETTLE_DELAY_MS);
    sniffedSettleTimer.unref();
  }
}

/** Shared broker prompt-event subscription — installed lazily the first
 *  time an adopted-turn watcher needs it (broker mode only), then kept for
 *  the process lifetime: one shared ctl subscription fans out to every
 *  watcher by sessionId, so nothing per-turn is ever subscribed or torn
 *  down. */
let promptEvtArmed = false;
function ensurePromptEvtSub(ctx: ApiContext) {
  if (promptEvtArmed || !brokerEnabled) return;
  promptEvtArmed = true;
  void brokerOnEvent((e) => {
    try { onBrokerPromptEvt(ctx, e); } catch { /* events never break the sub */ }
  }).catch(() => { promptEvtArmed = false; });
}

function watchAdoptedTurn(ctx: ApiContext, id: string, acp: DevinAcp, resync = false) {
  ensurePromptEvtSub(ctx); // millisecond settle via broker prompt-done
  adoptedTurns.add(id);
  inflight.add(id);
  acp.busySessions.add(id); // same protection a real prompt gets — no hard
                            // kill / unpool while the adopted turn streams
  ctx.hub.broadcast({ type: "session_status", sessionId: id, status: sessionStatus(ctx, id).status });
  const t0 = Date.now();
  // Do NOT touchSessionActivity here: pre-attach silence is real silence —
  // a turn that died before the restart shouldn't get a free 90s of
  // "working". The floor below still grants ~30s of benefit-of-doubt for
  // turns silently running on the other side.
  let finished = false;
  const done = (err: boolean, ok = true, errMsg?: string) => {
    if (finished) return;
    finished = true;
    clearInterval(iv);
    adoptedSettle.delete(id);
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
      ]).finally(() => settleRecoveredTurn(ctx, id, ok, errMsg));
    } else {
      settleRecoveredTurn(ctx, id, ok, errMsg);
    }
  };
  adoptedSettle.set(id, (ok, errMsg) => done(false, ok, errMsg));
  // A prompt response may already have been sniffed (ring replay lands
  // during init, before this watcher's arm) — consume it instantly through
  // done() so resync + busy bookkeeping stay exact.
  const sniffed = sniffedSettles.get(id);
  if (sniffed && openTurns.get(id) === sniffed.turn) {
    sniffedSettles.delete(id);
    setTimeout(() => done(false, sniffed.ok, sniffed.errMsg), 0);
  }
  const iv = setInterval(() => {
    if (acp.exited) return done(true);
    // Floor grants ~30s grace post-attach (a live turn's stream updates push
    // lastActivity past it anyway); without it a restart resets the clock and
    // an already-dead turn ghosts "working" for the full silence window.
    const last = Math.max(lastActivity.get(id) ?? 0, t0 - ADOPT_SILENCE_MS + 30_000);
    if (Date.now() - last > ADOPT_SILENCE_MS) {
      console.error(`[adopt] ${id}: turn silent ${Math.round((Date.now() - last) / 1000)}s — declaring settled`);
      done(false);
    }
  }, 5000);
  iv.unref();
}

/** A journaled turn the broker prompt-ledger proves already answered —
 * settle it instantly instead of ghosting "working" through the silence
 * window. Same resync tail as watchAdoptedTurn's done(): a crash attach
 * first replays a bounded session/load so the dead-window gap doesn't
 * fossilize under the turn boundary. */
function settleDeadAdoptedTurn(ctx: ApiContext, id: string, acp: DevinAcp, resync: boolean) {
  if (!resync) { settleRecoveredTurn(ctx, id); return; }
  void Promise.race([
    loadOnce(ctx, acp, id, ctx.sessionCwd.get(id) ?? acp.cwd).catch(() => {}),
    new Promise((r) => setTimeout(r, 60_000)),
  ]).finally(() => settleRecoveredTurn(ctx, id));
}

/** The ledger broker always emits `pendingPrompts` per acp — a missing field
 *  means a pre-ledger build is running, which this backend no longer
 *  tolerates: the ledger reads as EMPTY (authoritative — every in-window
 *  journaled turn settles instantly) and one loud error per process names
 *  the offender. */
let preLedgerWarned = false;
function warnPreLedgerBroker(acpId: string) {
  if (preLedgerWarned) return;
  preLedgerWarned = true;
  console.error(`[broker] pre-ledger broker — upgrade required: acp ${acpId} reports no pendingPrompts ledger; treating it as EMPTY (authoritative)`);
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
      // The ledger broker always emits pendingPrompts — absent means a
      // pre-ledger build; warn once and treat it as an EMPTY (authoritative)
      // ledger rather than falling back to blind silence-watching.
      if (!Array.isArray(a.pendingPrompts)) warnPreLedgerBroker(a.acpId);
      const ledger = a.pendingPrompts ?? [];
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
            // Locked by SOMEONE but devin won't name the holder (this build
            // stamps lockHolderPid:null on every lock): pinning an unstamped
            // record to this acp without evidence is how a session wedges on
            // a host that only answers session_not_found — the exact bug
            // claimLockedHolder's probe repairs. Claim ONLY records that
            // name this acp's pid, or a session whose still-pending prompt
            // the broker ledger saw go out on THIS acp (ledger proof
            // outweighs the missing stamp). Everything else stays unpinned —
            // its next op's session_locked goes through claimLockedHolder.
            const t = openTurns.has(sid) && !adoptedTurns.has(sid) ? openTurns.get(sid) : undefined;
            const pending = t != null && ledger.some(
              (p) => p.sessionId === sid || (t.reqId != null && String(t.reqId) === p.reqId),
            );
            if (holder === a.pid || pending) {
              held++;
              if (!loadedOn.get(acp)) loadedOn.set(acp, new Set());
              markLoadedOn(sid, acp);
              // Dedicated (single-session) agents resolve via bySession —
              // the pool path is multi-session only.
              if (!agent.multiSession) ctx.manager.bindSession(sid, acp);
            }
            // Turn watchers arm on the first listing acp even when the session
            // is held elsewhere: the real holder's frames feed lastActivity
            // through the same wire either way, and an unarmed live turn would
            // look dead to the boot auto-resume. adoptedTurns dedups the rest.
            if (t) {
              if (pending) {
                watchAdoptedTurn(ctx, sid, acp, offsets[a.acpId] == null); turns++;
              } else if (t.ts != null && t.ts >= a.startedAt) {
                // The ledger watched this acp since spawn and shows no
                // outstanding prompt — the turn's response already fired
                // (consumed or dropped in the dead window). Settle now
                // instead of ghosting "working" to the silence cap.
                settleDeadAdoptedTurn(ctx, sid, acp, offsets[a.acpId] == null); turns++;
              } else {
                // Journaled before this acp's lifetime — outside the
                // ledger's authoritative window, so its absence proves
                // nothing; only the silence detector tells live from dead.
                watchAdoptedTurn(ctx, sid, acp, offsets[a.acpId] == null); turns++;
              }
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
  // Dead-window responses sniffed before the scan armed their watchers were
  // stashed; sessions the scan re-discovered consume them at arm time —
  // flush settles the rest (turn whose session was never re-listed).
  flushSniffedSettles(ctx);
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


