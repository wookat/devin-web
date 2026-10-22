/**
 * lweb/admin/fsbrowse — filesystem browsers: fs/dirs + fs/list + fs/file
 * (draft workspace picker), the ssh dirs/test/fs ops, and the agent
 * resource roots (rules/skills enumeration + confined resource-file r/w).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ApiContext } from "../../routes.js";
import { sshFs, sshHostFor, sshListDirs, sshTest } from "../../ssh.js";
import { json, readJson } from "../../httputil.js";

/** Agent resource roots: project .devin/.agents + global ~/.devin/~/.agents +
 *  the well-known root rule files. Returns the resolved path when `raw` lands
 *  inside, else null. Shared by /api/admin/resource-file and the per-session
 *  rule-file route (sessioncontrol) — keep the two confined identically. */
export function resourceRootPath(ctx: ApiContext, raw: string): string | null {
  const roots = [
    path.join(ctx.primaryCwd, ".devin"), path.join(ctx.primaryCwd, ".agents"),
    path.join(os.homedir(), ".devin"), path.join(os.homedir(), ".agents"),
  ];
  const extra = ["AGENTS.md", "CLAUDE.md", ".windsurfrules", ".cursorrules"].map((f) => path.resolve(ctx.primaryCwd, f));
  const rp = raw ? path.resolve(raw) : "";
  if (!rp) return null;
  return (roots.some((r) => rp === path.resolve(r) || rp.startsWith(path.resolve(r) + path.sep)) || extra.includes(rp)) ? rp : null;
}

export async function handleFsBrowse(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL, m: string, p: string, parts: string[]): Promise<boolean> {
  // GET /api/admin/fs/dirs?path= — directory browser for the new-session
  // workspace picker (desktop parity). Admin-only, dirs never files;
  // path=roots returns win32 drive letters ('/' on posix), empty path
  // starts at primaryCwd. A drive root's parent comes back as "roots".
  if (p === "/api/admin/fs/dirs" && m === "GET") {
    const raw = (url.searchParams.get("path") ?? "").trim();
    const listDirs = (target: string) => fs.readdirSync(target, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => ({ name: d.name, path: path.join(target, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 500);
    try {
      if (raw === "roots") {
        if (process.platform === "win32") {
          const drives: { name: string; path: string }[] = [];
          for (let i = 65; i <= 90; i++) {
            const d = `${String.fromCharCode(i)}:\\`;
            try { fs.accessSync(d); drives.push({ name: d, path: d }); } catch { /* absent */ }
          }
          json(res, 200, { cwd: "", parent: null, dirs: drives });
        } else {
          json(res, 200, { cwd: "/", parent: null, dirs: listDirs("/") });
        }
        return true;
      }
      const target = path.resolve(raw || ctx.primaryCwd);
      if (!fs.statSync(target).isDirectory()) throw new Error("not a dir");
      const parent = path.dirname(target);
      json(res, 200, {
        cwd: target,
        parent: parent === target ? (process.platform === "win32" ? "roots" : null) : parent,
        dirs: listDirs(target),
      });
    } catch { json(res, 400, { error: "bad_path" }); }
    return true;
  }

  // GET /api/admin/ssh/dirs?target&path — REMOTE directory listing for the
  // draft picker's ssh mode (sftp on the pooled control connection). The
  // target must be a configured prefs.sshHosts entry.
  if (p === "/api/admin/ssh/dirs" && m === "GET") {
    const target = (url.searchParams.get("target") ?? "").trim();
    if (!sshHostFor(target)) { json(res, 400, { error: "ssh target not configured" }); return true; }
    try {
      json(res, 200, await sshListDirs(target, url.searchParams.get("path") ?? ""));
    } catch (e) {
      json(res, 400, { error: e instanceof Error ? e.message : "ssh_list_failed" });
    }
    return true;
  }

  // POST /api/admin/ssh/test {target} — connectivity probe for the
  // settings SSH panel (auth check + latency + remote whoami).
  if (p === "/api/admin/ssh/test" && m === "POST") {
    const body = await readJson(req);
    const target = String(body.target ?? "").trim();
    if (!sshHostFor(target)) { json(res, 400, { error: "ssh target not configured" }); return true; }
    json(res, 200, await sshTest(target));
    return true;
  }

  // POST /api/admin/ssh/fs {target, op, path, to?, content?} — remote file
  // management: list / mkdir / rename / delete / write / read.
  if (p === "/api/admin/ssh/fs" && m === "POST") {
    const body = await readJson(req);
    const target = String(body.target ?? "").trim();
    if (!sshHostFor(target)) { json(res, 400, { error: "ssh target not configured" }); return true; }
    try {
      json(res, 200, await sshFs(target, body as Parameters<typeof sshFs>[1]));
    } catch (e) {
      json(res, 400, { error: e instanceof Error ? e.message : "ssh_fs_failed" });
    }
    return true;
  }

  // Draft-page project browser: list dirs+files / read text, same shape as
  // the session workspace endpoints but rooted anywhere the picker reached.
  if (p === "/api/admin/fs/list" && m === "GET") {
    const target = path.resolve(url.searchParams.get("path") || ctx.primaryCwd);
    try {
      const entries = fs.readdirSync(target, { withFileTypes: true })
        .filter((e) => !e.name.startsWith(".git") && e.name !== "node_modules")
        .map((e) => ({ name: e.name, dir: e.isDirectory() }))
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
        .slice(0, 2000);
      json(res, 200, { cwd: target, entries });
    } catch { json(res, 400, { error: "bad_path" }); }
    return true;
  }
  if (p === "/api/admin/fs/file" && m === "GET") {
    const target = path.resolve(url.searchParams.get("path") || "");
    try {
      const buf = fs.readFileSync(target);
      if (buf.length > 2 * 1024 * 1024) { json(res, 413, { error: "too large" }); return true; }
      const bin = /[\x00-\x08]/.test(buf.subarray(0, 512).toString("binary"));
      json(res, 200, { text: bin ? null : buf.toString("utf8"), binary: bin });
    } catch { json(res, 404, { error: "not found" }); }
    return true;
  }


  // Multi-level agent resources: global (~/.devin, ~/.agents) + project
  // (<cwd>/.devin, <cwd>/.agents). Enumerate rules/skills for /settings.
  if (parts[2] === "resources" && m === "GET") {
    const scopes = [
      { scope: "project" as const, dir: path.join(ctx.primaryCwd, ".devin") },
      { scope: "project" as const, dir: path.join(ctx.primaryCwd, ".agents") },
      { scope: "global" as const, dir: path.join(os.homedir(), ".devin") },
      { scope: "global" as const, dir: path.join(os.homedir(), ".agents") },
    ];
    const rules: { scope: string; name: string; path: string }[] = [];
    const skills: { scope: string; name: string; description: string; path: string }[] = [];
    const seenSkill = new Set<string>();
    const listMd = (dir: string, scope: string, rel: string) => {
      try {
        for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
          const p = path.join(dir, rel, e.name);
          if (e.isDirectory()) listMd(dir, scope, rel ? `${rel}/${e.name}` : e.name);
          else if (/\.(md|txt|mdc)$/i.test(e.name)) rules.push({ scope, name: e.name, path: p });
        }
      } catch { /* missing dir */ }
    };
    for (const { scope, dir } of scopes) {
      listMd(dir, scope, "rules");
      try {
        for (const e of fs.readdirSync(path.join(dir, "skills"), { withFileTypes: true })) {
          if (!e.isDirectory() || seenSkill.has(e.name)) continue;
          const md = path.join(dir, "skills", e.name, "SKILL.md");
          let desc = "";
          try {
            const head = fs.readFileSync(md, "utf8").slice(0, 4000);
            const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head)?.[1] ?? "";
            desc = /^description:\s*(.+)$/m.exec(fm)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
          } catch { continue; }
          seenSkill.add(e.name);
          skills.push({ scope, name: e.name, description: desc.slice(0, 200), path: md });
        }
      } catch { /* no skills dir */ }
    }
    // AGENTS.md / CLAUDE.md at the project root count as project rules.
    for (const f of ["AGENTS.md", "CLAUDE.md", ".windsurfrules", ".cursorrules"]) {
      const p = path.join(ctx.primaryCwd, f);
      if (fs.existsSync(p)) rules.push({ scope: "project", name: f, path: p });
    }
    json(res, 200, { cwd: ctx.primaryCwd, rules, skills });
    return true;
  }

  // /api/admin/resource-file?path= — read/write files under the resource
  // roots only (project .devin/.agents + global ~/.devin/~/.agents + the
  // project-root agent files). Confined exactly like session /file ops.
  if (parts[2] === "resource-file") {
    const raw = m === "GET" ? url.searchParams.get("path") : String((await readJson(req)).path ?? "");
    const rp = resourceRootPath(ctx, String(raw ?? ""));
    if (!rp) { json(res, 403, { error: "outside resource roots" }); return true; }
    if (m === "GET") {
      try {
        const buf = fs.readFileSync(rp);
        json(res, 200, { text: buf.toString("utf8"), binary: /[\x00-\x08]/.test(buf.subarray(0, 512).toString("binary")) });
      } catch { json(res, 404, { error: "not found" }); }
      return true;
    }
    if (m === "POST") {
      const body = await readJson(req);
      try {
        fs.mkdirSync(path.dirname(rp), { recursive: true });
        fs.writeFileSync(rp, String(body.text ?? ""), "utf8");
        json(res, 200, { ok: true });
      } catch (e) { json(res, 500, { error: e instanceof Error ? e.message : "write failed" }); }
      return true;
    }
    json(res, 405, { error: "method" });
    return true;
  }

  // POST /api/admin/skill-install {name, content} — installing a skill locally
  // IS writing ~/.agents/skills/<name>/SKILL.md: the agent's skills/list probe
  // and the /resources enumerator both scan exactly that dir. Older devin
  // builds don't expose a plugins/marketplace ext method, so there is no
  // remote catalog to search — this is the honest local install path.
  if (parts[2] === "skill-install" && m === "POST") {
    const body = await readJson(req);
    const name = String(body.name ?? "").trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) { json(res, 400, { error: "bad name" }); return true; }
    const target = path.join(os.homedir(), ".agents", "skills", name, "SKILL.md");
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, String(body.content ?? ""), "utf8");
      json(res, 200, { ok: true, path: target });
    } catch (e) { json(res, 500, { error: e instanceof Error ? e.message : "write failed" }); }
    return true;
  }

  return false;
}
