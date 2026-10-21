/**
 * lweb/share — the /api/share/<token>/* route tree: visitor-permission
 * enforcement, the shared sessionSubs dispatch, and the sanitized read
 * endpoints (meta/timeline/messages/todos/changes). Cloud media is 404.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiContext } from "../routes.js";
import { meta, loadReg } from "../dwstore.js";
import { snapshotItems, buildMessages, buildTimeline, tlReset } from "../dwtimeline.js";
import { ensureLoaded } from "../sessionload.js";
import { sessionStatus } from "../sessionview.js";
import { queueList } from "../sessionqueue.js";
import { loadInflight } from "../sessionplace.js";
import { json, UNSUPPORTED } from "../httputil.js";
import { sessionSubs, titleFromLog } from "./session.js";

export async function handleShareTree(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const m = req.method ?? "GET";
  const parts = url.pathname.split("/").filter(Boolean);

      const id = decodeURIComponent(parts[2]);
      const sub = parts[3] ?? "";

      // Share access is opt-in — a session id is NOT a capability token by
      // default (ids are enumerable via /ws + the sessions list). The admin
      // share-link toggle sets meta.shared. Read the raw registry, NOT
      // meta() — auto-creating an entry per probed id would pollute dw.json.
      if (!loadReg(ctx).sessions[id]?.shared) { json(res, 404, { error: "not_shared" }); return true; }

      // Enforce the visitor permission tier server-side — the UI caps alone
      // are cosmetic; anyone with the share URL can call these directly.
      // readonly: no writes. chat/basic: message yes, upload no (canUpload is
      // detailed-only in capsFor). detailed/full: everything.
      if (m === "POST") {
        const perm = meta(ctx, id).permission ?? "detailed";
        const writeSub = sub === "message" || sub === "upload" || sub === "upload-stage";
        if ((perm === "readonly" && writeSub) || (perm !== "detailed" && perm !== "full" && sub.startsWith("upload"))) {
          json(res, 403, { error: `visitor permission "${perm}" forbids ${sub}` });
          return true;
        }
      }

      const sharedH = sessionSubs[`${sub}:${m}`];
      if (sharedH) { await sharedH(ctx, id, req, res, url); return true; }

      if (sub === "meta" && m === "GET") {
        const mm = meta(ctx, id);
        json(res, 200, {
          title: mm.title ?? titleFromLog(ctx, id) ?? "Devin session",
          permission: mm.permission ?? "detailed",
          status: sessionStatus(ctx, id).status,
          pull_request: null, pull_requests: [],
        });
        return true;
      }
      if (sub === "timeline" && m === "GET") {
        void ensureLoaded(ctx, id);
        const loading = loadInflight.has(id);
        const { items: live, gen } = buildTimeline(ctx, id);
        const snap = (loading || !live.length) ? snapshotItems(ctx, id) : null;
        const serveSnap = !!(loading && snap);
        const all = serveSnap ? snap : live;
        const reset = !serveSnap && tlReset.delete(id);
        const items = (loading && !snap ? [] : all.slice(-300)).map((it) =>
          it.attachments?.some((a) => a.url.startsWith("/api/admin/"))
            ? { ...it, attachments: it.attachments.filter((a) => !a.url.startsWith("/api/admin/")) }
            : it,
        );
        json(res, 200, { items, next_cursor: null, error: null, queue: queueList(id), reset: reset || undefined, gen: serveSnap ? 0 : gen, activity: loading ? { text: "Loading history…" } : null });
        return true;
      }
      if (sub === "messages" && m === "GET") {
        void ensureLoaded(ctx, id);
        json(res, 200, { messages: buildMessages(buildTimeline(ctx, id).items) });
        return true;
      }
      if (sub === "todos" && m === "GET") {
        json(res, 200, { todos: [] });
        return true;
      }
      if (sub === "changes" && m === "GET") {
        json(res, 200, { files: [], truncated: false, error: null });
        return true;
      }
      if ((sub === "screenshot" || sub === "attachment" || sub === "file" || sub === "terminal") && m === "GET") {
        json(res, 404, { error: "no cloud media locally" });
        return true;
      }
      json(res, 200, UNSUPPORTED);
      return true;
  return false;
}
