/**
 * sessionview — derived read-models over session state: the status pill
 * projection, the live-config view (config options / mode / commands /
 * model picker), the terminal echo buffer, and the session-listing +
 * snippet read-models the sidebar polls. Leaf module.
 */
import type { ApiContext } from "./routes.js";
import { dataDir } from "./env.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { catalogInfo } from "./modelcat.js";
import { remapLegacyCwd } from "./store.js";
import { loadReg, saveReg, meta } from "./dwstore.js";
import { responseCfg, lastAgentCfg, lastAgentCommands, setLastAgentCommands, type ConfigOption, type SessionConfig } from "./sessioncfg.js";
import { isSessionPinned } from "./sessionplace.js";
import { inflight } from "./sessionlive.js";

// ---------------------------------------------------------------------------
// live session config (config_option_update / mode / commands / terminal)
// ---------------------------------------------------------------------------

export function sessionConfig(ctx: ApiContext, id: string): SessionConfig {
  const out: SessionConfig = { options: [], mode: null, commands: [], model: null };
  // Base: config from this session's new|load response; fall back to the
  // agent-level config last seen (old sessions get no config on load).
  const base = responseCfg.get(id) ?? lastAgentCfg ?? undefined;
  const own = responseCfg.get(id);
  const echoTs = own?.echoTs ?? 0;
  if (base?.configOptions) out.options = base.configOptions;
  // Mode is per-session — only trust this session's own response/log, never the
  // agent-level fallback's currentModeId (that's another session's mode).
  if (own?.modes) out.mode = own.modes.currentModeId ?? null;
  // Overlay: latest streamed config updates win. Scan newest→oldest but only
  // take option ids a newer event hasn't already covered — otherwise the
  // oldest logged update (e.g. the load-time push) would clobber fresh
  // setSessionConfigOption echoes stored in responseCfg.
  const log = ctx.sessionLog.get(id);
  const cfgCovered = new Set<string>();
  for (let i = log.length - 1; i >= 0; i--) {
    const u = log[i].update as Record<string, unknown>;
    const k = u.sessionUpdate;
    if (k === "config_option_update") {
      if (log[i].ts < echoTs) continue; // predates the authoritative write echo
      const upd = (u.configOptions as ConfigOption[]) ?? [];
      // Merge by id — an update may carry only the changed option(s).
      const byId = new Map(out.options.map((o) => [String(o.id ?? ""), o]));
      for (const o of upd) {
        const oid = String(o.id ?? "");
        if (cfgCovered.has(oid)) continue;
        byId.set(oid, o);
        cfgCovered.add(oid);
      }
      out.options = [...byId.values()];
    } else if (k === "current_mode_update" && !out.mode) {
      out.mode = (u.currentModeId as string) ?? null;
    } else if (k === "available_commands_update" && !out.commands.length) {
      out.commands = (u.availableCommands as SessionConfig["commands"]) ?? [];
    }
  }
  // Commands are agent-level: remember the newest non-empty set, fall back to
  // it (or this session's own load-response copy) when the replay window
  // hasn't delivered a commands_update yet.
  if (out.commands.length) setLastAgentCommands(out.commands);
  else out.commands = (responseCfg.get(id)?.commands?.length ? responseCfg.get(id)!.commands! : lastAgentCommands ?? []);
  // Expose ACP modes as a synthetic `_mode` config group when the agent hasn't
  // already surfaced one itself.
  const hasModeOpt = out.options.some((o) => o.id === "mode" || /mode/i.test(String(o.id ?? "")));
  if (!hasModeOpt && base?.modes?.availableModes?.length) {
    out.options.push({
      id: "_mode",
      name: "Mode",
      currentValue: out.mode ?? "",
      options: base.modes.availableModes.map((m) => ({ value: m.id, name: m.name ?? m.id })),
    });
  }
  const modelOpt = out.options.find((o) => o.id === "model" || /model/i.test(String(o.id ?? "")));
  if (modelOpt) {
    const cur = String(modelOpt.currentValue ?? "");
    const name = modelOpt.options?.find((o) => o.value === cur)?.name ?? cur;
    out.model = {
      id: String(modelOpt.id ?? "model"),
      current: cur,
      currentName: name,
      options: (modelOpt.options ?? []).map((o) => {
        // Per-family data decoded from the local model catalog — ACP only
        // exposes global thought_level/speed groups; fast/ctx1m gate whether
        // the desktop-style flyout shows Speed / 1M Context sections.
        const info = catalogInfo(o.value);
        return {
          value: o.value,
          name: o.name,
          efforts: info?.efforts ?? [],
          effortCtl: info?.effortCtl ?? false,
          family: info?.family,
          fast: info?.fast ?? false,
          ctx1m: info?.ctx1m ?? false,
          prices: info?.prices,
        };
      }),
    };
  }
  // Per-session picks overlay — devin's echoed configOptions do NOT carry the
  // user's model choice across session/load (a refresh reverts to "high").
  // meta.lastConfig is journaled by the POST /config handler; re-apply it so
  // what the user picked is what the picker shows after every reload.
  const sticky = meta(ctx, id).lastConfig;
  if (sticky) {
    for (const o of out.options) {
      const k = String(o.id ?? "");
      if (sticky[k] !== undefined) o.currentValue = sticky[k];
    }
    if (sticky.mode) out.mode = sticky.mode;
    if (sticky.model && out.model) {
      out.model.current = sticky.model;
      out.model.currentName = out.model.options.find((o) => o.value === sticky.model)?.name ?? sticky.model;
    }
  }
  return out;
}

/** cloud version pill strings → local model config values */
export function cloudVersionToModel(version: string, opts: { value: string; name?: string }[]): string | null {
  const has = (v: string) => opts.some((o) => o.value === v);
  const pick = (...cands: string[]) => cands.find(has) ?? null;
  switch (version) {
    case "devin-auto":
    case "devin-auto-fast":
      return pick("adaptive", "swe-2-high");
    case "devin-ultra":
      return pick("swe-2-high", "adaptive");
    case "devin-2-5":
      return pick("swe-1-7-medium", "swe-2-high", "adaptive");
    case "devin-fast-opus":
      return pick("swe-1-7-lightning-medium", "swe-1-7-medium");
    case "devin_lite":
      return pick("swe-1-7-lightning-medium", "swe-1-7-medium");
    case "devin-swe-1-7":
      return pick("swe-1-7-medium");
    case "devin-swe-1-7-lightning":
      return pick("swe-1-7-lightning-medium");
    default:
      return has(version) ? version : pick("adaptive");
  }
}

/** terminalId → accumulated output (fed by index.ts onTerminalOutput).
 *  Memory is a hot cache — every chunk is also appended to a per-terminal
 *  disk sidecar (`<dataDir>/term/<sid>.<pid>.log`) because terminal/output
 *  is a client-RPC channel that never lands in the session log: without
 *  the sidecar a backend restart left every exec row at "未捕获输出". */
export const terminalBuf = new Map<string, { sessionId: string; text: string }>();
const TERM_CAP = 512 * 1024;
function termFile(sessionId: string, terminalId: string): string {
  const safe = (s: string) => s.replace(/[^\w.-]+/g, "_").slice(-120);
  return join(dataDir(), "term", `${safe(sessionId)}.${safe(terminalId)}.log`);
}
export function recordTerminal(terminalId: string, sessionId: string, data: string) {
  const e = terminalBuf.get(terminalId) ?? { sessionId, text: "" };
  e.sessionId = sessionId;
  e.text = (e.text + data).slice(-TERM_CAP);
  terminalBuf.set(terminalId, e);
  try {
    const f = termFile(sessionId, terminalId);
    mkdirSync(join(dataDir(), "term"), { recursive: true });
    if (existsSync(f) && statSync(f).size > TERM_CAP) {
      // Keep the tail: rewrite the last TERM_CAP/2 bytes then keep appending.
      const old = readFileSync(f);
      writeFileSync(f, old.subarray(-TERM_CAP / 2));
    }
    appendFileSync(f, data);
  } catch { /* disk echo is best-effort — memory still serves */ }
}
/** Read-through: memory first, then the disk sidecar (post-restart hits
 *  repopulate the cache so one cold read warms later ones). */
export function terminalText(terminalId: string): { sessionId: string; text: string } | undefined {
  const hit = terminalBuf.get(terminalId);
  if (hit) return hit;
  const dir = join(dataDir(), "term");
  let f: string | undefined;
  try { f = readdirSync(dir).find((n) => n.endsWith(`.${terminalId.replace(/[^\w.-]+/g, "_").slice(-120)}.log`)); } catch { return undefined; }
  if (!f) return undefined;
  try {
    const raw = readFileSync(join(dir, f));
    const text = raw.length > TERM_CAP ? raw.subarray(-TERM_CAP).toString("utf8") : raw.toString("utf8");
    const sessionId = f.split(".")[0];
    terminalBuf.set(terminalId, { sessionId, text });
    return { sessionId, text };
  } catch { return undefined; }
}

export function sessionStatus(ctx: ApiContext, id: string): { status: string; activity: string } {
  if (inflight.has(id)) return { status: "working", activity: "working" };
  // 'blocked' = "awaiting instructions" with an enabled composer; the
  // web treats 'waiting' as a transient "reverting checkpoint" state.
  return { status: "blocked", activity: "idle" };
}

export interface ListedSession {
  id: string;
  title: string;
  updated: string;
  cwd: string;
  /** devin's `_meta["cognition.ai/isLocked"]` — held open by SOME acp
   *  process (ours included). Pair with `loaded_here` to tell "在别处占用"
   *  apart from "本工作台已加载". */
  locked: boolean;
  created: string | null;
  /** Owning agent id (devin default; custom agents from agents.json). */
  agent?: string;
}

export async function listLocalSessions(ctx: ApiContext): Promise<ListedSession[]> {
  const out: ListedSession[] = [];
  let dirty = false;
  try {
    const acp = await ctx.manager.get(ctx.primaryCwd);
    let cursor: string | undefined;
    do {
      const page = await acp.listSessions(cursor);
      for (const s of page.sessions) {
        // Pinned sessions keep their loaded host — session/list reporting a
        // different cwd must not bounce them to another pooled process.
        if (!isSessionPinned(s.sessionId)) ctx.sessionCwd.set(s.sessionId, remapLegacyCwd(s.cwd));
        const m = meta(ctx, s.sessionId);
        // devin returns camelCase `updatedAt` (may be absent) — persist it so
        // restarts/list outages keep real times; NEVER fall back to now(),
        // which made every session look freshly updated on each poll.
        const seen = (s as { updatedAt?: string; updated_at?: string }).updatedAt
          ?? (s as { updated_at?: string }).updated_at ?? null;
        if (seen && seen !== m.updatedAt) { m.updatedAt = seen; dirty = true; }
        // Internal plumbing sessions (sidechat backends) keep their cwd pin
        // above but never list — machinery must not crowd the sidebar.
        if (m.hidden) continue;
        const lm = ((s as { _meta?: Record<string, unknown> })._meta ?? {}) as Record<string, unknown>;
        out.push({
          id: s.sessionId,
          title: m.title ?? s.title ?? "Untitled session",
          updated: seen ?? m.updatedAt ?? "1970-01-01T00:00:00.000Z",
          cwd: remapLegacyCwd(s.cwd),
          locked: lm["cognition.ai/isLocked"] === true,
          created: (lm["cognition.ai/createdAt"] as string | undefined) ?? null,
          agent: m.agent ?? "devin",
        });
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor && out.length < 2000);
  } catch { /* devin list may be down; show registry-only */ }
  if (dirty) saveReg();
  const known = new Set(out.map((s) => s.id));
  for (const [id, m] of Object.entries(loadReg(ctx).sessions)) {
    if (!known.has(id) && !m.archived && !m.hidden) {
      out.push({ id, title: m.title ?? "Untitled session", updated: m.updatedAt ?? "1970-01-01T00:00:00.000Z", cwd: remapLegacyCwd(ctx.sessionCwd.get(id) ?? ctx.primaryCwd), locked: false, created: null, agent: m.agent ?? ctx.store.agentSession(id)?.agent });
    }
  }
  return out;
}

/** Last message text, scanning only the tail of the log — the sidebar list
 * calls this for every session on every poll, so it must not buildTimeline. */
export function snippetFromLog(ctx: ApiContext, id: string): string {
  const log = ctx.sessionLog.get(id);
  for (let i = log.length - 1; i >= 0 && i > log.length - 100; i--) {
    const u = log[i].update as { sessionUpdate?: string; content?: { text?: string } };
    if ((u.sessionUpdate === "agent_message_chunk" || u.sessionUpdate === "user_message_chunk") && u.content?.text) {
      return u.content.text.replace(/\s+/g, " ").slice(0, 140);
    }
  }
  return "";
}
