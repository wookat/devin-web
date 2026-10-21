/**
 * lweb/admin/persession — the /api/admin/session/:id/<sub> subtree:
 * detail, shared subs, file ops + workspace browser, timeline/index/changes
 * /todos, queue, subagents, config/version, permission/archive/fork/share,
 * and the cloud-only fallthrough.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ApiContext } from "../../routes.js";
import { saveReg, meta, noteLastUsed } from "../../dwstore.js";
import { noteUpdate, snapshotItems, buildMessages, buildTimeline, tlReset } from "../../dwtimeline.js";
import { hostFor, ensureLoaded, acpForId, restartSession, interruptedTurn } from "../../sessionload.js";
import { sessionConfig, sessionStatus, terminalBuf, cloudVersionToModel } from "../../sessionview.js";
import { subagentTimeline } from "../../sessionsub.js";
import { dispatchPrompt } from "../../sessionprompt.js";
import { queueList, queueAdd, queueRemove, queueFlush } from "../../sessionqueue.js";
import {loadInflight, markLoadedOn } from "../../sessionplace.js";
import { inflight, isDraining } from "../../sessionlive.js";
import { responseCfg, captureLoadResponse, type ConfigOption } from "../../sessioncfg.js";
import { personaState } from "../../persona.js";
import { agentById } from "../../agents.js";
import { handlePrRoute } from "../../pr.js";
import { json, readBody, readJson, UNSUPPORTED } from "../../httputil.js";
import {
  sessionSubs, handleSubSession, parseSubId, cwdFor, confined,
  subsAny, summarizeForFork, titleFromLog, lastContextUsage,
} from "../session.js";

/** file-git response cache — 8s per session (was lweb/common). */
const gitStatusCache = new Map<string, { at: number; body: unknown }>();

export async function handlePerSession(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL, m: string, p: string, parts: string[]): Promise<boolean> {
  // ======================= per-session routes =======================
  if (parts[2] === "session" && parts.length >= 4) {
    const id = decodeURIComponent(parts[3]);
    // Multi-segment subpath: "subagent/<aid>/timeline" etc.
    const sub = parts.slice(4).join("/");

    // sub:<parent>:<agentId> — a subagent as a first-class child session
    // (cloud parity: child sessions open as full session pages). Data
    // lives in the parent's log; unhandled subs fall through to the
    // generic handlers (files/file/file-raw work via cwdFor → parent cwd).
    const subRef = parseSubId(id);
    if (subRef) {

      if (await handleSubSession(ctx, subRef, id, sub, m, req, res, url)) return true;
    }

    // PR review endpoints (PrPanel) — GitHub data via `gh api`; the panel
    // sends pr_url, not the session's repo, so this stays session-agnostic
    // data plumbing inside the admin tree.
    if (sub === "pr" || sub.startsWith("pr-")) {
      if (await handlePrRoute(ctx, sub, m, req, res, url)) return true;
    }

    // GET /api/admin/session/:id — detail (slim or full). Memory-only:
    // this is also hit by sidebar prefetch; triggering a history replay
    // here would bump the session's updatedAt on every hover.
    if (!sub && m === "GET") {
      const items = buildTimeline(ctx, id).items;
      const mm = meta(ctx, id);
      const st = sessionStatus(ctx, id);
      const cfg = sessionConfig(ctx, id);
      json(res, 200, {
        session: {
          id, devin_session_id: id,
          title: mm.title ?? titleFromLog(ctx, id) ?? "Untitled session",
          devin_title: titleFromLog(ctx, id) ?? "Untitled session",
          permission: mm.permission ?? "detailed",
          archived: mm.archived ? 1 : 0,
          status: st.status, status_message: null,
          current_devin_version: cfg.model?.currentName ?? null,
          pull_requests: [], repos: [cwdFor(ctx, id)],
          cwd: cwdFor(ctx, id),
          is_locked: false,
          loaded_here: ctx.sessionLog.get(id).length > 0 || loadInflight.has(id) || inflight.has(id),
          context_usage: lastContextUsage(ctx, id),
          // Owning ACP agent — the client degrades devin-private UI
          // (share/end-session/subagents) for other agents' sessions.
          agent: mm.agent ?? ctx.store.agentSession(id)?.agent ?? "devin",
          // Fork = native session/fork or transcript-seed fallback; only
          // dedicated single-session agents can't host a second session.
          canFork: agentById(mm.agent ?? ctx.store.agentSession(id)?.agent).multiSession,
        },
        // Detail is polled every few seconds — the frontend only needs a
        // presence check / composer hint, not the whole transcript.
        messages: buildMessages(items.slice(-60)),
        share_url: mm.shared ? `/s/${id}?t=local` : null,
        dashboard_url: `/api/session/${id}/dashboard?token=local`,
        media_token: "local",
      });
      return true;
    }

    const sharedH = sessionSubs[`${sub}:${m}`];
    if (sharedH) { await sharedH(ctx, id, req, res, url); return true; }

    // Editor write/ops — ADMIN ONLY (never in sessionSubs: share links must
    // not write). All paths confined inside the session cwd.
    if (sub === "file-write" && m === "POST") {
      const body = await readJson(req);
      const cwd = cwdFor(ctx, id);
      const full = confined(cwd, body.path);
      if (!full) { json(res, 400, { error: "path escapes cwd" }); return true; }
      try {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        const buf = typeof body.base64 === "string" ? Buffer.from(body.base64, "base64") : Buffer.from(String(body.text ?? ""), "utf8");
        if (buf.length > 50 * 1024 * 1024) { json(res, 413, { error: "too large" }); return true; }
        fs.writeFileSync(full, buf);
        json(res, 200, { ok: true, size: buf.length });
      } catch (e) { json(res, 500, { error: (e as Error).message }); }
      return true;
    }
    if (sub === "file-ops" && m === "POST") {
      const body = await readJson(req);
      const cwd = cwdFor(ctx, id);
      const full = confined(cwd, body.path);
      if (!full) { json(res, 400, { error: "path escapes cwd" }); return true; }
      const dest = typeof body.to === "string" ? confined(cwd, body.to) : null;
      const needDest = body.op === "rename" || body.op === "move" || body.op === "copy";
      if (needDest && !dest) { json(res, 400, { error: "destination escapes cwd" }); return true; }
      try {
        switch (body.op) {
          case "rename": fs.renameSync(full, dest!); break;
          case "move": fs.renameSync(full, path.join(dest!, path.basename(full))); break;
          case "copy": fs.cpSync(full, dest!, { recursive: true }); break;
          case "mkdir": fs.mkdirSync(full, { recursive: true }); break;
          case "newfile": if (fs.existsSync(full)) { json(res, 409, { error: "exists" }); return true; } fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, ""); break;
          case "delete": fs.rmSync(full, { recursive: true, force: true }); break;
          default: json(res, 400, { error: `unknown op ${body.op}` }); return true;
        }
        json(res, 200, { ok: true });
      } catch (e) { json(res, 500, { error: (e as Error).message }); }
      return true;
    }

    // GET file-git — VSCode-style git status map for the workspace tree.
    // {git:false} for non-repo cwds; otherwise map relpath→status letter.
    if (sub === "file-git" && m === "GET") {
      const cwd = cwdFor(ctx, id);
      const cache = (gitStatusCache.get(id) ?? { at: 0, body: { git: false, map: {} } }) as { at: number; body: unknown };
      if (Date.now() - cache.at < 8000) { json(res, 200, cache.body); return true; }
      let body: { git: boolean; map: Record<string, string> } = { git: false, map: {} };
      try {
        const r = spawnSync("git", ["status", "--porcelain=v1", "-z", "--ignored=no"], { cwd, encoding: "buffer", timeout: 5000, windowsHide: true });
        if (r.status === 0 && r.stdout) {
          const map: Record<string, string> = {};
          const segs = r.stdout.toString("utf8").split("\0");
          for (let i = 0; i + 0 < segs.length; i++) {
            const line = segs[i];
            if (!line) continue;
            const x = line[0], y = line[1];
            const rel = line.slice(3);
            const st = y !== " " ? y : x;
            map[rel.replace(/\\/g, "/")] = st === "?" ? "U" : (st || "M");
            if (x === "R" || x === "C") i++; // rename/copy: skip the source path field
          }
          body = { git: true, map };
        }
      } catch { /* git absent or not a repo */ }
      gitStatusCache.set(id, { at: Date.now(), body });
      json(res, 200, body);
      return true;
    }

    if (sub === "timeline" && m === "GET") {
      // Kick off the replay but DON'T await it. While it runs, serve the
      // snapshot (pre-reload log / persisted tail) so the UI sits on the
      // newest messages instead of watching mid-history stream by; cold
      // sessions with no snapshot get a clean loading state rather than
      // old entries mislabeled as newest.
      // peek=1 — lazy read: serve snapshot/memory WITHOUT kicking off a
      // session/load (devin counts loads as activity and bumps the
      // session's updatedAt; casual browsing must stay free). The client
      // graduates to a real fetch on dwell/interaction.
      const peek = url.searchParams.get("peek") === "1";
      if (!peek) void ensureLoaded(ctx, id);
      const loading = !peek && loadInflight.has(id);
      const { items: live, gen } = buildTimeline(ctx, id);
      const snap = (loading || peek || !live.length) ? snapshotItems(ctx, id) : null;
      // During replay serve ONLY the old-gen snapshot; afterwards ONLY
      // the rebuilt live items — never mix generations. In peek mode the
      // snapshot wins unless the live log already holds more (newer) data.
      const serveSnap = !!snap && (loading || (peek && snap.length >= live.length));
      const all = serveSnap ? snap : live;
      // Consume the reset flag only when actually serving new-gen items.
      const reset = !loading && !serveSnap && tlReset.delete(id);
      // Page from the END (newest). `limit` items per page; `cursor` is the
      // exclusive upper index of the next-older page, so clients paging
      // backwards pass it back verbatim. Frozen (null) while a replay is
      // in flight — indexes shift mid-replay, so back-paging then would
      // land on misaligned slices.
      const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get("limit") ?? "300", 10) || 300));
      const cursor = url.searchParams.get("cursor");
      if (url.searchParams.get("raw") === "1") {
        json(res, 200, { entries: ctx.sessionLog.get(id) });
        return true;
      }
      const end = cursor !== null ? Math.min(all.length, Math.max(0, parseInt(cursor, 10) || 0)) : all.length;
      const start = Math.max(0, end - limit);
      const items = loading && !snap ? [] : all.slice(start, end);
      const st = sessionStatus(ctx, id);
      json(res, 200, {
        items,
        // Peek pages can't back-page: snapshot indexes don't line up with
        // the live log, so older history needs a real (loading) fetch.
        next_cursor: !loading && !peek && start > 0 ? String(start) : null,
        error: null, queue: queueList(id),
        // `reset` tells clients the log was rebuilt (replay / disk
        // re-seed): merge must be replaced wholesale or stale-window
        // items linger next to their seq-id twins.
        reset: reset || undefined,
        // Generation of the items actually served (0 = snapshot);
        // timeline_delta events carry the same marker.
        gen: serveSnap ? 0 : gen,
        peek: peek || undefined,
        activity: loading ? { text: "Loading history…" } : st.status === "working" ? { text: "working" } : null,
        // A turn that died mid-flight (server crash / killed acp) — the
        // original message so the client can offer one-click resend.
        interrupted: interruptedTurn(ctx, id) ?? undefined,
        persona: personaState(ctx, id),
      });
      return true;
    }

    // GET .../index — full-history session index (official historySkeleton
    // parity): every user message + PR event across the whole log, not
    // just the loaded window. Fields mirror what the client indexEntries
    // merge needs (id/ts/kind/body/pr) with body truncated server-side.
    if (sub === "index" && m === "GET") {
      const { items } = buildTimeline(ctx, id);
      const entries = items
        .filter((it) => (it.kind === "message" && it.role === "user") || (it.kind === "git" && it.raw_type === "pr_created"))
        .map((it) => ({
          id: it.id, ts: it.ts, kind: it.kind, raw_type: it.raw_type,
          role: it.role,
          body: it.body ? it.body.slice(0, 1200) : undefined,
        }));
      json(res, 200, { entries });
      return true;
    }

    if (sub === "changes" && m === "GET") {
      // Memory-only panel data — replay is already driven by /timeline.
      const items = buildTimeline(ctx, id).items;
      const files = new Map<string, { path: string; added: number; removed: number; firstPrevKey?: string; lastKey?: string; actionType?: string }>();
      for (const it of items) {
        if (it.kind !== "edit") continue;
        for (const f of it.fileUpdates ?? []) {
          const cur = files.get(f.file_path) ?? { path: f.file_path, added: 0, removed: 0 };
          cur.added += f.lines_added ?? 0;
          cur.removed += f.lines_removed ?? 0;
          cur.lastKey = f.fileId;
          files.set(f.file_path, cur);
        }
      }
      json(res, 200, { files: [...files.values()], truncated: false, error: null });
      return true;
    }

    if (sub === "todos" && m === "GET") {
      const items = buildTimeline(ctx, id).items;
      const last = [...items].reverse().find((i) => i.kind === "todo" && i.todos?.length);
      json(res, 200, { todos: last?.todos ?? [] });
      return true;
    }

    if (sub === "queue" && m === "GET") {
      json(res, 200, { queue: queueList(id) });
      return true;
    }
    // POST .../queue {message} — park a prompt while a turn is in flight;
    // dispatchPrompt's settle path flushes it FIFO (queueFlush).
    if (sub === "queue" && m === "POST") {
      const body = (await readJson(req)) as { message?: string };
      const text = (body.message ?? "").trim();
      if (!text) { json(res, 400, { error: "empty message" }); return true; }
      if (isDraining()) { json(res, 503, { error: "server restarting" }); return true; }
      if (!inflight.has(id) && !queueList(id).length) {
        dispatchPrompt(ctx, id, text, []);
        json(res, 200, { ok: true, sent: true });
        return true;
      }
      const m2 = queueAdd(ctx, id, text);
      if (!inflight.has(id)) queueFlush(ctx, id); // idle + stale queue → keep FIFO moving
      json(res, 200, { ok: true, id: m2.id });
      return true;
    }
    if (sub === "queue-op" && m === "POST") {
      const body = (await readJson(req)) as { op?: string; id?: string; ids?: string[]; message?: string };
      const q = queueList(id);
      switch (body.op) {
        case "remove": queueRemove(ctx, id, body.id ?? ""); break;
        case "clear": for (const m2 of [...q]) queueRemove(ctx, id, m2.id); break;
        case "edit": { const m2 = q.find((x) => x.id === body.id); if (m2 && body.message) m2.text = body.message; break; }
        case "reorder": {
          if (Array.isArray(body.ids)) {
            const byId = new Map(q.map((x) => [x.id, x]));
            const next = body.ids.map((x) => byId.get(x)).filter((x): x is NonNullable<typeof x> => !!x);
            q.splice(0, q.length, ...next);
          }
          break;
        }
        case "send_now": {
          if (isDraining()) break;
          // Two shapes: {id} pulls a queued row; {message} is the
          // draft-free "send immediately" path. Busy → cancel the live
          // turn so settle→queueFlush fires the front item right away
          // ("立即发送" really interrupts); idle → dispatch directly.
          const i = q.findIndex((x) => x.id === body.id);
          let armed = false;
          if (i >= 0) {
            const [m2] = q.splice(i, 1);
            q.unshift(m2);
            armed = true;
          } else if (typeof body.message === "string" && body.message.trim()) {
            const m2 = queueAdd(ctx, id, body.message.trim());
            q.splice(q.indexOf(m2), 1);
            q.unshift(m2);
            armed = true;
          }
          if (!armed) break;
          if (inflight.has(id)) {
            try { (await acpForId(ctx, id)).cancel(id); } catch { /* not running */ }
          } else {
            queueFlush(ctx, id);
          }
          break;
        }
        default: break; // hold/unhold are client-side edit state
      }
      json(res, 200, { ok: true });
      return true;
    }

    if (sub === "sidechains" && m === "GET") {
      json(res, 200, { threads: [] });
      return true;
    }
    if ((sub === "sidechain" || sub === "sidechain/cancel") && m === "POST") {
      json(res, 200, sub === "sidechain" ? UNSUPPORTED : { ok: true });
      return true;
    }

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
      const [rules, skills, profiles, plans, hooks, config] = await Promise.all([
        call("rules", "_cognition.ai/rules/list", [{ sessionId: id, cwd }, { cwd }, {}]),
        call("skills", "_cognition.ai/skills/list", [{ sessionId: id, cwd }, { cwd }]),
        call("subagentProfiles", "_cognition.ai/subagents/list", [{ sessionId: id, cwd }, { cwd }]),
        call("plans", "_cognition.ai/plans/list", [{ sessionId: id, cwd }, { cwd }, {}]),
        call("hooks", "_cognition.ai/hooks/list", [{ sessionId: id, cwd }, { cwd }, {}]),
        call("config", "_cognition.ai/config/read", [{ sessionId: id }, {}]),
      ]);
      json(res, 200, {
        rules: rules?.rules ?? null,
        skills: skills?.skills ?? null,
        subagentProfiles: profiles?.subagents ?? profiles?.profiles ?? null,
        plans: plans?.plans ?? null,
        hooks: hooks?.hooks ?? null,
        config: config?.config ?? null,
        ...(Object.keys(errors).length ? { errors } : {}),
      });
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
      const result = isMode
        ? await acp.setMode(id, value)
        : await acp.setConfigOption(id, configId, value);
      // setSessionConfigOption returns the full refreshed configOptions — keep them.
      const ropts = (result as { configOptions?: ConfigOption[] } | null)?.configOptions;
      if (ropts) responseCfg.set(id, { ...(responseCfg.get(id) ?? {}), configOptions: ropts, echoTs: Date.now() });
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
      ctx.hub.broadcast({ type: "session_update", sessionId: id, update: { sessionUpdate: "config_option_update", configOptions: ropts ?? [] } });
      json(res, 200, result ?? { ok: true });
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

    if (sub === "archive" && m === "POST") {
      const body = await readJson(req);
      meta(ctx, id).archived = !!body.archived;
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

    // Workspace file browser — the session's project tree mapped into the
    // panel. Confined to the session cwd; never touches acp state.
    if (sub === "files" && m === "GET") {
      const cwd = cwdFor(ctx, id);
      const rel = url.searchParams.get("path") ?? "";
      try {
        const dir = path.resolve(cwd, rel);
        const relCheck = path.relative(cwd, dir);
        if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) throw new Error("escapes workspace");
        const ents = await fs.promises.readdir(dir, { withFileTypes: true });
        const entries = ents
          .filter((e) => !e.name.startsWith(".") || url.searchParams.get("all") === "1")
          .map((e) => {
            let size = 0, mtime = "";
            try { const s = fs.statSync(path.join(dir, e.name)); size = s.size; mtime = s.mtime.toISOString(); } catch { /* gone */ }
            return { name: e.name, dir: e.isDirectory(), size, mtime };
          })
          .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
        json(res, 200, { cwd, path: relCheck.replace(/\\/g, "/"), entries, error: null });
      } catch (e) {
        json(res, 200, { cwd, path: rel, entries: [], error: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }
    if (sub === "file" && m === "GET") {
      const cwd = cwdFor(ctx, id);
      const rel = url.searchParams.get("path") ?? "";
      try {
        const file = path.resolve(cwd, rel);
        const relCheck = path.relative(cwd, file);
        if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) throw new Error("escapes workspace");
        const stat = fs.statSync(file);
        if (stat.isDirectory()) throw new Error("is a directory");
        if (stat.size > 2 * 1024 * 1024) { json(res, 200, { path: rel, text: null, truncated: false, tooLarge: true, size: stat.size }); return true; }
        const buf = fs.readFileSync(file);
        const text = buf.includes(0) ? null : buf.toString("utf8");
        json(res, 200, { path: rel, text, truncated: stat.size > 512 * 1024 ? true : false, binary: text === null, size: stat.size });
      } catch (e) {
        json(res, 200, { path: rel, text: null, error: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }

    if (sub === "presign" && m === "POST") {
      json(res, 200, { urls: {} });
      return true;
    }

    if (sub === "terminal" && m === "GET") {
      const pid = url.searchParams.get("pid") ?? "";
      const buf = terminalBuf.get(pid);
      // fall back to the latest shell output embedded in the tool update
      let text = buf?.text ?? null;
      if (!text) {
        const items = buildTimeline(ctx, id).items;
        const shell = [...items].reverse().find((i) => i.kind === "shell" && i.processId === pid);
        text = shell?.output ?? null;
      }
      json(res, 200, { text, next_cursor: null });
      return true;
    }
    if (sub === "live-desktop" && m === "GET") {
      json(res, 200, { error: null, url: null });
      return true;
    }

    // cloud-only endpoints: PR review, env suggestions, translations…
    if (m === "POST") await readBody(req);
    json(res, 200, UNSUPPORTED);
    return true;
  }

  return false;
}
