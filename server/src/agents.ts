// Registry of ACP-capable agent CLIs the console can drive.
//
// Two layers:
//  - BUILTIN: agents shipped with devin-web (devin, prime).
//  - USER:    <dataDir>/agents.json — a user-editable list that can add any
//             ACP CLI (opencode, glm-agent, ...) or override a builtin.
//
// agents.json shape:
//   { "agents": [ { "id", "label", "command", "args": [], "multiSession": bool,
//                   "versionArgs": [], "env": {}, "enabled": bool } ] }
// The file is re-read when its mtime changes — edits take effect without a
// server restart (new spawns pick them up; running processes are untouched).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export interface AgentDef {
  id: string;
  label: string;
  command: string;
  args: string[];
  /**
   * Whether one process hosts many sessions (Devin) or exactly one
   * (Prime Agent refuses a second session/new and has no session/list
   * or session/load, so its sessions cannot be pooled or replayed).
   */
  multiSession: boolean;
  /** CLI args that print a version, for the install check in /api/meta. */
  versionArgs: string[];
  /** Extra env merged into the child process (agent-specific auth etc.). */
  env?: Record<string, string>;
  /**
   * Spawn through %ComSpec% — Windows npm CLIs are .cmd/.ps1 shims, which
   * Node ≥20.12 refuses to spawn directly (EINVAL). devin.exe needs no shell;
   * opencode/glm-agent (npm shims) do.
   */
  shell?: boolean;
  /** True for entries sourced from agents.json (not shipped defaults). */
  custom?: boolean;
  /** Hidden from pickers; existing sessions on it keep running. */
  disabled?: boolean;
}

export const AGENTS: Record<string, AgentDef> = {
  devin: {
    id: "devin",
    label: "Devin Local",
    command: "devin",
    args: ["acp"],
    multiSession: true,
    versionArgs: ["version"],
  },
  prime: {
    id: "prime",
    label: "Prime",
    command: "prime-agent",
    args: ["--mode", "acp"],
    multiSession: false,
    versionArgs: ["--version"],
  },
};

export const DEFAULT_AGENT = AGENTS.devin;

/** Whole command as one string for `spawn(line, { shell: true })` — quoting
 *  each word ourselves avoids DEP0190 (args array + shell concatenates raw). */
export function agentCommandLine(def: AgentDef, args: string[] = def.args): string {
  const q = (a: string) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  return [def.command, ...args].map(q).join(" ");
}

let agentsDir = path.join(os.homedir(), ".devin-web");

/** Called once at boot with the real data dir (DEVIN_WEB_HOME-aware). */
export function setAgentsDir(dir: string) {
  agentsDir = dir;
  userCache = null;
}

function agentsFile(): string {
  return path.join(agentsDir, "agents.json");
}

let userCache: { mtime: number; list: AgentDef[] } | null = null;

function parseUserList(raw: unknown): AgentDef[] {
  const arr = (raw as { agents?: unknown[] })?.agents;
  if (!Array.isArray(arr)) return [];
  const out: AgentDef[] = [];
  for (const a of arr) {
    const r = a as Partial<AgentDef> & { enabled?: boolean };
    if (!r || typeof r.id !== "string" || !r.id || typeof r.command !== "string" || !r.command) continue;
    out.push({
      id: r.id,
      label: typeof r.label === "string" && r.label ? r.label : r.id,
      command: r.command,
      args: Array.isArray(r.args) ? r.args.map(String) : [],
      multiSession: r.multiSession === true,
      versionArgs: Array.isArray(r.versionArgs) ? r.versionArgs.map(String) : ["--version"],
      env: r.env && typeof r.env === "object" ? (r.env as Record<string, string>) : undefined,
      shell: r.shell === true,
      custom: true,
      disabled: r.enabled === false,
    });
  }
  return out;
}

/** User-defined agents from <dataDir>/agents.json (mtime-cached). */
export function userAgents(): AgentDef[] {
  let mtime = 0;
  try {
    mtime = fs.statSync(agentsFile()).mtimeMs;
  } catch {
    userCache = null;
    return [];
  }
  if (userCache && userCache.mtime === mtime) return userCache.list;
  let list: AgentDef[] = [];
  try {
    list = parseUserList(JSON.parse(fs.readFileSync(agentsFile(), "utf8")));
  } catch {
    list = [];
  }
  userCache = { mtime, list };
  return list;
}

/** Full effective registry: builtins overridden/extended by user entries. */
export function listAgents(): AgentDef[] {
  const out = new Map<string, AgentDef>(Object.values(AGENTS).map((a) => [a.id, a]));
  for (const a of userAgents()) out.set(a.id, a);
  return [...out.values()];
}

export function agentById(id: unknown): AgentDef {
  const key = String(id ?? "devin");
  return listAgents().find((a) => a.id === key) ?? DEFAULT_AGENT;
}

/** Persist the user layer (validates + normalizes). */
export function saveUserAgents(list: unknown[]): { ok: boolean; count: number } {
  const parsed = parseUserList({ agents: list });
  fs.mkdirSync(agentsDir, { recursive: true });
  const payload = {
    agents: parsed.map(({ custom: _c, disabled, ...rest }) => ({ ...rest, enabled: !disabled })),
  };
  fs.writeFileSync(agentsFile(), JSON.stringify(payload, null, 2));
  userCache = null;
  return { ok: true, count: parsed.length };
}

const probeCache = new Map<string, { at: number; ok: boolean; detail: string }>();

/** Spawn `versionArgs` with a short timeout — the install check. */
export async function probeAgent(def: AgentDef): Promise<{ ok: boolean; detail: string }> {
  const hit = probeCache.get(def.id);
  if (hit && Date.now() - hit.at < 60_000) return { ok: hit.ok, detail: hit.detail };
  const res = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
    let proc;
    try {
      proc = def.shell
        ? spawn(agentCommandLine(def, def.versionArgs), { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], shell: true })
        : spawn(def.command, def.versionArgs, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ ok: false, detail: String((e as Error).message ?? e) });
    }
    let out = "";
    const done = (ok: boolean, detail: string) => {
      clearTimeout(timer);
      probeCache.set(def.id, { at: Date.now(), ok, detail });
      resolve({ ok, detail });
    };
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* noop */ }
      done(false, "probe timed out");
    }, 8000);
    proc.stdout?.on("data", (d) => { out += String(d).slice(0, 200); });
    proc.stderr?.on("data", (d) => { if (out.length < 200) out += String(d).slice(0, 200); });
    proc.on("error", (e) => done(false, e.message));
    proc.on("exit", (code) => done(code === 0 || out.length > 0, out.trim() || `exit ${code}`));
  });
  return res;
}
