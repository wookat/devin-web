// automations.ts — local scheduled sessions (official "Automations" parity).
// dw.json `automations` holds 5-field cron entries; a 30s tick fires due ones:
// each fire creates a REAL session on the automation's cwd (mirrors the
// /api/admin/sessions/new recipe) and dispatchPrompts its task. Fired sessions
// show up in the sidebar titled "⚙ <name>" with folder ".automations".
// An automation may carry `steps[]` — a serial workflow run inside one
// session (context carries over). Progress is JOURNALED on the automation
// (`running {sessionId, step}`) so a backend restart resumes the chain: each
// tick, a running entry whose session has gone fully idle (no inflight turn,
// no open-turns entry, nothing queued) advances to the next step.
import type { ApiContext } from "./routes.js";
import { loadReg, saveReg, meta, type DwAutomation } from "./dwstore.js";
import { agentById } from "./agents.js";
import { dispatchPrompt } from "./sessionprompt.js";
import { captureLoadResponse } from "./sessioncfg.js";
import { markLoadedOn } from "./sessionplace.js";
import { inflight, isDraining } from "./sessionlive.js";
import { openTurns } from "./sessionturns.js";
import { queueList } from "./sessionqueue.js";
import { remapLegacyCwd } from "./store.js";

// ---------------------------------------------------------------------------
// 5-field cron: "min hour dom mon dow" — * , */n , a-b , a,b,c ; dow 0|7=Sun.
// Vixie rule: when both dom and dow are restricted they OR, else they AND.
// ---------------------------------------------------------------------------

function parseField(f: string, lo: number, hi: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of f.split(",")) {
    const [rng, stepS] = part.split("/");
    const step = stepS ? Math.max(1, parseInt(stepS, 10) || 0) : 1;
    if (!step) return null;
    let a = lo, b = hi;
    if (rng !== "*") {
      const m = rng.match(/^(\d+)(?:-(\d+))?$/);
      if (!m) return null;
      a = +m[1]; b = m[2] != null ? +m[2] : a;
      if (a < lo || b > hi || a > b) return null;
    }
    for (let i = a; i <= b; i += step) out.add(i);
  }
  return out.size ? out : null;
}

/** Next fire time after `from`, or null when the expression is invalid /
 *  unreachable within a year. Cheap scan — worst ~527k trivial iterations
 *  only for impossible expressions (Feb 31), and only at save-time. */
export function cronNext(expr: string, from = Date.now()): number | null {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const mn = parseField(f[0], 0, 59), hh = parseField(f[1], 0, 23);
  const dm = parseField(f[2], 1, 31), mo = parseField(f[3], 1, 12);
  const dw = parseField(f[4], 0, 7);
  if (!mn || !hh || !dm || !mo || !dw) return null;
  const domAny = f[2] === "*", dowAny = f[4] === "*";
  const t = new Date(from + 60_000);
  t.setSeconds(0, 0);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const dom = dm.has(t.getDate());
    const dow = dw.has(t.getDay()) || (t.getDay() === 0 && dw.has(7));
    const day = !domAny && !dowAny ? dom || dow : dom && dow;
    if (mo.has(t.getMonth() + 1) && day && hh.has(t.getHours()) && mn.has(t.getMinutes())) return t.getTime();
    t.setMinutes(t.getMinutes() + 1);
  }
  return null;
}

// ---------------------------------------------------------------------------
// firing — real session per run, same recipe as POST /api/admin/sessions/new
// ---------------------------------------------------------------------------

const firing = new Set<string>();

/** Effective step list — single-prompt automations count as one step. */
function stepsOf(a: DwAutomation): { name: string; prompt: string }[] {
  return a.steps?.length ? a.steps : [{ name: "", prompt: a.prompt }];
}

/** Fully idle? inflight (in-memory) + openTurns (journaled / adopted turns)
 * + a parked queue all mean the turn is still owned by someone. */
function sessionBusy(id: string): boolean {
  return inflight.has(id) || openTurns.has(id) || queueList(id).length > 0;
}

function sendStep(ctx: ApiContext, a: DwAutomation, sessionId: string, step: number) {
  const st = stepsOf(a)[step];
  if (!st) return;
  a.running = { sessionId, step, sentAt: Date.now() };
  saveReg();
  // Promise-bearing dispatch — a bare call would let a rejection escape to
  // unhandledRejection (auto-resume does the same dance).
  void Promise.resolve(dispatchPrompt(ctx, sessionId, st.prompt, [])).catch((e) =>
    console.error(`[automations] ${a.name} step ${step + 1}: dispatch failed`, e));
}

/** Close out the running entry: history row (cap 10) + clear the marker. */
function finishRun(a: DwAutomation) {
  if (!a.running) return;
  (a.runs ??= []).push({ at: a.lastRun ?? Date.now(), sessionId: a.running.sessionId });
  if (a.runs.length > 10) a.runs = a.runs.slice(-10);
  delete a.running;
  saveReg();
}

async function fire(ctx: ApiContext, a: DwAutomation): Promise<string | null> {
  const cwd = a.cwd || ctx.primaryCwd;
  const agent = agentById(undefined);
  const acp = agent.multiSession
    ? await ctx.manager.get(cwd, agent)
    : await ctx.manager.startForSession(cwd, agent);
  const s = await acp.newSession(cwd);
  if (!agent.multiSession) {
    ctx.manager.bindSession(s.sessionId, acp);
    ctx.store.addAgentSession(s.sessionId, agent.id, cwd);
  }
  ctx.sessionCwd.set(s.sessionId, remapLegacyCwd(cwd));
  captureLoadResponse(s.sessionId, s, acp.agent?.id ?? "devin");
    markLoadedOn(s.sessionId, acp);
  const mm = meta(ctx, s.sessionId);
  mm.title = `⚙ ${a.name}`;
  mm.folder = ".automations";
  saveReg();
  sendStep(ctx, a, s.sessionId, 0);
  return s.sessionId;
}

export async function runAutomation(ctx: ApiContext, id: string): Promise<string | null> {
  const a = loadReg(ctx).automations?.[id];
  if (!a) return null;
  delete a.running; // manual run supersedes any wedged chain marker
  const sid = await fire(ctx, a);
  a.lastRun = Date.now();
  a.lastSession = sid ?? undefined;
  a.nextRun = cronNext(a.schedule) ?? undefined;
  saveReg();
  return sid;
}

// ---------------------------------------------------------------------------
// scheduler — 30s tick; journaled `running` drives multi-step progression
// ---------------------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null;

export function startAutomations(ctx: ApiContext) {
  if (timer) return;
  timer = setInterval(() => void tick(ctx).catch(() => {}), 30_000);
  void tick(ctx).catch(() => {});
}

async function tick(ctx: ApiContext) {
  if (isDraining()) return;
  const reg = loadReg(ctx);
  const autos = reg.automations ?? {};
  const now = Date.now();
  for (const a of Object.values(autos)) {
    // ── In-flight workflow chain (survives restarts — `running` is journaled)
    const r = a.running;
    if (r) {
      if (!meta(ctx, r.sessionId)) { finishRun(a); continue; } // session deleted → abort chain
      if (sessionBusy(r.sessionId)) continue;                   // turn still owned — keep waiting
      if (now - r.sentAt < 10_000) continue;                    // grace: let the turn actually register
      const steps = stepsOf(a);
      if (r.step + 1 < steps.length) sendStep(ctx, a, r.sessionId, r.step + 1);
      else finishRun(a);
      continue;
    }
    // ── Cron firing
    if (!a.enabled || firing.has(a.id)) continue;
    const next = a.nextRun ?? (a.nextRun = cronNext(a.schedule) ?? undefined);
    if (!next || next > now) continue;
    firing.add(a.id);
    a.lastRun = now;           // mark BEFORE firing — overlap-proof
    a.nextRun = cronNext(a.schedule, now) ?? undefined;
    saveReg();
    try {
      const sid = await fire(ctx, a);
      a.lastSession = sid ?? undefined;
      saveReg();
    } catch (e) {
      console.error(`[automations] ${a.name}: ${e instanceof Error ? e.message : e}`);
      (a.runs ??= []).push({ at: now, sessionId: null });
      if (a.runs.length > 10) a.runs = a.runs.slice(-10);
      delete a.running; // session spawn failed — clear any marker fire() planted
      saveReg();
    } finally {
      firing.delete(a.id);
    }
  }
}
