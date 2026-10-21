// Wiki endpoints — the local equivalent of the official /wiki surface.
// Official wiki is DeepWiki-backed (org private repos). Locally we ride the
// free public DeepWiki MCP server (https://mcp.deepwiki.com/mcp — streamable
// HTTP, no auth) which exposes read_wiki_structure / read_wiki_contents /
// ask_wiki_question for any indexed PUBLIC GitHub repo.
//
// Endpoints (all under /api/admin/wiki):
//   GET    /repos                     → {repos:[{repo,pinned,addedAt,lastOpenedAt,indexed,topicCount?}]}
//   POST   /repos        {repo}       → validate via structure probe, then add
//   DELETE /repos/:owner/:repo
//   POST   /repos/:owner/:repo/pin    {pinned:boolean}
//   GET    /structure?repo=owner/repo → {topics:[{id,title,depth}]}
//   GET    /page?repo=&page=<id>      → {title, markdown}  (full-doc split)
//   POST   /ask          {repo,question} → {answer}
import fs from "node:fs";
import { json, readJson } from "./httputil.js";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiContext } from "./routes.js";
import { loadReg, saveReg } from "./dwstore.js";

const MCP_URL = "https://mcp.deepwiki.com/mcp";
const CACHE_TTL_MS = 24 * 3600_000;


let rpcId = 0;
/** One JSON-RPC call over MCP streamable-HTTP. The server replies as an SSE
 *  stream (`event: message` + `data: {...}`) even for single responses —
 *  collect `data:` lines and take the first complete JSON-RPC result. */
async function mcpCall(tool: string, args: Record<string, unknown>, timeoutMs = 90_000): Promise<{ text: string; isError: boolean }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name: tool, arguments: args } }),
      signal: ac.signal,
    });
    if (!r.ok) throw new Error(`mcp http ${r.status}`);
    const raw = await r.text();
    // SSE: lines of `data: {json}` — last one carries the result.
    let result: any = null;
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try { result = JSON.parse(line.slice(5).trim()); } catch { /* keep last good */ }
    }
    if (!result) throw new Error("mcp empty response");
    if (result.error) throw new Error(result.error.message || "mcp rpc error");
    const sc = result.result?.structuredContent?.result;
    const text = typeof sc === "string" ? sc : result.result?.content?.[0]?.text ?? "";
    return { text, isError: !!result.result?.isError };
  } finally {
    clearTimeout(timer);
  }
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const validRepo = (s: string) => REPO_RE.test(s.trim()) && s.trim().length < 200;

/** Parse the structure text ("- 1 Title\n  - 1.1 Sub") into ordered topics. */
export function parseStructure(text: string): { id: string; title: string; depth: number }[] {
  const topics: { id: string; title: string; depth: number }[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^(\s*)-\s+([\d.]+)\s+(.+?)\s*$/);
    if (!m) continue;
    topics.push({ id: m[2], title: m[3], depth: Math.floor(m[1].length / 2) });
  }
  return topics;
}

/** Split the concatenated wiki doc on `# Page:` markers. Returns pages in
 *  document order; each keeps its title + full markdown body. */
export function splitPages(doc: string): { title: string; markdown: string }[] {
  const parts = doc.split(/^# Page:\s*/m).slice(1);
  return parts.map((p) => {
    const nl = p.indexOf("\n");
    return { title: (nl < 0 ? p : p.slice(0, nl)).trim(), markdown: nl < 0 ? "" : p.slice(nl + 1).trim() };
  });
}

function cacheFile(ctx: ApiContext, repo: string) {
  return path.join(ctx.store.dataDir, "wiki-cache", repo.replace("/", "--") + ".md");
}
/** Full wiki doc with a 24h disk cache (react's is ~670KB — refetching per
 *  page click would be miserable). `force` bypasses the cache. */
async function wikiDoc(ctx: ApiContext, repo: string, force = false): Promise<string> {
  const f = cacheFile(ctx, repo);
  if (!force) {
    try {
      const st = fs.statSync(f);
      if (Date.now() - st.mtimeMs < CACHE_TTL_MS) return fs.readFileSync(f, "utf8");
    } catch { /* no cache */ }
  }
  const { text, isError } = await mcpCall("read_wiki_contents", { repoName: repo });
  if (isError || !text) throw new Error(text.slice(0, 300) || "deepwiki returned no content");
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); } catch { /* cache is best-effort */ }
  return text;
}

export async function handleWikiRoute(ctx: ApiContext, parts: string[], m: string, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const reg = loadReg(ctx);
  reg.wikiRepos ??= {};

  // /repos CRUD
  if (parts[3] === "repos") {
    if (m === "GET" && parts.length === 4) {
      const repos = Object.values(reg.wikiRepos)
        .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.lastOpenedAt ?? b.addedAt) - (a.lastOpenedAt ?? a.addedAt));
      json(res, 200, { repos });
      return true;
    }
    if (m === "POST" && parts.length === 4) {
      const body = await readJson(req);
      const repo = String(body.repo ?? "").trim().toLowerCase();
      if (!validRepo(repo)) { json(res, 400, { error: "repo must be owner/name" }); return true; }
      // Validate indexability once so the card doesn't render dead on arrival.
      const probe = await mcpCall("read_wiki_structure", { repoName: repo }).catch((e) => ({ text: "", isError: true, err: String(e) }));
      const topics = parseStructure(probe.text ?? "");
      if (!topics.length) { json(res, 404, { error: "no DeepWiki index for this repo (public repos only)" }); return true; }
      const rec = reg.wikiRepos[repo] ?? { repo, pinned: false, addedAt: Date.now() };
      rec.indexed = true;
      rec.topicCount = topics.length;
      rec.topics = topics;
      reg.wikiRepos[repo] = rec;
      saveReg();
      json(res, 200, { ok: true, repo: rec });
      return true;
    }
    // /repos/:owner/:repo[/pin]
    if (parts.length >= 6) {
      const repo = `${decodeURIComponent(parts[4])}/${decodeURIComponent(parts[5])}`.toLowerCase();
      const rec = reg.wikiRepos[repo];
      if (!rec) { json(res, 404, { error: "not found" }); return true; }
      if (m === "DELETE" && parts.length === 6) {
        delete reg.wikiRepos[repo]; saveReg();
        json(res, 200, { ok: true });
        return true;
      }
      if (m === "POST" && parts[6] === "pin") {
        const body = await readJson(req);
        rec.pinned = !!body.pinned; saveReg();
        json(res, 200, { ok: true, repo: rec });
        return true;
      }
      json(res, 404, { error: "not found" });
      return true;
    }
  }

  const repo = String(url.searchParams.get("repo") ?? "").trim().toLowerCase();

  // GET /structure?repo= — topic tree (cached on the repo record when known).
  if (parts[3] === "structure" && m === "GET") {
    if (!validRepo(repo)) { json(res, 400, { error: "repo must be owner/name" }); return true; }
    const rec = reg.wikiRepos[repo];
    if (rec?.topics?.length && !url.searchParams.has("fresh")) {
      json(res, 200, { topics: rec.topics });
      return true;
    }
    const { text, isError } = await mcpCall("read_wiki_structure", { repoName: repo });
    const topics = parseStructure(text);
    if (!topics.length) { json(res, 404, { error: isError ? text.slice(0, 300) : "no DeepWiki index for this repo" }); return true; }
    if (rec) { rec.topics = topics; rec.indexed = true; rec.topicCount = topics.length; saveReg(); }
    json(res, 200, { topics });
    return true;
  }

  // GET /page?repo=&page=<topicId|index> — one page of the split doc. Touch
  // lastOpenedAt so the home grid's "recently viewed" ordering works.
  if (parts[3] === "page" && m === "GET") {
    if (!validRepo(repo)) { json(res, 400, { error: "repo must be owner/name" }); return true; }
    let pages: { title: string; markdown: string }[];
    try { pages = splitPages(await wikiDoc(ctx, repo, url.searchParams.has("fresh"))); }
    catch (e) { json(res, 502, { error: String(e).slice(0, 300) }); return true; }
    const want = String(url.searchParams.get("page") ?? "");
    const rec = reg.wikiRepos[repo];
    let topics = rec?.topics ?? [];
    // Repo opened without a prior structure fetch (e.g. direct link) — pull
    // it now so topic ids resolve instead of falling through to page 0.
    if (!topics.length) {
      const s = await mcpCall("read_wiki_structure", { repoName: repo }).catch(() => null);
      topics = s ? parseStructure(s.text) : [];
      if (rec && topics.length) { rec.topics = topics; rec.indexed = true; rec.topicCount = topics.length; saveReg(); }
    }
    const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    // Topic id → title → page-by-title is the reliable mapping (page order in
    // the concatenated doc occasionally differs from the topic list order).
    const topic = topics.find((t) => t.id === want);
    let page = (topic && pages.find((p) => norm(p.title) === norm(topic.title) || norm(p.title).endsWith(norm(topic.title))))
      ?? pages.find((p) => norm(p.title) === norm(want))
      ?? (topics.length && pages.length ? pages[Math.max(0, topics.findIndex((t) => t.id === want))] : undefined)
      ?? (/^\d+$/.test(want) ? pages[+want] : undefined)
      ?? pages[0];
    if (!page) { json(res, 404, { error: "page not found" }); return true; }
    if (rec) { rec.lastOpenedAt = Date.now(); saveReg(); }
    json(res, 200, { title: page.title, markdown: page.markdown, pageCount: pages.length });
    return true;
  }

  // POST /ask {repo, question}
  if (parts[3] === "ask" && m === "POST") {
    const body = await readJson(req);
    const r2 = String(body.repo ?? "").trim().toLowerCase();
    const q = String(body.question ?? "").trim();
    if (!validRepo(r2) || !q) { json(res, 400, { error: "repo and question required" }); return true; }
    const { text, isError } = await mcpCall("ask_wiki_question", { repoName: r2, question: q.slice(0, 4000) }, 120_000)
      .catch((e) => ({ text: String(e), isError: true }));
    if (isError) { json(res, 502, { error: text.slice(0, 300) }); return true; }
    if (reg.wikiRepos[r2]) { reg.wikiRepos[r2].lastOpenedAt = Date.now(); saveReg(); }
    json(res, 200, { answer: text });
    return true;
  }

  return false;
}
