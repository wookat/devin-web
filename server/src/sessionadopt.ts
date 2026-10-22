/**
 * sessionadopt — broker-adoption + recovered-turn settlement engine.
 * Extracted from sessionload.ts (behavior unchanged): everything that runs
 * when a restarted backend re-attaches to broker-owned acp processes —
 * adoptBrokerAcps (the boot scan), watchAdoptedTurn (silence fallback),
 * settleDeadAdoptedTurn (ledger evidence), resolveTurnByReq (wire-sniffed
 * late responses), the prompt-done ctl event hook, and the shared
 * settleRecoveredTurn cleanup. Imports the load engine (loadOnce) only for
 * the bounded resync that heals crash-attach transcript gaps — the
 * dependency stays one-directional (sessionload never imports this file).
 */
import type { ApiContext } from "./routes.js";
import type { DevinAcp } from "./acp.js";
import { brokerEnabled, brokerList, brokerOnEvent, readOffsets, clearOffsets, type BrokerCtlEvent } from "./acpbroker.js";
import { agentById, DEFAULT_AGENT } from "./agents.js";
import { noteUpdate, persistTail } from "./dwtimeline.js";
import { queueFlush } from "./sessionqueue.js";
import { releaseBusy } from "./sessionprompt.js";
import { openTurns, openTurnsLoad, openTurnsSave, sessionByReqId, type OpenTurn } from "./sessionturns.js";
import { loadedOn, sessionHost, markLoadedOn } from "./sessionplace.js";
import { inflight, adoptedTurns, lastActivity } from "./sessionlive.js";
import { sessionStatus } from "./sessionview.js";
import { loadOnce } from "./sessionload.js";
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
