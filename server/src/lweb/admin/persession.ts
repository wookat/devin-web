/**
 * lweb/admin/persession — the /api/admin/session/:id/<sub> subtree:
 * subagent-as-session + PR prelude, the session detail GET, the shared
 * sessionSubs table, then dispatch to the route-group handlers in
 * sessionfiles/sessiontimeline/sessioncontrol/sessionlifecycle, and the
 * cloud-only fallthrough.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiContext } from "../../routes.js";
import { meta } from "../../dwstore.js";
import { buildMessages, buildTimeline } from "../../dwtimeline.js";
import { sessionConfig, sessionStatus } from "../../sessionview.js";
import { loadInflight } from "../../sessionplace.js";
import { inflight } from "../../sessionlive.js";
import { agentById } from "../../agents.js";
import { handlePrRoute } from "../../pr.js";
import { json, readBody, UNSUPPORTED } from "../../httputil.js";
import {
  sessionSubs, handleSubSession, parseSubId, cwdFor,
  titleFromLog, lastContextUsage,
} from "../session.js";
import { handleSessionFiles } from "./sessionfiles.js";
import { handleSessionTimeline } from "./sessiontimeline.js";
import { handleSessionControl } from "./sessioncontrol.js";
import { handleSessionLifecycle } from "./sessionlifecycle.js";

export async function handlePerSession(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL, m: string, p: string, parts: string[]): Promise<boolean> {
  // ======================= per-session routes =======================
  if (parts[2] === "session" && parts.length >= 4) {
    const id = decodeURIComponent(parts[3]);
    // Multi-segment subpath: "subagent/<aid>/timeline" etc.
    const sub = parts.slice(4).join("/");

    // sub:<parent>:<agentId> — a subagent as a first-class child session
    // (cloud parity: child sessions open as full session pages). Data
    // lives in the parent's log; unhandled subs fall through to the
    // generic handlers (files/file/file-raw work via cwdFor → parent cwd).
    const subRef = parseSubId(id);
    if (subRef) {

      if (await handleSubSession(ctx, subRef, id, sub, m, req, res, url)) return true;
    }

    // PR review endpoints (PrPanel) — GitHub data via `gh api`; the panel
    // sends pr_url, not the session's repo, so this stays session-agnostic
    // data plumbing inside the admin tree.
    if (sub === "pr" || sub.startsWith("pr-")) {
      if (await handlePrRoute(ctx, sub, m, req, res, url)) return true;
    }

    // GET /api/admin/session/:id — detail (slim or full). Memory-only:
    // this is also hit by sidebar prefetch; triggering a history replay
    // here would bump the session's updatedAt on every hover.
    if (!sub && m === "GET") {
      const items = buildTimeline(ctx, id).items;
      const mm = meta(ctx, id);
      const st = sessionStatus(ctx, id);
      const cfg = sessionConfig(ctx, id);
      json(res, 200, {
        session: {
          id, devin_session_id: id,
          title: mm.title ?? titleFromLog(ctx, id) ?? "Untitled session",
          devin_title: titleFromLog(ctx, id) ?? "Untitled session",
          permission: mm.permission ?? "detailed",
          archived: mm.archived ? 1 : 0,
          status: st.status, status_message: null,
          current_devin_version: cfg.model?.currentName ?? null,
          pull_requests: [], repos: [cwdFor(ctx, id)],
          cwd: cwdFor(ctx, id),
          is_locked: false,
          loaded_here: ctx.sessionLog.get(id).length > 0 || loadInflight.has(id) || inflight.has(id),
          context_usage: lastContextUsage(ctx, id),
          // Owning ACP agent — the client degrades devin-private UI
          // (share/end-session/subagents) for other agents' sessions.
          agent: mm.agent ?? ctx.store.agentSession(id)?.agent ?? "devin",
          // Fork = native session/fork or transcript-seed fallback; only
          // dedicated single-session agents can't host a second session.
          canFork: agentById(mm.agent ?? ctx.store.agentSession(id)?.agent).multiSession,
        },
        // Detail is polled every few seconds — the frontend only needs a
        // presence check / composer hint, not the whole transcript.
        messages: buildMessages(items.slice(-60)),
        share_url: mm.shared ? `/s/${id}?t=local` : null,
        dashboard_url: `/api/session/${id}/dashboard?token=local`,
        media_token: "local",
      });
      return true;
    }

    const sharedH = sessionSubs[`${sub}:${m}`];
    if (sharedH) { await sharedH(ctx, id, req, res, url); return true; }

    // Route-group handlers — each returns true when it served the sub.
    if (await handleSessionFiles(ctx, req, res, url, m, sub, id)) return true;
    if (await handleSessionTimeline(ctx, req, res, url, m, sub, id)) return true;
    if (await handleSessionControl(ctx, req, res, url, m, sub, id)) return true;
    if (await handleSessionLifecycle(ctx, req, res, url, m, sub, id)) return true;

    // cloud-only endpoints: PR review, env suggestions, translations…
    if (m === "POST") await readBody(req);
    json(res, 200, UNSUPPORTED);
    return true;
  }

  return false;
}
