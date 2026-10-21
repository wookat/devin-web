import fs from "node:fs/promises";
import { DevinAcp, type DevinAcpEvents } from "./acp.js";
import { isRateLimitError } from "./accounts.js";
import { TerminalRunner } from "./terminal.js";
import { DEFAULT_AGENT, type AgentDef } from "./agents.js";

export interface ManagedProcess {
  acp: DevinAcp;
  cwd: string;
  startedAt: number;
}

export interface ManagerEvents extends Omit<DevinAcpEvents, "onExit"> {
  onExit: (cwd: string, code: number | null, agent: string, sessionId?: string) => void;
  /** Called with the owning process for each permission request. */
  onPermissionOwner: (requestId: string, owner: DevinAcp) => void;
  /** Agent log line matched the rate-limit signature; account may be null. */
  onRateLimited?: (account: string | null, sessionId: string, message: string) => void;
}

/**
 * ACP child processes. Multi-session agents (Devin) get one pooled process
 * per workspace directory with sessions multiplexed by sessionId; single-
 * session agents (Prime) get a dedicated process per session.
 */
export class AcpManager {
  /** `${agent.id}:${cwd}` → pooled process (multi-session agents). */
  private pooled = new Map<string, ManagedProcess>();
  private starting = new Map<string, Promise<DevinAcp>>();
  /** Bumped by killPooled — a spawn started before a rotation lands with the
   *  old account's key, so get() discards and respawns stale births. */
  private spawnGen = 0;
  /** sessionId → dedicated process (single-session agents). */
  private bySession = new Map<string, ManagedProcess>();
  readonly terminal = new TerminalRunner();
  /** Per-process TerminalRunner for SSH-hosted agents — remote commands run
   *  on the remote fs, so each ssh acp gets its own runner (tracked here so
   *  killAll still sweeps them). */
  private sshTerminals = new Set<TerminalRunner>();
  /** Supplies spawn-time env (e.g. WINDSURF_API_KEY) + which account it belongs to. */
  envFor: ((agent: AgentDef) => { env: Record<string, string>; account: string | null }) | null = null;

  constructor(private ev: ManagerEvents) {}

  private async spawn(cwd: string, agent: AgentDef, onExit: (code: number | null) => void, ssh: string | null = null, poolKey?: string): Promise<DevinAcp> {
    if (!ssh) await fs.mkdir(cwd, { recursive: true });
    let instance: DevinAcp | null = null;
    const inj = this.envFor?.(agent) ?? { env: {}, account: null };
    const term = ssh ? new TerminalRunner(ssh) : this.terminal;
    if (ssh) this.sshTerminals.add(term);
    const acp = await DevinAcp.start(
      cwd,
      term,
      {
        ...this.ev,
        onPermissionRequest: (requestId, sessionId, toolCall, options) => {
          if (instance) this.ev.onPermissionOwner(requestId, instance);
          this.ev.onPermissionRequest(requestId, sessionId, toolCall, options);
        },
        onAgentLog: (sessionId, channel, message, level) => {
          if (isRateLimitError(message)) {
            this.ev.onRateLimited?.(instance?.account ?? null, sessionId, message);
          }
          this.ev.onAgentLog(sessionId, channel, message, level);
        },
        onExit: (code) => {
          if (ssh) this.sshTerminals.delete(term);
          onExit(code);
        },
      },
      agent,
      inj.env,
      inj.account,
      ssh,
      poolKey,
    );
    instance = acp;
    return acp;
  }

  /** Adopt a broker acp that outlived a backend restart: attach its stream,
   *  wire the same events a fresh spawn gets, and re-seat it in the pool
   *  (pooled key) or dedicated map (sessions discovered via session/list). */
  async adopt(cwd: string, agent: AgentDef, key: string | null, acpId: string, after: number, account: string | null = null): Promise<DevinAcp> {
    let instance: DevinAcp | null = null;
    const acp = await DevinAcp.adoptBrokered(cwd, this.terminal, {
      ...this.ev,
      onPermissionRequest: (requestId, sessionId, toolCall, options) => {
        if (instance) this.ev.onPermissionOwner(requestId, instance);
        this.ev.onPermissionRequest(requestId, sessionId, toolCall, options);
      },
      onAgentLog: (sessionId, channel, message, level) => {
        if (isRateLimitError(message)) {
          this.ev.onRateLimited?.(instance?.account ?? null, sessionId, message);
        }
        this.ev.onAgentLog(sessionId, channel, message, level);
      },
      onExit: (code) => {
        // Identity check: a same-key acp adopted after us may have taken the
        // pool slot — deleting unconditionally would evict the live one.
        if (key && this.pooled.get(key)?.acp === acp) this.pooled.delete(key);
        for (const [sid, m] of this.bySession) if (m.acp === acp) this.bySession.delete(sid);
        this.ev.onExit(cwd, code, agent.id);
      },
    }, agent, acpId, after, account);
    instance = acp;
    // Only multi-session acp take pool slots — a dedicated key (bare agent.id)
    // is an identity marker, not a pool slot; its sessions live in bySession
    // via bindSession during session discovery. Never overwrite a LIVE slot:
    // a same-key acp spawned during adoption keeps its seat — this one stays
    // session-pinned only (redundant-but-harmless until idle-retire).
    if (key && agent.multiSession && (this.pooled.get(key)?.acp.exited ?? true)) {
      this.pooled.set(key, { acp, cwd, startedAt: Date.now() });
    }
    return acp;
  }

  /** Get (or lazily start) the pooled process for a multi-session agent.
   *  `ssh` (user@host) pools per remote target — a remote process never
   *  shares a key with a local one even for the same cwd string. */
  async get(cwd: string, agent: AgentDef = DEFAULT_AGENT, ssh: string | null = null): Promise<DevinAcp> {
    if (!agent.multiSession) {
      throw new Error(`${agent.label} runs one session per process — use startForSession`);
    }
    const key = `${agent.id}:${ssh ? `ssh:${ssh}:` : ""}${cwd}`;
    const existing = this.pooled.get(key);
    if (existing && !existing.acp.exited) return existing.acp;

    const pending = this.starting.get(key);
    if (pending) return pending;

    const p = (async () => {
      for (;;) {
        const g = this.spawnGen;
        const acp = await this.spawn(cwd, agent, (code) => {
          this.pooled.delete(key);
          this.ev.onExit(cwd, code, agent.id);
        }, ssh, key);
        if (this.spawnGen === g) {
          this.pooled.set(key, { acp, cwd, startedAt: Date.now() });
          return acp;
        }
        acp.kill(); // born pre-rotation — carries the old account's key
      }
    })();

    this.starting.set(key, p);
    try {
      return await p;
    } finally {
      this.starting.delete(key);
    }
  }

  /** Spawn a dedicated process for one session of a single-session agent. */
  async startForSession(cwd: string, agent: AgentDef, ssh: string | null = null): Promise<DevinAcp> {
    const acp = await this.spawn(cwd, agent, (code) => {
      let sessionId: string | undefined;
      for (const [sid, m] of this.bySession) {
        if (m.acp === acp) {
          sessionId = sid;
          this.bySession.delete(sid);
        }
      }
      this.ev.onExit(cwd, code, agent.id, sessionId);
    // key = bare agent.id: journaled through the broker so adoption knows the
    // agent type — never seated in the pool (multiSession guard in adopt()).
    }, ssh, agent.id);
    return acp;
  }

  /** Register the session a dedicated process ended up hosting. */
  bindSession(sessionId: string, acp: DevinAcp): void {
    this.bySession.set(sessionId, { acp, cwd: acp.cwd, startedAt: Date.now() });
  }

  /** The live dedicated process for a session, if any. */
  forSession(sessionId: string): DevinAcp | undefined {
    const m = this.bySession.get(sessionId);
    return m && !m.acp.exited ? m.acp : undefined;
  }

  status() {
    const describe = (m: ManagedProcess, sessionId?: string) => ({
      cwd: m.cwd,
      agent: m.acp.agent.id,
      sessionId,
      startedAt: m.startedAt,
      exited: m.acp.exited,
      pid: m.acp.pid,
      account: m.acp.account,
      busy: m.acp.busySessions.size,
      capabilities: {
        loadSession: m.acp.capabilities?.agentCapabilities?.loadSession ?? false,
        image: m.acp.capabilities?.agentCapabilities?.promptCapabilities?.image ?? false,
      },
    });
    return [
      ...[...this.pooled.values()].map((m) => describe(m)),
      ...[...this.bySession.entries()].map(([sid, m]) => describe(m, sid)),
    ];
  }

  /** Kill every pooled process for an agent so the next get() respawns it —
   *  used after account rotation so new spawns pick up the new key.
   *  `keepAccount` spares processes already running the target account.
   *  A process mid-turn is NOT killed — it is unpooled (nothing new lands on
   *  the old key) and retires when its last in-flight turn settles. */
  killPooled(agentId?: string, keepAccount?: string | null) {
    this.spawnGen++;
    for (const [key, m] of this.pooled) {
      if (agentId && !key.startsWith(`${agentId}:`)) continue;
      if (keepAccount && m.acp.account === keepAccount) continue;
      if (m.acp.busySessions.size) {
        m.acp.retireAfterIdle = true;
        this.pooled.delete(key);
        continue;
      }
      m.acp.kill();
      this.pooled.delete(key);
    }
  }

  /** Pull an acp out of the pooled map (and a dedicated slot) WITHOUT
   *  killing it — sessions already pinned keep it until releaseBusy retires
   *  it (retireAfterIdle). */
  unpool(acp: DevinAcp, sessionId?: string) {
    for (const [key, m] of this.pooled) if (m.acp === acp) this.pooled.delete(key);
    if (sessionId && this.bySession.get(sessionId)?.acp === acp) this.bySession.delete(sessionId);
  }

  /** Account name a pooled process was spawned with, if known. */
  accountOf(cwd: string, agentId = "devin"): string | null {
    return this.pooled.get(`${agentId}:${cwd}`)?.acp.account ?? null;
  }

  /** Kill one specific acp process wherever it's registered — pooled or
   *  dedicated — so the next get()/forSession() respawns fresh. */
  killProcess(acp: DevinAcp) {
    for (const [key, m] of this.pooled) if (m.acp === acp) this.pooled.delete(key);
    for (const [sid, m] of this.bySession) if (m.acp === acp) this.bySession.delete(sid);
    acp.kill();
  }

  killAll() {
    for (const m of this.pooled.values()) m.acp.kill();
    this.pooled.clear();
    for (const m of this.bySession.values()) m.acp.kill();
    this.bySession.clear();
    this.killHelpers();
  }

  /** Every live acp (pooled + dedicated) — the graceful-exit offset journal
   *  iterates this to snapshot broker stream positions. */
  allAcps(): DevinAcp[] {
    return [...this.pooled.values(), ...this.bySession.values()].map((m) => m.acp);
  }

  /** Another LIVE acp already seats this pool key — the passed acp is a
   *  redundant adoption duplicate (spawn raced adoption). */
  pooledSlotTaken(key: string, acp: DevinAcp): boolean {
    const m = this.pooled.get(key);
    return !!m && m.acp !== acp && !m.acp.exited;
  }

  /** Kill only backend-local helper processes (terminal runners). Broker mode
   *  exits with acp children ALIVE under the broker — only these die with us. */
  killHelpers() {
    this.terminal.killAll();
    for (const t of this.sshTerminals) t.killAll();
    this.sshTerminals.clear();
  }
}
