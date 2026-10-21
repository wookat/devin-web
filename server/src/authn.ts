// authn.ts — the request-authentication seam.
//
// local edition ships a single fixed principal: no users, no scopes. The
// seam is that every admin request resolves through requireAdmin() — when
// DEVIN_WEB_ADMIN_KEY is set the existing `x-admin-key` channel (frontend
// localStorage `dw_admin_key`, already sent by api.ts) becomes a real gate;
// unset keeps today's open-local behavior. Team/school/enterprise editions
// replace this one function — SSO token, roster lookup, whatever — and the
// rest of the server never notices.

import type { IncomingMessage } from "node:http";
import { featureEnabled } from "./edition.js";

export interface Principal { id: string; name: string; }

export const LOCAL_USER: Principal = { id: "local", name: "本地用户" };

/** The principal behind this request. One implementation today; the hook
 * exists so identity resolution never spreads into route code. */
export function currentUser(_req: IncomingMessage): Principal {
  return LOCAL_USER;
}

const ADMIN_KEY = process.env.DEVIN_WEB_ADMIN_KEY ?? "";

/** /api/admin/* gate. Returns the principal, or null → respond 401. */
export function requireAdmin(req: IncomingMessage): Principal | null {
  if (!ADMIN_KEY || !featureEnabled("adminKey")) return LOCAL_USER;
  return req.headers["x-admin-key"] === ADMIN_KEY ? LOCAL_USER : null;
}
