/**
 * lweb/admin/sessionlifecycle — the per-session lifecycle surface under
 * /api/admin/session/:id: config options (GET/POST), archive, end/share/
 * share-link, restart (acp kill+replay), fork (native or transcript-seed),
 * and the cloud-compat keep-alive stubs.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiContext } from "../../routes.js";
import { saveReg, meta, noteLastUsed } from "../../dwstore.js";
import { hostFor, acpForId, restartSession } from "../../sessionload.js";
import { sessionConfig } from "../../sessionview.js";
import { dispatchPrompt } from "../../sessionprompt.js";
import { loadInflight, markLoadedOn } from "../../sessionplace.js";
import { responseCfg, captureLoadResponse, type ConfigOption } from "../../sessioncfg.js";
import { agentById } from "../../agents.js";
import { json, readBody, readJson } from "../../httputil.js";
import { summarizeForFork, titleFromLog } from "../session.js";
import { archiveSidechats } from "./sessiontimeline.js";

export async function handleSessionLifecycle(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL, m: string, sub: string, id: string): Promise<boolean> {
  // GET /api/admin/session/:id/config — real ACP config options (mode/model).
  // NEVER starts a session/load (browsing must not bump updatedAt);
  // only waits for one already in flight, briefly, before falling back
  // to the agent-level config. POST /config does load — that's a real op.
  if (sub === "config" && m === "GET") {
    await Promise.race([loadInflight.get(id)?.p ?? Promise.resolve(), new Promise((r) => setTimeout(r, 2500))]);
    const cfg = sessionConfig(ctx, id);
    if (url.searchParams.get("raw") === "1") {
      const cfgUpdates = ctx.sessionLog.get(id)
        .map((e) => e.update as { sessionUpdate?: string; configOptions?: { id?: string; currentValue?: string }[]; currentModeId?: string })
        .filter((u) => u.sessionUpdate === "config_option_update" || u.sessionUpdate === "current_mode_update")
        .slice(-6);
      json(res, 200, { cfg, responseCfg: responseCfg.get(id), cfgUpdates });
    } else {
      json(res, 200, { options: cfg.options, mode: cfg.mode, commands: cfg.commands, model: cfg.model });
    }
    return true;
  }
  if (sub === "config" && m === "POST") {
    const body = await readJson(req);
    const acp = await acpForId(ctx, id);
    const configId = String(body.configId);
    const value = String(body.value);
    // `mode` is dual-exposed by devin: a modes state (set via
    // session/set_mode) AND a configOptions mirror group that only
    // refreshes when the agent repushes config. Route both ids to
    // set_mode so the change actually sticks.
    const isMode = configId === "_mode" || configId === "mode";
    const isAcpModel = configId === "model" && !!(responseCfg.get(id)?.configOptions as { id?: string; _acp?: boolean }[] | undefined)?.find((o) => o.id === "model")?._acp;
    const result = isMode
      ? await acp.setMode(id, value)
      : isAcpModel
        ? await acp.extMethod(id, "session/set_model", { sessionId: id, modelId: value })
        : await acp.setConfigOption(id, configId, value);
    if (isAcpModel) {
      const prev = responseCfg.get(id);
      responseCfg.set(id, { ...(prev ?? {}), configOptions: (prev?.configOptions ?? []).map((o) => (o as { id?: string }).id === "model" ? { ...o, currentValue: value } : o), echoTs: Date.now() });
    }
    // setSessionConfigOption returns a full configOptions snapshot — but a
    // pick like "SWE-2 · max" posts model AND thought_level in parallel, and
    // each echo carries EVERY group's currentValue from the moment that one
    // write landed. Whichever response arrives last would clobber the other's
    // fresh value (the pill then showed the stale "high" instead of "max").
    // Merge instead of replace: the group we just set adopts the echo
    // wholesale; untouched groups take only the echo's options refresh
    // (thought_level re-advertises per-model levels when model changes)
    // while keeping the currentValue we already believe.
    const ropts = (result as { configOptions?: ConfigOption[] } | null)?.configOptions;
    if (ropts) {
      const prevOpts = responseCfg.get(id)?.configOptions ?? [];
      const setId = isMode ? "mode" : configId;
      const merged = ropts.map((g) => {
        const p = prevOpts.find((x) => x.id === g.id);
        if (!p) return g;
        return g.id === setId ? { ...p, ...g } : { ...g, currentValue: p.currentValue };
      });
      const missing = prevOpts.filter((p) => !ropts.some((g) => g.id === p.id));
      responseCfg.set(id, { ...(responseCfg.get(id) ?? {}), configOptions: [...merged, ...missing], echoTs: Date.now() });
    }
    if (isMode) {
      const prev = responseCfg.get(id);
      // Update both layers: modes.currentModeId AND the configOptions
      // mirror group's currentValue.
      responseCfg.set(id, {
        configOptions: (prev?.configOptions ?? []).map((o) => o.id === "mode" ? { ...o, currentValue: value } : o),
        modes: { currentModeId: value, availableModes: prev?.modes?.availableModes ?? [] },
        echoTs: Date.now(),
      });
    }
    noteLastUsed(ctx, isMode ? "mode" : configId, value);
    // Per-session stickiness: devin does not persist model across loads —
    // journal the pick on the session meta so sessionConfig can re-overlay
    // it after every refresh/restart instead of falling back to "high".
    meta(ctx, id).lastConfig = { ...(meta(ctx, id).lastConfig ?? {}), [isMode ? "mode" : configId]: value };
    saveReg();
    ctx.hub.broadcast({ type: "session_update", sessionId: id, update: { sessionUpdate: "config_option_update", configOptions: ropts ?? [] } });
    json(res, 200, result ?? { ok: true });
    return true;
  }

  if (sub === "archive" && m === "POST") {
    const body = await readJson(req);
    const archived = !!body.archived;
    meta(ctx, id).archived = archived;
    if (archived) archiveSidechats(ctx, id); // sidechat backends follow the parent onto the shelf
    saveReg();
    json(res, 200, { ok: true });
    return true;
  }

  // POST .../end — desktop "End session". Verified: {_cognition.ai/
  // session/end, {sessionId, reason}} → {dispatched:true} on this build.
  if (sub === "end" && m === "POST") {
    try {
      const acp = await acpForId(ctx, id);
      const r = await acp.extMethod(id, "_cognition.ai/session/end", { sessionId: id, reason: "user" });
      json(res, 200, { ok: true, result: r });
    } catch (e) { json(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) }); }
    return true;
  }

  // POST .../share — uploads transcript to Devin cloud, returns a public
  // app.devin.ai link. Verified: {_cognition.ai/session/share,{sessionId}}
  // → {shareId,url,truncated}. Requires loaded session (acpForId).
  if (sub === "share" && m === "POST") {
    try {
      const acp = await acpForId(ctx, id);
      const r = await acp.extMethod(id, "_cognition.ai/session/share", { sessionId: id }) as Record<string, unknown> | undefined;
      json(res, 200, { ok: true, url: String(r?.url ?? ""), shareId: String(r?.shareId ?? ""), truncated: !!r?.truncated });
    } catch (e) { json(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) }); }
    return true;
  }

  // POST .../share-link {enabled} — toggles the LOCAL share link
  // (/s/<id> via /api/share/*): sets/clears meta.shared. Distinct from
  // cloud `share` above (uploads to app.devin.ai). The link is live only
  // while enabled; share_url in payloads is null otherwise.
  if (sub === "share-link" && m === "POST") {
    const body = (await readJson(req)) as { enabled?: boolean };
    const mm2 = meta(ctx, id);
    mm2.shared = !!body?.enabled;
    saveReg();
    json(res, 200, { ok: true, enabled: mm2.shared, url: mm2.shared ? `/s/${id}?t=local` : null });
    return true;
  }

  // POST .../restart — kill the acp hosting this session; the next op
  // respawns + replays history (local analog of cloud "reboot VM").
  if (sub === "restart" && m === "POST") {
    restartSession(ctx, id);
    json(res, 200, { ok: true });
    return true;
  }

  // POST .../fork — clone the session. Native ACP `session/fork` when the
  // agent advertises sessionCapabilities.fork (opencode does); devin's
  // local acp has no fork, so the fallback opens a new session on the
  // same process and seeds it with a handoff prompt (model-written
  // summary when the handoff writer answers; mechanical transcript
  // extract as fallback).
  if (sub === "fork" && m === "POST") {
    const body = await readJson(req);
    // `anchor` = timeline item id ("e<seq>") to fork FROM that message.
    // ACP session/fork only clones at head, so an anchored fork always
    // takes the transcript-seed path (uniform across agents).
    const anchor = typeof body.anchor === "string" && /^e\d+$/.test(body.anchor) ? Number(body.anchor.slice(1))
      : typeof body.anchor === "number" ? body.anchor : null;
    const { acp, cwd } = await hostFor(ctx, id);
    const agent = agentById(ctx.store.agentSession(id)?.agent ?? meta(ctx, id).agent);
    if (!agent.multiSession) {
      json(res, 409, { error: "该 Agent 每进程仅承载一个会话，无法分叉" });
      return true;
    }
    // Anchored forks need source material at/before the anchor —
    // validate BEFORE creating the child session so a 409 leaks nothing.
    if (anchor !== null) {
      let any = false;
      for (const e of ctx.sessionLog.get(id)) {
        const u = e.update as { sessionUpdate?: string; content?: { text?: string } };
        if ((u.sessionUpdate === "user_message_chunk" || u.sessionUpdate === "agent_message_chunk")
          && u.content?.text && (e.seq ?? -1) <= anchor) { any = true; break; }
      }
      if (!any) { json(res, 409, { error: "该位置之前没有可分叉的消息" }); return true; }
    }
    const srcTitle = meta(ctx, id).title ?? titleFromLog(ctx, id) ?? "Untitled session";
    let newId: string | null = null;
    let forkRes: unknown = null;
    let native = false;
    if (anchor === null && acp.supportsFork) {
      const r = (await acp.forkSession(id, cwd)) as { sessionId?: string } | null;
      newId = r?.sessionId ?? null;
      forkRes = r;
      native = !!newId;
    }
    if (!newId) {
      const s = await acp.newSession(cwd);
      newId = s.sessionId;
      forkRes = s;
    }
      markLoadedOn(newId, acp);
    ctx.sessionCwd.set(newId, cwd);
    captureLoadResponse(newId, forkRes);
    const mm = meta(ctx, newId);
    mm.title = `${srcTitle} (fork)`;
    (mm as Record<string, unknown>).forkedFrom = anchor !== null ? `${id}@${anchor}` : id;
    if (agent.id !== "devin") mm.agent = agent.id;
    saveReg();
    json(res, 200, { ok: true, id: newId, native: acp.supportsFork });
    // Handoff seed (fallback path only): the fork's first prompt is a
    // MODEL-WRITTEN summary of the source transcript — task, decisions,
    // files, state, next steps — the same practice as Claude Code
    // /compact and Devin handoffs. Async: the client already routed to
    // the new session. A dead writer degrades to a bare continue-task
    // directive so the fork still works.
    if (native) return true; // native clone needs no seed
    const nid = newId;
    void (async () => {
      const summary = await summarizeForFork(ctx, id, anchor, srcTitle);
      dispatchPrompt(ctx, nid, summary
        ? `[分叉自会话「${srcTitle}」${anchor !== null ? "（锚点分叉）" : ""}] 以下是原会话的交接摘要。请在此基础上继续完成相同任务：\n\n${summary}`
        : `[分叉自会话「${srcTitle}」] 请继续该会话的任务。`, []);
    })().catch((e) => console.error(`[fork] handoff seed: ${e instanceof Error ? e.message : e}`));
    return true;
  }

  if (sub === "keep-alive" || sub === "feedback" || sub === "reset-token" || sub === "env" || sub === "editor" || sub === "queue-clear") {
    if (m === "POST") await readBody(req);
    json(res, 200, sub === "env" && m === "GET" ? { env: null } : { ok: true });
    return true;
  }

  return false;
}
