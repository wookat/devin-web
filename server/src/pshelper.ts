import { spawn, type ChildProcess } from "node:child_process";

// One resident powershell.exe per backend — mirror of scripts/pshelper.mjs
// for the TS tree (same line protocol). Periodic probes used to spawn a
// fresh powershell per call (~150ms + a hidden conhost each time); the
// resources page polling this every 5s was the worst offender.
let child: ChildProcess | null = null;
let seq = 0;
let buf = "";
const pending = new Map<number, { resolve: (s: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

function failAll(err: Error) {
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err); }
  pending.clear();
}

function drain() {
  for (;;) {
    const m = /<<DWEND(\d+)>>/.exec(buf);
    if (!m) return;
    const id = Number(m[1]);
    const out = buf.slice(0, m.index);
    buf = buf.slice(m.index + m[0].length);
    const p = pending.get(id);
    if (!p) continue;
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(out);
  }
}

function ensure(): ChildProcess {
  if (child && child.exitCode == null) return child;
  buf = "";
  child = spawn("powershell", ["-NoProfile", "-NoLogo", "-Command", "-"], {
    stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
  });
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (d: string) => { buf += d; drain(); });
  child.on("exit", () => { child = null; failAll(new Error("pshelper exited")); });
  child.on("error", () => { child = null; failAll(new Error("pshelper spawn failed")); });
  child.unref();
  return child;
}

/** Run a one-liner in the resident shell; the next call after a death
 *  transparently respawns. */
export function psRun(command: string, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = ensure();
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`ps timeout (${timeoutMs}ms)`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    c.stdin!.write(`try { ${command} } catch { }; Write-Output '<<DWEND${id}>>'\n`);
  });
}
