/**
 * lweb/admin/sessiontimeline — the per-session transcript surface under
 * /api/admin/session/:id: timeline/index/changes/todos read models, the
 * parked-prompt queue (queue/queue-op), sidechain stubs, terminal output,
 * and the live-desktop cloud stub.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiContext } from "../../routes.js";
import { buildTimeline, tlReset } from "../../dwtimeline.js";
import { snapshotItems } from "../../dwtailsnap.js";
import { ensureLoaded, acpForId, interruptedTurn } from "../../sessionload.js";
import { sessionStatus, terminalBuf } from "../../sessionview.js";
import { dispatchPrompt } from "../../sessionprompt.js";
import { queueList, queueAdd, queueRemove, queueFlush } from "../../sessionqueue.js";
import { loadInflight } from "../../sessionplace.js";
import { inflight, isDraining } from "../../sessionlive.js";
import { personaState } from "../../persona.js";
import { json, readJson, UNSUPPORTED } from "../../httputil.js";

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
    const snap = (loading || peek || !live.length) ? snapshotItems(ctx, id) : null;
    // During replay serve ONLY the old-gen snapshot; afterwards ONLY
    // the rebuilt live items — never mix generations. In peek mode the
    // snapshot wins unless the live log already holds more (newer) data.
    const serveSnap = !!snap && (loading || (peek && snap.length >= live.length));
    const all = serveSnap ? snap : live;
    // Consume the reset flag only when actually serving new-gen items.
    const reset = !loading && !serveSnap && tlReset.delete(id);
    // Page from the END (newest). `limit` items per page; `cursor` is the
    // exclusive upper index of the next-older page, so clients paging
    // backwards pass it back verbatim. Frozen (null) while a replay is
    // in flight — indexes shift mid-replay, so back-paging then would
    // land on misaligned slices.
    const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get("limit") ?? "300", 10) || 300));
    const cursor = url.searchParams.get("cursor");
    if (url.searchParams.get("raw") === "1") {
      json(res, 200, { entries: ctx.sessionLog.get(id) });
      return true;
    }
    const end = cursor !== null ? Math.min(all.length, Math.max(0, parseInt(cursor, 10) || 0)) : all.length;
    const start = Math.max(0, end - limit);
    const items = loading && !snap ? [] : all.slice(start, end);
    const st = sessionStatus(ctx, id);
    json(res, 200, {
      items,
      // Peek pages can't back-page: snapshot indexes don't line up with
      // the live log, so older history needs a real (loading) fetch.
      next_cursor: !loading && !peek && start > 0 ? String(start) : null,
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
      // original message so the client can offer one-click resend.
      interrupted: interruptedTurn(ctx, id) ?? undefined,
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
    json(res, 200, { threads: [] });
    return true;
  }
  if ((sub === "sidechain" || sub === "sidechain/cancel") && m === "POST") {
    json(res, 200, sub === "sidechain" ? UNSUPPORTED : { ok: true });
    return true;
  }

  if (sub === "terminal" && m === "GET") {
    const pid = url.searchParams.get("pid") ?? "";
    const buf = terminalBuf.get(pid);
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
