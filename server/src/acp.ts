import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import { Readable, Writable, Transform } from "node:stream";
import type { ReadableStream, WritableStream } from "node:stream/web";
import { EventEmitter } from "node:events";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import type { TerminalRunner } from "./terminal.js";
import { DEFAULT_AGENT, agentCommandLine, type AgentDef } from "./agents.js";
import { sshSpawn } from "./ssh.js";
import { featureEnabled } from "./edition.js";
import { dashboardMcpOn } from "./env.js";
import { brokerEnabled, brokerSpawn, brokerAttach, brokerOnExit, type ProcHandle } from "./acpbroker.js";

// Dashboard MCP: injected into every session/new so agents can push the
// kanban (widgets) without the raw HTTP push API. Lives outside dist/, so
// the path resolves off the compiled module's location. Opt-IN via
// DEVIN_WEB_DASHBOARD_MCP=1 — the plain file convention is the default
// write path (no resident process, works on pre-existing sessions).
const DASHBOARD_MCP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "dashboard-mcp.mjs");
function dashboardMcpServers(cwd: string): { name: string; command: string; args: string[]; env: { name: string; value: string }[] }[] {
  if (!featureEnabled("dashboardMcp") || !dashboardMcpOn() || !existsSync(DASHBOARD_MCP)) return [];
  return [{ name: "devin-web-dashboard", command: process.execPath, args: [DASHBOARD_MCP], env: [{ name: "DEVIN_WEB_SESSION_CWD", value: cwd }] }];
}

export interface DevinAcpEvents {
  onSessionUpdate: (sessionId: string, update: unknown) => void;
  onAgentLog: (sessionId: string, channel: string, message: string, level: string) => void;
  onPermissionRequest: (
    requestId: string,
    sessionId: string,
    toolCall: unknown,
    options: Array<{ optionId: string; name: string; kind: string }>,
  ) => void;
  /** Fired when a pending request is resolved without the client (timeout, process exit). */
  onPermissionResolved: (requestId: string) => void;
  /** The ACP wire never links a terminal back to its tool_call — journal the
   * create (command line included) so the timeline can bind terminalId →
   * shell item and show real stdout instead of "Exited with code N". */
  onTerminalCreate: (terminalId: string, sessionId: string, command: string) => void;
  onTerminalOutput: (terminalId: string, sessionId: string, data: string) => void;
  onTerminalExit: (terminalId: string, sessionId: string, exitCode: number | null, signal: string | null) => void;
  /** Wire-sniffed client→agent `session/prompt` request: `requestId` is the
   * JSON-RPC id this connection dispatched the turn under — consumers
   * journal it on the session's open-turn entry so a response that outlives
   * the byte stream (dead window over a restart) can still be correlated. */
  onPromptRequest: (acp: DevinAcp, sessionId: string, requestId: number | string) => void;
  /** Wire-sniffed agent→client JSON-RPC response. `sessionId` is set when
   * the id matches a request THIS connection sent; null when the id is
   * unknown to the connection — the dead-window case (the SDK drops those
   * as "response to unknown request", but they may answer a journaled
   * open turn from the previous backend's connection). */
  onPromptResponse: (
    acp: DevinAcp,
    requestId: number | string,
    sessionId: string | null,
    ok: boolean,
    errorMessage?: string,
  ) => void;
  onExit: (code: number | null) => void;
}

let permissionSeq = 0;

// Wire-sniffer substring prefilters (same trick as acp-broker.mjs): a JSON-RPC
// frame is only parsed when the tag bytes are actually present.
const METHOD_TAG = Buffer.from('"method"');
const ID_TAG = Buffer.from('"id"');
const RESULT_TAG = Buffer.from('"result"');
const ERROR_TAG = Buffer.from('"error"');

/** Pipe the broker's control-channel exit event into the fake proc's 'exit'
 * so DevinAcp's real code + cleanup lands (socket 'close' also emits
 * exit(null) — init's `finished` guard dedupes whichever arrives second). */
async function wireBrokerExit(acpId: string, proc: ProcHandle): Promise<void> {
  const off = await brokerOnExit((id, code) => {
    if (id !== acpId) return;
    proc.emit("exit", code);
    off();
  });
  // The socket-close path can emit exit before the ctl event arrives — drop
  // the ctl subscriber either way so it doesn't leak on the shared channel.
  proc.on("exit", () => off());
}

/**
 * One ACP agent child process (`devin acp`, `prime-agent --mode acp`, ...)
 * bound to a workspace directory, with a typed ACP client connection on top
 * of its stdio.
 */
type PendingPermission = {
  resolve: (r: acp.RequestPermissionResponse) => void;
  timer: NodeJS.Timeout;
};

export class DevinAcp {
  private proc: ProcHandle;
  private conn: acp.ClientSideConnection;
  private pendingPermissions: Map<string, PendingPermission>;
  readonly cwd: string;
  readonly agent: AgentDef;
  capabilities: acp.InitializeResponse | null = null;
  exited = false;
  /** Broker-owned acp id (DEVIN_WEB_ACP_BROKER mode); null for direct spawn. */
  brokerId: string | null = null;
  /** Sessions with an in-flight prompt on this process. A pooled acp hosts
   * several sessions — rotation/restart must not hard-kill it while any are
   * mid-turn (that cuts every live turn, including the caller's own). */
  busySessions = new Set<string>();
  /** Set when a kill was requested while turns were in flight — the process
   * is unpooled immediately but dies only once the last turn settles. */
  retireAfterIdle = false;
  /** JSON-RPC requests THIS connection sent without yet seeing a response —
   * reqId (a per-connection counter) → {method, sessionId}. Written by the
   * wire sniffer, reaped on response or exit; lets an inbound response be
   * attributed to the method (and prompt session) that asked for it. */
  readonly pendingReqs = new Map<string, { method: string; sessionId?: string }>();

  private constructor(
    cwd: string,
    agent: AgentDef,
    proc: ProcHandle,
    conn: acp.ClientSideConnection,
    pendingPermissions: Map<string, PendingPermission>,
  ) {
    this.cwd = cwd;
    this.agent = agent;
    this.proc = proc;
    this.conn = conn;
    this.pendingPermissions = pendingPermissions;
  }

  /** Which pool account this process was launched with (key injected via env). */
  account: string | null = null;

  /** OS pid of the wrapped child — diagnostics only. */
  get pid(): number { return this.proc.pid ?? 0; }

  /** Broker-mode received-byte counter (0 for direct spawns) — persisted on
   *  graceful exit so adoption resumes the stream exactly where it left. */
  get bytesReceived(): number { return this.proc.bytesReceived?.() ?? 0; }

  static async start(
    cwd: string,
    terminal: TerminalRunner,
    ev: DevinAcpEvents,
    agent: AgentDef = DEFAULT_AGENT,
    extraEnv: Record<string, string> = {},
    account: string | null = null,
    /** user@host[:port] / ssh config alias — the agent CLI runs on the REMOTE
     *  host via `ssh <target> <agentLine>`; stdio is the same ACP pipe. */
    ssh: string | null = null,
    /** Manager pool key — journaled through the broker so a post-restart
     *  backend can re-map a surviving acp to its pool slot. */
    poolKey?: string,
  ): Promise<DevinAcp> {
    // Broker mode: the broker process owns the child — a backend restart
    // leaves it alive and the next boot adopts it (see adoptBrokered). SSH
    // agents stay direct: ssh2-shim channels are in-process objects, not
    // child processes a broker can hold. A broker outage degrades to DIRECT
    // spawn rather than a failed spawn — the ctl channel self-heals on the
    // next attempt (turns just lose restart-survival for this process).
    if (brokerEnabled && !ssh) {
      try {
        return await DevinAcp.startBrokered(cwd, terminal, ev, agent, extraEnv, account, poolKey);
      } catch (e) {
        console.warn(`[acp] broker spawn failed (${String((e as Error)?.message ?? e).slice(0, 120)}) — falling back to direct spawn`);
      }
    }
    // Windows npm CLIs are .cmd/.ps1 shims — Node ≥20.12 refuses to spawn
    // them without a shell (EINVAL). agent.shell routes through %ComSpec%.
    const spawnOpts = {
      cwd: ssh ? os.homedir() : cwd,
      // devin's stderr is extremely verbose (chisel debug logs, tens of
      // thousands of lines per session load). Pipe + drain instead of
      // inheriting — console writes on Windows are slow and were measurable
      // jank during loadSession replays.
      stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv },
      windowsHide: true,
    };
    const proc: ChildProcessByStdio<Writable, Readable, Readable> = ssh
      // sshSpawn: OpenSSH binary for agent-auth hosts (user's own keys/config),
      // the ssh2 channel shim for password/key records — same ChildProcess
      // shape, so the ndJson pipe wiring below is unchanged.
      ? await sshSpawn(ssh, agentCommandLine(agent), spawnOpts)
      : agent.shell
        ? (spawn(agentCommandLine(agent), { ...spawnOpts, shell: true }) as ChildProcessByStdio<Writable, Readable, Readable>)
        : spawn(agent.command, agent.args, spawnOpts);
    return DevinAcp.init(cwd, terminal, ev, agent, proc, account);
  }

  /** Broker-mode spawn: ctl spawn → data attach → shared init handshake. */
  static async startBrokered(
    cwd: string,
    terminal: TerminalRunner,
    ev: DevinAcpEvents,
    agent: AgentDef,
    extraEnv: Record<string, string>,
    account: string | null,
    poolKey?: string,
  ): Promise<DevinAcp> {
    const { acpId } = await brokerSpawn({
      cwd, command: agent.command, args: agent.args, env: extraEnv,
      shell: agent.shell === true, cmdline: agent.shell ? agentCommandLine(agent) : undefined, key: poolKey, account,
    });
    const { proc } = await brokerAttach(acpId, 0);
    const self = await DevinAcp.init(cwd, terminal, ev, agent, proc, account);
    self.brokerId = acpId;
    void wireBrokerExit(acpId, proc).catch(() => {});
    return self;
  }

  /** Re-attach to a broker acp that outlived a backend restart. The process
   * is already initialized — a second initialize on the fresh byte stream may
   * or may not answer, so tolerate its failure and degrade capabilities. */
  static async adoptBrokered(
    cwd: string,
    terminal: TerminalRunner,
    ev: DevinAcpEvents,
    agent: AgentDef,
    acpId: string,
    after: number,
    account: string | null = null,
  ): Promise<DevinAcp> {
    const { proc } = await brokerAttach(acpId, after);
    const self = await DevinAcp.init(cwd, terminal, ev, agent, proc, account, true);
    self.brokerId = acpId;
    void wireBrokerExit(acpId, proc).catch(() => {});
    return self;
  }

  /** Shared wiring: client handlers → ndJson stream → conn → handshake →
   * exit bookkeeping. `tolerateInit` lets adopted (already-handshaken) acp
   * past a refused second initialize with null capabilities. */
  private static async init(
    cwd: string,
    terminal: TerminalRunner,
    ev: DevinAcpEvents,
    agent: AgentDef,
    proc: ProcHandle,
    account: string | null,
    tolerateInit = false,
  ): Promise<DevinAcp> {
    const pendingPermissions = new Map<string, PendingPermission>();
    proc.stderr?.on("data", () => { /* drain: see stdio note above */ });
    const spawnedAccount = account;

    const client: acp.Client = {
      sessionUpdate: (params) => {
        // Keep params-level _meta too — devin stamps eventId/timestamp/sidechain
        // coordinates on the notification params, not only on update._meta.
        const u = params.update as Record<string, unknown>;
        const pm = (params as { _meta?: Record<string, unknown> })._meta;
        if (pm && u && typeof u === "object") {
          const um = (u._meta ?? {}) as Record<string, unknown>;
          u._meta = { ...pm, ...um };
        }
        ev.onSessionUpdate(params.sessionId, u);
      },

      requestPermission: (params) => {
        const requestId = `perm-${Date.now()}-${permissionSeq++}`;
        const options = (params.options ?? []).map((o) => ({
          optionId: o.optionId,
          name: o.name,
          kind: String(o.kind),
        }));
        ev.onPermissionRequest(requestId, params.sessionId, params.toolCall, options);
        return new Promise<acp.RequestPermissionResponse>((resolve) => {
          const timer = setTimeout(() => {
            pendingPermissions.delete(requestId);
            resolve({ outcome: { outcome: "cancelled" } });
            ev.onPermissionResolved(requestId);
          }, 5 * 60 * 1000);
          pendingPermissions.set(requestId, { resolve, timer });
        });
      },

      readTextFile: async (params) => {
        const p = confine(cwd, params.path);
        const content = await fs.readFile(p, "utf8");
        if (params.line == null && params.limit == null) return { content };
        const lines = content.split("\n");
        const start = Math.max(0, (params.line ?? 1) - 1);
        const slice = params.limit == null ? lines.slice(start) : lines.slice(start, start + params.limit);
        return { content: slice.join("\n") };
      },

      writeTextFile: async (params) => {
        const p = confine(cwd, params.path);
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, params.content, "utf8");
      },

      createTerminal: async (params) => {
        return terminal.create(cwd, params, ev);
      },
      terminalOutput: async (params) => terminal.output(params.terminalId),
      waitForTerminalExit: async (params) => terminal.waitForExit(params.terminalId),
      killTerminal: async (params) => {
        terminal.kill(params.terminalId);
      },
      releaseTerminal: async (params) => {
        terminal.release(params.terminalId);
      },
    };

    // Extension notifications from devin (agent log channel, MCP changes, ...).
    const clientWithExt = client as acp.Client & {
      extNotification?: (method: string, params: Record<string, unknown>) => void;
    };
    clientWithExt.extNotification = (method, params) => {
      if (method === "_cognition.ai/output") {
        ev.onAgentLog(
          String(params.sessionId ?? ""),
          String(params.channel ?? ""),
          String(params.message ?? ""),
          String(params.level ?? "info"),
        );
      }
    };

    // ---- wire sniffer -------------------------------------------------------
    // Tap the raw stdio BEFORE the web-stream adapters: outbound request
    // frames (stdin write wrap) are recorded in `self.pendingReqs`, inbound
    // frames (a PassThrough-style Transform tee on stdout) resolve them.
    // This is what lets a session/prompt response emitted during a backend
    // restart be attributed to its turn: the frame arrives on the NEW
    // connection carrying an id it never sent — the SDK drops it as
    // "response to unknown request", but the sniffer still sees it.
    // Sniffing is strictly passive — the tee forwards every byte in order
    // and the stdin wrap only observes chunks before forwarding them.
    let inBuf = Buffer.alloc(0);
    const sniffOutLine = (line: Buffer) => {
      if (!line.includes(METHOD_TAG) || !line.includes(ID_TAG)) return;
      let m: Record<string, unknown>;
      try { m = JSON.parse(line.toString("utf8")) as Record<string, unknown>; } catch { return; }
      if (m == null || (typeof m.id !== "number" && typeof m.id !== "string") || typeof m.method !== "string") return;
      const rec: { method: string; sessionId?: string } = { method: m.method };
      if (m.method === "session/prompt") {
        const sid = (m.params as { sessionId?: unknown } | undefined)?.sessionId;
        if (typeof sid === "string" && sid) rec.sessionId = sid;
      }
      self.pendingReqs.set(String(m.id), rec);
      if (rec.sessionId) ev.onPromptRequest(self, rec.sessionId, m.id);
    };
    let outBuf = Buffer.alloc(0);
    const sniffInLine = (line: Buffer) => {
      // Prefilter: every notification frame carries "method" (tool output
      // inside it routinely contains "id"/"result"/"error" text) — skip it
      // before JSON.parse. A response carries "id" + ("result"|"error").
      if (line.includes(METHOD_TAG) || !line.includes(ID_TAG)) return;
      if (!line.includes(RESULT_TAG) && !line.includes(ERROR_TAG)) return;
      let m: Record<string, unknown>;
      try { m = JSON.parse(line.toString("utf8")) as Record<string, unknown>; } catch { return; }
      if (m == null || (typeof m.id !== "number" && typeof m.id !== "string") || m.method != null) return;
      if (!("result" in m) && !("error" in m)) return;
      const ok = "result" in m;
      const errMsg = !ok && m.error && typeof m.error === "object"
        ? String((m.error as { message?: unknown }).message ?? "request failed")
        : undefined;
      const key = String(m.id);
      const rec = self.pendingReqs.get(key);
      if (rec) {
        self.pendingReqs.delete(key);
        if (rec.method === "session/prompt" && rec.sessionId) {
          ev.onPromptResponse(self, m.id, rec.sessionId, ok, errMsg);
        }
      } else {
        // Unknown to this connection — maybe a dead-window prompt response
        // for a journaled open turn; the consumer decides via reqId lookup.
        ev.onPromptResponse(self, m.id, null, ok, errMsg);
      }
    };
    const sniffChunk = (c: unknown): Buffer =>
      Buffer.isBuffer(c) ? c : typeof c === "string" ? Buffer.from(c, "utf8") : Buffer.from(c as Uint8Array);
    const procStdin = proc.stdin!;
    const rawWrite = procStdin.write.bind(procStdin) as (chunk: unknown, ...rest: unknown[]) => boolean;
    (procStdin as unknown as { write: (chunk: unknown, ...rest: unknown[]) => boolean }).write = (chunk, ...rest) => {
      try {
        inBuf = Buffer.concat([inBuf, sniffChunk(chunk)]);
        for (;;) {
          const nl = inBuf.indexOf(0x0a);
          if (nl < 0) break;
          const line = inBuf.subarray(0, nl);
          inBuf = inBuf.subarray(nl + 1);
          sniffOutLine(line);
        }
      } catch { /* sniffing never disturbs the wire */ }
      return rawWrite(chunk, ...rest);
    };
    const stdoutTee = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        try {
          outBuf = Buffer.concat([outBuf, chunk]);
          for (;;) {
            const nl = outBuf.indexOf(0x0a);
            if (nl < 0) break;
            const line = outBuf.subarray(0, nl);
            outBuf = outBuf.subarray(nl + 1);
            sniffInLine(line);
          }
        } catch { /* sniffing never disturbs the wire */ }
        cb(null, chunk);
      },
    });
    // Route agent output THROUGH the tee — the SDK consumes the tee (bytes
    // unchanged, 'data' stays fully delivered), the sniffer taps frames.
    // Works identically for ChildProcess pipes and broker attach sockets.
    proc.stdout!.on("error", (e) => stdoutTee.destroy(e));
    proc.stdout!.pipe(stdoutTee);

    const input = Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>;
    const output = Readable.toWeb(stdoutTee) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);
    const conn = new acp.ClientSideConnection(() => clientWithExt, stream);

    const self = new DevinAcp(cwd, agent, proc, conn, pendingPermissions);
    self.account = spawnedAccount;
    let handshaken = false;
    let failStart: (err: Error) => void = () => {};
    const startFailed = new Promise<never>((_, reject) => {
      failStart = reject;
    });
    // `finished` guards the cleanup body — self.exited is set eagerly by
    // kill() so host checks see the process as dead immediately, but the
    // real 'exit' event must still run this once.
    let finished = false;
    const finish = (code: number | null, err?: Error) => {
      if (finished) return;
      finished = true;
      self.exited = true;
      for (const [requestId, p] of self.pendingPermissions) {
        clearTimeout(p.timer);
        p.resolve({ outcome: { outcome: "cancelled" } });
        ev.onPermissionResolved(requestId);
      }
      self.pendingPermissions.clear();
      self.pendingReqs.clear();
      if (!handshaken) {
        failStart(err ?? new Error(`${agent.command} exited (code ${code}) before the ACP handshake completed`));
      }
      ev.onExit(code);
    };
    // A missing binary emits 'error' (no 'exit'); a broken install exits
    // before the handshake. Either way the server must survive and start()
    // must reject instead of hanging.
    proc.on("error", (procErr) => {
      finish(null, new Error(`failed to start ${agent.command}: ${procErr.message}`));
      // 'error' does not imply the child died (post-spawn stdio errors) —
      // we just declared it dead, so make that true rather than leak it.
      self.kill();
    });
    proc.on("exit", (code) => finish(code));
    proc.stdin!.on("error", () => {});
    proc.stdout!.on("error", () => {});

    try {
      self.capabilities = await Promise.race([
        conn.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true,
            _meta: {
              // Declare support for devin's extension surfaces so the agent
              // emits subagent/chain/sidechain events and accepts control
              // calls. Mirrors what devin desktop declares at handshake.
              "cognition.ai/subagentSupport": true,
              "cognition.ai/subagentControl": true,
              "cognition.ai/chains": true,
              "cognition.ai/sidechains": true,
              "cognition.ai/messageGrouping": true,
              "cognition.ai/partialContent": true,
              "cognition.ai/clarificationRequested": true,
            },
          },
          clientInfo: { name: "devin-web", version: "0.1.0" },
        }),
        startFailed,
        // An alive-but-unanswering acp (wedged devin) must not hang init —
        // an unbounded handshake stalls adoption and pools the never-
        // settling promise in manager.starting forever.
        new Promise<never>((_, rej) => {
          const t = setTimeout(() => rej(new Error("acp initialize timeout (30s)")), 30_000);
          t.unref();
        }),
      ]);
    } catch (err) {
      if (!tolerateInit) {
        // Never leave an orphaned child when the handshake fails.
        self.kill();
        throw err;
      }
      // Adopted broker acp were initialized on their original byte stream —
      // some agents refuse a second initialize. The connection still answers
      // every other RPC, so degrade caps and carry on.
      console.warn(`[acp] adopted ${agent.id} refused re-initialize (${String((err as Error)?.message ?? err).slice(0, 120)}) — running with cached/no capabilities`);
      self.capabilities = null;
    }
    handshaken = true;
    return self;
  }

  resolvePermission(requestId: string, optionId: string | null): boolean {
    const p = this.pendingPermissions.get(requestId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pendingPermissions.delete(requestId);
    p.resolve(
      optionId === null
        ? { outcome: { outcome: "cancelled" } }
        : { outcome: { outcome: "selected", optionId } },
    );
    return true;
  }

  async newSession(cwd: string) {
    return this.conn.newSession({ cwd, mcpServers: dashboardMcpServers(cwd) });
  }

  /** True when the agent advertised `sessionCapabilities.fork` at initialize
   *  (opencode yes; devin's local acp does not — its fork fallback lives in
   *  the /fork route). sessionCapabilities predates the SDK type, so it is
   *  read through a structural cast. */
  get supportsFork(): boolean {
    const caps = this.capabilities?.agentCapabilities as
      | { sessionCapabilities?: Record<string, unknown> }
      | undefined;
    return !!caps?.sessionCapabilities?.fork;
  }

  /** ACP `session/fork` — clone a session on the same process (unstable SDK
   *  surface; only call when supportsFork). */
  async forkSession(sessionId: string, cwd: string) {
    return this.conn.unstable_forkSession({ sessionId, cwd, mcpServers: dashboardMcpServers(cwd) });
  }

  async loadSession(sessionId: string, cwd: string) {
    // update_meta asks the agent to stamp these meta keys on every replayed
    // update — the desktop relies on cognition.ai/eventId (+ timestamp) to
    // anchor sidechain threads; without it they never appear.
    return this.conn.loadSession({
      sessionId, cwd, mcpServers: dashboardMcpServers(cwd),
      update_meta: {
        "cognition.ai/eventId": true,
        "cognition.ai/timestamp": true,
        "cognition.ai/sidechain": true,
        "cognition.ai/subagent_context": true,
        "cognition.ai/subagent_started": true,
        "cognition.ai/subagent_completed": true,
        "cognition.ai/overwrite": true,
      },
    } as Parameters<typeof this.conn.loadSession>[0]);
  }

  async listSessions(cursor?: string) {
    return this.conn.listSessions(cursor ? { cursor } : {});
  }

  async prompt(sessionId: string, blocks: acp.ContentBlock[], meta?: Record<string, unknown>) {
    return this.conn.prompt({ sessionId, prompt: blocks, ...(meta ? { _meta: meta } : {}) });
  }

  /** devin extension: foreground/background/cancel a running subagent. */
  async subagentControl(sessionId: string, agentId: string, action: "cancel" | "foreground" | "background") {
    return this.conn.extMethod(`_cognition.ai/subagent/${action}`, { sessionId, agentId });
  }

  /** devin extension: reply on a sidechain thread (subagent conversation). */
  async sidechainRequest(params: {
    sessionId: string; requestId: string; eventId: string;
    anchorEventId: string; anchorTs: number | string; message: string;
    richContent?: unknown[]; ensureAwake?: boolean;
  }) {
    return this.conn.extMethod(`_cognition.ai/sidechain/request`, params as Record<string, unknown>);
  }

  /** Raw extension-method passthrough (debug/probing). */
  async extMethod(_sessionId: string, method: string, params?: Record<string, unknown>) {
    return this.conn.extMethod(method, params ?? {});
  }

  async cancel(sessionId: string) {
    return this.conn.cancel({ sessionId });
  }

  async setConfigOption(sessionId: string, configId: string, value: string) {
    return this.conn.setSessionConfigOption({ sessionId, configId, value });
  }

  async setMode(sessionId: string, modeId: string) {
    return this.conn.setSessionMode({ sessionId, modeId });
  }

  async renameSession(sessionId: string, title: string) {
    // Cognition advertises cognition.ai/sessionRename support; the exact
    // extension method name is not documented, so try candidates and ignore
    // "method not found" — the local alias in store.json is authoritative.
    for (const m of ["_cognition.ai/session/rename", "_cognition.ai/sessionRename", "session/rename"]) {
      try {
        await this.conn.extMethod(m, { sessionId, title });
        return true;
      } catch {
        /* try next */
      }
    }
    return false;
  }

  kill() {
    try {
      this.proc.kill("SIGTERM");
    } catch {
      /* already dead */
    }
    // Treat as unusable NOW — the 'exit' event lags the kill call, and a
    // hostFor()/forSession() check in between would otherwise hand back
    // this dying process (e.g. the rate-limit retry racing its own kill).
    this.exited = true;
  }
}

/** Resolve `p` against `root` and refuse escapes outside the workspace. */
function confine(root: string, p: string): string {
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw acp.RequestError.invalidParams(`path escapes workspace: ${p}`);
  }
  return abs;
}
