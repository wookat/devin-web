/**
 * sessionlive — volatile liveness state: what is alive RIGHT NOW.
 *
 * Everything here is deliberately ephemeral — none of it should survive a
 * restart (unlike the journals in sessionturns/queue/health/cfg):
 *
 *  inflight       sessions with a prompt currently in flight (composer state)
 *  adoptedTurns   adopted turns still streaming on a broker-held acp
 *  lastActivity   sessionId → last streamed update ts (silence settle clock)
 *  draining       restart gate — no new prompts once a deploy begins
 *  gracefulExit   deliberate-restart flag — settle paths must NOT clear
 *                 open-turns (auto-resume replays them on the next backend)
 *
 * markGracefulExit also journals broker stream offsets — restart liveness
 * is this module's domain, and acpbroker is a downward import (leaf-safe).
 */
import type { ApiContext } from "./routes.js";
import { brokerEnabled, writeOffsets } from "./acpbroker.js";

export const inflight = new Set<string>();
export const adoptedTurns = new Set<string>();
export const lastActivity = new Map<string, number>();
export function touchSessionActivity(id: string) { lastActivity.set(id, Date.now()); }

/** Set once a redeploy/restart enters its drain phase — after that, NO new
 * prompts may be dispatched. Without this gate a send (or an auto-resume)
 * landing mid-drain re-adds to `inflight` and the drain can be starved
 * forever. Send-paths return 503; internal dispatchers just no-op. */
let draining = false;
let drainStartedAt = 0;
export function beginDrain() { if (!draining) drainStartedAt = Date.now(); draining = true; }
export function isDraining() { return draining; }
export function drainSince() { return draining ? drainStartedAt : 0; }

/** Deliberate restart marker: settles caused by an acp killAll must NOT
 * clear open-turns — the entries are what auto-resume replays on the next
 * backend. Crash paths never set this (they die before settling). */
let gracefulExit = false;
export function isGracefulExit() { return gracefulExit; }
export function markGracefulExit(ctx?: ApiContext) {
  gracefulExit = true;
  // Broker mode: snapshot each acp's consumed-byte offset so the next backend
  // re-attaches at the exact stream position — its ring replay then covers
  // only the death-gap frames (no duplicates, no skipped chunks).
  if (ctx && brokerEnabled) {
    const m: Record<string, number> = {};
    for (const a of ctx.manager.allAcps()) {
      if (a.brokerId) m[a.brokerId] = a.bytesReceived;
    }
    writeOffsets(ctx.store.dataDir, m);
  }
}
