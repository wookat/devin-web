// GitHub-backed PR review endpoints for PrPanel (web/src/pages/mirror/PrPanel.tsx).
// All data flows through the `gh` CLI (user-authenticated, `repo` scope) — no
// Devin cloud dependency. Covers github.com PRs; other hosts return a clear error.
import { execFile } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";

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
const reactions = (groups: any[]) => rg(groups)
  .filter((g: any) => (g.users?.totalCount ?? 0) > 0)
  .map((g: any) => ({ content: g.content, count: g.users.totalCount, viewer_reacted: !!g.viewerHasReacted }));
const cmOf = (n: any) => ({
  id: String(n.databaseId ?? n.id), body: n.body ?? "", login: n.author?.login ?? "",
  avatar_url: n.author?.avatarUrl ?? "", is_bot: /\[bot\]|bot$/i.test(n.author?.login ?? ""),
  created_at: n.createdAt ?? "", url: n.url ?? undefined,
  reactions: reactions(n.reactionGroups),
});

const PR_QUERY = `query($o:String!,$r:String!,$n:Int!){
 repository(owner:$o,name:$r){
  pullRequest(number:$n){
   id title number state isDraft merged body url changedFiles additions deletions
   baseRefName headRefName headRefOid mergeable mergedBy{login}
   author{login avatarUrl}
   assignees(first:20){nodes{login avatarUrl}}
   reviewRequests(first:20){nodes{requestedReviewer{... on User{login avatarUrl}}}}
   labels(first:30){nodes{name color}}
   commits(last:100){nodes{commit{oid messageHeadline committedDate author{name user{login}}}}}
   comments(first:100){nodes{databaseId body createdAt url author{login avatarUrl} reactionGroups{content users{totalCount} viewerHasReacted}}}
   reviewThreads(first:100){nodes{id isResolved isOutdated path line comments(first:50){nodes{databaseId body createdAt url author{login avatarUrl} reactionGroups{content users{totalCount} viewerHasReacted}}}}}
  }
 } }`;

async function fetchDetail(ref: PrRef) {
  const [g, files] = await Promise.all([
    ghGql(PR_QUERY, { o: ref.owner, r: ref.repo, n: ref.num }),
    ghRest(`repos/${ref.owner}/${ref.repo}/pulls/${ref.num}/files?per_page=100`).catch(() => []),
  ]);
  const pr = g?.data?.repository?.pullRequest;
  if (!pr) throw new Error("PR not found (check gh auth + repo access)");
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
      comments: rg(t.comments).map(cmOf),
    })),
    commits: rg(pr.commits).map((n: any) => ({ sha: n.commit.oid, headline: n.commit.messageHeadline, author: n.commit.author?.user?.login ?? n.commit.author?.name ?? "", committed_at: n.commit.committedDate })),
    head_sha: pr.headRefOid,
    assignees: rg(pr.assignees).map((u: any) => ({ login: u.login, avatar_url: u.avatarUrl })),
    requested_reviewers: rg(pr.reviewRequests).map((n: any) => ({ login: n.requestedReviewer?.login ?? "", avatar_url: n.requestedReviewer?.avatarUrl ?? "" })),
    labels: rg(pr.labels).map((l: any) => ({ name: l.name, color: l.color })),
    author: pr.author ? { login: pr.author.login, avatar_url: pr.author.avatarUrl, is_bot: /\[bot\]|bot$/i.test(pr.author.login) } : null,
    _files: files, _nodeId: pr.id,
  };
}

async function threadFirstCommentDbId(threadId: string): Promise<number | null> {
  const g = await ghGql(`query($id:ID!){node(id:$id){... on PullRequestReviewThread{comments(first:1){nodes{databaseId}}}}}`, { id: threadId });
  return g?.data?.node?.comments?.nodes?.[0]?.databaseId ?? null;
}

// Comment id may be an issue comment or a review comment — try both resource paths.
async function tryIssueThenPull(ref: PrRef, id: string, fn: (base: string) => Promise<any>) {
  try { return await fn(`repos/${ref.owner}/${ref.repo}/issues/comments/${id}`); }
  catch { return await fn(`repos/${ref.owner}/${ref.repo}/pulls/comments/${id}`); }
}

export async function handlePrRoute(sub: string, m: string, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
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
        sections: null, analysis_status: "completed", error: null,
      });
      return true;
    }
    if (sub === "pr-bugs" && m === "GET") {
      json(res, 200, { data: { status: "unavailable", bugs: [], security_findings: [], flags: [] }, error: null });
      return true;
    }
    if (sub === "pr-analyze" && m === "POST") {
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
      const tid = String(body.thread_id ?? ""), text = String(body.body ?? "");
      if (body.start_review) {
        await ghGql(`mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t,body:$b}){comment{id}}}`, { t: tid, b: text });
      } else {
        const dbid = await threadFirstCommentDbId(tid);
        if (!dbid) throw new Error("thread not found");
        await ghWrite(`repos/${ref.owner}/${ref.repo}/pulls/${ref.num}/comments/${dbid}/replies`, "POST", { body: text });
      }
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
        await ghGql(`mutation(${decls.join(",")}){addPullRequestReview(input:{pullRequestId:$p,event:PENDING,threads:[{${thread}}]}){pullRequestReview{id}}}`, vars);
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
    return false;
  } catch (e) {
    json(res, 502, { error: e instanceof Error ? e.message.slice(0, 500) : "github request failed" });
    return true;
  }
}
