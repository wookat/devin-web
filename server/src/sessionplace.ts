/**
 * sessionplace — session placement state: which acp process hosts what.
 *
 * loadedOn:    acp → sessions already `session/load`ed on it (dies with
 *              the process; rebuilt by broker adoption via session/list).
 * sessionHost: sessionId → the acp process that has it loaded. Once open,
 *              a session is LOCKED to that process — later ops must reuse
 *              this host even if sessionCwd gets rewritten by session/list
 *              (otherwise the other pooled acp tries to load and devin
 *              reports session_locked).
 * loadEpoch:   sessionId → when its acp-side subagent registry was last
 *              emptied (every successful session/load resets it).
 * loadInflight: sessionId → in-flight replay + the acp ACTUALLY performing
 *              it. Opening a page fires several endpoints at once; without
 *              dedup EACH started its own session/load.
 *
 * Pure placement state — a leaf module. Consumers (ensureLoaded, adopt,
 * dispatch, routes) stay downstream; dwtimeline also reads sessionHost
 * which previously forced a dwtimeline→sessionio cycle.
 */
import type { DevinAcp } from "./acp.js";

export const loadedOn = new WeakMap<object, Set<string>>();
export const sessionHost = new Map<string, DevinAcp>();
export const loadEpoch = new Map<string, number>();
export const loadInflight = new Map<string, { acp: DevinAcp; p: Promise<void> }>();

/** The acp holding the session's lock is still alive. */
export function isSessionPinned(id: string): boolean {
  const host = sessionHost.get(id);
  return !!host && !host.exited;
}

/** Mark `id` as open on `host` — the ONE placement write path. Both indexes
 * must always move together (loadedOn ⊃ sessionHost's targets): a site that
 * sets one without the other breaks ensureLoaded's pin lookup or lets ops
 * bounce to the wrong pooled acp. Never mark an acp that merely JOINED
 * another process's load. */
export function markLoadedOn(id: string, host: DevinAcp): DevinAcp {
  let s = loadedOn.get(host);
  if (!s) loadedOn.set(host, (s = new Set()));
  s.add(id);
  sessionHost.set(id, host);
  return host;
}

/** acp → sessions created (not loaded) on it and never yet persisted.
 * devin ≥3000.11.216 keeps `session/new` results in-memory until the first
 * prompt — `session/load` on them errors "Session not found" and a host
 * restart loses them entirely. Ops on such sessions must skip load and go
 * straight to the creating process (markMemOnly also pins the host). */
export const memOnly = new WeakMap<object, Set<string>>();

export function markMemOnly(id: string, host: DevinAcp): DevinAcp {
  markLoadedOn(id, host);
  let s = memOnly.get(host);
  if (!s) memOnly.set(host, (s = new Set()));
  s.add(id);
  return host;
}
