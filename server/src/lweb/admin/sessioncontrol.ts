/**
 * lweb/admin/sessioncontrol — the per-session control surface under
 * /api/admin/session/:id: resume/cancel/stop, subagents (list +
 * per-agent timeline/message/control), agent-level resources + ext
 * passthrough, permission responses, permission mode, and the version
 * (model) pill.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { ApiContext } from "../../routes.js";
import { saveReg, meta } from "../../dwstore.js";
import { noteUpdate } from "../../dwtimeline.js";
import { hostFor, acpForId } from "../../sessionload.js";
import { sessionConfig, cloudVersionToModel } from "../../sessionview.js";
import { subagentTimeline } from "../../sessionsub.js";
import { dispatchPrompt } from "../../sessionprompt.js";
import { queueList, queueAdd, queueFlush } from "../../sessionqueue.js";
import { inflight, isDraining } from "../../sessionlive.js";
import { json, readBody, readJson } from "../../httputil.js";
import { subsAny } from "../session.js";
import { resourceRootPath } from "./fsbrowse.js";

export async function handleSessionControl(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL, m: string, sub: string, id: string): Promise<boolean> {
  // Wake/resume on a main session is a UI no-op — nothing sleeps
  // server-side; the next message just dispatches on the live acp.
  if (sub === "resume" && m === "POST") { await readBody(req); json(res, 200, { ok: true }); return true; }

  // Stop button posts /pause, End session posts /end — locally both
  // mean turn cancel (session/cancel settles the prompt RPC as
  // outcome:cancelled; settle → inflight clear → queueFlush runs).
  if ((sub === "cancel" || sub === "pause" || sub === "stop" || sub === "end") && m === "POST") {
    try { (await acpForId(ctx, id)).cancel(id); } catch { /* not running */ }
    json(res, 200, { ok: true });
    return true;
  }

  if (sub === "subagents" && m === "GET") {
    json(res, 200, { subagents: subsAny(ctx, id, "root") });
    return true;
  }

  // GET .../resources — agent-level context: rules, skills catalog,
  // spawnable subagent profiles, plans, hooks, agent config. Uses the
  // pooled host WITHOUT session/load (reads are agent-scoped, not
  // transcript-scoped — no replay cost, no updatedAt bump).
  if (sub === "resources" && m === "GET") {
    const { acp, cwd } = await hostFor(ctx, id);
    const errors: Record<string, string> = {};
    // ext methods disagree on scope: some take {sessionId,cwd}, some are
    // agent-scoped ({cwd}) or take nothing at all — walk the candidates.
    const call = (key: string, method: string, shapes: Record<string, unknown>[]) =>
      (async () => {
        let last: unknown = null;
        for (const params of shapes) {
          try { return (await acp.extMethod(id, method, params) as Record<string, unknown>) ?? {} } catch (e) { last = e }
        }
        errors[key] = last instanceof Error ? last.message : String(last ?? "failed");
        return null;
      })();
    const [rules, skills, profiles, plans, hooks, config, mcp] = await Promise.all([
      call("rules", "_cognition.ai/rules/list", [{ sessionId: id, cwd }, { cwd }, {}]),
      call("skills", "_cognition.ai/skills/list", [{ sessionId: id, cwd }, { cwd }]),
      call("subagentProfiles", "_cognition.ai/subagents/list", [{ sessionId: id, cwd }, { cwd }]),
      call("plans", "_cognition.ai/plans/list", [{ sessionId: id, cwd }, { cwd }, {}]),
      call("hooks", "_cognition.ai/hooks/list", [{ sessionId: id, cwd }, { cwd }, {}]),
      call("config", "_cognition.ai/config/read", [{ sessionId: id }, {}]),
      call("mcp", "_cognition.ai/mcp/listServers", [{ sessionId: id, cwd }, { cwd }, {}]),
    ]);
    const cfg = (config?.config ?? null) as Record<string, unknown> | null;
    // Older devin builds don't implement mcp/listServers (Method not found) —
    // configured MCP servers still live in agent config (config.mcpServers:
    // name→{command|url,args,env,…}), so fall back to that instead of
    // reporting an empty section.
    const cfgMcp = cfg?.mcpServers;
    const cfgMcpList = Array.isArray(cfgMcp)
      ? cfgMcp.map((s) => (s && typeof s === "object" ? { source: "config", ...(s as Record<string, unknown>) } : { name: String(s), source: "config" }))
      : cfgMcp && typeof cfgMcp === "object"
        ? Object.entries(cfgMcp as Record<string, unknown>).map(([name, def]) => ({ name, ...(def && typeof def === "object" ? def as Record<string, unknown> : { command: String(def) }), source: "config" }))
        : [];
    const mcpServers = mcp?.servers ?? mcp?.mcpServers ?? mcp?.servers_list ?? (cfgMcpList.length ? cfgMcpList : null);
    if (errors.mcp && cfgMcpList.length) delete errors.mcp; // recovered via config — not a failure
    // Same fallback for hooks: hooks/list may be absent on old builds while
    // config.hooks still carries {event: command|[{command,…}]}.
    const cfgHooks = cfg?.hooks;
    const cfgHookList = Array.isArray(cfgHooks)
      ? (cfgHooks as Record<string, unknown>[]).map((h) => ({ ...h, source: h.source ?? "config" }))
      : cfgHooks && typeof cfgHooks === "object"
        ? Object.entries(cfgHooks as Record<string, unknown>).flatMap(([event, v]) =>
            Array.isArray(v)
              ? v.map((c) => ({ event, ...(c && typeof c === "object" ? c as Record<string, unknown> : { command: String(c) }), source: "config" }))
              : [{ event, command: typeof v === "string" ? v : JSON.stringify(v), source: "config" }])
        : [];
    const hooksOut = hooks?.hooks ?? (cfgHookList.length ? cfgHookList : null);
    if (errors.hooks && cfgHookList.length) delete errors.hooks;
    json(res, 200, {
      rules: rules?.rules ?? null,
      skills: skills?.skills ?? null,
      subagentProfiles: profiles?.subagents ?? profiles?.profiles ?? null,
      plans: plans?.plans ?? null,
      hooks: hooksOut,
      config: cfg,
      configPath: config?.configPath ?? null,
      mcpServers,
      // Runtime registry — the session's actually-spawned subagents (the
      // profiles probe is empty on most builds; this is the real roster).
      subagents: subsAny(ctx, id, "root"),
      ...(Object.keys(errors).length ? { errors } : {}),
    });
    return true;
  }

  // GET/POST .../rule-file?path= — view + edit a rule (or plan) file the
  // agent reports. Confined to the shared resource roots (~/.devin, ~/.agents,
  // <cwd>/.devin/.agents, root AGENTS.md/CLAUDE.md/…) UNION this session's
  // own rules/list + plans/list paths (provider rules live elsewhere, e.g.
  // ~/.codeium — the agent told us those paths, so they're in-scope).
  if (sub === "rule-file" && (m === "GET" || m === "POST")) {
    const body = m === "POST" ? await readJson(req) : null;
    const raw = String(m === "GET" ? url.searchParams.get("path") ?? "" : body?.path ?? "");
    let rp = resourceRootPath(ctx, raw);
    if (!rp && raw) {
      const resolved = path.resolve(raw);
      const norm = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s);
      const listedPaths = async (method: string, key: string) => {
        let host: { acp: Awaited<ReturnType<typeof hostFor>>["acp"]; cwd: string };
        try { host = await hostFor(ctx, id) } catch { return [] as { path?: string }[] }
        for (const params of [{ sessionId: id, cwd: host.cwd }, { cwd: host.cwd }, {}]) {
          try {
            const r = (await host.acp.extMethod(id, method, params)) as Record<string, unknown> | undefined;
            const arr = r?.[key];
            if (Array.isArray(arr)) return arr as { path?: string }[];
          } catch { /* try next params shape */ }
        }
        return [] as { path?: string }[];
      };
      const [rulePaths, planPaths] = await Promise.all([
        listedPaths("_cognition.ai/rules/list", "rules"),
        listedPaths("_cognition.ai/plans/list", "plans"),
      ]);
      if ([...rulePaths, ...planPaths].some((e) => e.path && norm(path.resolve(e.path)) === norm(resolved))) rp = resolved;
    }
    if (!rp) { json(res, 403, { error: "outside resource roots" }); return true; }
    if (m === "GET") {
      try {
        const buf = fs.readFileSync(rp);
        if (buf.length > 2 * 1024 * 1024) { json(res, 413, { error: "too large" }); return true; }
        json(res, 200, { text: buf.toString("utf8"), binary: /[\x00-\x08]/.test(buf.subarray(0, 512).toString("binary")) });
      } catch { json(res, 404, { error: "not found" }); }
      return true;
    }
    try {
      fs.mkdirSync(path.dirname(rp), { recursive: true });
      fs.writeFileSync(rp, String(body?.text ?? ""), "utf8");
      json(res, 200, { ok: true });
    } catch (e) { json(res, 500, { error: e instanceof Error ? e.message : "write failed" }); }
    return true;
  }

  // Debug: raw extension-method passthrough — POST {method, params}.
  // Uses hostFor (NO session/load): this is a probe console, replay must
  // not run. Pass load:1 in the body for methods that need a loaded
  // session.
  if (sub === "ext" && m === "POST") {
    const body = await readJson(req);
    const method = String(body.method ?? "");
    if (!/^_?cognition\.ai\//.test(method)) { json(res, 400, { error: "ext methods only" }); return true; }
    try {
      const acp = body.load ? await acpForId(ctx, id) : (await hostFor(ctx, id)).acp;
      const result = await acp.extMethod(id, method, body.params as Record<string, unknown> | undefined);
      json(res, 200, { ok: true, result });
    } catch (err) {
      json(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  const subMatch = /^subagent\/([^/]+)\/(timeline|message|control)$/.exec(sub);
  if (subMatch) {
    const agentId = decodeURIComponent(subMatch[1]);
    const act = subMatch[2];
    if (act === "timeline" && m === "GET") {
      json(res, 200, { items: subagentTimeline(ctx, id, agentId) });
      return true;
    }
    if (act === "message" && m === "POST") {
      const body = await readJson(req);
      const text = String(body.message ?? body.text ?? "").trim();
      if (!text) { json(res, 400, { error: "empty message" }); return true; }
      if (isDraining()) { json(res, 503, { error: "server restarting" }); return true; }
      if (agentId.startsWith("spawn:")) { json(res, 400, { error: "subagent transcript not replayed; cannot message" }); return true; }
      // Busy → park like the main message path: concurrent dispatches
      // would overwrite each other's open-turns entry (it's a per-
      // session map slot, not per-turn).
      if (inflight.has(id) || queueList(id).length) {
        const m2 = queueAdd(ctx, id, text, [], { subagentId: agentId });
        if (!inflight.has(id)) queueFlush(ctx, id);
        json(res, 200, { ok: true, queued: m2.id });
        return true;
      }
      dispatchPrompt(ctx, id, text, [], agentId);
      json(res, 200, { ok: true });
      return true;
    }
    if (act === "control" && m === "POST") {
      const body = await readJson(req);
      const action = String(body.action ?? "");
      if (!["cancel", "foreground", "background"].includes(action)) {
        json(res, 400, { error: "bad action" });
        return true;
      }
      if (agentId.startsWith("spawn:")) { json(res, 200, { ok: false, error: "subagent not live (replayed)" }); return true; }
      try {
        const acp = await acpForId(ctx, id);
        await acp.subagentControl(id, agentId, action as "cancel" | "foreground" | "background");
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }
  }

  if (sub === "permission-response" && m === "POST") {
    const body = await readJson(req);
    const rid = String(body.request_id ?? "");
    const approved = body.approved !== false;
    const owner = ctx.permissionOwner.get(rid);
    if (!owner) { json(res, 200, { ok: false }); return true; }
    // Recover the original option list from the logged request so we can
    // pick a real optionId (allow_once/allow_always/reject_*).
    let optionId: string | null = null;
    const log = ctx.sessionLog.get(id);
    for (let i = log.length - 1; i >= 0; i--) {
      const u = log[i].update as Record<string, unknown>;
      if (u.sessionUpdate === "permission_request" && String(u.requestId) === rid) {
        const opts = (u.options as { optionId: string; kind?: string; name?: string }[] | undefined) ?? [];
        const find = (pred: (k: string) => boolean) => opts.find((o) => pred(o.kind ?? o.name ?? o.optionId))?.optionId;
        optionId = approved
          ? (body.bypass_all_future
            ? find((k) => /always|always_allow|bypass/i.test(k)) ?? find((k) => /allow/i.test(k))
            : find((k) => /allow_once|once|allow|proceed|yes/i.test(k))) ?? opts[0]?.optionId ?? null
          : find((k) => /reject|deny|no/i.test(k)) ?? null;
        break;
      }
    }
    const ok = owner.resolvePermission(rid, optionId);
    ctx.permissionOwner.delete(rid);
    ctx.hub.broadcast({ type: "permission_resolved", requestId: rid });
    ctx.sessionLog.append(id, { sessionUpdate: "permission_resolved", requestId: rid, optionId });
    noteUpdate(ctx, id);
    json(res, 200, { ok });
    return true;
  }

  // POST /api/admin/session/:id/version — cloud model pill → local model config
  if (sub === "version" && m === "POST") {
    const body = await readJson(req);
    const cfg = sessionConfig(ctx, id);
    const value = cloudVersionToModel(String(body.version ?? ""), cfg.model?.options ?? []);
    if (!value || !cfg.model) { json(res, 200, { ok: false, error: "model option unavailable" }); return true; }
    const acp = await acpForId(ctx, id);
    const result = await acp.setConfigOption(id, cfg.model.id, value);
    json(res, 200, result ?? { ok: true });
    return true;
  }

  if (sub === "permission" && m === "POST") {
    const body = await readJson(req);
    meta(ctx, id).permission = String(body.permission ?? "detailed");
    saveReg();
    json(res, 200, { ok: true });
    return true;
  }

  return false;
}
