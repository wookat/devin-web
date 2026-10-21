/**
 * sessioncfg — live session config caches + the durable-state seam.
 *
 * Owns: the configOptions/modes/commands captured from session/new·load
 * responses (agent-level fallback + per-session picks), the lock-retry
 * helper for session/load, and persistJson — the one write-through
 * primitive all of the session family's durable files (agent-cfg.json, queues.json,
 * send-errors.json, open-turns.json) share. Extracted from sessionio.ts;
 * behavior unchanged.
 */
import fs from "node:fs";
import path from "node:path";

export interface ConfigOption { id?: string; name?: string; currentValue?: string; options?: { value: string; name?: string; description?: string }[] }
export interface SessionConfig {
  options: ConfigOption[];
  mode: string | null;
  commands: { name: string; description?: string; input?: { hint?: string } }[];
  model: { id: string; current: string; currentName: string; options: { value: string; name?: string; efforts?: string[]; effortCtl?: boolean; family?: string; fast?: boolean; ctx1m?: boolean; prices?: { input?: number; cached?: number; output?: number } }[] } | null;
}

interface ResponseCfgEntry {
  configOptions?: ConfigOption[] | null;
  modes?: { currentModeId: string; availableModes?: { id: string; name?: string }[] } | null;
  commands?: { name: string; description?: string; input?: { hint?: string } }[] | null;
  /** Time of the most recent authoritative echo (load or setConfigOption).
   * Logged config_option_update notifications older than this are stale. */
  echoTs?: number;
}

/** sessionId → config returned in the session/new / session/load RESPONSE
 * (modes + configOptions). Devin emits these in the response, not always as
 * streamed notifications, so capture them here and merge into sessionConfig. */
export const responseCfg = new Map<string, ResponseCfgEntry>();

/** Last non-empty config seen from ANY session — model/mode option lists are
 * agent-level capabilities (identical for every session on the same CLI), so
 * old sessions whose loadSession response omits config can still show them. */
export let lastAgentCfg: {
  configOptions?: ConfigOption[];
  modes?: { currentModeId: string; availableModes?: { id: string; name?: string }[] };
} | null = null;

/** Last non-empty slash-command list seen from ANY session — the set is
 * agent-level (same CLI binary advertises the same commands), so a session
 * whose replay hasn't reached its commands_update yet still gets the list. */
export let lastAgentCommands: SessionConfig["commands"] | null = null;
export function setLastAgentCommands(v: SessionConfig["commands"]) { lastAgentCommands = v; }

/** Persisted runtime state — ONE seam restores every piece of memory a
 *  restart used to silently drop. Broker adoption deliberately skips
 *  session/load (the only writer of the cfg caches), and a transparent
 *  restart must not eat user data (message queue) or diagnostics
 *  (sendErrors). All durable files live in stateDir and write through on
 *  mutation; sessionload calls this BEFORE adoption/auto-resume. */
let stateDir = "";

/** Restore the config caches from agent-cfg.json (agent-level + bySession).
 *  Called by sessionload's restore hook — it owns the queue/error files. */
export function initCfgState(dir: string) {
  stateDir = dir;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, "agent-cfg.json"), "utf8")) as {
      configOptions?: ConfigOption[];
      modes?: { currentModeId: string; availableModes?: { id: string; name?: string }[] };
      commands?: SessionConfig["commands"];
      bySession?: Record<string, ResponseCfgEntry>;
    };
    if (j.configOptions?.length || j.modes) {
      lastAgentCfg = {
        ...(j.configOptions?.length ? { configOptions: j.configOptions } : {}),
        ...(j.modes ? { modes: j.modes } : {}),
      };
    }
    if (j.commands?.length) lastAgentCommands = j.commands;
    for (const [sid, c] of Object.entries(j.bySession ?? {})) if (c && typeof c === "object") responseCfg.set(sid, c);
  } catch { /* cold start — no cache yet */ }
}

/** Write-through for every durable file under stateDir (no-op pre-init). */
export function persistJson(file: string, data: unknown) {
  if (!stateDir) return;
  try { fs.writeFileSync(path.join(stateDir, file), JSON.stringify(data)); } catch { /* best-effort */ }
}

function persistAgentCfg() {
  // Per-session entries ride the same file (LRU-capped) — a session's
  // currentValue picks (its model/mode) differ from agent defaults.
  const bySession = [...responseCfg.entries()].sort((a, b) => (b[1].echoTs ?? 0) - (a[1].echoTs ?? 0)).slice(0, 40);
  persistJson("agent-cfg.json", {
    ...(lastAgentCfg ?? {}),
    commands: lastAgentCommands ?? undefined,
    bySession: bySession.length ? Object.fromEntries(bySession) : undefined,
  });
}

export function captureLoadResponse(id: string, r: unknown) {
  if (!r || typeof r !== "object") return;
  const res = r as { configOptions?: ConfigOption[]; modes?: { currentModeId: string; availableModes?: { id: string; name?: string }[] }; availableCommands?: SessionConfig["commands"] };
  responseCfg.set(id, { configOptions: res.configOptions ?? undefined, modes: res.modes ?? undefined, commands: res.availableCommands ?? undefined, echoTs: Date.now() });
  if (res.availableCommands?.length) lastAgentCommands = res.availableCommands;
  if (res.configOptions?.length || res.modes) {
    lastAgentCfg = {
      ...(res.configOptions?.length ? { configOptions: res.configOptions } : {}),
      ...(res.modes ? { modes: res.modes } : {}),
    };
  }
  persistAgentCfg();
}

/** devin returns errorKind `session_locked` when a session is still open in a
 * dying/other acp process. It advertises `retryable: true` — retry briefly to
 * ride out the lock release, then give up. */
export function isSessionLocked(e: unknown): boolean {
  const s = String((e as Error)?.message ?? e);
  return /already open in another process|session_locked/i.test(s);
}

export async function loadWithRetry(acp: { loadSession(id: string, cwd: string): Promise<unknown> }, id: string, cwd: string, tries = 5): Promise<unknown> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await acp.loadSession(id, cwd);
    } catch (e) {
      lastErr = e;
      if (!isSessionLocked(e) || i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}
