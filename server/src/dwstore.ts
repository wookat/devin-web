/**
 * dwstore — dw.json registry: per-session overrides + folder order + dashboards.
 * Extracted from localweb.ts (mechanical move, behavior unchanged).
 */
import fs from "node:fs";
import path from "node:path";
import type { ApiContext } from "./routes.js";

// ---------------------------------------------------------------------------
// registry (dw.json): per-session overrides + folder order + dashboards
// ---------------------------------------------------------------------------

interface DwSessionMeta {
  title?: string;
  folder?: string | null;
  pinned?: boolean;
  archived?: boolean;
  permission?: string;
  /** last real updatedAt seen from session/list — survives restarts so the
   * sidebar never has to fall back to "now". */
  updatedAt?: string;
  // persona 分身: per-session mode override ('off'|'semi'|'auto'), the
  // escalation flag (amber banner) and the last handled question seq.
  personaMode?: string;
  personaEscalated?: boolean;
  personaLastSeq?: number;
  /** Which ACP agent owns this session (devin | prime | user-registered ids).
   *  Absent = devin. Read by hostFor to route ops to the right process. */
  agent?: string;
  /** SSH target (user@host) when this session's agent runs on a remote host —
   *  the cwd in sessionCwd is then a REMOTE path. Persisted so restarts keep
   *  routing through ssh. */
  ssh?: string;
  /** Local share-link opt-in: /api/share/<id>/* answers only while set.
   *  Without the flag every session id is an ambient capability URL — ids
   *  are enumerable via /ws and the sessions list. Toggled by the admin
   *  share-link endpoint. */
  shared?: boolean;
  /** Per-session config picks (model/mode/effort) the user set through the
   *  web UI — devin's own configOptions echo does NOT persist model across
   *  session/load, so without this overlay a refresh reverts the picker to
   *  the agent default ("high"). Overlay wins over the echoed cfg. */
  lastConfig?: Record<string, string>;
  /** Internal plumbing session (persona / PR-review / fork-writer / sidechat
   *  backends) — listLocalSessions drops it so machinery never surfaces in
   *  the sidebar as a normal session row. */
  hidden?: boolean;
  /** Local sidechat threads — the fallback for devin builds without the
   *  `_cognition.ai/sidechain` ext. Key is the client anchor id ("e<seq>" /
   *  "t<toolCallId>"), value is the dedicated devin session that hosts that
   *  thread's Q&A (all share one <dataDir>/sidechat pooled acp). */
  sidechats?: Record<string, string>;
  /** Anchors whose sidechat session already received the seeded anchor-
   *  context message — later sends go to that thread bare. */
  sidechatSeeded?: Record<string, boolean>;
  /** On a sidechat backend session: the parent session it answers for —
   *  lets lifecycle cleanup cascade archive/end to the thread sessions. */
  sidechatFor?: string;
}

interface DwRegistry {
  sessions: Record<string, DwSessionMeta>;
  folderOrder: string[];
  /** Manual session order per section — key is the folder name, "" for the
   *  unfiled "Recent" list, "_pinned" for the pinned section. A session's
   *  position = its index here; sessions absent from the list sort to the
   *  top by updated_at. Rebuilt wholesale on every positional drop. */
  sessionOrder?: Record<string, string[]>;
  dashboards: Record<string, unknown>;
  /** Last model/mode/effort/speed picked — applied to new sessions. */
  lastConfig?: Record<string, string>;
  /** Server-side web preferences — unlike browser localStorage these
   * act even with no tab open (auto-resume runs on boot). */
  prefs?: { autoResume?: boolean; persona?: { mode?: string; webhook?: string; maxPerHour?: number }; sshHosts?: { name?: string; target: string; cwd?: string; auth?: "agent" | "password" | "key"; password?: string; keyPath?: string; passphrase?: string }[] };
  /** The persistent persona acp session (cwd=<dataDir>/persona). */
  persona?: { sessionId?: string };
  /** The persistent pr-review acp session (cwd=<dataDir>/pr-review). */
  prReview?: { sessionId?: string };
  /** The persistent fork-handoff writer session — reads a source session's
   * transcript and produces the handoff summary used as the fork seed. */
  forkHandoff?: { sessionId?: string };
  /** Scheduled sessions — 5-field cron entries fired by the automations
   *  scheduler (server/src/automations.ts). */
  automations?: Record<string, DwAutomation>;
  /** Wiki home grid — public GitHub repos browsed via the DeepWiki MCP
   *  (server/src/wiki.ts). Key: "owner/repo" lowercase. */
  wikiRepos?: Record<string, DwWikiRepo>;
  /** Security surface — local code scans + scan profiles
   *  (server/src/security.ts). Field names mirror the official
   *  /code-scans API (repo_name, status, severity, stage, finding_id). */
  securityScans?: Record<string, DwSecurityScan>;
  securityProfiles?: Record<string, DwSecurityProfile>;
}

export interface DwSecurityProfile {
  id: string;
  name: string;
  prompt: string;
  created_at: number;
}

export interface DwSecurityFinding {
  finding_id: string;
  title: string;
  description: string;
  file_path: string | null;
  start_line: number | null;
  severity: "critical" | "high" | "medium" | "low" | "info";
  category: string | null;
  cwe_id: string | null;
  status: "open" | "resolved" | "ignored" | "false_positive";
  stage: "unassigned" | "triaged" | "fixing" | "resolved";
}

export interface DwSecurityScan {
  id: string;
  repo_name: string;
  cwd: string;
  scan_type: "security";
  status: "pending" | "running" | "done" | "failed" | "cancelled";
  effort: "lite" | "standard";
  profile_id: string | null;
  session_id: string | null;
  findings: DwSecurityFinding[];
  summary: string;
  created_at: number;
  finished_at?: number;
  archived?: boolean;
}

export interface DwWikiRepo {
  repo: string;
  pinned: boolean;
  addedAt: number;
  lastOpenedAt?: number;
  /** Last successful structure probe. */
  indexed?: boolean;
  topicCount?: number;
  topics?: { id: string; title: string; depth: number }[];
}

export interface DwAutomation {
  id: string;
  name: string;
  prompt: string;
  /** 5-field cron expression "min hour dom mon dow". */
  schedule: string;
  cwd: string;
  enabled: boolean;
  createdAt: number;
  lastRun?: number;
  lastSession?: string;
  nextRun?: number;
}

let reg: DwRegistry | null = null;
let regFile = "";

function loadReg(ctx: ApiContext): DwRegistry {
  if (reg) return reg;
  regFile = path.join(ctx.store.dataDir, "dw.json");
  try {
    reg = JSON.parse(fs.readFileSync(regFile, "utf8")) as DwRegistry;
  } catch {
    reg = { sessions: {}, folderOrder: [], dashboards: {} };
  }
  reg!.sessions ??= {};
  reg!.folderOrder ??= [];
  reg!.sessionOrder ??= {};
  reg!.dashboards ??= {};
  reg!.prefs ??= {};
  return reg!;
}

function saveReg() {
  try {
    fs.mkdirSync(path.dirname(regFile), { recursive: true });
    fs.writeFileSync(regFile, JSON.stringify(reg));
  } catch { /* best-effort */ }
}

function meta(ctx: ApiContext, id: string): DwSessionMeta {
  const r = loadReg(ctx);
  return (r.sessions[id] ??= {});
}


/** Last model/mode/effort/speed the user picked — applied to new sessions. */
function noteLastUsed(ctx: ApiContext, configId: string, value: string) {
  const r = loadReg(ctx);
  r.lastConfig = { ...(r.lastConfig ?? {}), [configId]: value };
  saveReg();
}

export { type DwSessionMeta, type DwRegistry, loadReg, saveReg, meta, noteLastUsed };
