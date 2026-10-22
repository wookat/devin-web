// Shared event types between the devin-web server and its web client.
// Keep in sync with web/src/types.ts.

export interface WsServerEvent {
  type:
    | "session_update"
    | "timeline_delta"
    | "permission_request"
    | "permission_resolved"
    | "terminal_output"
    | "terminal_exit"
    | "agent_log"
    | "process_status"
    | "prompt_done"
    | "account_limited"
    | "account_rotated"
    | "session_status"
    | "persona_state"
    | "config";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface UsageRecord {
  ts: number;
  sessionId: string;
  cwd: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  model?: string;
}

export interface AgentSessionRecord {
  agent: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
}

export interface StoreShape {
  aliases: Record<string, string>;
  workspaces: string[];
  usage: UsageRecord[];
  /** Sessions of single-session agents (Prime) — the agent CLI cannot list them. */
  agentSessions: Record<string, AgentSessionRecord>;
  settings: {
    theme: "dark" | "light" | "system";
    soundComplete: boolean;
    soundNotify: boolean;
    desktopNotify: boolean;
    defaultModel?: string;
    defaultMode?: string;
  };
}
