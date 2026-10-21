/**
 * sessionsub — subagent registry: spawn/lifecycle bookkeeping over the
 * session log (listSubagents), the child's own stream slice
 * (subagentTimeline), liveness pings for the composer pill, and the dead-
 * handle set that short-circuits doomed relays. Leaf module — placement
 * state comes from sessionplace, timelines from dwtimeline.
 */
import type { ApiContext } from "./routes.js";
import { buildTimelineFrom, type DwItem, type LogEntry } from "./dwtimeline.js";
import { loadInflight, loadEpoch, sessionHost } from "./sessionplace.js";

/** Server boot — the acp subagent registry is process-local, so any agent
 * spawned before this process started has no live handle by definition. */
const BOOT_TS = Date.now();
/** `parent:agentId` — a resume already failed with a missing-handle error
 * for these; short-circuits further relays instead of burning a turn each
 * time the user retries a dead child. */
const deadSubs = new Set<string>();
export function markSubagentDead(parent: string, aid: string) {
  deadSubs.add(`${parent}:${aid}`);
}

/** Fresh-ping setter — the prompt pipeline (sessionprompt) pings a
 *  subagent right before the relay so its status pill reads Working at
 *  once; injected into sessionprompt by sessionload's bindPromptDeps. */
export function pingSubagent(aid: string) { subPing.set(aid, Date.now()); }

// ---------------------------------------------------------------------------
// subagents — events tagged cognition.ai/subagent_context.parentAgentId=agentId
// ---------------------------------------------------------------------------

export interface SubagentInfo {
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
export function subPingActive(aid: string): boolean {
  const t = subPing.get(aid) ?? 0;
  if (Date.now() - t > 60_000) { subPing.delete(aid); return false; }
  return true;
}

export function listSubagents(ctx: ApiContext, id: string, scope?: string, entries?: LogEntry[]): SubagentInfo[] {
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
const subTlCache = new Map<string, { m: number | null; lastSeq: number; items: DwItem[] }>();
export function subagentTimeline(ctx: ApiContext, id: string, agentId: string): DwItem[] {
  const key = `${id}${agentId}`;
  const mem = ctx.sessionLog.get(id);
  const forAgent = (e: LogEntry) => {
    const c = (e.update._meta as Record<string, unknown> | undefined)?.["cognition.ai/subagent_context"] as { parentAgentId?: string } | undefined;
    return c?.parentAgentId === agentId || e.update.toolCallId === agentId;
  };
  const resolve = (u: Record<string, unknown>) => ctx.sessionLog.resolveBlobs(u);
  // Full coverage test: replay restarts seq at 0, so a ring whose first
  // entry is seq 0 was never truncated. A truncated window must be unioned
  // with the disk index or early subagent events vanish.
  if (mem.length && mem[0].seq === 0) return buildTimelineFrom(mem.filter(forAgent), agentId, id, resolve);
  // Cold parent → serve from the child's sidechain file. Cache keyed on the
  // SIDECAR's mtime (the main log's mtime churns during live writes and would
  // defeat the cache, re-parsing the stream on every poll).
  const im = ctx.sessionLog.sidecars.subStreamMtime(id, agentId);
  const lastSeq = mem.length ? mem[mem.length - 1].seq ?? -1 : -1;
  const hit = subTlCache.get(key);
  if (hit && hit.m === im && im != null && hit.lastSeq === lastSeq) return hit.items;
  if (ctx.sessionLog.sidecars.subFilesStale(id)) ctx.sessionLog.sidecars.ensureSubFiles(id);
  const idx = ctx.sessionLog.sidecars.readSubStream(id, agentId) ?? [];
  const seen = new Set(idx.map((e) => e.seq));
  const items = buildTimelineFrom((mem.length ? [...idx, ...mem.filter((e) => !seen.has(e.seq))] : idx).filter(forAgent), agentId, id, resolve);
  // Cache only a settled read — a missing stream means the scan is still
  // running and the empty result must not stick or the transcript never fills.
  if (im != null) subTlCache.set(key, { m: im, lastSeq, items });
  return items;
}
