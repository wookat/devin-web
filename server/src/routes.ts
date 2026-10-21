import type { IncomingMessage, ServerResponse } from "node:http";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { AcpManager } from "./manager.js";
import { remapLegacyCwd, type Store } from "./store.js";
import type { WsHub } from "./ws.js";
import type { SessionLog } from "./sessionlog.js";
import type { DevinAcp } from "./acp.js";
import { serveUpload, stageUpload } from "./uploads.js";
import { buildSessionZip } from "./export.js";
import { agentById } from "./agents.js";
import { meta, saveReg } from "./dwstore.js";
import { AccountPool, fetchUserStatus, pkceFinish, pkceStart } from "./accounts.js";
import { isSessionPinned, hostFor, attachmentBlocks, promptWithRetry, isDraining, inflight, acpForId } from "./sessionio.js";
import type { UsageRecord } from "./types.js";

export interface ApiContext {
  store: Store;
  manager: AcpManager;
  accounts: AccountPool;
  /** Rotate to a healthy account + kill pooled devin processes. */
  rotate: (reason: string, target?: string) => string | null;
  hub: WsHub;
  sessionLog: SessionLog;
  appVersion: string;
  primaryCwd: string;
  devinCheck: () => Promise<unknown>;
  /** Install/auth status for every registered agent CLI. */
  agentsCheck: () => Promise<unknown[]>;
  /** sessionId → workspace cwd (learned from list/new/load). */
  sessionCwd: Map<string, string>;
  /** sessionId → ssh target (user@host) when the session's agent runs remote. */
  sessionSsh: Map<string, string>;
  /** permission requestId → owning acp process. */
  permissionOwner: Map<string, DevinAcp>;
}

function json(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" }).end(data);
}

async function readBody(req: IncomingMessage, limit = 10 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const buf = await readBody(req);
  if (buf.length === 0) return {};
  return JSON.parse(buf.toString("utf8"));
}

/** Resolve staged-upload references (`uploadId` or `/api/uploads/<id>` url)
 * into real ACP content blocks via the canonical attachmentBlocks path —
 * images inline as base64, small text as resource, rest as resource_link. */
async function normalizeBlocks(ctx: ApiContext, blocks: unknown[]): Promise<ContentBlock[]> {
  const out: ContentBlock[] = [];
  for (const raw of blocks) {
    const b = raw as Record<string, unknown>;
    const uploadId = typeof b.uploadId === "string" ? b.uploadId
      : typeof b.url === "string" && b.url.startsWith("/api/uploads/")
        ? decodeURIComponent(b.url.slice("/api/uploads/".length)) : null;
    if (uploadId) {
      const staged = await attachmentBlocks(ctx, [{ url: `/api/uploads/${encodeURIComponent(uploadId)}` }]);
      out.push(...(staged as unknown as ContentBlock[]));
    } else {
      out.push(raw as ContentBlock);
    }
  }
  return out;
}

async function acpForSession(ctx: ApiContext, sessionId: string, cwd?: string) {
  // Single-session agents run on a dedicated process — checked inside hostFor
  // too, but surface the ended-session semantics first.
  const rec = ctx.store.agentSession(sessionId);
  if (rec && !ctx.manager.forSession(sessionId)) {
    const agent = agentById(rec.agent);
    throw Object.assign(
      new Error(`this ${agent.label} session has ended — its history stays readable, but start a new session to continue`),
      { status: 409 },
    );
  }
  const dir = cwd ?? ctx.sessionCwd.get(sessionId);
  if (!ctx.manager.forSession(sessionId) && !dir) {
    throw Object.assign(new Error("unknown session — pass cwd"), { status: 400 });
  }
  // Canonical resolver — honors sessionHost pinning so a loaded session never
  // re-resolves onto a different pooled process (session_locked).
  return (await hostFor(ctx, sessionId, dir)).acp;
}

export async function handleApi(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const m = req.method ?? "GET";
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]

  try {
    // GET /api/meta
    if (m === "GET" && url.pathname === "/api/meta") {
      return json(res, 200, {
        app: { name: "devin-web", version: ctx.appVersion },
        devin: await ctx.devinCheck(),
        agents: await ctx.agentsCheck(),
        workspaces: ctx.store.workspaces(),
        processes: ctx.manager.status(),
        settings: ctx.store.settings,
        primaryCwd: ctx.primaryCwd,
      });
    }

    // GET /api/sessions — Devin's own list plus locally-tracked agent sessions.
    if (m === "GET" && url.pathname === "/api/sessions") {
      const aliases = ctx.store.aliases();
      const sessions: Array<Record<string, unknown>> = [];
      let devinError: string | null = null;
      try {
        const acp = await ctx.manager.get(ctx.primaryCwd);
        let cursor: string | undefined;
        do {
          const page = await acp.listSessions(cursor);
          for (const s of page.sessions) {
            // Don't overwrite the cwd of a session already pinned to a host —
            // a stale/rewritten list entry would bounce it to another process.
            if (!isSessionPinned(s.sessionId)) ctx.sessionCwd.set(s.sessionId, remapLegacyCwd(s.cwd));
            sessions.push({
              sessionId: s.sessionId,
              cwd: s.cwd,
              agent: "devin",
              title: s.title ?? null,
              alias: aliases[s.sessionId] ?? null,
              updatedAt: (s as { updatedAt?: string }).updatedAt ?? null,
            });
          }
          cursor = page.nextCursor ?? undefined;
        } while (cursor && sessions.length < 2000);
      } catch (err) {
        // Devin being missing/broken must not hide other agents' sessions.
        devinError = err instanceof Error ? err.message : String(err);
      }
      const known = new Set(sessions.map((s) => s.sessionId));
      for (const [sid, rec] of Object.entries(ctx.store.agentSessions())) {
        if (known.has(sid)) continue;
        ctx.sessionCwd.set(sid, remapLegacyCwd(rec.cwd));
        sessions.push({
          sessionId: sid,
          cwd: rec.cwd,
          agent: rec.agent,
          title: null,
          alias: aliases[sid] ?? null,
          updatedAt: new Date(rec.updatedAt).toISOString(),
          live: !!ctx.manager.forSession(sid),
        });
      }
      return json(res, 200, { sessions, devinError });
    }

    // POST /api/sessions {cwd, agent?}
    if (m === "POST" && url.pathname === "/api/sessions") {
      const body = await readJson(req);
      const cwd = String(body.cwd ?? ctx.primaryCwd);
      const agent = agentById(body.agent);
      ctx.store.addWorkspace(cwd);
      const acp = agent.multiSession
        ? await ctx.manager.get(cwd, agent)
        : await ctx.manager.startForSession(cwd, agent);
      const s = await acp.newSession(cwd);
      if (!agent.multiSession) {
        ctx.manager.bindSession(s.sessionId, acp);
        ctx.store.addAgentSession(s.sessionId, agent.id, cwd);
      }
      // Non-devin ownership goes into dw.json meta — hostFor reads it to
      // route ops to the right process (absent = devin), and the registry
      // entry keeps dedicated-agent sessions visible in the sidebar.
      if (agent.id !== "devin") {
        meta(ctx, s.sessionId).agent = agent.id;
        saveReg();
      }
      ctx.sessionCwd.set(s.sessionId, remapLegacyCwd(cwd));
      return json(res, 200, {
        sessionId: s.sessionId,
        cwd,
        agent: agent.id,
        modes: (s as { modes?: unknown }).modes ?? null,
      });
    }

    // /api/sessions/:id/...
    if (parts[1] === "sessions" && parts.length >= 4) {
      const id = decodeURIComponent(parts[2]);
      const action = parts[3];

      if (m === "POST" && action === "open") {
        // Single-session agents can't replay (no session/load) — the client
        // must treat WS events as live and read history from the local log.
        if (ctx.store.agentSession(id)) {
          return json(res, 409, { error: "session replay is not supported for this agent" });
        }
        const body = await readJson(req);
        const acp = await acpForSession(ctx, id, body.cwd as string | undefined);
        await acp.loadSession(id, acp.cwd);
        return json(res, 200, { ok: true });
      }

      if (m === "POST" && action === "prompt") {
        const body = await readJson(req);
        const blocks = await normalizeBlocks(ctx, (body.blocks as unknown[]) ?? []);
        if (blocks.length === 0) return json(res, 400, { error: "empty prompt" });
        if (isDraining()) return json(res, 503, { error: "server restarting" });
        // Mirror the user message into the session log for export/replay.
        for (const b of blocks) {
          if (b.type === "text") {
            ctx.sessionLog.append(id, {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: (b as { text: string }).text },
            });
          }
        }
        // Same retry policy as the wb /message route: on rate-limit the server
        // cools the failing account, rotates, and resends once itself.
        // Register in `inflight` for the await — the deploy drain must see
        // this turn (it otherwise exits mid-prompt and resets the client).
        let acp: DevinAcp | undefined;
        inflight.add(id);
        try {
          const done = await promptWithRetry(ctx, id,
            // acpForSession keeps the 409/400 guards; acpForId then pins +
            // loads so a never-loaded session doesn't session_not_found.
            async () => {
              await acpForSession(ctx, id, body.cwd as string | undefined);
              return (acp = await acpForId(ctx, id));
            },
            (a) => a.prompt(id, blocks));
          const usage = (done as { usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }).usage;
          if (usage?.totalTokens) {
            const rec: UsageRecord = {
              ts: Date.now(),
              sessionId: id,
              cwd: acp!.cwd,
              inputTokens: usage.inputTokens ?? 0,
              outputTokens: usage.outputTokens ?? 0,
              totalTokens: usage.totalTokens,
            };
            ctx.store.recordUsage(rec);
          }
          ctx.store.touchAgentSession(id);
          ctx.hub.broadcast({ type: "prompt_done", sessionId: id, result: done });
          return json(res, 200, done);
        } finally {
          inflight.delete(id);
        }
      }

      if (m === "POST" && action === "cancel") {
        const body = await readJson(req);
        const acp = await acpForSession(ctx, id, body.cwd as string | undefined);
        await acp.cancel(id);
        return json(res, 200, { ok: true });
      }

      if (m === "POST" && action === "rename") {
        const body = await readJson(req);
        const title = String(body.title ?? "").trim();
        // The local alias is authoritative; the remote rename is best-effort
        // (dead single-session agents can still be renamed locally).
        ctx.store.setAlias(id, title);
        let remote = false;
        try {
          const acp = await acpForSession(ctx, id, body.cwd as string | undefined);
          remote = title ? await acp.renameSession(id, title) : false;
        } catch {
          /* alias saved — that's enough */
        }
        return json(res, 200, { ok: true, remote });
      }

      if (m === "POST" && action === "config") {
        const body = await readJson(req);
        const acp = await acpForSession(ctx, id, body.cwd as string | undefined);
        const result = await acp.setConfigOption(id, String(body.configId), String(body.value));
        return json(res, 200, result ?? { ok: true });
      }

      if (m === "GET" && action === "export") {
        const zip = buildSessionZip(ctx.sessionLog, id, {
          cwd: ctx.sessionCwd.get(id) ?? null,
          alias: ctx.store.alias(id) ?? null,
          app: `devin-web ${ctx.appVersion}`,
        });
        res.writeHead(200, {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="devin-session-${id}.zip"`,
          "content-length": zip.length,
        });
        res.end(Buffer.from(zip));
        return;
      }

      if (m === "GET" && action === "history") {
        return json(res, 200, { updates: ctx.sessionLog.get(id).map((e) => e.update) });
      }
    }

    // POST /api/permissions/:requestId {optionId | null}
    if (m === "POST" && parts[1] === "permissions" && parts.length === 3) {
      const requestId = decodeURIComponent(parts[2]);
      const body = await readJson(req);
      const owner = ctx.permissionOwner.get(requestId);
      if (!owner) return json(res, 404, { error: "permission request expired" });
      const ok = owner.resolvePermission(requestId, (body.optionId as string | null) ?? null);
      ctx.permissionOwner.delete(requestId);
      ctx.hub.broadcast({ type: "permission_resolved", requestId });
      return json(res, ok ? 200 : 410, { ok });
    }

    // POST /api/uploads?filename=... (raw binary body)
    if (m === "POST" && url.pathname === "/api/uploads") {
      return json(res, 200, await stageUpload(req, ctx.store, url.searchParams.get("filename")));
    }

    // GET /api/uploads/:id
    if (m === "GET" && parts[1] === "uploads" && parts.length === 3) {
      return serveUpload(ctx.store, decodeURIComponent(parts[2]), res);
    }

    // GET /api/accounts — pool status (current, cooldowns, healthy) + quota info.
    if (m === "GET" && url.pathname === "/api/accounts") {
      const rows = ctx.accounts.status();
      return json(res, 200, {
        accounts: rows.map((a) => ({
          ...a,
          info: ctx.accounts.info(a.name), // cached; kicks refresh when stale
        })),
        // Display current: the in-use account even while it cools.
        current: rows.find((r) => r.current)?.name ?? ctx.accounts.pick(),
        picked: ctx.accounts.pick(),
        nextRecoveryAt: ctx.accounts.nextRecoveryAt(),
      });
    }

    // POST /api/accounts/rotate {target?} — manual rotation.
    if (m === "POST" && url.pathname === "/api/accounts/rotate") {
      const body = await readJson(req);
      const next = ctx.rotate("manual", body.target ? String(body.target) : undefined);
      if (!next) {
        return json(res, 409, {
          error: "no healthy account to rotate to",
          retryAfter: ctx.accounts.nextRecoveryAt(),
        });
      }
      return json(res, 200, { current: next, accounts: ctx.accounts.status() });
    }

    // POST /api/accounts/limited {name, retryAfter?} — mark an account cooling.
    if (m === "POST" && url.pathname === "/api/accounts/limited") {
      const body = await readJson(req);
      const name = String(body.name ?? "");
      if (!name) return json(res, 400, { error: "missing name" });
      ctx.accounts.markLimited(name, body.retryAfter ? Number(body.retryAfter) : null);
      return json(res, 200, { ok: true, accounts: ctx.accounts.status() });
    }

    // POST /api/accounts/unlimited {name} — clear a cooldown mark (bogus or
    // manually cleared when the account is known healthy).
    if (m === "POST" && url.pathname === "/api/accounts/unlimited") {
      const body = await readJson(req);
      const name = String(body.name ?? "");
      if (!name) return json(res, 400, { error: "missing name" });
      ctx.accounts.clearLimited(name);
      return json(res, 200, { ok: true, accounts: ctx.accounts.status() });
    }

    // POST /api/accounts {name, key} — add an account by pasting a session token.
    if (m === "POST" && url.pathname === "/api/accounts") {
      const body = await readJson(req);
      const name = String(body.name ?? "").trim();
      const key = String(body.key ?? "").trim();
      if (!name) return json(res, 400, { error: "missing name" });
      if (!key.startsWith("devin-session-token$"))
        return json(res, 400, { error: "key must be a devin-session-token$… token" });
      if (ctx.accounts.list().some((a) => a.name === name))
        return json(res, 409, { error: "account name already exists" });
      if (ctx.accounts.list().some((a) => a.key === key))
        return json(res, 409, { error: "this token is already registered" });
      ctx.accounts.add(name, key);
      const info = await ctx.accounts.refresh(name);
      return json(res, 200, { ok: true, name, info });
    }

    // DELETE /api/accounts/:name — remove an account.
    if (m === "DELETE" && url.pathname.startsWith("/api/accounts/")) {
      const name = decodeURIComponent(url.pathname.slice("/api/accounts/".length));
      if (!ctx.accounts.remove(name)) return json(res, 404, { error: "no such account" });
      return json(res, 200, { ok: true, accounts: ctx.accounts.status() });
    }

    // POST /api/accounts/login/start — begin a browser PKCE flow.
    if (m === "POST" && url.pathname === "/api/accounts/login/start") {
      const { url: loginUrl, id } = pkceStart();
      return json(res, 200, { url: loginUrl, id });
    }

    // POST /api/accounts/login/finish {id, code, name?} — complete PKCE, add account.
    if (m === "POST" && url.pathname === "/api/accounts/login/finish") {
      const body = await readJson(req);
      const id = String(body.id ?? "");
      const code = String(body.code ?? "").trim();
      let name = String(body.name ?? "").trim();
      if (!code) return json(res, 400, { error: "missing code" });
      let key: string;
      try {
        key = await pkceFinish(id, code);
      } catch (e) {
        return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
      if (ctx.accounts.list().some((a) => a.key === key))
        return json(res, 409, { error: "这个账号已在列表中" });
      // name it after the account email when not provided
      if (!name) {
        const info = await fetchUserStatus(key).catch(() => null);
        name = info?.email ?? info?.userName ?? `account-${id.slice(0, 6)}`;
      }
      if (ctx.accounts.list().some((a) => a.name === name)) name = `${name}-${id.slice(0, 4)}`;
      ctx.accounts.add(name, key);
      const info = await ctx.accounts.refresh(name);
      return json(res, 200, { ok: true, name, info });
    }

    // POST /api/accounts/refresh {name?} — force quota re-read (one or all).
    if (m === "POST" && url.pathname === "/api/accounts/refresh") {
      const body = await readJson(req).catch(() => ({} as Record<string, unknown>));
      const names = body.name
        ? [String((body as Record<string, unknown>).name)]
        : ctx.accounts.list().map((a) => a.name);
      const out: Record<string, unknown> = {};
      for (const n of names) out[n] = await ctx.accounts.refresh(n);
      return json(res, 200, { ok: true, info: out });
    }

    // GET /api/usage
    if (m === "GET" && url.pathname === "/api/usage") {
      const records = ctx.store.usage();
      const byDay: Record<string, { inputTokens: number; outputTokens: number; totalTokens: number; turns: number }> = {};
      let input = 0, output = 0;
      for (const r of records) {
        const day = new Date(r.ts).toISOString().slice(0, 10);
        (byDay[day] ??= { inputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 0 });
        byDay[day].inputTokens += r.inputTokens;
        byDay[day].outputTokens += r.outputTokens;
        byDay[day].totalTokens += r.totalTokens;
        byDay[day].turns += 1;
        input += r.inputTokens;
        output += r.outputTokens;
      }
      return json(res, 200, {
        totals: { inputTokens: input, outputTokens: output, totalTokens: input + output, turns: records.length },
        byDay,
        recent: records.slice(-200).reverse(),
      });
    }

    // GET/PUT /api/settings
    if (url.pathname === "/api/settings") {
      if (m === "GET") return json(res, 200, ctx.store.settings);
      if (m === "PUT" || m === "POST") {
        const body = await readJson(req);
        return json(res, 200, ctx.store.setSettings(body));
      }
    }

    json(res, 404, { error: `not found: ${m} ${url.pathname}` });
  } catch (err) {
    const e = err as { status?: number; details?: Record<string, unknown> };
    json(res, e.status ?? 500, { error: err instanceof Error ? err.message : String(err), ...e.details });
  }
}
