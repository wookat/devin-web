/**
 * lweb/admin — the /api/admin/* route tree. Thin coordinator: owns the
 * helpers shared across families (runCli / indexWorkspace / scanLocalSkills)
 * and dispatches to the per-family modules under ./admin/ in the original
 * if-chain's first-appearance order. Called only when isAdmin (auth already
 * enforced by the index shell).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ApiContext } from "../routes.js";
import { handleSystem } from "./admin/system.js";
import { handleRegistry } from "./admin/registry.js";
import { handleFsBrowse } from "./admin/fsbrowse.js";
import { handleNewSession } from "./admin/newsession.js";
import { handlePerSession } from "./admin/persession.js";

// ---------------------------------------------------------------------------
// CLI proxy — spawn `devin <args>` with a hard whitelist (see /api/admin/cli/run)
// ---------------------------------------------------------------------------

export function runCli(argv: string[], cwd: string): Promise<{ ok: boolean; code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(DEFAULT_CLI, argv, { cwd, env: process.env, windowsHide: true });
    let out = "";
    const cap = () => { if (out.length > 256 * 1024) { proc.kill(); } };
    proc.stdout?.on("data", (d) => { out += String(d); cap(); });
    proc.stderr?.on("data", (d) => { out += String(d); cap(); });
    const timer = setTimeout(() => { proc.kill(); reject(new Error("cli timed out (30s)")); }, 30_000);
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
    proc.on("exit", (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, output: out }); });
  });
}

// Resolved once — same binary the acp pool spawns (agents.ts devin.command).
const DEFAULT_CLI = process.env.DEVIN_CLI_BIN || "devin";


// ---------------------------------------------------------------------------
// workspace file index (@file mentions) + local skills (@skills) + last-used
// ---------------------------------------------------------------------------

const INDEX_SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "out", ".next", ".nuxt", "target", "vendor", "__pycache__", ".venv", "venv", ".idea", ".vscode", "coverage", ".cache", "bin", "obj"]);
const wsIndexCache = new Map<string, { at: number; paths: string[] }>();

/** Bounded BFS of a workspace → relative forward-slash file paths (@files). */
export function indexWorkspace(root: string): string[] {
  const hit = wsIndexCache.get(root);
  if (hit && Date.now() - hit.at < 60_000) return hit.paths;
  const out: string[] = [];
  const queue: string[] = [""];
  while (queue.length && out.length < 5000) {
    const rel = queue.shift()!;
    const dir = rel ? path.join(root, rel) : root;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (out.length >= 5000) break;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!INDEX_SKIP_DIRS.has(e.name) && !e.name.startsWith(".turbo")) queue.push(r);
      } else {
        out.push(r);
      }
    }
  }
  wsIndexCache.set(root, { at: Date.now(), paths: out });
  return out;
}

/** Local skills visible to the @skills mention: project + user skill dirs. */
export function scanLocalSkills(ctx: ApiContext): { repo: string; name: string; description: string }[] {
  const seen = new Set<string>();
  const out: { repo: string; name: string; description: string }[] = [];
  const dirs = [
    path.join(ctx.primaryCwd, ".devin", "skills"),
    path.join(ctx.primaryCwd, ".agents", "skills"),
    path.join(os.homedir(), ".devin", "skills"),
    path.join(os.homedir(), ".agents", "skills"),
  ];
  for (const dir of dirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || seen.has(e.name)) continue;
      const md = path.join(dir, e.name, "SKILL.md");
      let desc = "";
      try {
        const head = fs.readFileSync(md, "utf8").slice(0, 4000);
        const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head)?.[1] ?? "";
        desc = /^description:\s*(.+)$/m.exec(fm)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
      } catch {
        continue; // no SKILL.md → not a skill dir
      }
      seen.add(e.name);
      out.push({ repo: dir.includes(".devin") ? "project" : "user", name: e.name, description: desc.slice(0, 200) });
    }
  }
  return out;
}

export async function handleAdminTree(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const m = req.method ?? "GET";
  const p = url.pathname;
  const parts = p.split("/").filter(Boolean);
  if (await handleSystem(ctx, req, res, url, m, p, parts)) return true;
  if (await handleRegistry(ctx, req, res, url, m, p, parts)) return true;
  if (await handleFsBrowse(ctx, req, res, url, m, p, parts)) return true;
  if (await handleNewSession(ctx, req, res, url, m, p, parts)) return true;
  if (await handlePerSession(ctx, req, res, url, m, p, parts)) return true;
  return false;
}
