/**
 * lweb/admin/sessionfiles — the per-session file surface under
 * /api/admin/session/:id: editor writes/ops, the workspace git-status
 * map, the workspace browser (files/file), and the cloud-compat presign
 * stub. ADMIN ONLY (never in sessionSubs: share links must not write);
 * every path is confined inside the session cwd.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ApiContext } from "../../routes.js";
import { json, readJson } from "../../httputil.js";
import { cwdFor, confined } from "../session.js";

/** file-git response cache — 8s per session (was lweb/common). */
const gitStatusCache = new Map<string, { at: number; body: unknown }>();

export async function handleSessionFiles(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL, m: string, sub: string, id: string): Promise<boolean> {
  // Editor write/ops — ADMIN ONLY (never in sessionSubs: share links must
  // not write). All paths confined inside the session cwd.
  if (sub === "file-write" && m === "POST") {
    const body = await readJson(req);
    const cwd = cwdFor(ctx, id);
    const full = confined(cwd, body.path);
    if (!full) { json(res, 400, { error: "path escapes cwd" }); return true; }
    try {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      const buf = typeof body.base64 === "string" ? Buffer.from(body.base64, "base64") : Buffer.from(String(body.text ?? ""), "utf8");
      if (buf.length > 50 * 1024 * 1024) { json(res, 413, { error: "too large" }); return true; }
      fs.writeFileSync(full, buf);
      json(res, 200, { ok: true, size: buf.length });
    } catch (e) { json(res, 500, { error: (e as Error).message }); }
    return true;
  }
  if (sub === "file-ops" && m === "POST") {
    const body = await readJson(req);
    const cwd = cwdFor(ctx, id);
    const full = confined(cwd, body.path);
    if (!full) { json(res, 400, { error: "path escapes cwd" }); return true; }
    const dest = typeof body.to === "string" ? confined(cwd, body.to) : null;
    const needDest = body.op === "rename" || body.op === "move" || body.op === "copy";
    if (needDest && !dest) { json(res, 400, { error: "destination escapes cwd" }); return true; }
    try {
      switch (body.op) {
        case "rename": fs.renameSync(full, dest!); break;
        case "move": fs.renameSync(full, path.join(dest!, path.basename(full))); break;
        case "copy": fs.cpSync(full, dest!, { recursive: true }); break;
        case "mkdir": fs.mkdirSync(full, { recursive: true }); break;
        case "newfile": if (fs.existsSync(full)) { json(res, 409, { error: "exists" }); return true; } fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, ""); break;
        case "delete": fs.rmSync(full, { recursive: true, force: true }); break;
        default: json(res, 400, { error: `unknown op ${body.op}` }); return true;
      }
      json(res, 200, { ok: true });
    } catch (e) { json(res, 500, { error: (e as Error).message }); }
    return true;
  }

  // GET file-git — VSCode-style git status map for the workspace tree.
  // {git:false} for non-repo cwds; otherwise map relpath→status letter.
  if (sub === "file-git" && m === "GET") {
    const cwd = cwdFor(ctx, id);
    const cache = (gitStatusCache.get(id) ?? { at: 0, body: { git: false, map: {} } }) as { at: number; body: unknown };
    if (Date.now() - cache.at < 8000) { json(res, 200, cache.body); return true; }
    let body: { git: boolean; map: Record<string, string> } = { git: false, map: {} };
    try {
      const r = spawnSync("git", ["status", "--porcelain=v1", "-z", "--ignored=no"], { cwd, encoding: "buffer", timeout: 5000, windowsHide: true });
      if (r.status === 0 && r.stdout) {
        const map: Record<string, string> = {};
        const segs = r.stdout.toString("utf8").split("\0");
        for (let i = 0; i + 0 < segs.length; i++) {
          const line = segs[i];
          if (!line) continue;
          const x = line[0], y = line[1];
          const rel = line.slice(3);
          const st = y !== " " ? y : x;
          map[rel.replace(/\\/g, "/")] = st === "?" ? "U" : (st || "M");
          if (x === "R" || x === "C") i++; // rename/copy: skip the source path field
        }
        body = { git: true, map };
      }
    } catch { /* git absent or not a repo */ }
    gitStatusCache.set(id, { at: Date.now(), body });
    json(res, 200, body);
    return true;
  }

  // Workspace file browser — the session's project tree mapped into the
  // panel. Confined to the session cwd; never touches acp state.
  if (sub === "files" && m === "GET") {
    const cwd = cwdFor(ctx, id);
    const rel = url.searchParams.get("path") ?? "";
    try {
      const dir = path.resolve(cwd, rel);
      const relCheck = path.relative(cwd, dir);
      if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) throw new Error("escapes workspace");
      const ents = await fs.promises.readdir(dir, { withFileTypes: true });
      const entries = ents
        .filter((e) => !e.name.startsWith(".") || url.searchParams.get("all") === "1")
        .map((e) => {
          let size = 0, mtime = "";
          try { const s = fs.statSync(path.join(dir, e.name)); size = s.size; mtime = s.mtime.toISOString(); } catch { /* gone */ }
          return { name: e.name, dir: e.isDirectory(), size, mtime };
        })
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
      json(res, 200, { cwd, path: relCheck.replace(/\\/g, "/"), entries, error: null });
    } catch (e) {
      json(res, 200, { cwd, path: rel, entries: [], error: e instanceof Error ? e.message : String(e) });
    }
    return true;
  }
  if (sub === "file" && m === "GET") {
    const cwd = cwdFor(ctx, id);
    const rel = url.searchParams.get("path") ?? "";
    try {
      const file = path.resolve(cwd, rel);
      const relCheck = path.relative(cwd, file);
      if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) throw new Error("escapes workspace");
      const stat = fs.statSync(file);
      if (stat.isDirectory()) throw new Error("is a directory");
      // ?stat=1 — the workspace live-sync probes open files without paying
      // for the content read on every poll.
      if (url.searchParams.get("stat") === "1") { json(res, 200, { path: rel, text: null, stat: true, size: stat.size, mtime: stat.mtime.toISOString() }); return true; }
      if (stat.size > 2 * 1024 * 1024) { json(res, 200, { path: rel, text: null, truncated: false, tooLarge: true, size: stat.size, mtime: stat.mtime.toISOString() }); return true; }
      const buf = fs.readFileSync(file);
      const text = buf.includes(0) ? null : buf.toString("utf8");
      json(res, 200, { path: rel, text, truncated: stat.size > 512 * 1024 ? true : false, binary: text === null, size: stat.size, mtime: stat.mtime.toISOString() });
    } catch (e) {
      json(res, 200, { path: rel, text: null, error: e instanceof Error ? e.message : String(e) });
    }
    return true;
  }

  if (sub === "presign" && m === "POST") {
    json(res, 200, { urls: {} });
    return true;
  }

  return false;
}
