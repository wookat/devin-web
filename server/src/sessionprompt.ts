/**
 * sessionprompt — the send pipeline: staged-upload resolution → ACP prompt
 * blocks, dispatch (open-turn journaling + settle bookkeeping), the single
 * retry policy (stale-pin heal → transport-death heal → rate-limit rotate),
 * the turn-silence watchdog, and the send-preflight diagnostic.
 * Leaf-adjacent: every engine callback it needs from the load/subagent
 * domains is INJECTED via bindPromptDeps (same doctrine as sessionqueue)
 * so this module can never import its consumers.
 */
import fs from "node:fs";
import path from "node:path";
import type { ApiContext } from "./routes.js";
import type { DevinAcp } from "./acp.js";
import { uploadPath, MIME } from "./uploads.js";
import { isRateLimitError, retryAfterSeconds } from "./accounts.js";
import { brokerEnabled, brokerList, brokerOnEvent } from "./acpbroker.js";
import { loadReg } from "./dwstore.js";
import { noteUpdate } from "./dwtimeline.js";
import { persistTail } from "./dwtailsnap.js";
import { noteSendError, lastSendError, type SendCheckStep } from "./sendhealth.js";
import { inflight, isDraining, isGracefulExit, lastActivity } from "./sessionlive.js";
import { openTurns, openTurnsLoad, openTurnsSave } from "./sessionturns.js";
import { queueList, queueFlush } from "./sessionqueue.js";
import { incMetric } from "./metrics.js";
import { loadedOn, sessionHost } from "./sessionplace.js";
import { turnSilenceMs } from "./env.js";

// ---------------------------------------------------------------------------
// injected engine callbacks — bound once by the load domain at module init.
// dispatchPrompt needs a host resolver (acpForId), a status read for the
// settle broadcast (sessionStatus), and a subagent-liveness ping (subPing);
// all three live in sessionload/sessionsub/sessionview — injection keeps
// the edge one-directional.
// ---------------------------------------------------------------------------
interface PromptDeps {
  resolveAcp: (ctx: ApiContext, id: string) => Promise<DevinAcp>;
  statusOf: (ctx: ApiContext, id: string) => { status: string; activity: string };
  pingSubagent: (agentId: string) => void;
}
let deps: PromptDeps = {
  resolveAcp: () => Promise.reject(new Error("sessionprompt deps not bound")),
  statusOf: () => ({ status: "blocked", activity: "idle" }),
  pingSubagent: () => {},
};
export function bindPromptDeps(d: PromptDeps) { deps = d; }

// ---------------------------------------------------------------------------
// send preflight — the /send-check diagnostic panel
// ---------------------------------------------------------------------------

export function sendPreflight(ctx: ApiContext, id: string) {
  openTurnsLoad(ctx);
  const steps: SendCheckStep[] = [];
  const rec = (id2: string, level: SendCheckStep["level"], detail: string) => steps.push({ id: id2, level, detail });

  rec("gate", isDraining() ? "fail" : "ok",
    isDraining() ? "server is draining for a restart — sends are refused until it is back" : "dispatch gate open");

  const known = ctx.sessionCwd.has(id) || !!ctx.store.agentSession(id) || loadReg(ctx).sessions[id] != null;
  rec("known", known ? "ok" : "warn",
    known ? "session registered" : "unknown session id — a first send must carry cwd");

  const flying = inflight.has(id);
  const queued = queueList(id).length;
  rec("busy", flying ? "warn" : "ok",
    flying ? `turn in flight — a send now parks in the queue (depth ${queued})`
      : queued ? `idle — ${queued} queued message(s)` : "idle");

  const dedicated = ctx.manager.forSession(id);
  const pinned = sessionHost.get(id);
  if (dedicated) {
    rec("host", "ok", `dedicated agent process pid ${dedicated.pid}`);
  } else if (pinned) {
    rec("host", pinned.exited ? "warn" : "ok",
      pinned.exited
        ? `pinned host pid ${pinned.pid} exited — next send re-resolves and replays`
        : `pinned ${pinned.agent.id} process pid ${pinned.pid} (account ${pinned.account ?? "?"})`);
  } else {
    const dir = ctx.sessionCwd.get(id);
    rec("host", dir ? "ok" : "warn",
      dir ? `no live host — next send spawns/loads on cwd pool (${dir})`
        : "no live host and no known cwd — a send will fail with 'unknown session'");
  }

  const healthy = ctx.accounts.healthy();
  const acct = pinned?.account ?? dedicated?.account ?? ctx.accounts.pick() ?? ctx.accounts.accountForCredFile();
  rec("account", acct ? "ok" : healthy.length ? "warn" : "fail",
    acct ? `account: ${acct}${pinned?.exited ? " (host dead — respawn picks a healthy one)" : ""}`
      : healthy.length ? `no spawn attribution — healthy pool: ${healthy.join(", ")}`
        : "ALL accounts cooling — sends will fail 429");

  const dbs = ctx.sessionLog.dbStats();
  rec("store", dbs ? "ok" : "warn",
    dbs ? `${dbs.events.toLocaleString()} events · ${dbs.blobs.toLocaleString()} blobs · ${(dbs.fileBytes / 1048576).toFixed(0)}MB`
      : "sqlite store unavailable — file-mirror fallback only");

  const open = openTurns.get(id);
  if (open) rec("openTurn", "warn", `an earlier turn never settled (${new Date(open.ts).toLocaleTimeString()}) — it will auto-recover or resend`);

  const last = lastSendError(id);
  if (last) rec("lastError", "warn", `${new Date(last.ts).toLocaleTimeString()} [${last.stage}] ${last.message}`);

  return {
    steps,
    verdict: steps.some((s) => s.level === "fail") ? "blocked" : steps.some((s) => s.level === "warn") ? "degraded" : "ok",
  };
}

// ---------------------------------------------------------------------------
// attachments — staged /api/uploads urls → real ACP prompt blocks
// ---------------------------------------------------------------------------

const TEXTISH = /^text\/|\/(json|xml|javascript|typescript|x-yaml)$/i;
const TEXT_EXT = new Set([".txt", ".md", ".json", ".jsonc", ".yaml", ".yml", ".xml", ".csv", ".tsv", ".log", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".hpp", ".cs", ".rb", ".php", ".sh", ".bash", ".zsh", ".ps1", ".bat", ".cmd", ".sql", ".html", ".htm", ".css", ".scss", ".less", ".vue", ".svelte", ".toml", ".ini", ".cfg", ".conf", ".env", ".gitignore", ".dockerfile", ".swift", ".kt", ".lua", ".r", ".dart", ".ex", ".exs", ".erl", ".hs", ".ml", ".clj", ".scala", ".gradle", ".cmake", ".proto", ".tf"]);

/** Resolve a staged `/api/uploads/<id>` url to its on-disk file + mime. */
export function resolveUpload(ctx: ApiContext, url: string): { file: string; mime: string; name: string } | null {
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
export async function attachmentBlocks(ctx: ApiContext, attachments: { url: string; name?: string }[]): Promise<Record<string, unknown>[]> {
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

// ---------------------------------------------------------------------------
// error predicates + busy tracking — the retry policy's vocabulary
// ---------------------------------------------------------------------------

/** devin's -32016: the session isn't open on the acp we resolved — the
 * loadedOn mark/pin went stale (cross-pool join race, lock stolen by
 * another app, or the acp silently dropped it). */
function isSessionNotFoundError(e: unknown): boolean {
  const kind = (e as { data?: Record<string, unknown> })?.data?.["cognition.ai/errorKind"];
  if (kind === "session_not_found") return true;
  const s = String((e as Error)?.message ?? e);
  return /session not found|session_not_found/i.test(s);
}

/** The JSON-RPC transport died mid-call — the SDK rejects pending calls with
 * "Connection closed" when the acp pipe breaks. The process can stay alive
 * (alive per the process table, dead per the pipe): a half-dead host wedges a
 * session into "loaded_here but every prompt dies" — the puzzling-tithonia
 * loop. Killing and re-resolving is the only way out. */
function isTransportDeadError(e: unknown): boolean {
  const s = String((e as Error)?.message ?? e);
  return /connection closed|write EPIPE|ERR_STREAM_DESTROYED|premature close|socket hang up/i.test(s);
}

/** A prompt RPC can hang forever when the agent backend wedges — it used to
 * leave `inflight` set and stall the deploy drain indefinitely. A turn that
 * produced no output for this long is declared dead: the host acp is
 * recycled (its transport close rejects the pending RPC anyway; the race
 * below is the belt-and-braces settle) so dispatchPrompt's finally runs and
 * the drain can proceed. Env-tunable; default 15min of silence. */
const TURN_SILENCE_MS = turnSilenceMs();

/** Drop a session's busy mark on `acp` — when the acp was flagged for
 * retire-after-idle (rotation/restart while mid-turn), the last settle is
 * what actually recycles it. */
export function releaseBusy(ctx: ApiContext, acp: DevinAcp, id: string) {
  acp.busySessions.delete(id);
  if (acp.retireAfterIdle && !acp.busySessions.size && !acp.exited) {
    ctx.manager.killProcess(acp);
  }
}

/** The ledger broker always emits `pendingPrompts` per acp — a missing field
 *  means a pre-ledger build is running, which this backend no longer
 *  tolerates. One loud error per process names it; the ledger probe skips
 *  rather than trusting a blind broker. */
let preLedgerWarned = false;
function warnPreLedgerBroker() {
  if (preLedgerWarned) return;
  preLedgerWarned = true;
  console.error("[broker] pre-ledger broker — upgrade required: pendingPrompts ledger missing; lost-response probe skipped");
}

// ---------------------------------------------------------------------------
// promptWithRetry — the ONE retry policy shared by every send path
// ---------------------------------------------------------------------------

/** Send a prompt with ONE automatic rate-limit retry — the single retry policy
 * shared by the wb /message route and the native /prompt route: cool the
 * account the failing acp actually runs on, rotate (kills pooled processes so
 * the next spawn uses a fresh key), re-resolve the host via getAcp, resend.
 * Throws a status-429 error when every account is cooling. */
export async function promptWithRetry<T>(
  ctx: ApiContext,
  id: string,
  getAcp: () => Promise<DevinAcp>,
  act: (acp: DevinAcp) => Promise<T>,
): Promise<T> {
  for (let retried = false, healed = false; ;) {
    const acp = await getAcp().catch((e: unknown) => {
      (e as { stage?: string }).stage ??= "resolve";
      throw e;
    });
    acp.busySessions.add(id);
    // Busy is released in act's own .finally so the catch-policy below sees
    // the failed acp already idle — a rate-limit killPooled must be able to
    // recycle THIS process so the retry lands on a fresh account.
    let wedgedReject: (e: Error) => void = () => {};
    const wedged = new Promise<never>((_, rej) => { wedgedReject = rej; });
    const t0 = Date.now();
    let ledgerIv: NodeJS.Timeout | null = null;
    let promptEvtOff: (() => void) | null = null;
    let watchDone = false; // clearWatch ran — late-resolving subs self-destruct
    const clearWatch = () => {
      watchDone = true;
      clearInterval(watchdog);
      if (ledgerIv) { clearInterval(ledgerIv); ledgerIv = null; }
      if (promptEvtOff) { promptEvtOff(); promptEvtOff = null; }
    };
    const watchdog = setInterval(() => {
      // Floor at t0: lastActivity may hold a PREVIOUS turn's timestamp —
      // without the floor an idle-for-a-while session gets killed 60s into
      // its next (healthy) turn.
      const last = Math.max(lastActivity.get(id) ?? 0, t0);
      if (Date.now() - last <= TURN_SILENCE_MS) return;
      clearWatch();
      console.warn(`[session] ${id}: no output for ${Math.round(TURN_SILENCE_MS / 60000)}min — recycling wedged host acp`);
      if (!acp.exited) ctx.manager.killProcess(acp);
      wedgedReject(Object.assign(new Error(`turn produced no output for ${Math.round(TURN_SILENCE_MS / 60000)}min — wedged host process recycled`), { stage: "watchdog" }));
    }, 60_000);
    watchdog.unref();
    // Broker prompt-ledger probe (~30s, staggered from the 60s watchdog): the
    // broker witnesses every session/prompt request AND its response on this
    // acp's byte stream. If the ledger shows NO outstanding prompt for this
    // session while `act`'s promise still pends, the response frame was lost
    // mid-connection — the turn is DONE on the agent side and only the SDK
    // settle is missing. Without this the only exit was the 15min silence
    // watchdog. An acp missing from the broker's list skips the poll (broker
    // restart race), and a probe failure must NEVER kill a healthy turn.
    let sentSeen = false; // send-evidence observed on an earlier poll
    if (brokerEnabled && acp.brokerId) {
      const bid = acp.brokerId;
      ledgerIv = setInterval(() => {
        void (async () => {
          try {
            if (acp.exited) return; // transport death reports via act's own rejection
            const info = (await brokerList()).find((a) => a.acpId === bid);
            if (!info) return; // acp not listed this poll — broker restart race; skip
            if (!Array.isArray(info.pendingPrompts)) { warnPreLedgerBroker(); return; }
            // The sniffer journals reqId+acpId the moment the prompt frame
            // leaves this process (notePromptReq) — only a journal stamped
            // to THIS acp's connection counts as send-evidence here.
            const t = openTurns.get(id);
            const reqId = t && t.acpId === bid ? t.reqId : undefined;
            const pending = info.pendingPrompts.some(
              (p) => p.sessionId === id || (reqId != null && String(p.reqId) === String(reqId)),
            );
            if (pending) { sentSeen = true; return; }
            // Nothing outstanding on the broker. Declare loss only with
            // proof the request really went out AND had a full cycle to
            // reach the broker (absorbs the write→broker-read lag for a
            // freshly-written frame):
            //  - responseSeen: the journaled reqId is already gone from
            //    pendingReqs — the sniffer consumed the response off OUR
            //    wire yet the SDK promise never settled (instant, race-free);
            //  - sentBefore: send-evidence (ledger-pending, locally
            //    outstanding, or journaled reqId) seen on a PRIOR poll, now
            //    absent from the ledger → the broker watched it get answered.
            const responseSeen = reqId != null && !acp.pendingReqs.has(String(reqId));
            const sentBefore = sentSeen;
            if (reqId != null || [...acp.pendingReqs.values()].some((r) => r.method === "session/prompt" && r.sessionId === id)) sentSeen = true;
            if (!responseSeen && !sentBefore) return;
            clearWatch();
            console.warn(`[session] ${id}: broker ledger shows no outstanding prompt but the turn never settled — response lost mid-connection`);
            wedgedReject(Object.assign(new Error("prompt response lost — broker ledger shows no outstanding prompt"), { stage: "lost-response" }));
          } catch { /* ledger failures never kill a healthy turn */ }
        })();
      }, 30_000);
      ledgerIv.unref();
      // Event-driven fast path for the same lost-response condition: the
      // broker's prompt-done event says it saw the answer on this acp's
      // wire. The response frame rides the data channel right behind the
      // ctl event, so the check is deferred a beat — still outstanding on
      // OUR wire after that means the frame was lost mid-connection and
      // the SDK promise will never settle: reject lost-response now
      // instead of waiting out the 30s poll.
      void brokerOnEvent((e) => {
        if (e.ev !== "prompt-done" || e.id !== bid) return;
        const t = openTurns.get(id);
        const reqId = t && t.acpId === bid ? t.reqId : undefined;
        if (reqId == null || String(reqId) !== String(e.reqId)) return;
        setTimeout(() => {
          if (acp.exited || !acp.pendingReqs.has(String(reqId))) return;
          clearWatch();
          console.warn(`[session] ${id}: broker delivered prompt-done for req ${reqId} but the response never reached this connection — lost-response`);
          wedgedReject(Object.assign(new Error("prompt response lost — broker saw the answer but it never reached the client"), { stage: "lost-response" }));
        }, 250).unref();
      }).then((off) => { if (watchDone) off(); else promptEvtOff = off; }).catch(() => {});
    }
    try {
      return await Promise.race([
        act(acp).finally(() => { clearWatch(); releaseBusy(ctx, acp, id); }),
        wedged,
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      (err as { stage?: string }).stage ??=
        isSessionNotFoundError(err) ? "resolve" : isRateLimitError(msg) ? "rate-limit" : "prompt";
      // The pin/mark lied — clear it and re-resolve once so loadOnce
      // replays the session onto the acp the retry actually lands on.
      if (isSessionNotFoundError(err) && !healed) {
        healed = true;
        loadedOn.get(acp)?.delete(id);
        if (sessionHost.get(id) === acp) sessionHost.delete(id);
        console.warn(`[session] ${id}: stale host mark — reloading onto a fresh acp (${msg})`);
        continue;
      }
      // Transport died with the session pinned here — the host is a corpse
      // regardless of `exited`. Recycle it (busy poolmates are spared via the
      // same unpool+retire rule restartSession uses) and replay once on a
      // fresh acp. `healed` bounds this to one shot; a still-broken session
      // surfaces its next error unchanged.
      if (isTransportDeadError(err) && !healed) {
        healed = true;
        loadedOn.get(acp)?.delete(id);
        if (sessionHost.get(id) === acp) sessionHost.delete(id);
        if (acp.busySessions.size) { ctx.manager.unpool(acp, id); acp.retireAfterIdle = true; }
        else ctx.manager.killProcess(acp);
        console.warn(`[session] ${id}: acp transport died (${msg.slice(0, 80)}) — recycled host, retrying on a fresh process`);
        continue;
      }
      if (!isRateLimitError(msg) || retried) throw err;
      retried = true;
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
        sessionUpdate: "dw_notice",
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

// ---------------------------------------------------------------------------
// dispatchPrompt — the send orchestrator: journal → run → settle → flush
// ---------------------------------------------------------------------------

/** Post-settle delegates (persona 分身 registers here — keeps the import
 * one-directional: persona→sessionprompt, never the reverse). */
export const turnEndHooks = new Set<(ctx: ApiContext, id: string) => void>();

export function dispatchPrompt(ctx: ApiContext, id: string, text: string, attachments: { url: string; name?: string; mime?: string; size?: number }[] = [], subagentId?: string, respawnRow?: { title: string; task: string; profile: string }) {
  incMetric("prompts.dispatched");
  // Drain gate: no new turns once a restart is draining — internal callers
  // (queueFlush, auto-resume, subagent relays) no-op; HTTP send-paths were
  // already 503'd before reaching here.
  if (isDraining()) return;
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
  // Sidebar rows poll /mirror/sessions only every 60s — push the status flip
  // so other clients' trees turn "working" immediately.
  ctx.hub.broadcast({ type: "session_status", sessionId: id, status: "working" });
  openTurnsLoad(ctx);
  openTurns.set(id, { text, ts: Date.now(), ...(attachments.length ? { attachments } : {}), resumeCount: openTurns.get(id)?.resumeCount ?? 0 });
  openTurnsSave(ctx);
  const run = async () => {
    const blocks = await attachmentBlocks(ctx, attachments).catch((e: unknown) => {
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), { stage: "attachments" });
    });
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
    if (subagentId) deps.pingSubagent(subagentId);
    // respawnRow: the old handle is dead — the lead spawns a SUCCESSOR
    // (fresh agent, same profile, prior task+tail as context) instead of
    // resuming. The successor lands as a NEW child row; the dead one stays.
    const tail = respawnRow ? ctx.sessionLog.sidecars.subTailText(id, subagentId!).slice(-1500) : "";
    const promptText = subagentId
      ? respawnRow
        ? `[Subagent relay] Subagent "${subagentId}" is permanently dead (its host process was recycled) — do NOT resume it. Call run_subagent(title=${JSON.stringify(respawnRow.title || "Subagent successor")}, profile=${JSON.stringify(respawnRow.profile || "subagent_general")}, task=<task>) now to spawn a SUCCESSOR agent — this is your ONLY task. Compose <task> as: "You continue the work of a previous subagent. Original task: ${JSON.stringify(respawnRow.task.slice(0, 600))}. Its last output before the handle died: ${JSON.stringify(tail)}. New instruction from the user: ${JSON.stringify(text)}"`
        : `[Subagent relay] Call run_subagent(resume="${subagentId}", task=<message>) now and pass the user's message verbatim — this is your ONLY task, do not do anything else first. If the subagent is still running and cannot be resumed, just say so. User message: ${JSON.stringify(text)}`
      : text;
    const textBlock = ctxMeta ? { type: "text", text: promptText, _meta: ctxMeta } : { type: "text", text: promptText };
    return promptWithRetry(ctx, id, () => deps.resolveAcp(ctx, id), (acp) => acp.prompt(id, [textBlock, ...blocks] as never, ctxMeta));
  };
  void run()
    .then(() => {
      // Durable turn boundary — survives log replay via the tail re-append,
      // so interruptedTurn can tell "finished turn" from "cut turn".
      ctx.sessionLog.append(id, { sessionUpdate: "dw_turn_end" });
      ctx.hub.broadcast({ type: "prompt_done", sessionId: id, result: null });
      persistTail(ctx, id);
      for (const h of turnEndHooks) { try { h(ctx, id); } catch { /* hooks never break a settle */ } }
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      const stage = (err as { stage?: string })?.stage ?? "prompt";
      noteSendError(id, stage, msg);
      ctx.sessionLog.append(id, {
        sessionUpdate: "dw_notice",
        notice: `错误[${stage}]: ${msg.slice(0, 200)}`,
      });
      noteUpdate(ctx, id);
    })
    .finally(() => {
      inflight.delete(id);
      ctx.hub.broadcast({ type: "session_status", sessionId: id, status: deps.statusOf(ctx, id).status });
      if (isGracefulExit()) {
        // A deploy-killed resume never got a fair shot — refund the attempt.
        // resumeCount only counts turns that failed NATURALLY; otherwise N
        // restarts burn the cap and the entry parks as a forever tombstone.
        const t = openTurns.get(id);
        if (t?.resumeCount) { t.resumeCount--; openTurnsSave(ctx); }
      } else if (openTurns.delete(id)) openTurnsSave(ctx);
      queueFlush(ctx, id);
    });
}
