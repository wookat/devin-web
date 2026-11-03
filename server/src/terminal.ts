import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { existsSync } from "node:fs";
import type { CreateTerminalRequest, CreateTerminalResponse, TerminalOutputResponse, WaitForTerminalExitResponse } from "@agentclientprotocol/sdk";
import type { DevinAcpEvents } from "./acp.js";
import { sshSpawn } from "./ssh.js";
import { ShellDecoder } from "./shelltext.js";

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

export const SECRET_MASK = "••••••";
/** Values shorter than this are not masked — masking "ab" would shred
 *  ordinary output (and a 3-char secret is worthless anyway). */
export const MIN_REDACT_LEN = 4;

export function scrubSecrets(text: string, values: string[]): string {
  for (const v of values) {
    if (v.length >= MIN_REDACT_LEN) text = text.split(v).join(SECRET_MASK);
  }
  return text;
}

/** Stream redactor: secrets can straddle chunk boundaries, so the last
 *  (maxLen-1) bytes are held back and merged into the next chunk. Order
 *  matters: the WHOLE buffer is scrubbed BEFORE the emit/tail split — a
 *  secret fully inside the buffer is masked in place; one straddling the
 *  boundary has its head (≤ maxLen-1 bytes) inside the held-back tail, so
 *  it joins the next buffer and is masked as a unit there. flush() emits
 *  the remainder on process settle. */
export function makeStreamRedactor(values: string[]): { push: (chunk: string) => string; flush: () => string } {
  const vals = values.filter((v) => v.length >= MIN_REDACT_LEN);
  if (!vals.length) return { push: (c) => c, flush: () => "" };
  const maxLen = Math.max(...vals.map((v) => v.length));
  let tail = "";
  return {
    push(chunk) {
      const buf = scrubSecrets(tail + chunk, vals);
      const emitLen = buf.length - (maxLen - 1);
      if (emitLen <= 0) { tail = buf; return ""; }
      tail = buf.slice(emitLen);
      return buf.slice(0, emitLen);
    },
    flush() {
      const out = scrubSecrets(tail, vals);
      tail = "";
      return out;
    },
  };
}

export class TerminalRunner {
  private terminals = new Map<string, Terminal>();

  /** `sshTarget` (user@host[:port] or an ssh config alias) routes every
   *  terminal command through `ssh <target> 'cd <cwd> && <cmd> <args>'` —
   *  used when the ACP agent itself runs on a remote host. */
  constructor(private sshTarget: string | null = null) {}

  /** Session-bound secret env (secrets.ts). Resolved per spawn — each
   *  terminal/create is a fresh process so a newly bound secret applies on
   *  the agent's next command with no respawn. SSH runners ignore it:
   *  remote env can't be set without embedding values in the command line
   *  (which would leak them into the transcript). */
  secretEnv: ((sessionId: string) => Record<string, string>) | null = null;

  /** Session-bound secret VALUES for output redaction. Also applied on SSH
   *  runners: nothing is injected there, but a bound value that reaches the
   *  remote side any other way (user-exported env, seeded file) still must
   *  not echo back into the transcript. */
  secretValues: ((sessionId: string) => string[]) | null = null;

  /** Redact bound secret values in a text destined for the agent/log —
   *  used by fs/read_text_file so a seeded .env the agent cats out can't
   *  smuggle the plaintext past the terminal scrubber. */
  redactFor(sessionId: string, text: string): string {
    const vals = this.secretValues?.(sessionId) ?? [];
    return scrubSecrets(text, vals);
  }

  async create(
    defaultCwd: string,
    params: CreateTerminalRequest,
    ev: Pick<DevinAcpEvents, "onTerminalCreate" | "onTerminalOutput" | "onTerminalExit">,
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
        // Secrets win last: a bound name must resolve to the store's value,
        // not whatever the agent chose to pass in params.env.
        ...(this.secretEnv?.(params.sessionId) ?? {}),
      };
      if (GIT_BINS.length) {
        const key = "Path" in env ? "Path" : "PATH";
        env[key] = [...GIT_BINS, env[key] ?? ""].filter(Boolean).join(path.delimiter);
      }
      // Windows: a bare spawn can't launch builtins/.cmd shims → route
      // through cmd /c. Quoting keeps `&`/`|` literal inside args. Pipe
      // output arrives as OEM bytes — decoded GBK-or-UTF8 per chunk in
      // onData (chcp can't touch pipe encoding, so we don't bother).
      if (process.platform === "win32") {
        const cq = (a: string) => (/[\s"&|<>^%]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
        const line = `${params.command}${params.args?.length ? " " + params.args.map(cq).join(" ") : ""}`;
        proc = spawn("cmd.exe", ["/d", "/s", "/c", line], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      } else {
        proc = spawn(params.command, params.args ?? [], {
          cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
      }
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
    ev.onTerminalCreate(id, term.sessionId, [params.command, ...(params.args ?? [])].join(" "));

    const dec = new ShellDecoder(!this.sshTarget && process.platform === "win32");
    // Redact the session's bound secret values from stdout/stderr — this is
    // the choke point that feeds term.output (agent read-back), the session
    // log, the timeline, and the WS broadcast, so one scrub covers every
    // downstream consumer.
    const redactor = makeStreamRedactor(this.secretValues?.(params.sessionId) ?? []);
    const emit = (data: string) => {
      if (!data) return;
      term.output += data;
      if (term.output.length > term.limit) {
        term.output = term.output.slice(-term.limit);
        term.truncated = true;
      }
      ev.onTerminalOutput(id, term.sessionId, data);
    };
    const onData = (chunk: Buffer) => {
      emit(redactor.push(dec.push(chunk)));
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", onData);
    const settle = (code: number | null, signal: string | null) => {
      if (term.exitCode !== null || term.signal !== null) return;
      term.exitCode = code;
      term.signal = signal;
      emit(dec.flush ? dec.flush() : "");
      emit(redactor.flush());
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
