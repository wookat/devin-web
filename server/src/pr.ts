// GitHub-backed PR review endpoints for PrPanel (web/src/pages/mirror/PrPanel.tsx).
// All data flows through the `gh` CLI (user-authenticated, `repo` scope) — no
// Devin cloud dependency. Covers github.com PRs; other hosts return a clear error.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiContext } from "./routes.js";
import { loadReg, saveReg, meta } from "./dwstore.js";
import {
  acpForId, promptWithRetry, isDraining,
  inflight, loadedOn, sessionHost, captureLoadResponse,
} from "./sessionio.js";

// Never pass free-text via -f/-F: gh reads `@path` values as files (comment
// bodies starting with a mention would break) and brace/escape handling is
// fragile — every body goes through --input - as JSON on stdin.
function ghRun(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = execFile("gh", args, { timeout: 60_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (e, so, se) => { if (e) reject(new Error(String(se || e.message).slice(0, 500))); else resolve(so); });
    p.stdin!.end(input ?? "");
  });
}
async function ghJson(args: string[], input?: string): Promise<any> {
  const out = await ghRun(args, input);
  return out.trim() ? JSON.parse(out) : null;
}
const ghRest = (path: string) => ghJson(["api", path]);
const ghWrite = (path: string, method: string, body: Record<string, unknown>) =>
  Object.keys(body).length
    ? ghJson(["api", path, "-X", method, "--input", "-"], JSON.stringify(body))
    : ghJson(["api", path, "-X", method]);
const ghGql = (query: string, variables: Record<string, unknown>) =>
  ghJson(["api", "graphql", "--input", "-"], JSON.stringify({ query, variables }));

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

interface PrRef { owner: string; repo: string; num: number; host: string }
function parsePrUrl(raw: string): PrRef | null {
  const m = raw.trim().match(/^https?:\/\/(www\.)?(github\.com)\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (m) return { host: m[2], owner: m[3], repo: m[4].replace(/\.git$/, ""), num: +m[5] };
  const gl = raw.trim().match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/-\/merge_requests\/(\d+)/i);
  if (gl) return { host: gl[1], owner: gl[2], repo: gl[3], num: +gl[4] };
  return null;
}
const isGh = (r: PrRef) => /(^|\.)github\.com$/i.test(r.host);

// Unified-diff patch → PrDiffFileT.hunks: each hunk keeps context+del in
// before_content and context+add in after_content, line ranges 1-based inclusive.
function parsePatch(patch: string | null | undefined): { before_lines: [number, number] | null; after_lines: [number, number] | null; before_content: string | null; after_content: string | null }[] {
  if (!patch) return [];
  const out: ReturnType<typeof parsePatch> = [];
  const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  const marks: { b0: number; bn: number; a0: number; an: number; start: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(patch))) marks.push({ b0: +m[1], bn: m[2] ? +m[2] : 1, a0: +m[3], an: m[4] ? +m[4] : 1, start: m.index });
  for (let i = 0; i < marks.length; i++) {
    const mk = marks[i];
    const end = i + 1 < marks.length ? marks[i + 1].start : patch.length;
    const before: string[] = [], after: string[] = [];
    for (const ln of patch.slice(patch.indexOf("\n", mk.start) + 1, end).split("\n")) {
      if (ln.startsWith("\\")) continue;
      if (ln.startsWith("-")) before.push(ln.slice(1));
      else if (ln.startsWith("+")) after.push(ln.slice(1));
      else { before.push(ln.replace(/^ /, "")); after.push(ln.replace(/^ /, "")); }
    }
    out.push({
      before_lines: mk.bn ? [mk.b0, mk.b0 + mk.bn - 1] : null,
      after_lines: mk.an ? [mk.a0, mk.a0 + mk.an - 1] : null,
      before_content: before.join("\n"), after_content: after.join("\n"),
    });
  }
  return out;
}

const rg = (g: any) => (g?.nodes ?? g?.edges?.map((e: any) => e.node) ?? []).filter((x: any) => x && (x.users?.totalCount ?? x.users?.total_count ?? 1) > -1);
// GraphQL ReactionContent enums → the REST names the write path + UI use.
const REACT_NAME: Record<string, string> = {
  THUMBS_UP: "+1", THUMBS_DOWN: "-1", LAUGH: "laugh", HOORAY: "hooray",
  CONFUSED: "confused", HEART: "heart", ROCKET: "rocket", EYES: "eyes",
};
const reactions = (groups: any[]) => (groups ?? [])
  .filter((g: any) => (g.users?.totalCount ?? 0) > 0)
  .map((g: any) => ({ content: REACT_NAME[g.content] ?? String(g.content).toLowerCase(), count: g.users.totalCount, viewer_reacted: !!g.viewerHasReacted }));
const cmOf = (n: any) => ({
  id: String(n.databaseId ?? n.id), body: n.body ?? "", login: n.author?.login ?? "",
  avatar_url: n.author?.avatarUrl ?? "", is_bot: /\[bot\]|bot$/i.test(n.author?.login ?? ""),
  created_at: n.createdAt ?? "", url: n.url ?? undefined,
  reactions: reactions(n.reactionGroups),
});

const PR_QUERY = `query($o:String!,$r:String!,$n:Int!){
 viewer{login}
 repository(owner:$o,name:$r){
  pullRequest(number:$n){
   id title number state isDraft merged body url changedFiles additions deletions
   baseRefName headRefName headRefOid mergeable mergedBy{login}
   reviews(last:20, states:[PENDING]){nodes{databaseId author{login}}}
   author{login avatarUrl}
   assignees(first:20){nodes{login avatarUrl}}
   reviewRequests(first:20){nodes{requestedReviewer{... on User{login avatarUrl}}}}
   labels(first:30){nodes{name color}}
   commits(last:100){nodes{commit{oid messageHeadline committedDate author{name user{login}}}}}
   comments(first:100){nodes{databaseId body createdAt url author{login avatarUrl} reactionGroups{content users{totalCount} viewerHasReacted}}}
   reviewThreads(first:100){nodes{id isResolved isOutdated path line comments(first:50){nodes{databaseId body createdAt url state author{login avatarUrl} reactionGroups{content users{totalCount} viewerHasReacted}}}}}
  }
 } }`;

async function fetchDetail(ref: PrRef) {
  const [g, files] = await Promise.all([
    ghGql(PR_QUERY, { o: ref.owner, r: ref.repo, n: ref.num }),
    ghRest(`repos/${ref.owner}/${ref.repo}/pulls/${ref.num}/files?per_page=100`).catch(() => []),
  ]);
  const pr = g?.data?.repository?.pullRequest;
  if (!pr) throw new Error("PR not found (check gh auth + repo access)");
  const viewer = g?.data?.viewer?.login;
  const pendRev = rg(pr.reviews).find((v: any) => v.author?.login === viewer);
  let checks: any[] = [];
  try {
    const cr = await ghRest(`repos/${ref.owner}/${ref.repo}/commits/${pr.headRefOid}/check-runs?per_page=100`);
    checks = (cr?.check_runs ?? []).map((c: any) => ({ name: c.name, status: c.status, conclusion: c.conclusion, description: c.output?.title ?? "", details_url: c.details_url ?? c.html_url ?? undefined, is_required: false }));
  } catch { /* no checks */ }
  const pending = checks.some((c) => c.status !== "completed");
  const failing = checks.some((c) => ["failure", "cancelled", "timed_out", "action_required"].includes(c.conclusion));
  return {
    info: {
      title: pr.title, number: pr.number, state: String(pr.state).toLowerCase(),
      draft: !!pr.isDraft, merged: !!pr.merged, base_branch: pr.baseRefName,
      head_branch: pr.headRefName, user: pr.author?.login, additions: pr.additions,
      deletions: pr.deletions, changed_files: pr.changedFiles, html_url: pr.url,
      comments: rg(pr.comments).length, merged_by: pr.mergedBy?.login, body: pr.body,
    },
    merge_status: { state: pr.merged ? "MERGED" : String(pr.state).toLowerCase(), mergeable: pr.mergeable, checks_pending: pending, checks_failing: failing },
    checks: { checks },
    comments: rg(pr.comments).map(cmOf),
    threads: rg(pr.reviewThreads).map((t: any) => ({
      id: t.id, path: t.path, line: t.line, is_resolved: !!t.isResolved, is_outdated: !!t.isOutdated,
      comments: rg(t.comments).map((c: any) => ({ ...cmOf(c), pending: c.state === "PENDING" })),
    })),
    commits: rg(pr.commits).map((n: any) => ({ sha: n.commit.oid, headline: n.commit.messageHeadline, author: n.commit.author?.user?.login ?? n.commit.author?.name ?? "", committed_at: n.commit.committedDate })),
    head_sha: pr.headRefOid,
    viewer_pending_review_id: pendRev?.databaseId ?? null,
    assignees: rg(pr.assignees).map((u: any) => ({ login: u.login, avatar_url: u.avatarUrl })),
    requested_reviewers: rg(pr.reviewRequests).map((n: any) => ({ login: n.requestedReviewer?.login ?? "", avatar_url: n.requestedReviewer?.avatarUrl ?? "" })),
    labels: rg(pr.labels).map((l: any) => ({ name: l.name, color: l.color })),
    author: pr.author ? { login: pr.author.login, avatar_url: pr.author.avatarUrl, is_bot: /\[bot\]|bot$/i.test(pr.author.login) } : null,
    _files: files, _nodeId: pr.id,
  };
}

// Comment id may be an issue comment or a review comment — try both resource paths.
async function tryIssueThenPull(ref: PrRef, id: string, fn: (base: string) => Promise<any>) {
  try { return await fn(`repos/${ref.owner}/${ref.repo}/issues/comments/${id}`); }
  catch { return await fn(`repos/${ref.owner}/${ref.repo}/pulls/comments/${id}`); }
}

// ---------------------------------------------------------------------------
// PR analysis — a dedicated acp session (cwd=<dataDir>/pr-review, AGENTS.md
// pins JSON-only output) reviews the raw unified diff and returns findings in
// the PrPanel bug-item shape. Mirrors the persona machinery. Results are
// cached per pr_url in memory; a restart just loses the cache.
// ---------------------------------------------------------------------------

const REVIEW_MD = `You are a senior code reviewer inside devin-web's PR analysis lane.
When the user pastes a pull-request diff, return ONLY a JSON object — no prose,
no markdown fences:

{"bugs":[...],"security_findings":[...],"flags":[...]}

Every item: {"title":string,"description":string,"file_path":string|null,
"start_line":number|null,"severity":"low"|"medium"|"high"|"critical",
"category":string|null,"cwe_id":string|null,"needs_investigation":boolean}

- bugs: correctness defects — null deref, off-by-one, races, logic errors.
- security_findings: exploitable issues — set cwe_id (e.g. "CWE-79").
- flags: non-blocking concerns — perf regressions, risky patterns, missing tests.
Empty arrays when nothing found. Review only what the diff shows; do not
invent context. Use the diff's new-file line numbers for start_line.`;

interface BugItem { title: string; description: string; file_path: string | null; start_line: number | null; severity: string; category: string | null; cwe_id: string | null; needs_investigation: boolean }
interface BugsState { status: string; bugs: BugItem[]; security_findings: BugItem[]; flags: BugItem[] }
const bugsCache = new Map<string, BugsState>();

function reviewDir(ctx: ApiContext) { return path.join(ctx.store.dataDir, "pr-review"); }

let revCreating: Promise<string> | null = null;
async function ensureReviewSession(ctx: ApiContext): Promise<string> {
  const dir = reviewDir(ctx);
  const existing = loadReg(ctx).prReview?.sessionId;
  if (existing && ctx.sessionCwd.get(existing) === dir) return existing;
  if (revCreating) return revCreating;
  revCreating = (async () => {
    fs.mkdirSync(dir, { recursive: true });
    const agents = path.join(dir, "AGENTS.md");
    if (!fs.existsSync(agents)) fs.writeFileSync(agents, REVIEW_MD);
    const acp = await ctx.manager.get(dir);
    const s = await acp.newSession(dir);
    ctx.sessionCwd.set(s.sessionId, dir);
    captureLoadResponse(s.sessionId, s);
    let n = loadedOn.get(acp);
    if (!n) loadedOn.set(acp, (n = new Set()));
    n.add(s.sessionId);
    sessionHost.set(s.sessionId, acp);
    const mm = meta(ctx, s.sessionId);
    mm.title = "🔍 PR review"; mm.folder = ".persona";
    (loadReg(ctx).prReview ??= {}).sessionId = s.sessionId;
    saveReg();
    return s.sessionId;
  })().finally(() => { revCreating = null; });
  return revCreating;
}

/** Fire one prompt at the review session, return joined agent text (mirrors
 * runPersona in persona.ts — dispatch logging + drain/inflight bookkeeping). */
async function runReviewAgent(ctx: ApiContext, pid: string, prompt: string): Promise<string> {
  if (isDraining()) throw new Error("server draining");
  ctx.sessionLog.append(pid, {
    sessionUpdate: "user_message_chunk",
    content: { type: "text", text: prompt }, _local: true,
  });
  const log = ctx.sessionLog.get(pid);
  const marker = log.length - 1;
  inflight.add(pid);
  try {
    await promptWithRetry(ctx, pid, () => acpForId(ctx, pid), (acp) => acp.prompt(pid, [{ type: "text", text: prompt }] as never));
  } finally {
    inflight.delete(pid);
  }
  ctx.sessionLog.append(pid, { sessionUpdate: "dw_turn_end" });
  const out: string[] = [];
  for (let i = marker + 1; i < log.length; i++) {
    const u = log[i].update;
    if (u.sessionUpdate === "agent_message_chunk") {
      out.push(String((u.content as { text?: string } | undefined)?.text ?? ""));
    }
  }
  return out.join("").trim();
}

function sanitizeItem(x: any): BugItem | null {
  if (!x || typeof x !== "object" || !String(x.title ?? "").trim()) return null;
  const sev = ["low", "medium", "high", "critical"].includes(String(x.severity)) ? String(x.severity) : "medium";
  return {
    title: String(x.title).slice(0, 200),
    description: String(x.description ?? "").slice(0, 2000),
    file_path: x.file_path ? String(x.file_path).slice(0, 500) : null,
    start_line: Number.isFinite(+x.start_line) ? +x.start_line : null,
    severity: sev,
    category: x.category ? String(x.category).slice(0, 100) : null,
    cwe_id: x.cwe_id ? String(x.cwe_id).slice(0, 40) : null,
    needs_investigation: !!x.needs_investigation,
  };
}
function parseFindings(text: string): Pick<BugsState, "bugs" | "security_findings" | "flags"> {
  const i = text.indexOf("{"), j = text.lastIndexOf("}");
  const empty = { bugs: [], security_findings: [], flags: [] };
  if (i < 0 || j <= i) return empty;
  try {
    const o = JSON.parse(text.slice(i, j + 1));
    const list = (k: string) => (Array.isArray(o?.[k]) ? o[k].map(sanitizeItem).filter((x: BugItem | null): x is BugItem => !!x).slice(0, 50) : []);
    return { bugs: list("bugs"), security_findings: list("security_findings"), flags: list("flags") };
  } catch { return empty; }
}

async function runAnalysis(ctx: ApiContext, ref: PrRef, prUrl: string) {
  try {
    const diffText = await ghRun(["api", `repos/${ref.owner}/${ref.repo}/pulls/${ref.num}`, "-H", "Accept: application/vnd.github.diff"]);
    const info = await ghRest(`repos/${ref.owner}/${ref.repo}/pulls/${ref.num}`).catch(() => null);
    const pid = await ensureReviewSession(ctx);
    const prompt = [
      `Review this GitHub pull request and return findings JSON.`,
      `PR: ${info?.title ?? "(untitled)"} — ${prUrl}`,
      `Base: ${info?.base?.ref ?? "?"} ← Head: ${info?.head?.ref ?? "?"} (${info?.merged ? "merged" : info?.state ?? "?"})`,
      info?.body ? `Description (truncated):\n${String(info.body).slice(0, 3000)}` : "",
      "",
      "DIFF:",
      diffText.slice(0, 100_000),
    ].join("\n");
    const answer = await runReviewAgent(ctx, pid, prompt);
    bugsCache.set(prUrl, { status: "completed", ...parseFindings(answer) });
  } catch (e) {
    console.error(`[pr-analyze] ${e instanceof Error ? e.message : e}`);
    bugsCache.set(prUrl, { status: "failed", bugs: [], security_findings: [], flags: [] });
  }
}

export async function handlePrRoute(ctx: ApiContext, sub: string, m: string, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const body = m === "POST" ? await readJson(req) : {};
  const prUrl = String(url.searchParams.get("pr_url") ?? body.pr_url ?? "");
  const ref = parsePrUrl(prUrl);
  if (!ref) { json(res, 400, { error: "unsupported pr_url (github.com/.../pull/N or gitlab .../merge_requests/N expected)" }); return true; }
  if (!isGh(ref)) { json(res, 400, { error: "only github.com PRs are supported locally (gitlab via cloud proxy is not wired)" }); return true; }
  try {
    if (sub === "pr" && m === "GET") {
      const d = await fetchDetail(ref);
      const { _files, _nodeId, ...data } = d;
      json(res, 200, { data, error: null });
      return true;
    }
    if (sub === "pr-changes" && m === "GET") {
      const files: any[] = [];
      for (let page = 1; page <= 3; page++) {
        const batch = await ghRest(`repos/${ref.owner}/${ref.repo}/pulls/${ref.num}/files?per_page=100&page=${page}`);
        if (!Array.isArray(batch) || !batch.length) break;
        files.push(...batch);
        if (batch.length < 100) break;
      }
      json(res, 200, {
        files: files.map((f) => ({
          file_path: f.filename, old_file_path: f.previous_filename ?? null,
          change_type: f.status, base_content: null, hunks: parsePatch(f.patch),
        })),
        sections: null, analysis_status: bugsCache.get(prUrl)?.status === "completed" ? "completed" : "not_analyzed", error: null,
      });
      return true;
    }
    if (sub === "pr-bugs" && m === "GET") {
      const st = bugsCache.get(prUrl) ?? { status: "unavailable", bugs: [], security_findings: [], flags: [] };
      json(res, 200, { data: st, error: null });
      return true;
    }
    if (sub === "pr-analyze" && m === "POST") {
      if (bugsCache.get(prUrl)?.status !== "running") {
        bugsCache.set(prUrl, { status: "running", bugs: [], security_findings: [], flags: [] });
        void runAnalysis(ctx, ref, prUrl);
      }
      json(res, 200, { ok: true });
      return true;
    }
    if (sub === "pr-comment" && m === "POST") {
      const r = await ghWrite(`repos/${ref.owner}/${ref.repo}/issues/${ref.num}/comments`, "POST", { body: String(body.body ?? "") });
      json(res, 200, { ok: true, data: r ? cmOf({ ...r, databaseId: r.id, createdAt: r.created_at, url: r.html_url, author: { login: r.user?.login, avatarUrl: r.user?.avatar_url }, reactionGroups: [] }) : null, error: null });
      return true;
    }
    if (sub === "pr-reaction" && m === "POST") {
      const cid = String(body.comment_id ?? ""), content = String(body.content ?? ""), op = String(body.op ?? "add");
      await tryIssueThenPull(ref, cid, async (base) => {
        if (op === "remove") {
          const list = await ghRest(`${base}/reactions?per_page=100`);
          const me = (await ghJson(["api", "user"]))?.login;
          const mine = (list ?? []).filter((x: any) => x.content === content && x.user?.login === me);
          for (const x of mine) await ghWrite(`${base}/reactions/${x.id}`, "DELETE", {});
        } else {
          await ghWrite(`${base}/reactions`, "POST", { content });
        }
        return true;
      });
      json(res, 200, { ok: true, error: null });
      return true;
    }
    if (sub === "pr-thread-resolve" && m === "POST") {
      const unresolve = String(body.op ?? "") === "unresolve";
      await ghGql(`mutation($id:ID!){${unresolve ? "unresolveReviewThread" : "resolveReviewThread"}(input:{threadId:$id}){thread{id}}}`, { id: String(body.thread_id ?? "") });
      json(res, 200, { ok: true, error: null });
      return true;
    }
    if (sub === "pr-thread-reply" && m === "POST") {
      // GraphQL reply handles both cases: joins the viewer's pending review
      // when one exists, else posts a standalone comment. The REST
      // /replies endpoint 422s once a pending review exists for the user.
      await ghGql(`mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t,body:$b}){comment{id}}}`, { t: String(body.thread_id ?? ""), b: String(body.body ?? "") });
      json(res, 200, { ok: true, error: null });
      return true;
    }
    if (sub === "pr-line-comment" && m === "POST") {
      const fp = String(body.file_path ?? ""), text = String(body.body ?? "");
      const line = body.line == null || body.line === "" ? null : +body.line;
      const otherSide = body.other_side_line == null || body.other_side_line === "" ? null : +body.other_side_line;
      const d = await fetchDetail(ref);
      // line:null → FILE-level subject; other_side_line → LEFT/RIGHT range.
      const thread = line == null
        ? `path:$path,subjectType:FILE,body:$b`
        : otherSide == null
          ? `path:$path,line:$l,side:RIGHT,body:$b`
          : `path:$path,line:$l,side:RIGHT,startLine:$sl,startSide:LEFT,body:$b`;
      const vars: Record<string, unknown> = { p: d._nodeId, path: fp, b: text };
      const decls = ["$p:ID!", "$path:String!", "$b:String!"];
      if (line != null) { decls.push("$l:Int!"); vars.l = line; }
      if (otherSide != null) { decls.push("$sl:Int!"); vars.sl = otherSide; }
      if (body.start_review) {
        // No `event:` — a review created without an event IS the pending review
        // (PENDING is not a PullRequestReviewEvent; omitting it leaves it pending).
        // DraftPullRequestReviewThread rejects `subjectType`, so a FILE-level
        // comment can't ride the batch threads[] input — create the pending
        // review first, then attach the thread via pullRequestReviewId.
        if (line == null) {
          const rv = await ghGql(`mutation($p:ID!){addPullRequestReview(input:{pullRequestId:$p}){pullRequestReview{id}}}`, { p: d._nodeId });
          const rid = rv?.data?.addPullRequestReview?.pullRequestReview?.id;
          await ghGql(`mutation($p:ID!,$r:ID!,$path:String!,$b:String!){addPullRequestReviewThread(input:{pullRequestId:$p,pullRequestReviewId:$r,path:$path,subjectType:FILE,body:$b}){thread{id}}}`, { p: d._nodeId, r: rid, path: fp, b: text });
        } else {
          await ghGql(`mutation(${decls.join(",")}){addPullRequestReview(input:{pullRequestId:$p,threads:[{${thread}}]}){pullRequestReview{id}}}`, vars);
        }
      } else {
        await ghGql(`mutation(${decls.join(",")}){addPullRequestReviewThread(input:{pullRequestId:$p,${thread}}){thread{id}}}`, vars);
      }
      json(res, 200, { ok: true, error: null });
      return true;
    }
    if (sub === "pr-comment-edit" && m === "POST") {
      await tryIssueThenPull(ref, String(body.comment_id ?? ""), (base) => ghWrite(base, "PATCH", { body: String(body.body ?? "") }));
      json(res, 200, { ok: true, error: null });
      return true;
    }
    if (sub === "pr-comment-delete" && m === "POST") {
      await tryIssueThenPull(ref, String(body.comment_id ?? ""), (base) => ghWrite(base, "DELETE", {}));
      json(res, 200, { ok: true, error: null });
      return true;
    }
    if (sub === "pr-submit-review" && m === "POST") {
      // Submit the viewer's pending review via REST events endpoint (official
      // semantics: POST gh/reviews/{id}/submit {event}). Events are whitelisted;
      // body is optional review summary text.
      const event = String(body.event ?? "").toUpperCase();
      if (!["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(event)) {
        json(res, 400, { ok: false, error: "event must be APPROVE, REQUEST_CHANGES, or COMMENT" });
        return true;
      }
      const g = await ghGql(`query($o:String!,$r:String!,$n:Int!){viewer{login} repository(owner:$o,name:$r){pullRequest(number:$n){reviews(last:20, states:[PENDING]){nodes{databaseId author{login}}}}}}`, { o: ref.owner, r: ref.repo, n: ref.num });
      const me = g?.data?.viewer?.login;
      const rid = rg(g?.data?.repository?.pullRequest?.reviews).find((v: any) => v.author?.login === me)?.databaseId;
      if (!rid) { json(res, 400, { ok: false, error: "no pending review" }); return true; }
      const payload: Record<string, unknown> = { event };
      if (body.body) payload.body = String(body.body);
      await ghWrite(`repos/${ref.owner}/${ref.repo}/pulls/${ref.num}/reviews/${rid}/events`, "POST", payload);
      json(res, 200, { ok: true, error: null });
      return true;
    }
    if (sub === "pr-merge" && m === "POST") {
      const method = ["merge", "squash", "rebase"].includes(String(body.method ?? "")) ? String(body.method) : "merge";
      const r = await ghWrite(`repos/${ref.owner}/${ref.repo}/pulls/${ref.num}/merge`, "PUT", { merge_method: method });
      json(res, 200, { ok: !!r?.merged, sha: r?.sha ?? null, error: r?.merged ? null : String(r?.message ?? "not merged") });
      return true;
    }
    if (sub === "pr-close" && m === "POST") {
      const reopen = String(body.op ?? "") === "reopen";
      await ghWrite(`repos/${ref.owner}/${ref.repo}/pulls/${ref.num}`, "PATCH", { state: reopen ? "open" : "closed" });
      json(res, 200, { ok: true, error: null });
      return true;
    }
    return false;
  } catch (e) {
    json(res, 502, { error: e instanceof Error ? e.message.slice(0, 500) : "github request failed" });
    return true;
  }
}
