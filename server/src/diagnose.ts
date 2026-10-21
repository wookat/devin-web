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
import { isDraining, drainSince, inflight, restartSession, listLocalSessions } from "./sessionio.js";

const execFileP = promisify(execFile);

interface Check {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  fix?: string; // repair action id that resolves this check
}

/** `devin.exe acp` children whose parent pid is already dead — they keep
 * holding session locks after a hard restart, which is why "send" errors
 * with session_locked until they die. Windows-only probe; 0 on other OS. */
async function orphanAcps(): Promise<number[]> {
  if (process.platform !== "win32") return [];
  try {
    const { stdout } = await execFileP("powershell", ["-NoProfile", "-Command",
      "Get-CimInstance Win32_Process -Filter \"name='devin.exe'\" | Where-Object { $_.CommandLine -match 'acp' -and -not (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue) } | Select-Object -ExpandProperty ProcessId"],
      { timeout: 15000, windowsHide: true });
    return stdout.trim().split(/\r?\n/).map(Number).filter(Boolean);
  } catch { return []; }
}

async function killOrphans(): Promise<string> {
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
  checks.push({ id: "supervisor", label: "Supervisor", ok: supervised,
    detail: supervised ? `pid ${process.ppid} · :7791 proxying :7792` : "bare backend — no supervisor/self-heal" });

  // drain gate
  const draining = isDraining();
  checks.push({ id: "drain", label: "Drain (deploy gate)", ok: !draining,
    detail: draining ? `draining ${Math.round((Date.now() - drainSince()) / 1000)}s — sends 503 until it clears` : "not draining",
    fix: draining ? "restart-now" : undefined });

  // inflight turns — replays of huge logs look exactly like this and block sends
  const inFl = [...inflight];
  checks.push({ id: "inflight", label: "In-flight turns", ok: inFl.length === 0,
    detail: inFl.length ? `${inFl.length} running: ${inFl.join(", ")}` : "none",
    fix: inFl.length ? "stop-turns" : undefined });

  // acp host pool
  const procs = (ctx.manager.status() as { exited: boolean; busy: number }[]);
  const dead = procs.filter(p => p.exited).length;
  checks.push({ id: "acp", label: "Agent processes", ok: dead === 0,
    detail: `${procs.length} pooled · ${dead} exited · ${procs.reduce((a, p) => a + p.busy, 0)} busy` });

  // orphaned acp holding locks
  const orphans = await orphanAcps();
  checks.push({ id: "orphans", label: "Orphaned acp (lock holders)", ok: orphans.length === 0,
    detail: orphans.length ? `${orphans.length} zombie(s) holding session locks: ${orphans.join(",")}` : "none",
    fix: orphans.length ? "kill-orphans" : undefined });

  // session locks held by other processes
  let lockedIds: string[] = [];
  try {
    lockedIds = (await listLocalSessions(ctx)).filter(s => (s as { is_locked?: boolean }).is_locked).map(s => s.id);
  } catch {}
  checks.push({ id: "locks", label: "Session locks (other processes)", ok: lockedIds.length === 0,
    detail: lockedIds.length ? `${lockedIds.length} locked: ${lockedIds.slice(0, 6).join(",")}${lockedIds.length > 6 ? "…" : ""}` : "none",
    fix: lockedIds.length ? "kill-orphans" : undefined });

  // open-turns residue — entries here get auto-resumed (replayed) on next boot
  const ot = Object.keys(openTurns(ctx));
  checks.push({ id: "open-turns", label: "Pending turn replays", ok: ot.length === 0,
    detail: ot.length ? `${ot.length} will auto-resume: ${ot.join(", ")}` : "none",
    fix: ot.length ? "clear-open-turns" : undefined });

  // disk headroom on the data-dir volume
  try {
    const st = fs.statfsSync(ctx.store.dataDir);
    const freeGb = (st.bavail * st.bsize) / 1e9;
    checks.push({ id: "disk", label: "Disk free", ok: freeGb > 2,
      detail: `${freeGb.toFixed(1)} GB free` });
  } catch {}

  // public domain (best-effort — the box itself may lack outbound https)
  try {
    const r = await fetch("https://devin-web.zalize.com/api/health", { signal: AbortSignal.timeout(8000) });
    checks.push({ id: "public", label: "devin-web.zalize.com", ok: r.ok, detail: `HTTP ${r.status}` });
  } catch (e) {
    checks.push({ id: "public", label: "devin-web.zalize.com", ok: false,
      detail: `unreachable — ${e instanceof Error ? e.message : String(e)} (check cloudflared service)` });
  }

  console.error(`[diagnose] ${checks.filter(c => !c.ok).length}/${checks.length} failing in ${Date.now() - t0}ms`);
  return { ok: checks.every(c => c.ok), checks };
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
        const f = path.join(ctx.store.dataDir, "open-turns.json");
        fs.writeFileSync(f, "{}");
        results[fix] = "cleared — next boot won't replay them";
      } else if (fix === "restart-now") {
        results[fix] = "exiting — supervisor respawns immediately";
        setTimeout(() => { console.error("[repair] hard exit requested by user"); process.exit(0); }, 400);
      } else results[fix] = "unknown fix";
    } catch (e) { results[fix] = `failed: ${e instanceof Error ? e.message : String(e)}`; }
  }
  console.error(`[repair] done ${JSON.stringify(results)}`);
  return { results };
}
