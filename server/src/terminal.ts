import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { existsSync } from "node:fs";
import type { CreateTerminalRequest, CreateTerminalResponse, TerminalOutputResponse, WaitForTerminalExitResponse } from "@agentclientprotocol/sdk";
import type { DevinAcpEvents } from "./acp.js";
import { sshSpawn } from "./ssh.js";

interface Terminal {
  id: string;
  sessionId: string;
  proc: ChildProcess;
  output: string;
  truncated: boolean;
  exitCode: number | null;
  signal: string | null;
  waiters: Array<() => void>;
  limit: number;
}

const MAX_OUTPUT = 1024 * 1024; // 1 MiB ring buffer per terminal

/**
 * Windows: agents send unix program names (sh/bash/ls/grep/head/…). Git\cmd
 * is typically on PATH but Git\usr\bin — where sh.exe and the coreutils
 * actually live — usually is not. Collect the candidate dirs once and prepend
 * them to every spawned child's PATH so `sh -c …` resolves.
 */
function gitBins(): string[] {
  if (process.platform !== "win32") return [];
  const roots = new Set<string>();
  for (const p of (process.env.Path ?? process.env.PATH ?? "").split(path.delimiter)) {
    if (/git/i.test(p)) roots.add(path.dirname(p)); // …\Git\cmd → …\Git
  }
  for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]) {
    if (base) roots.add(path.join(base, "Git"));
  }
  const dirs: string[] = [];
  for (const root of roots) {
    for (const sub of ["usr\\bin", "bin", "mingw64\\bin"]) {
      const d = path.join(root, sub);
      if (existsSync(d)) dirs.push(d);
    }
  }
  return dirs;
}
const GIT_BINS = gitBins();

/**
 * Implements the ACP terminal/* client methods with plain child_process.
 * No native pty dependency — agent commands are non-interactive, so piped
 * stdio is enough and `npx devin-web` stays build-free.
 */
/** Quote one token for a remote POSIX shell line (ssh joins argv with
 *  spaces; the remote shell re-parses, so every token must be quoted). */
function shq(a: string): string {
  return `'${a.replace(/'/g, `'\\''`)}'`;
}

export class TerminalRunner {
  private terminals = new Map<string, Terminal>();

  /** `sshTarget` (user@host[:port] or an ssh config alias) routes every
   *  terminal command through `ssh <target> 'cd <cwd> && <cmd> <args>'` —
   *  used when the ACP agent itself runs on a remote host. */
  constructor(private sshTarget: string | null = null) {}

  async create(
    defaultCwd: string,
    params: CreateTerminalRequest,
    ev: Pick<DevinAcpEvents, "onTerminalOutput" | "onTerminalExit">,
  ): Promise<CreateTerminalResponse> {
    const id = randomUUID();
    const limit = params.outputByteLimit ?? MAX_OUTPUT;
    const cwd = params.cwd ?? defaultCwd;
    let proc: ChildProcess;
    if (this.sshTarget) {
      const line = `cd ${shq(cwd)} 2>/dev/null; ${[params.command, ...(params.args ?? [])].map(shq).join(" ")}`;
      // sshSpawn: OpenSSH for agent-auth hosts, ssh2 for password/key records.
      proc = await sshSpawn(this.sshTarget, line, {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
        windowsHide: true,
      });
    } else {
      const env = {
        ...process.env,
        ...Object.fromEntries((params.env ?? []).map((e) => [e.name, e.value])),
      };
      if (GIT_BINS.length) {
        const key = "Path" in env ? "Path" : "PATH";
        env[key] = [...GIT_BINS, env[key] ?? ""].filter(Boolean).join(path.delimiter);
      }
      proc = spawn(params.command, params.args ?? [], {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        // Windows: a bare spawn can't launch shell builtins (echo/cd), .cmd
        // shims (npm), or whole-string commands — route through cmd.exe.
        shell: process.platform === "win32",
      });
    }

    const term: Terminal = {
      id,
      sessionId: params.sessionId,
      proc,
      output: "",
      truncated: false,
      exitCode: null,
      signal: null,
      waiters: [],
      limit,
    };
    this.terminals.set(id, term);

    const onData = (chunk: Buffer) => {
      const data = chunk.toString("utf8");
      term.output += data;
      if (term.output.length > term.limit) {
        term.output = term.output.slice(-term.limit);
        term.truncated = true;
      }
      ev.onTerminalOutput(id, term.sessionId, data);
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", onData);
    const settle = (code: number | null, signal: string | null) => {
      if (term.exitCode !== null || term.signal !== null) return;
      term.exitCode = code;
      term.signal = signal;
      ev.onTerminalExit(id, term.sessionId, code, signal);
      for (const w of term.waiters) w();
      term.waiters = [];
    };
    proc.on("exit", (code, signal) => settle(code, signal));
    // A nonexistent command emits 'error' with no 'exit' — without this the
    // server crashes (unhandled 'error') and waitForExit callers hang forever.
    proc.on("error", (err) => {
      const msg = `[devin-web] failed to start "${params.command}": ${err.message}\n`;
      term.output = (term.output + msg).slice(-term.limit);
      ev.onTerminalOutput(id, term.sessionId, msg);
      settle(-1, null);
    });

    return { terminalId: id };
  }

  async output(terminalId: string): Promise<TerminalOutputResponse> {
    const t = this.mustGet(terminalId);
    const exited = t.exitCode !== null || t.signal !== null;
    return {
      output: t.output,
      truncated: t.truncated,
      ...(exited
        ? { exitStatus: { exitCode: t.exitCode, signal: t.signal } }
        : {}),
    };
  }

  async waitForExit(terminalId: string): Promise<WaitForTerminalExitResponse> {
    const t = this.mustGet(terminalId);
    if (t.exitCode === null && t.signal === null) {
      await new Promise<void>((resolve) => t.waiters.push(resolve));
    }
    return { exitCode: t.exitCode, signal: t.signal };
  }

  kill(terminalId: string) {
    const t = this.terminals.get(terminalId);
    if (t && t.exitCode === null) t.proc.kill("SIGKILL");
  }

  release(terminalId: string) {
    this.kill(terminalId);
    this.terminals.delete(terminalId);
  }

  killAll() {
    for (const t of this.terminals.values()) {
      if (t.exitCode === null) t.proc.kill("SIGKILL");
    }
    this.terminals.clear();
  }

  private mustGet(id: string): Terminal {
    const t = this.terminals.get(id);
    if (!t) throw new Error(`unknown terminal: ${id}`);
    return t;
  }
}
