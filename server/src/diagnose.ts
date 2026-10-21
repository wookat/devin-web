// diagnose.ts — one-shot chain health probe + self-repair for the admin UI.
// "检查链路" → GET /api/admin/diagnose runs every probe and returns per-check
// ok/detail plus which fixes apply; "一键修复" → POST /api/admin/repair runs
// the fixable ones (kill orphaned acp procs holding session locks, stop
// wedged/replay inflight turns, clear stale open-turns, hard restart).

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ApiContext } from "./routes.js";
import { restartSession, listLocalSessions } from "./sessionio.js";
import { isDraining, drainSince, inflight, markGracefulExit } from "./sessionlive.js";
import { clearOpenTurns } from "./sessionturns.js";
import { brokerEnabled } from "./acpbroker.js";

const execFileP = promisify(execFile);

interface Check {
  id: string;
  label: string;
  /** ok = healthy · warn = expected transient/attention-only (drain during
   * deploy, live turns, stale replays) · fail = actually broken */
  level: 'ok' | 'warn' | 'fail';
  detail: string;
  group: 'service' | 'session'; // 服务设施层 vs 会话运行时层
  fix?: string; // repair action id that resolves this check
}

/** `devin acp` children whose parent pid is already dead — they keep
 * holding session locks after a hard restart, which is why "send" errors
 * with session_locked until they die. win32 → CIM process table;
 * POSIX → `ps` scan + ppid liveness probe. */
async function orphanAcps(): Promise<number[]> {
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileP("powershell", ["-NoProfile", "-Command",
        "Get-CimInstance Win32_Process -Filter \"name='devin.exe'\" | Where-Object { $_.CommandLine -match 'acp' -and -not (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue) } | Select-Object -ExpandProperty ProcessId"],
        { timeout: 15000, windowsHide: true });
      return stdout.trim().split(/\r?\n/).map(Number).filter(Boolean);
    } catch { return []; }
  }
  try {
    const { stdout } = await execFileP("ps", ["-ax", "-o", "pid=,ppid=,args="], { timeout: 15000 });
    const dead = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
    return stdout.split("\n")
      .map(l => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
      .filter((m): m is RegExpMatchArray => !!m && /\bdevin\b/.test(m[3]) && /\bacp\b/.test(m[3])
        && Number(m[2]) !== 1 && dead(Number(m[2])))
      .map(m => Number(m[1]));
  } catch { return []; }
}

export async function killOrphans(): Promise<string> {
  const pids = await orphanAcps();
  for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch {} }
  return pids.length ? `killed ${pids.join(",")}` : "none found";
}

function openTurns(ctx: ApiContext): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(path.join(ctx.store.dataDir, "open-turns.json"), "utf8")); }
  catch { return {}; }
}

export async function diagnose(ctx: ApiContext): Promise<{ ok: boolean; checks: Check[] }> {
  const checks: Check[] = [];
  const t0 = Date.now();

  // supervisor reachable (we're answering, but supervised flag tells the mode)
  const supervised = process.env.DEVIN_WEB_SUPERVISED === "1";
  checks.push({ id: "supervisor", group: "service", label: "Supervisor", level: supervised ? "ok" : "fail",
    detail: supervised ? `pid ${process.ppid} · :7791 proxying :7792` : "bare backend — no supervisor/self-heal" });

  // drain gate — expected transient during deploys, so warn not fail
  const draining = isDraining();
  checks.push({ id: "drain", group: "service", label: "Drain (deploy gate)", level: draining ? "warn" : "ok",
    detail: draining ? `restarting — sends 503 for the ~${Math.round((Date.now() - drainSince()) / 1000)}s exit window` : "not draining",
    fix: draining ? "restart-now" : undefined });

  // inflight turns — live work, warn with a force-stop escape
  const inFl = [...inflight];
  checks.push({ id: "inflight", group: "session", label: "In-flight turns", level: inFl.length ? "warn" : "ok",
    detail: inFl.length ? `${inFl.length} running: ${inFl.join(", ")}` : "none",
    fix: inFl.length ? "stop-turns" : undefined });

  // acp host pool
  const procs = (ctx.manager.status() as { exited: boolean; busy: number }[]);
  const dead = procs.filter(p => p.exited).length;
  checks.push({ id: "acp", group: "session", label: "Agent processes", level: dead ? "fail" : "ok",
    detail: `${procs.length} pooled · ${dead} exited · ${procs.reduce((a, p) => a + p.busy, 0)} busy` });

  // orphaned acp holding locks
  const orphans = await orphanAcps();
  checks.push({ id: "orphans", group: "session", label: "Orphaned acp (lock holders)", level: orphans.length ? "fail" : "ok",
    detail: orphans.length ? `${orphans.length} zombie(s) holding session locks: ${orphans.join(",")}` : "none",
    fix: orphans.length ? "kill-orphans" : undefined });

  // session locks held by other processes (desktop/CLI counts as legitimate holders → warn)
  let lockedIds: string[] = [];
  try {
    lockedIds = (await listLocalSessions(ctx)).filter(s => (s as { is_locked?: boolean }).is_locked).map(s => s.id);
  } catch {}
  checks.push({ id: "locks", group: "session", label: "Session locks (other processes)", level: lockedIds.length ? "warn" : "ok",
    detail: lockedIds.length ? `${lockedIds.length} locked: ${lockedIds.slice(0, 6).join(",")}${lockedIds.length > 6 ? "…" : ""}` : "none",
    fix: lockedIds.length ? "kill-orphans" : undefined });

  // open-turns residue — entries whose resumeCount hit the cap (2) are stale
  // and won't actually auto-resume: report each with its state.
  const otMap = openTurns(ctx) as Record<string, { resumeCount?: number; text?: string }>;
  const otEntries = Object.entries(otMap);
  const pending = otEntries.filter(([, v]) => (v?.resumeCount ?? 0) < 2).map(([k]) => k);
  const stale = otEntries.length - pending.length;
  checks.push({ id: "open-turns", group: "session", label: "Pending turn replays",
    level: pending.length ? "warn" : "ok",
    detail: [
      pending.length ? `${pending.length} will auto-resume: ${pending.join(", ")}` : "",
      stale ? `${stale} stale (retry cap reached — won't resume)` : "",
      !otEntries.length ? "none" : "",
    ].filter(Boolean).join(" · "),
    fix: pending.length ? "clear-open-turns" : undefined });

  // disk headroom on the data-dir volume
  try {
    const st = fs.statfsSync(ctx.store.dataDir);
    const freeGb = (st.bavail * st.bsize) / 1e9;
    checks.push({ id: "disk", group: "service", label: "Disk free", level: freeGb > 2 ? "ok" : "fail",
      detail: `${freeGb.toFixed(1)} GB free` });
  } catch {}

  // public reachability — the box itself often can't hairpin back through the
  // tunnel, so check the LOCAL cloudflared daemon instead: it IS the tunnel.
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileP("powershell", ["-NoProfile", "-Command",
        "(Get-Service cloudflared -ErrorAction Stop).Status"], { timeout: 8000, windowsHide: true });
      const running = /running/i.test(stdout.trim());
      checks.push({ id: "public", group: "service", label: "Cloudflare tunnel (cloudflared)", level: running ? "ok" : "fail",
        detail: running ? `cloudflared service Running → devin-web.zalize.com proxied here` : `cloudflared service ${stdout.trim() || "not found"} — public domain down` });
    } catch {
      checks.push({ id: "public", group: "service", label: "Cloudflare tunnel (cloudflared)", level: "fail",
        detail: "cloudflared service missing — public domain down; site still works on :7791" });
    }
  } else {
    try {
      const r = await fetch("https://devin-web.zalize.com/api/health", { signal: AbortSignal.timeout(6000) });
      checks.push({ id: "public", group: "service", label: "devin-web.zalize.com", level: r.ok ? "ok" : "warn", detail: `HTTP ${r.status}` });
    } catch {
      checks.push({ id: "public", group: "service", label: "devin-web.zalize.com", level: "warn",
        detail: "unreachable from this box — may still work externally (hairpin)" });
    }
  }

  const fails = checks.filter(c => c.level === "fail").length;
  const warns = checks.filter(c => c.level === "warn").length;
  console.error(`[diagnose] ${fails} fail + ${warns} warn in ${Date.now() - t0}ms`);
  return { ok: fails === 0, checks };
}

export async function repair(ctx: ApiContext, fixes: string[] | "all"): Promise<{ results: Record<string, string> }> {
  const diag = await diagnose(ctx);
  const wanted = fixes === "all" ? diag.checks.map(c => c.fix).filter(Boolean) as string[] : fixes;
  const results: Record<string, string> = {};
  console.error(`[repair] requested ${JSON.stringify(wanted)}`);

  for (const fix of new Set(wanted)) {
    try {
      if (fix === "kill-orphans") results[fix] = await killOrphans();
      else if (fix === "stop-turns") {
        const ids = [...inflight];
        for (const id of ids) restartSession(ctx, id);
        results[fix] = ids.length ? `stopped turn host(s) for: ${ids.join(", ")} — turns settle as errors` : "none in flight";
      } else if (fix === "clear-open-turns") {
        const n = clearOpenTurns(ctx);
        results[fix] = `cleared ${n} entr${n === 1 ? "y" : "ies"} — next boot won't replay them`;
      } else if (fix === "restart-now") {
        results[fix] = "exiting — supervisor respawns immediately";
        setTimeout(() => {
          console.error("[repair] restart requested by user");
          markGracefulExit(ctx);    // open-turns survive for auto-resume
          if (brokerEnabled) ctx.manager.killHelpers(); // acp live under the broker
          else ctx.manager.killAll();                   // no orphaned acp holding session locks
          process.exit(0);
        }, 400);
      } else results[fix] = "unknown fix";
    } catch (e) { results[fix] = `failed: ${e instanceof Error ? e.message : String(e)}`; }
  }
  console.error(`[repair] done ${JSON.stringify(results)}`);
  return { results };
}
