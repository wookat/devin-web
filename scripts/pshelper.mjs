import { spawn } from "node:child_process";

// One resident powershell.exe per host process — replaces the spawn-per-scan
// pattern behind the periodic probes (broker memScan 30s, supervisor
// foreign-sweep 60s, orphan/port sweeps). Each spawn cost ~50-200ms and, on
// a consoleless parent, flashed a conhost window every tick.
//
// Line protocol over `powershell -Command -` (executes each line on
// arrival): the caller sends a one-liner, the helper appends an end
// sentinel, and whatever stdout preceded it is the result. The child is
// respawned lazily on exit; in-flight calls reject rather than hang.
let child = null;
let seq = 0;
let buf = "";
const pending = new Map(); // id -> {resolve, reject, timer}

function failAll(err) {
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

function ensure() {
  if (child && child.exitCode == null) return child;
  buf = "";
  child = spawn("powershell", ["-NoProfile", "-NoLogo", "-Command", "-"], {
    stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => { buf += d; drain(); });
  child.on("exit", () => { child = null; failAll(new Error("pshelper exited")); });
  child.on("error", () => { child = null; failAll(new Error("pshelper spawn failed")); });
  child.unref();
  return child;
}

/** Run a one-liner in the resident shell. Rejects on timeout or helper
 *  death; the next call transparently respawns. */
export function psRun(command, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const c = ensure();
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`ps timeout (${timeoutMs}ms)`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    c.stdin.write(`try { ${command} } catch { }; Write-Output '<<DWEND${id}>>'\n`);
  });
}

/** Sync callers (boot-time journal sweeps) can keep execSync — they run
 *  once, not on a timer. Exported for symmetry/testing only. */
export function psAlive() {
  return child != null && child.exitCode == null;
}
