/**
 * env.mjs — single owner of DEVIN_WEB_* env resolution for the standalone
 * scripts (supervisor / watchdog / acp-broker), which run outside the
 * compiled dist/server bundle and therefore cannot import server/src/env.ts.
 * Keep the resolution rules identical to server/src/env.ts.
 */
import os from "node:os";
import path from "node:path";

/** Data directory: DEVIN_WEB_DATA_DIR wins (the supervisor injects it into
 * backend + broker), then DEVIN_WEB_HOME, then ~/.devin-web. */
export function dataDir() {
  return (
    process.env.DEVIN_WEB_DATA_DIR ||
    process.env.DEVIN_WEB_HOME ||
    path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), ".devin-web")
  );
}

export function pubPort() {
  return Number(process.env.DEVIN_WEB_PUBLIC_PORT) || 7791;
}

export function backPort() {
  return Number(process.env.DEVIN_WEB_BACKEND_PORT) || 7792;
}

export function adminKey() {
  return process.env.DEVIN_WEB_ADMIN_KEY || "";
}

export function allowedHostsRaw() {
  return process.env.DEVIN_WEB_ALLOWED_HOSTS ?? "";
}
