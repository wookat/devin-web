/**
 * Cloud REST read layer — the devin webapp's own `app.devin.ai/api/*` calls
 * (auth1 session token + x-cog-org-id, same headers translate.ts uses).
 * Read-only surface: the local app's W1/W2 features live on the acp channel;
 * everything here is what only the cloud can answer (billing, org settings,
 * members, notification prefs, automation schemas). fetch() honors the
 * supervisor-injected NODE_USE_ENV_PROXY — direct CN egress 403s on this API.
 */
import { devinApiBase, devinOrg, devinToken } from "./env.js";

export function cloudCreds(): { token: string; org: string } | null {
  const token = devinToken(), org = devinOrg();
  return token && org ? { token, org } : null;
}

export async function cloudGet(path: string, timeoutMs = 12_000): Promise<{ status: number; body: unknown }> {
  const creds = cloudCreds();
  if (!creds) return { status: 0, body: { error: "no devin token/org (devin-web.token / devin-web.org unset)" } };
  try {
    const r = await fetch(`${devinApiBase()}/${path.replace(/^\/+/, "")}`, {
      headers: { authorization: `Bearer ${creds.token}`, "x-cog-org-id": creds.org },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await r.json().catch(() => null);
    return { status: r.status, body };
  } catch (e) {
    return { status: -1, body: { error: (e as Error).message ?? "request failed" } };
  }
}

/** Read endpoints verified live 2026-11-02 (all 200 w/ real data on this
 *  install). The generic /cloud/proxy route is restricted to this list —
 *  it's an auth1-token-bearing surface, not an open relay. */
export const CLOUD_READ_PATHS = new Set([
  "organizations", "billing/subscription", "billing/invoices",
  "account/commit-email", "account/pr-open-as", "account/devin-pr-merge",
  "users/notification-preferences", "automations/schemas",
]);
/** Prefix-allowed read paths (dynamic segments — org id, devin_id, query). */
export const CLOUD_READ_PREFIXES = ["knowledge-suggestions/", "knowledge/"];
export function cloudReadAllowed(path: string): boolean {
  const clean = path.replace(/^\/+/, "");
  return CLOUD_READ_PATHS.has(clean) || CLOUD_READ_PREFIXES.some((pre) => clean.startsWith(pre));
}
export function cloudOrgPath(tail: string): string | null {
  const creds = cloudCreds(); if (!creds) return null;
  const ok = new Set(["", "settings", "members", "session-tags", "slash-commands", "managed-plugins", "account-managed-plugins"]);
  return ok.has(tail) ? `organizations/${creds.org}${tail ? "/" + tail : ""}` : null;
}
