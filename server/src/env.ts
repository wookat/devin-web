/**
 * env — the single owner of every DEVIN_WEB_* environment read in the
 * backend. Accessors are functions (lazy) so semantics match the previous
 * inline reads, whether they were module-level consts or per-call lookups.
 *
 * The standalone scripts (supervisor/broker/watchdog) cannot import this
 * module — they live outside the compiled bundle and share scripts/env.mjs
 * instead. Keep the two files' resolution rules identical.
 */
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

/** Opt-out of injecting the dashboard MCP server into new sessions. */
export function noDashboardMcp(): boolean {
  return !!process.env.DEVIN_WEB_NO_DASHBOARD_MCP;
}
