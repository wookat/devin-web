/**
 * lweb/admin/newsession — the session-creation surface: sessions
 * list/register/new, session-less upload staging, composer-meta (draft
 * composer data), and the agents registry GET/PUT.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiContext } from "../../routes.js";
import { stageUpload } from "../../uploads.js";
import { loadReg, saveReg, meta } from "../../dwstore.js";
import { remapLegacyCwd } from "../../store.js";
import { buildTimeline } from "../../dwtimeline.js";
import { sessionConfig, sessionStatus, listLocalSessions } from "../../sessionview.js";
import { dispatchPrompt } from "../../sessionprompt.js";
import { loadedOn, sessionHost } from "../../sessionplace.js";
import { isDraining } from "../../sessionlive.js";
import { captureLoadResponse } from "../../sessioncfg.js";
import { agentById, listAgents, probeAgent, saveUserAgents } from "../../agents.js";
import { publicSshHost } from "../../ssh.js";
import { json, readJson } from "../common.js";
import { scanLocalSkills } from "../admin.js";

export async function handleNewSession(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL, m: string, p: string, parts: string[]): Promise<boolean> {
  // GET /api/admin/sessions — classic admin list
  if (p === "/api/admin/sessions" && m === "GET") {
    const sessions = (await listLocalSessions(ctx)).map((s) => {
      const m2 = meta(ctx, s.id);
      const items = ctx.sessionLog.get(s.id).length ? buildTimeline(ctx, s.id).items : [];
      const lastMsg = [...items].reverse().find((i) => i.kind === "message");
      return {
        id: s.id, devin_session_id: s.id, title: m2.title ?? s.title, devin_title: s.title,
        permission: m2.permission ?? "detailed", archived: m2.archived ? 1 : 0, pinned: m2.pinned ? 1 : 0,
        created_at: s.updated, status: sessionStatus(ctx, s.id).status,
        status_message: null, last_message: lastMsg?.body?.slice(0, 200) ?? "",
        last_timestamp: lastMsg?.ts ?? s.updated, share_url: `/s/${s.id}?t=local`,
      };
    });
    json(res, 200, { sessions });
    return true;
  }

  // POST /api/admin/sessions — register a session id (no-op record locally)
  if (p === "/api/admin/sessions" && m === "POST") {
    const body = await readJson(req);
    const id = String(body.devin_session_id ?? body.id ?? "");
    if (!id) { json(res, 400, { error: "missing session id" }); return true; }
    if (body.title) meta(ctx, id).title = String(body.title);
    saveReg();
    json(res, 200, { ok: true, id });
    return true;
  }

  // POST /api/admin/sessions/new — create a local session (+ optional task)
  // body.agent picks the ACP agent (devin default; user registry in
  // agents.json adds generic CLIs). Agent is a session-lifetime property —
  // persisted in dw.json meta so reloads route to the right process.
  if (p === "/api/admin/sessions/new" && m === "POST") {
    if (isDraining()) { json(res, 503, { error: "server restarting" }); return true; }
    const body = await readJson(req);
    // `ssh` runs the agent on a REMOTE host — only targets configured in
    // prefs.sshHosts are accepted (the web has no auth). The cwd is then
    // a path on the remote machine.
    const sshReq = typeof body.ssh === "string" && body.ssh.trim() ? body.ssh.trim() : null;
    const sshHosts = loadReg(ctx).prefs?.sshHosts ?? [];
    const sshHost = sshReq ? sshHosts.find((h) => h.target === sshReq) ?? null : null;
    if (sshReq && !sshHost) { json(res, 400, { error: "ssh target not configured — add it in the local/remote picker" }); return true; }
    const ssh = sshHost?.target ?? null;
    const cwd = ssh ? String(body.cwd ?? sshHost?.cwd ?? "~") : String(body.cwd ?? ctx.primaryCwd);
    const agent = agentById(body.agent);
    const acp = agent.multiSession
      ? await ctx.manager.get(cwd, agent, ssh)
      : await ctx.manager.startForSession(cwd, agent, ssh);
    const s = await acp.newSession(cwd);
    if (!agent.multiSession) {
      ctx.manager.bindSession(s.sessionId, acp);
      ctx.store.addAgentSession(s.sessionId, agent.id, cwd);
    }
    ctx.sessionCwd.set(s.sessionId, ssh ? cwd : remapLegacyCwd(cwd));
    if (ssh) ctx.sessionSsh.set(s.sessionId, ssh);
    captureLoadResponse(s.sessionId, s);
    let nset = loadedOn.get(acp);
    if (!nset) loadedOn.set(acp, (nset = new Set()));
    nset.add(s.sessionId);
    // Pin the owning process or the next prompt re-loads onto a pooled
    // acp and devin rejects it ("already open in another process").
    sessionHost.set(s.sessionId, acp);
    const mm = meta(ctx, s.sessionId);
    if (body.title) mm.title = String(body.title);
    if (body.folder) mm.folder = String(body.folder);
    if (agent.id !== "devin") mm.agent = agent.id;
    if (ssh) mm.ssh = ssh;
    saveReg();
    const task = String(body.task ?? "").trim();
    // apply last-used model/mode — desktop carries the pick into new sessions
    const last = loadReg(ctx).lastConfig ?? {};
    for (const [cfgId, val] of Object.entries(last)) {
      try {
        if (cfgId === "mode" || cfgId === "_mode") await acp.setMode(s.sessionId, val);
        else await acp.setConfigOption(s.sessionId, cfgId, val);
      } catch { /* group may not exist on this profile */ }
    }
    const atts = Array.isArray(body.attachments) ? body.attachments : [];
    if (task || atts.length) dispatchPrompt(ctx, s.sessionId, task || " ", atts);
    json(res, 200, { ok: true, id: s.sessionId, devin_session_id: s.sessionId });
    return true;
  }

  // Session-less staging for the /admin/new draft composer — same raw-body
  // contract as the session-scoped upload-stage.
  if (p === "/api/admin/upload-stage" && m === "POST") {
    json(res, 200, await stageUpload(req, ctx.store, url.searchParams.get("filename")));
    return true;
  }

  if (p === "/api/admin/composer-meta" && m === "GET") {
    const sessions = (await listLocalSessions(ctx)).slice(0, 30).map((s) => ({ id: s.id, title: s.title, snippet: "" }));
    // slash commands + repos from any currently-loaded session's config
    let commands: { command: string; description: string; hint?: string }[] = [];
    const repos = (ctx.store.workspaces() ?? []).map((w) => ({ name: String(w).split(/[\\/]/).pop() || String(w), org: String(w) }));
    // best-effort: pull commands from the most recently-active logged session
    let newest = 0;
    for (const s of sessions) {
      const log = ctx.sessionLog.get(s.id);
      const last = log[log.length - 1]?.ts ?? 0;
      if (last > newest) { newest = last; }
    }
    for (const s of sessions) {
      const log = ctx.sessionLog.get(s.id);
      if ((log[log.length - 1]?.ts ?? 0) === newest && newest) {
        commands = sessionConfig(ctx, s.id).commands.map((c) => ({ command: c.name, description: c.description ?? "", hint: c.input?.hint }));
        break;
      }
    }
    // No session replayed its commands yet this boot — the agent-level
    // fallback inside sessionConfig (last load-response / last seen set)
    // still resolves against any known session id.
    if (!commands.length && sessions[0]) {
      commands = sessionConfig(ctx, sessions[0].id).commands.map((c) => ({ command: c.name, description: c.description ?? "", hint: c.input?.hint }));
    }
    // Draft-page cfg: agent-level modes/configOptions/model so the
    // /admin/new composer shows the real mode+model pills before any
    // session exists (same lastAgentCfg fallback sessionConfig uses).
    const cfg = sessionConfig(ctx, sessions[0]?.id ?? "");
    // Enabled agents for the draft picker's dropdown (disabled entries
    // stay hidden — their existing sessions still run via meta.agent).
    const agents = listAgents().filter((a) => !a.disabled).map((a) => ({ id: a.id, label: a.label }));
    json(res, 200, { commands, skills: scanLocalSkills(ctx), playbooks: [], secrets: [], macros: [], repos, sessions, primary_cwd: ctx.primaryCwd, cfg, last_config: loadReg(ctx).lastConfig ?? {}, agents, ssh_hosts: (loadReg(ctx).prefs?.sshHosts ?? []).map(publicSshHost) });
    return true;
  }

  // Agent registry: GET lists every entry (builtin + user) with install
  // probe status; PUT rewrites the user layer (agents.json) wholesale.
  if (p === "/api/admin/agents" && m === "GET") {
    const probe = url.searchParams.get("probe") === "1";
    const rows = await Promise.all(listAgents().map(async (a) => ({
      id: a.id,
      label: a.label,
      command: a.command,
      args: a.args,
      multiSession: a.multiSession,
      versionArgs: a.versionArgs,
      env: a.env,
      shell: a.shell === true,
      custom: !!a.custom,
      enabled: !a.disabled,
      installed: probe ? (await probeAgent(a)) : null,
    })));
    json(res, 200, { agents: rows });
    return true;
  }
  if (p === "/api/admin/agents" && m === "PUT") {
    const body = await readJson(req);
    const list = Array.isArray(body?.agents) ? body.agents : [];
    const r = saveUserAgents(list);
    json(res, 200, r);
    return true;
  }

  return false;
}
