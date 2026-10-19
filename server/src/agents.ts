// Registry of ACP-capable agent CLIs the console can drive.

export interface AgentDef {
  id: "devin" | "prime";
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
}

export const AGENTS: Record<string, AgentDef> = {
  devin: {
    id: "devin",
    label: "Devin",
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

export function agentById(id: unknown): AgentDef {
  return AGENTS[String(id ?? "devin")] ?? DEFAULT_AGENT;
}
