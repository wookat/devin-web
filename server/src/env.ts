/**
 * env — the single owner of every DEVIN_WEB_* environment read in the
 * backend. Accessors are functions (lazy) so semantics match the previous
 * inline reads, whether they were module-level consts or per-call lookups.
 *
 * The standalone scripts (supervisor/broker/watchdog) cannot import this
 * module — they live outside the compiled bundle and share scripts/env.mjs
 * instead. Keep the two files' resolution rules identical.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Data directory — DEVIN_WEB_DATA_DIR (injected by the supervisor into the
 * backend and the broker) wins, then DEVIN_WEB_HOME, then the profile
 * directory. The HOME||USERPROFILE inner fallback covers stripped-down
 * Windows shells where os.homedir() could disagree with the account
 * profile; os.homedir() is the final safety net. */
export function dataDir(): string {
  return (
    process.env.DEVIN_WEB_DATA_DIR ||
    process.env.DEVIN_WEB_HOME ||
    path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), ".devin-web")
  );
}

/** Admin API key — empty string when unset (open local mode). */
export function adminKey(): string {
  return process.env.DEVIN_WEB_ADMIN_KEY ?? "";
}

/** True when running under scripts/supervisor.mjs. */
export function isSupervised(): boolean {
  return process.env.DEVIN_WEB_SUPERVISED === "1";
}

/** Opt-out of the detached-supervisor handoff on bare dev runs. */
export function noSupervisor(): boolean {
  return !!process.env.DEVIN_WEB_NO_SUPERVISOR;
}

/** Opt-out of the boot-time auto-resume of interrupted turns. */
export function noAutoResume(): boolean {
  return !!process.env.DEVIN_WEB_NO_AUTORESUME;
}

/** Max .jsonl mirror size before rotation; NaN (falsy) when unset. */
export function logMaxMb(): number {
  return Number(process.env.DEVIN_WEB_LOG_MAX_MB);
}

/** Turn-silence budget for a live prompt before the watchdog declares it
 * wedged (default 15 min). */
export function turnSilenceMs(): number {
  return Number(process.env.DEVIN_WEB_TURN_SILENCE_MS ?? 15 * 60_000);
}

/** Raw comma-separated extra allowed hostnames ("" when unset). */
export function allowedHostsRaw(): string {
  return process.env.DEVIN_WEB_ALLOWED_HOSTS ?? "";
}

/** Broker endpoint (named pipe on Windows, unix socket elsewhere) —
 * empty string means direct (unbrokered) acp mode. */
export function acpBrokerSock(): string {
  return process.env.DEVIN_WEB_ACP_BROKER || "";
}

/** Opt-IN to injecting the dashboard MCP server into new sessions
 *  (DEVIN_WEB_DASHBOARD_MCP=1). Default off: the file convention
 *  (<cwd>/.devin-web-dashboard.json) covers the same writes with zero
 *  resident-process cost, and this build's acp hasn't been proven to
 *  actually spawn injected mcpServers. */
export function dashboardMcpOn(): boolean {
  return !!process.env.DEVIN_WEB_DASHBOARD_MCP;
}

/** Optional upstream translate endpoint (DEVIN_WEB_TRANSLATE_URL) — when
 *  set, /api/admin/mirror/translate proxies to it with the devin account
 *  Bearer token (same contract as the transcribe-audio proxy: POST
 *  {text,target} → {result|text|translation}). */
export function translateUrl(): string {
  return process.env.DEVIN_WEB_TRANSLATE_URL || "";
}

/** Devin web session token (auth1_…) — DEVIN_WEB_DEVIN_TOKEN wins, then
 *  <dataDir>/devin-web.token (one line, written once from the logged-in
 *  browser's auth1_session). Feeds the official /api/chat translate
 *  provider; empty when unconfigured. */
export function devinToken(): string {
  const env = process.env.DEVIN_WEB_DEVIN_TOKEN;
  if (env) return env.trim();
  try {
    return fs.readFileSync(path.join(dataDir(), "devin-web.token"), "utf8").trim();
  } catch {
    return "";
  }
}

/** Devin org id for x-cog-org-id — DEVIN_WEB_DEVIN_ORG wins, then
 *  <dataDir>/devin-web.org. Required by every /api/* call for auth1
 *  sessions ("No organizations found" without it), so auto-discovery is
 *  only a fallback for token types that don't need org context. */
export function devinOrg(): string {
  const env = process.env.DEVIN_WEB_DEVIN_ORG;
  if (env) return env.trim();
  try {
    return fs.readFileSync(path.join(dataDir(), "devin-web.org"), "utf8").trim();
  } catch {
    return "";
  }
}

/** Devin web api base (DEVIN_WEB_DEVIN_API) — defaults to the official
 *  webapp host; overridable for staging/enterprise. */
export function devinApiBase(): string {
  return (process.env.DEVIN_WEB_DEVIN_API || "https://app.devin.ai/api").replace(/\/+$/, "");
}
