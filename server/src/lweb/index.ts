/**
 * lweb — web-frontend compatibility layer.
 *
 * devin-web's frontend speaks the Cloudflare Worker/D1 API of
 * devin2.zalize.com. This shell owns the route-family dispatch: flag
 * parsing, the admin auth seam, the SSH host resolver, and the three
 * prologue routes (media, session-dashboard writes, devin-coach) — then
 * hands /api/admin/* to ./admin.ts and /api/share/* to ./share.ts.
 * Shared session machinery lives in ./session.ts, HTTP utils in
 * ./common.ts.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiContext } from "../routes.js";
import { loadReg, saveReg } from "../dwstore.js";
import { setSshHostResolver } from "../ssh.js";
import { requireAdmin } from "../authn.js";
import { json, readJson } from "../httputil.js";
import { handleAdminTree } from "./admin.js";
import { handleShareTree } from "./share.js";

export async function handleLocalWb(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const m = req.method ?? "GET";
  const p = url.pathname;
  const parts = p.split("/").filter(Boolean);

  const isAdmin = parts[1] === "admin";
  const isShare = parts[1] === "share";
  const isMedia = parts[1] === "media";
  if (!isAdmin && !isShare && !isMedia && !(p.startsWith("/api/session/") || p.startsWith("/api/devin-coach"))) return false;

  // Auth seam — DEVIN_WEB_ADMIN_KEY unset → open local mode (today's
  // behavior); set → /api/admin/* requires the x-admin-key header the
  // frontend already sends. Share/media paths keep their own tokens.
  if (isAdmin && !requireAdmin(req)) { json(res, 401, { error: "unauthorized" }); return true; }

  // SSH auth registry — acp/terminal/ws-term resolve credentials for a target
  // through ssh.ts; the resolver always reads the current dw.json prefs.
  setSshHostResolver(() => loadReg(ctx).prefs?.sshHosts ?? []);

  try {
    // ---- share-side media is cloud-only; nothing stored remotely ----
    if (isMedia) {
      json(res, 404, { error: "no cloud media locally" });
      return true;
    }

    // POST /api/session/:id/dashboard — dashboard writes (widget storage).
    // Outside /api/admin/* the auth seam doesn't reach it — but this writes
    // dw.json, so with the admin key set it needs it too.
    if (parts[1] === "session" && parts[3] === "dashboard" && m === "POST") {
      if (!requireAdmin(req)) { json(res, 401, { error: "unauthorized" }); return true; }
      const body = await readJson(req);
      loadReg(ctx).dashboards[decodeURIComponent(parts[2])] = body;
      saveReg();
      json(res, 200, { ok: true });
      return true;
    }

    // POST /api/devin-coach/precheck — cloud-only coach
    if (parts[1] === "devin-coach") {
      json(res, 200, { findings: [] });
      return true;
    }

    if (isAdmin) return await handleAdminTree(ctx, req, res, url);
    if (isShare && parts.length >= 3) return await handleShareTree(ctx, req, res, url);

    return false;
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    // 5xx here surfaces to the client as a fetch failure ("Connection lost") —
    // log it so transient handler errors are distinguishable from a real
    // restart dead-window in server.log.
    if (status >= 500) console.error(`[route] ${req.method} ${req.url} → ${status}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    json(res, status, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }
}
