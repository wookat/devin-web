// security.ts — local code scans (official "Security" surface parity).
// Official scans are cloud jobs over GitHub repos (`/code-scans` API family);
// locally each scan is a REAL acp session rooted at the target directory —
// the agent reads the actual code and ends with a JSON findings block that
// we parse into official-shaped finding records (severity/status/stage).
//
// dw.json: securityScans {id: DwSecurityScan}, securityProfiles {id: DwSecurityProfile}.
// Scan sessions show in the sidebar titled "🛡 <name>" in ".security".
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiContext } from "./routes.js";
import { loadReg, saveReg, meta, type DwSecurityScan, type DwSecurityFinding } from "./dwstore.js";
import { agentById } from "./agents.js";
import { dispatchPrompt, captureLoadResponse, loadedOn, sessionHost, isDraining } from "./sessionio.js";
import { remapLegacyCwd } from "./store.js";

function json(res: ServerResponse, code: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(s) });
  res.end(s);
}
async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return {}; }
}

const SCAN_CONTRACT = `Audit the codebase in the current working directory for real, exploitable
issues — injection, authn/authz gaps, secrets, unsafe deserialization,
SSRF, path traversal, dependency red flags, dangerous defaults. Prefer
reading code over guessing; cite file:line for every finding.

Your LAST message must be ONLY a JSON object (no prose, no fences):

{"findings":[{"title":string,"description":string,"file_path":string|null,
"start_line":number|null,"severity":"critical"|"high"|"medium"|"low"|"info",
"category":string|null,"cwe_id":string|null}],
"summary":string}

Use [] when the code is clean. Do not invent findings to fill the list.`;

function buildPrompt(scan: DwSecurityScan, profilePrompt: string): string {
  return [
    `Run a security and dependency audit across this codebase.`,
    `Check for vulnerabilities, outdated deps, license issues, and unsafe patterns.`,
    profilePrompt ? `Scan profile instructions:\n${profilePrompt}` : "",
    SCAN_CONTRACT,
  ].filter(Boolean).join("\n\n");
}

function sanitizeFinding(x: any): DwSecurityFinding | null {
  if (!x || typeof x !== "object" || !String(x.title ?? "").trim()) return null;
  const sev = ["critical", "high", "medium", "low", "info"].includes(String(x.severity)) ? String(x.severity) : "medium";
  return {
    finding_id: `f_${Math.random().toString(36).slice(2, 10)}`,
    title: String(x.title).slice(0, 200),
    description: String(x.description ?? "").slice(0, 4000),
    file_path: x.file_path ? String(x.file_path).slice(0, 500) : null,
    start_line: Number.isFinite(+x.start_line) ? +x.start_line : null,
    severity: sev as DwSecurityFinding["severity"],
    category: x.category ? String(x.category).slice(0, 100) : null,
    cwe_id: x.cwe_id ? String(x.cwe_id).slice(0, 40) : null,
    status: "open",
    stage: "unassigned",
  };
}

/** Extract {"findings":[...],"summary":...} from trailing agent text. */
function parseScanOutput(text: string): { findings: DwSecurityFinding[]; summary: string } {
  const i = text.indexOf("{"), j = text.lastIndexOf("}");
  if (i < 0 || j <= i) return { findings: [], summary: "" };
  try {
    const o = JSON.parse(text.slice(i, j + 1));
    const findings = (Array.isArray(o?.findings) ? o.findings : [])
      .map(sanitizeFinding).filter((x: DwSecurityFinding | null): x is DwSecurityFinding => !!x).slice(0, 200);
    return { findings, summary: String(o?.summary ?? "").slice(0, 2000) };
  } catch { return { findings: [], summary: "" }; }
}

// ---------------------------------------------------------------------------
// Scan execution — new session in the scanned cwd (the "fire" recipe shared
// with automations), dispatch the audit prompt, then poll the session log for
// the dw_turn_end marker and parse the trailing agent text for findings JSON.
// ---------------------------------------------------------------------------

const running = new Set<string>();
const POLL_MS = 3_000;
const SCAN_TIMEOUT_MS = 30 * 60_000;

async function runScan(ctx: ApiContext, scan: DwSecurityScan) {
  const reg = loadReg(ctx);
  const finish = (status: DwSecurityScan["status"], extra?: Partial<DwSecurityScan>) => {
    Object.assign(scan, { status, finished_at: Date.now() }, extra);
    reg.securityScans![scan.id] = scan;
    saveReg();
    running.delete(scan.id);
  };
  try {
    const profilePrompt = scan.profile_id ? (reg.securityProfiles?.[scan.profile_id]?.prompt ?? "") : "";
    const agent = agentById(undefined);
    const acp = agent.multiSession ? await ctx.manager.get(scan.cwd, agent) : await ctx.manager.startForSession(scan.cwd, agent);
    const s = await acp.newSession(scan.cwd);
    if (!agent.multiSession) {
      ctx.manager.bindSession(s.sessionId, acp);
      ctx.store.addAgentSession(s.sessionId, agent.id, scan.cwd);
    }
    ctx.sessionCwd.set(s.sessionId, remapLegacyCwd(scan.cwd));
    captureLoadResponse(s.sessionId, s);
    let n = loadedOn.get(acp);
    if (!n) loadedOn.set(acp, (n = new Set()));
    n.add(s.sessionId);
    sessionHost.set(s.sessionId, acp);
    const mm = meta(ctx, s.sessionId);
    mm.title = `🛡 ${scan.repo_name}`;
    mm.folder = ".security";
    scan.session_id = s.sessionId;
    scan.status = "running";
    reg.securityScans![scan.id] = scan;
    saveReg();

    const marker = ctx.sessionLog.get(s.sessionId).length;
    dispatchPrompt(ctx, s.sessionId, buildPrompt(scan, profilePrompt), []);

    // Poll for the turn-end marker — the session is visible + live in the UI
    // meanwhile, matching how official scans stream progress.
    const deadline = Date.now() + SCAN_TIMEOUT_MS;
    for (;;) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const log = ctx.sessionLog.get(s.sessionId);
      if (log.slice(marker).some((e) => e?.update?.sessionUpdate === "dw_turn_end")) {
        const text = log.slice(marker)
          .filter((e) => e?.update?.sessionUpdate === "agent_message_chunk")
          .map((e) => String((e.update.content as { text?: string } | undefined)?.text ?? ""))
          .join("");
        const { findings, summary } = parseScanOutput(text);
        finish("done", { findings, summary });
        return;
      }
      if (Date.now() > deadline) { finish("failed"); return; }
      if (isDraining()) { finish("failed"); return; }
    }
  } catch (e) {
    console.error(`[security] scan ${scan.id}: ${e instanceof Error ? e.message : e}`);
    finish("failed");
  }
}

export function resumeScans(ctx: ApiContext) {
  // A backend restart mid-scan leaves the record stuck in pending/running —
  // mark it failed; the session itself survives in the sidebar and can be
  // re-prompted manually, matching crash-recovery semantics elsewhere.
  const reg = loadReg(ctx);
  for (const s of Object.values(reg.securityScans ?? {})) {
    if (s.status === "pending" || s.status === "running") { s.status = "failed"; saveReg(); }
  }
}

export async function handleSecurityRoute(ctx: ApiContext, parts: string[], m: string, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const reg = loadReg(ctx);
  reg.securityScans ??= {};
  reg.securityProfiles ??= {};
  const seg = parts[3];

  // ---------------- profiles ----------------
  if (seg === "profiles") {
    if (m === "GET" && parts.length === 4) {
      json(res, 200, { profiles: Object.values(reg.securityProfiles).sort((a, b) => a.created_at - b.created_at) });
      return true;
    }
    if (m === "POST" && parts.length === 4) {
      const b = await readJson(req);
      const name = String(b.name ?? "").trim().slice(0, 120);
      const prompt = String(b.prompt ?? "").trim().slice(0, 20_000);
      if (!name) { json(res, 400, { error: "name required" }); return true; }
      const p = { id: `prof-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, name, prompt, created_at: Date.now() };
      reg.securityProfiles[p.id] = p; saveReg();
      json(res, 200, { ok: true, profile: p });
      return true;
    }
    if (m === "DELETE" && parts.length === 5) {
      delete reg.securityProfiles[decodeURIComponent(parts[4])]; saveReg();
      json(res, 200, { ok: true });
      return true;
    }
    json(res, 404, { error: "not found" });
    return true;
  }

  // ---------------- scans ----------------
  if (seg === "scans") {
    if (m === "GET" && parts.length === 4) {
      const scans = Object.values(reg.securityScans)
        .filter((s) => !s.archived)
        .sort((a, b) => b.created_at - a.created_at);
      const counts = { open_findings: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 };
      for (const s of scans) for (const f of s.findings ?? []) {
        if (f.status === "open") { counts.open_findings++; (counts as any)[f.severity] = ((counts as any)[f.severity] ?? 0) + 1; }
      }
      json(res, 200, { scans: scans.map((s) => ({ ...s, findings: undefined, finding_count: (s.findings ?? []).length, open_count: (s.findings ?? []).filter((f) => f.status === "open").length })), counts });
      return true;
    }
    if (m === "POST" && parts.length === 4) {
      const b = await readJson(req);
      const cwd = String(b.cwd ?? b.repo ?? "").trim();
      if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        json(res, 400, { error: "cwd must be an existing local directory" });
        return true;
      }
      const id = `scan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const scan: DwSecurityScan = {
        id,
        repo_name: String(b.name ?? path.basename(cwd)).slice(0, 120),
        cwd,
        scan_type: "security",
        status: "pending",
        effort: b.effort === "lite" ? "lite" : "standard",
        profile_id: b.profile_id ? String(b.profile_id) : null,
        session_id: null,
        findings: [],
        summary: "",
        created_at: Date.now(),
      };
      reg.securityScans[id] = scan; saveReg();
      if (isDraining()) { json(res, 503, { error: "server draining" }); return true; }
      running.add(id);
      void runScan(ctx, scan);
      json(res, 202, { ok: true, scan });
      return true;
    }
    if (parts.length >= 5) {
      const scan = reg.securityScans[decodeURIComponent(parts[4])];
      if (!scan || scan.archived) { json(res, 404, { error: "not found" }); return true; }
      if (m === "GET" && parts.length === 5) {
        json(res, 200, { scan });
        return true;
      }
      if (m === "DELETE" && parts.length === 5) {
        scan.archived = true; saveReg();
        json(res, 200, { ok: true });
        return true;
      }
      // PATCH /scans/:id/findings/:fid {status?, stage?}
      if (m === "PATCH" && parts[5] === "findings" && parts.length === 7) {
        const f = (scan.findings ?? []).find((x) => x.finding_id === decodeURIComponent(parts[6]));
        if (!f) { json(res, 404, { error: "finding not found" }); return true; }
        const b = await readJson(req);
        if (b.status != null && ["open", "resolved", "ignored", "false_positive"].includes(String(b.status))) f.status = b.status;
        if (b.stage != null && ["unassigned", "triaged", "fixing", "resolved"].includes(String(b.stage))) f.stage = b.stage;
        saveReg();
        json(res, 200, { ok: true, finding: f });
        return true;
      }
      json(res, 404, { error: "not found" });
      return true;
    }
  }
  return false;
}
