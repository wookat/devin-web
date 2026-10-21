/**
 * lweb/admin/registry — dw.json-backed registry + the /mirror/* web
 * surface: automations, session list/folders/flags, children/parent/members,
 * prefs, persona, @file index, precheck/transcribe/translate.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { ApiContext } from "../../routes.js";
import { loadReg, saveReg, meta, type DwAutomation } from "../../dwstore.js";
import { listLocalSessions } from "../../sessionview.js";
import { personaState, personaMode, askPersona, decisionsTail } from "../../persona.js";
import { cronNext, runAutomation } from "../../automations.js";
import { publicSshHost, type SshHost } from "../../ssh.js";
import { json, readBody, readJson, UNSUPPORTED } from "../common.js";
import { parseSubId, cwdFor, subsAny, subTreeRow, treeSession, titleFromLog } from "../session.js";
import { indexWorkspace } from "../admin.js";

export async function handleRegistry(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL, m: string, p: string, parts: string[]): Promise<boolean> {
  // /api/admin/automations — scheduled-session CRUD + manual fire.
  // GET list; POST create; POST /:id patch {name?,prompt?,schedule?,cwd?,enabled?};
  // DELETE /:id; POST /:id/run → fire now (returns the new session id).
  if (parts[2] === "automations") {
    const reg = loadReg(ctx);
    reg.automations ??= {};
    const aid = parts[3] ? decodeURIComponent(parts[3]) : "";
    const one = aid ? reg.automations[aid] : null;
    if (one && parts[4] === "run" && m === "POST") {
      const sid = await runAutomation(ctx, aid).catch(() => null);
      json(res, sid ? 200 : 502, sid ? { ok: true, id: sid } : { error: "fire failed (acp unavailable?)" });
      return true;
    }
    if (m === "GET" && !aid) {
      json(res, 200, { automations: Object.values(reg.automations).sort((a, b) => a.createdAt - b.createdAt) });
      return true;
    }
    if (m === "POST" && !aid) {
      const body = await readJson(req);
      const schedule = String(body.schedule ?? "").trim();
      const next = cronNext(schedule);
      if (!String(body.name ?? "").trim() || !String(body.prompt ?? "").trim() || !next) {
        json(res, 400, { error: "name, prompt, and a valid 5-field cron schedule are required" });
        return true;
      }
      const a: DwAutomation = {
        id: `auto-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        name: String(body.name).slice(0, 120), prompt: String(body.prompt).slice(0, 20_000),
        schedule, cwd: String(body.cwd ?? ctx.primaryCwd),
        enabled: body.enabled !== false, createdAt: Date.now(), nextRun: next,
      };
      reg.automations[a.id] = a; saveReg();
      json(res, 200, { ok: true, automation: a });
      return true;
    }
    if (one && m === "POST") {
      const body = await readJson(req);
      if (body.name != null) one.name = String(body.name).slice(0, 120) || one.name;
      if (body.prompt != null) one.prompt = String(body.prompt).slice(0, 20_000);
      if (body.cwd != null) one.cwd = String(body.cwd) || one.cwd;
      if (body.schedule != null) {
        const n = cronNext(String(body.schedule));
        if (!n) { json(res, 400, { error: "invalid cron schedule" }); return true; }
        one.schedule = String(body.schedule).trim(); one.nextRun = n;
      }
      if (body.enabled != null) { one.enabled = !!body.enabled; one.nextRun = one.enabled ? (cronNext(one.schedule) ?? undefined) : undefined; }
      saveReg();
      json(res, 200, { ok: true, automation: one });
      return true;
    }
    if (one && m === "DELETE") {
      delete reg.automations[aid]; saveReg();
      json(res, 200, { ok: true });
      return true;
    }
    json(res, 404, { error: "not found" });
    return true;
  }

  // GET /api/admin/mirror/sessions — sidebar tree
  if (p === "/api/admin/mirror/sessions" && m === "GET") {
    const sessions = (await listLocalSessions(ctx)).map((s) => treeSession(ctx, s));
    // Sort menu sends order_by=updated_at|created_at — session/list comes
    // back updated-desc already, but the created pick must actually reorder.
    const byCreated = url.searchParams.get("order_by") === "created_at";
    sessions.sort((a, b) => String((byCreated ? b.created_at : b.updated_at) ?? "").localeCompare(String((byCreated ? a.created_at : a.updated_at) ?? "")));
    const r = loadReg(ctx);
    const totals: Record<string, number> = {};
    for (const s of sessions) if (s.folder) totals[s.folder] = (totals[s.folder] ?? 0) + 1;
    json(res, 200, { sessions, folder_order: r.folderOrder, folder_totals: totals, next_cursor: null });
    return true;
  }

  // POST /api/admin/mirror/folder-* — folder management
  if (parts[2] === "mirror" && parts[3]?.startsWith("folder-") && m === "POST") {
    const body = await readJson(req);
    const r = loadReg(ctx);
    const op = parts[3];
    if (op === "folder-create") {
      const name = String(body.name ?? "").trim();
      if (name && !r.folderOrder.includes(name)) r.folderOrder.push(name);
    } else if (op === "folder-rename") {
      const from = String(body.from ?? ""), to = String(body.to ?? "").trim();
      r.folderOrder = r.folderOrder.map((f) => (f === from ? to : f));
      for (const s of Object.values(r.sessions)) if (s.folder === from) s.folder = to;
    } else if (op === "folder-delete") {
      const name = String(body.name ?? "");
      r.folderOrder = r.folderOrder.filter((f) => f !== name);
      for (const s of Object.values(r.sessions)) if (s.folder === name) s.folder = null;
    } else if (op === "folder-reorder") {
      const order = body.order;
      if (Array.isArray(order)) r.folderOrder = order.map(String);
    }
    saveReg();
    json(res, 200, { ok: true });
    return true;
  }

  // POST /api/admin/mirror/session-* — per-session flags
  if (parts[2] === "mirror" && parts[3]?.startsWith("session-") && m === "POST") {
    const body = await readJson(req);
    const id = String(body.session_id ?? body.id ?? body.devin_id ?? "");
    const mm = meta(ctx, id);
    switch (parts[3]) {
      case "session-title": mm.title = String(body.title ?? ""); break;
      case "session-folder": mm.folder = body.folder ? String(body.folder) : null; break;
      case "session-pin": mm.pinned = !!body.pinned; break;
      case "session-archive": mm.archived = !!body.archived; break;
    }
    saveReg();
    json(res, 200, { ok: true });
    return true;
  }

  if (p === "/api/admin/mirror/session-children" && m === "GET") {
    // Lazy-load row children. `root` is a session id, or `sub:<id>:<aid>`
    // for a subagent's own nested children.
    const root = url.searchParams.get("root") ?? "";
    const ref = parseSubId(root);
    const kids = ref ? subsAny(ctx, ref.parent, ref.aid) : subsAny(ctx, root, "root");
    json(res, 200, { children: kids.map((a) => subTreeRow(ctx, ref?.parent ?? root, cwdFor(ctx, ref?.parent ?? root), a)) });
    return true;
  }
  if (p === "/api/admin/mirror/parent" && m === "GET") {
    const sid = url.searchParams.get("id") ?? url.searchParams.get("session") ?? "";
    const ref = parseSubId(sid);
    if (ref) {
      json(res, 200, { parent: { devin_id: ref.parent, title: meta(ctx, ref.parent).title ?? titleFromLog(ctx, ref.parent) ?? "Parent session" } });
    } else {
      json(res, 200, { parent: null });
    }
    return true;
  }
  if (p === "/api/admin/mirror/members" && m === "GET") {
    json(res, 200, { members: [{ user_id: "local", name: "local" }] });
    return true;
  }

  // GET/POST /api/admin/prefs — server-side web preferences
  // (dw.json `prefs`). autoResume drives the boot-time open-turns sweep.
  // sshHosts ride prefs too; secrets (password/passphrase) are stripped on
  // the way OUT — the UI only sees hasPassword/hasPassphrase flags.
  if (p === "/api/admin/prefs" && m === "GET") {
    const prefs = loadReg(ctx).prefs ?? {};
    json(res, 200, { prefs: { ...prefs, sshHosts: (prefs.sshHosts ?? []).map(publicSshHost) } });
    return true;
  }
  if (p === "/api/admin/prefs" && m === "POST") {
    const body = await readJson(req);
    const r = loadReg(ctx);
    if (typeof body.autoResume === "boolean") (r.prefs ??= {}).autoResume = body.autoResume;
    // SSH targets for the draft page's local/remote picker — shape
    // [{name?, target: "user@host", cwd?}]; only these may be used by
    // sessions/new (the web has no auth — never accept arbitrary targets).
    if (Array.isArray(body.sshHosts)) {
      const prev = new Map((r.prefs?.sshHosts ?? []).map((h) => [h.target, h]));
      const hosts = (body.sshHosts as unknown[]).flatMap((h) => {
        const r0 = h as { name?: unknown; target?: unknown; cwd?: unknown; auth?: unknown; password?: unknown; keyPath?: unknown; passphrase?: unknown };
        const target = String(r0?.target ?? "").trim();
        if (!/^[A-Za-z0-9_.@%:+-]{1,200}$/.test(target)) return [];
        const old = prev.get(target);
        // Secret merge: field absent → keep stored value; "" → cleared.
        const secret = (v: unknown, keep: string | undefined) =>
          v === undefined ? keep : typeof v === "string" ? v.slice(0, 300) || undefined : undefined;
        const auth = r0.auth === "password" || r0.auth === "key" ? r0.auth : "agent";
        const host: SshHost = {
          name: typeof r0.name === "string" && r0.name.trim() ? r0.name.trim().slice(0, 60) : undefined,
          target,
          cwd: typeof r0.cwd === "string" && r0.cwd.trim() ? r0.cwd.trim().slice(0, 300) : undefined,
          auth: auth === "agent" ? undefined : auth,
          password: secret(r0.password, old?.password),
          keyPath: typeof r0.keyPath === "string" && r0.keyPath.trim() ? r0.keyPath.trim().slice(0, 300) : undefined,
          passphrase: secret(r0.passphrase, old?.passphrase),
        };
        return [host];
      }).slice(0, 50);
      (r.prefs ??= {}).sshHosts = hosts;
    }
    saveReg();
    json(res, 200, { ok: true, prefs: { ...r.prefs, sshHosts: (r.prefs?.sshHosts ?? []).map(publicSshHost) } });
    return true;
  }

  // 分身 (persona): global default mode/webhook/cap + per-session override
  // + manual ask. The persona session itself is created lazily on first ask.
  if (p === "/api/admin/persona" && m === "GET") {
    const r = loadReg(ctx);
    json(res, 200, { cfg: r.prefs?.persona ?? {}, sessionId: r.persona?.sessionId ?? null, decisions: decisionsTail(ctx, 50) });
    return true;
  }
  if (p === "/api/admin/persona" && m === "POST") {
    const body = await readJson(req);
    const r = loadReg(ctx);
    const pcfg = (r.prefs ??= {}).persona ??= {};
    if (body.mode === "off" || body.mode === "semi" || body.mode === "auto") pcfg.mode = body.mode;
    if (typeof body.webhook === "string") pcfg.webhook = body.webhook;
    if (typeof body.maxPerHour === "number" && body.maxPerHour > 0) pcfg.maxPerHour = Math.floor(body.maxPerHour);
    saveReg();
    json(res, 200, { ok: true, cfg: pcfg });
    return true;
  }
  if (p === "/api/admin/session-persona" && m === "POST") {
    const body = await readJson(req);
    const id = String(body.id ?? "");
    const mm = meta(ctx, id);
    if (body.mode === "off" || body.mode === "semi" || body.mode === "auto") mm.personaMode = body.mode;
    else if (body.mode === "inherit" || body.mode === null) delete mm.personaMode;
    saveReg();
    json(res, 200, { ok: true, persona: personaState(ctx, id) });
    return true;
  }
  if (p === "/api/admin/session-persona-ask" && m === "POST") {
    const body = await readJson(req);
    const id = String(body.id ?? "");
    if (!id || personaMode(ctx, id) === "off") { json(res, 400, { error: "persona_off" }); return true; }
    const handled = await askPersona(ctx, id, "manual");
    json(res, 200, { ok: true, handled });
    return true;
  }

  if (p === "/api/admin/mirror/indexed-paths" && m === "GET") {
    // @file mention source: index the session's workspace files. Bounded
    // BFS — heavy dirs skipped — cached briefly per workspace.
    const sid = url.searchParams.get("session") ?? "";
    const cwdParam = url.searchParams.get("cwd");
    const cwd = (cwdParam && path.resolve(cwdParam)) || (sid && ctx.sessionCwd.get(parseSubId(sid)?.parent ?? sid)) || ctx.primaryCwd;
    const paths = indexWorkspace(cwd);
    json(res, 200, { paths });
    return true;
  }
  if (p === "/api/admin/mirror/precheck" && m === "POST") {
    json(res, 200, { findings: [] });
    return true;
  }
  if (p === "/api/admin/mirror/transcribe" && m === "POST") {
    // Voice input: proxy the multipart recording to Devin's real
    // transcribe-audio endpoint (same contract as the official webapp:
    // audio_file + start_time). The account session token rides Bearer;
    // api.devin.ai 422-verified the route exists.
    const key = ctx.accounts.apiKey();
    if (!key) { json(res, 503, { text: null, error: "no devin account available" }); return true; }
    try {
      const body = await readBody(req);
      const ct = req.headers["content-type"] ?? "multipart/form-data";
      const r = await fetch("https://api.devin.ai/transcribe-audio", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": ct },
        body,
        signal: AbortSignal.timeout(60_000),
      });
      const raw = await r.text();
      try {
        const j = JSON.parse(raw) as { text?: string; transcript?: string; detail?: unknown };
        const text = j.text ?? j.transcript ?? null;
        json(res, r.ok ? 200 : 502, { text, error: r.ok ? null : `upstream ${r.status}: ${raw.slice(0, 160)}` });
      } catch {
        json(res, r.ok ? 200 : 502, { text: r.ok ? raw : null, error: r.ok ? null : `upstream ${r.status}: ${raw.slice(0, 160)}` });
      }
    } catch (e) {
      json(res, 502, { text: null, error: e instanceof Error ? e.message : String(e) });
    }
    return true;
  }
  if (p === "/api/admin/mirror/translate" && m === "POST") {
    json(res, 200, UNSUPPORTED);
    return true;
  }

  return false;
}
