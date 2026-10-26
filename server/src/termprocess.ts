import { execFile, execFileSync, type ChildProcess } from "node:child_process";

const owned = new Map<ChildProcess, boolean>();
let exitHook = false;

/** /ws/term children are not ACP-manager helpers. Register their ownership so
 * ALL backend exit paths (admin restart, signals, watchdog) clean them too.
 * The exit hook must be synchronous: process.exit does not await promises. */
export function trackTerminalProcess(proc: ChildProcess, grouped = false): void {
  owned.set(proc, grouped);
  proc.once("close", () => owned.delete(proc));
  if (!proc.pid) proc.once("exit", () => owned.delete(proc)); // ssh2 (no close event)
  if (exitHook) return;
  exitHook = true;
  process.once("exit", () => {
    const pids: string[] = [];
    for (const [p, group] of owned) {
      try {
        if (process.platform === "win32" && p.pid) {
          pids.push("/PID", String(p.pid));
        } else if (group && p.pid) process.kill(-p.pid, "SIGKILL");
        else p.kill();
      } catch { /* already gone */ }
    }
    // One bounded cleanup, not N serial process launches during a restart.
    if (pids.length) {
      try {
        execFileSync("taskkill.exe", [...pids, "/T", "/F"],
          { windowsHide: true, stdio: "ignore", timeout: 2_000 });
      } catch { /* best effort on process exit; socket interruption reports errors */ }
    }
  });
}

/** A pipe byte 0x03 is NOT a console interrupt. Stop the owned process tree;
 * the UI explicitly recovers with a fresh shell (cwd/env state is reset).
 * Never use this for SSH PTY Ctrl+C, which belongs on the remote byte stream. */
export async function killTerminalTree(proc: ChildProcess, grouped = false): Promise<void> {
  if (!proc.pid) { proc.kill(); return; } // ssh2 channel-shaped child
  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      execFile("taskkill.exe", ["/PID", String(proc.pid), "/T", "/F"],
        { windowsHide: true, timeout: 10_000 }, (err) => {
          if (err && proc.exitCode === null) reject(err);
          else resolve();
        });
    });
  } else if (grouped) {
    try { process.kill(-proc.pid, "SIGKILL"); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err; }
  } else {
    proc.kill("SIGKILL");
  }
}
