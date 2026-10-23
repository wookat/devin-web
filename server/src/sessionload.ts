/**
 * sessionload — the load/recovery engine: session→acp resolution (hostFor),
 * session/load with append-only replay dedup (doLoad/loadOnce), placement
 * marks, session_locked forensics (claimLockedHolder), the interrupted-turn
 * evidence reader, auto-resume, and the durable-state boot hook. Broker
 * adoption + recovered-turn settlement live in sessionadopt.ts (it imports
 * loadOnce from here — the edge stays one-directional). This is the top of
 * the session module stack: it binds the queue/prompt injections so no leaf
 * ever imports a consumer.
 */
import type { ApiContext } from "./routes.js";
import type { DevinAcp } from "./acp.js";
import { brokerEnabled, brokerList } from "./acpbroker.js";
import { agentById, DEFAULT_AGENT } from "./agents.js";
import { remapLegacyCwd } from "./store.js";
import { loadReg, meta, noteLastUsed } from "./dwstore.js";
import { noteUpdate, tlCache } from "./dwtimeline.js";
import { persistTail } from "./dwtailsnap.js";
import type { LogEntry } from "./sessiondb.js";
import { initCfgState, isSessionLocked, loadWithRetry, captureLoadResponse } from "./sessioncfg.js";
import { queueList, queueFlush, restoreQueues, bindQueueDeps, queuedSessions } from "./sessionqueue.js";
import { restoreSendErrors } from "./sendhealth.js";
import { dispatchPrompt, releaseBusy, bindPromptDeps } from "./sessionprompt.js";
import { openTurns, openTurnsLoad, openTurnsSave, type OpenTurn } from "./sessionturns.js";
import {loadedOn, sessionHost, loadEpoch, loadInflight, markLoadedOn } from "./sessionplace.js";
import { inflight, adoptedTurns, lastActivity, isDraining } from "./sessionlive.js";
import { pingSubagent } from "./sessionsub.js";
import { sessionStatus } from "./sessionview.js";
import { noAutoResume } from "./env.js";

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

/** Replay history onto `acp` — APPEND-ONLY: the local store is never
 * cleared. session/load re-streams devin's transcript verbatim, and every
 * streamed update whose content key already sits in the store is skipped
 * by the dedup arm (beginDedupReplay); only the genuine delta lands. A
 * mid-replay kill therefore leaves the stored transcript intact — the next
 * load simply re-dedups the same stream — and `_local` optimistic entries
 * graduate in place when their authoritative twins arrive. */
async function doLoad(ctx: ApiContext, acp: DevinAcp, id: string, cwd: string): Promise<void> {
  const hasLog = ctx.sessionLog.get(id).length > 0;
  if (hasLog) ctx.sessionLog.beginDedupReplay(id);
  try {
    captureLoadResponse(id, await loadWithRetry(acp, id, cwd));
    // A successful reload rebuilt session state from the store — its
    // subagent registry is fresh: agents spawned before this moment have
    // no live handle even though their transcripts replay fine.
    loadEpoch.set(id, Date.now());
    persistTail(ctx, id);
  } finally {
    if (hasLog) ctx.sessionLog.endDedupReplay(id);
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
  let pinned = host && !host.exited ? host : undefined;
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
  if (pinned && !ssh) { const k = ctx.sessionCwd.get(id); if (k && remapLegacyCwd(pinned.cwd) !== remapLegacyCwd(k)) { sessionHost.delete(id); pinned = undefined; } }
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
    for (const a of live.filter((x) => x.cwd && remapLegacyCwd(x.cwd) === remapLegacyCwd(cwd))) {
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
  if (noAutoResume() || !loadReg(ctx).prefs?.autoResume || !openTurns.size) return;
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


