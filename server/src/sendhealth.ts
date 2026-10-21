/**
 * sendhealth — the send-error journal.
 *
 * Every failed send is recorded per-session WITH the pipeline stage that
 * produced it, so the settings panel can answer "which hop broke" instead
 * of surfacing a bare error string. Persisted to send-errors.json
 * (write-through via persistJson) — diagnose keeps its evidence across
 * restarts. Pure storage: sendPreflight (a consumer of sessionio state)
 * stays downstream and reads lastSendError from here.
 */
import fs from "node:fs";
import path from "node:path";
import { persistJson } from "./sessioncfg.js";

export interface SendError { ts: number; stage: string; message: string }
export interface SendCheckStep { id: string; level: "ok" | "warn" | "fail"; detail: string }

const sendErrors = new Map<string, SendError>();

export function noteSendError(id: string, stage: string, err: unknown) {
  sendErrors.set(id, { ts: Date.now(), stage, message: err instanceof Error ? err.message : String(err) });
  while (sendErrors.size > 200) sendErrors.delete(sendErrors.keys().next().value!);
  persistJson("send-errors.json", Object.fromEntries(sendErrors));
}

export function lastSendError(id: string): SendError | null { return sendErrors.get(id) ?? null; }

export function recentSendErrors(): (SendError & { sessionId: string })[] {
  return [...sendErrors.entries()].map(([sessionId, e]) => ({ sessionId, ...e })).slice(-20);
}

/** Restore send-errors.json — sessionio calls this from its boot hook. */
export function restoreSendErrors(dir: string) {
  try {
    const e = JSON.parse(fs.readFileSync(path.join(dir, "send-errors.json"), "utf8")) as Record<string, SendError>;
    for (const [sid, se] of Object.entries(e)) if (se && typeof se.ts === "number") sendErrors.set(sid, se);
  } catch { /* cold start */ }
}
