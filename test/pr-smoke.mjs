/**
 * PR write-path smoke — exercises every pr-* endpoint end-to-end against a
 * RUNNING server and a REAL GitHub PR (gh auth must cover the repo).
 *
 *   node test/pr-smoke.mjs --pr https://github.com/<o>/<r>/pull/<n> [--merge] [--close]
 *
 * Default mode runs read endpoints + reversible writes (comment create→edit→
 * delete, reaction add→remove, thread resolve→unresolve, pending review →
 * submit COMMENT) and verifies readbacks. --merge / --close additionally run
 * the destructive lifecycle ops — only use them on throwaway PRs.
 */
const BASE = process.argv.includes('--base')
  ? process.argv[process.argv.indexOf('--base') + 1]
  : 'http://127.0.0.1:7791';
const PR = process.argv.includes('--pr') ? process.argv[process.argv.indexOf('--pr') + 1] : null;
const DO_MERGE = process.argv.includes('--merge');
const DO_CLOSE = process.argv.includes('--close');
const SID = 'review'; // sentinel — pr routes don't scope by session id

const H = { 'x-admin-key': 'local', 'Content-Type': 'application/json' };
let pass = 0, fail = 0, skip = 0;
const check = (name, ok, detail = '') => {
  if (ok === null) { skip++; console.log(`  · ${name} — SKIP ${detail}`); return; }
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
};
const get = async (p) => (await fetch(BASE + p, { headers: H })).json();
const post = async (p, body) => (await fetch(BASE + p, { method: 'POST', headers: H, body: JSON.stringify(body) })).json();
const prGet = () => get(`/api/admin/session/${SID}/pr?pr_url=${encodeURIComponent(PR)}`);
const prPost = (sub, body) => post(`/api/admin/session/${SID}/${sub}`, { pr_url: PR, ...body });

const main = async () => {
  if (!PR) { console.log('usage: node test/pr-smoke.mjs --pr <github pr url> [--merge] [--close]'); process.exit(1); }
  console.log(`\n▸ target ${BASE}\n▸ pr ${PR}\n`);

  // ---- reads ----
  const d0 = await prGet();
  check('pr detail', !!d0.data?.info, d0.error || '');
  if (!d0.data?.info) return;
  const files = (await get(`/api/admin/session/${SID}/pr-changes?pr_url=${encodeURIComponent(PR)}`)).files;
  check('pr-changes files', Array.isArray(files) && files.length > 0, `${files?.length ?? 'n/a'} file(s)`);
  const bugs = await get(`/api/admin/session/${SID}/pr-bugs?pr_url=${encodeURIComponent(PR)}`);
  check('pr-bugs status', ['unavailable', 'not_analyzed', 'running', 'completed', 'failed'].includes(bugs.data?.status), bugs.data?.status);

  const state = d0.data.info.state;
  const merged = d0.data.info.merged;

  // ---- comment lifecycle ----
  const c = await prPost('pr-comment', { body: `smoke ${Date.now()}` });
  const cid = c.data?.id ?? c.comment_id;
  check('pr-comment create', !!cid, JSON.stringify(c).slice(0, 200));
  if (cid) {
    check('comment readback', (await prGet()).data?.comments?.some((x) => x.id === String(cid)) ?? false);
    check('pr-comment-edit', !!(await prPost('pr-comment-edit', { comment_id: cid, body: 'smoke edited' })).ok);
    check('edit readback', (await prGet()).data?.comments?.some((x) => x.id === String(cid) && x.body === 'smoke edited') ?? false);
    // reaction roundtrip on the comment
    check('pr-reaction add', !!(await prPost('pr-reaction', { comment_id: cid, content: '+1', op: 'add' })).ok);
    const afterAdd = await prGet();
    const cm = afterAdd.data?.comments?.find((x) => x.id === String(cid));
    check('reaction readback', !!cm?.reactions?.some((r) => r.content === '+1' && r.viewer_reacted), JSON.stringify(cm?.reactions));
    check('pr-reaction remove', !!(await prPost('pr-reaction', { comment_id: cid, content: '+1', op: 'remove' })).ok);
    check('pr-comment-delete', !!(await prPost('pr-comment-delete', { comment_id: cid })).ok);
    check('delete readback', !(await prGet()).data?.comments?.some((x) => x.id === String(cid)));
  }

  // ---- thread ops (needs a diff file) ----
  const file = files?.[0]?.file_path ?? files?.[0]?.filename ?? files?.[0]?.path;
  if (file && state === 'open' && !merged) {
    const lc = await prPost('pr-line-comment', { file_path: file, body: `smoke thread ${Date.now()}` });
    check('pr-line-comment', !!lc.ok, JSON.stringify(lc).slice(0, 200));
    const d1 = await prGet();
    const th = d1.data?.threads?.find((t) => t.path === file);
    check('thread readback', !!th);
    if (th) {
      check('pr-thread-reply', !!(await prPost('pr-thread-reply', { thread_id: th.id, body: 'smoke reply' })).ok);
      check('pr-thread-resolve', !!(await prPost('pr-thread-resolve', { thread_id: th.id, op: 'resolve' })).ok);
      const resolved = (await prGet()).data?.threads?.find((t) => t.id === th.id)?.is_resolved;
      check('resolve readback', resolved === true, `resolved=${resolved}`);
      check('pr-thread-unresolve', !!(await prPost('pr-thread-resolve', { thread_id: th.id, op: 'unresolve' })).ok);
    }
    // ---- pending review → submit ----
    const sr = await prPost('pr-line-comment', { file_path: file, body: 'pending via smoke', start_review: true });
    check('start_review', !!sr.ok, JSON.stringify(sr).slice(0, 200));
    const pend = (await prGet()).data?.viewer_pending_review_id;
    check('pending review visible', pend != null, `id=${pend}`);
    if (pend != null) {
      const sub = await prPost('pr-submit-review', { event: 'COMMENT', body: 'smoke review' });
      check('pr-submit-review COMMENT', !!sub.ok, JSON.stringify(sub).slice(0, 200));
      check('pending cleared', (await prGet()).data?.viewer_pending_review_id == null);
    }
  } else {
    check('thread/review writes', null, state !== 'open' || merged ? 'PR not open' : 'no files');
  }

  // ---- destructive lifecycle (opt-in) ----
  if (DO_MERGE && state === 'open' && !merged) {
    const mg = await prPost('pr-merge', { method: 'squash' });
    check('pr-merge squash', !!mg.ok, JSON.stringify(mg).slice(0, 200));
    check('merged readback', (await prGet()).data?.info?.merged === true);
  }
  if (DO_CLOSE) {
    const cur = await prGet();
    if (cur.data?.info?.state === 'open') {
      check('pr-close', !!(await prPost('pr-close', {})).ok);
      check('closed readback', (await prGet()).data?.info?.state === 'closed');
      check('pr-reopen', !!(await prPost('pr-close', { op: 'reopen' })).ok);
      check('reopened readback', (await prGet()).data?.info?.state === 'open');
    } else check('pr-close', null, `state=${cur.data?.info?.state}`);
  }

  console.log(`\n  ${pass} passed · ${fail} failed · ${skip} skipped\n`);
  process.exit(fail ? 1 : 0);
};
main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
