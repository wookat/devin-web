/**
 * Local web API smoke test.
 *
 * Exercises the web contract end-to-end against a RUNNING server:
 * session list → detail → timeline → config read/write → message send.
 *
 *   node test/api-smoke.mjs [--base http://127.0.0.1:7791] [--id <sessionId>] [--send]
 *
 * --send also posts a real prompt to Devin (costs a little, requires an
 * authenticated healthy account). Without it the test is read-only.
 */
const BASE = process.argv.includes('--base')
  ? process.argv[process.argv.indexOf('--base') + 1]
  : 'http://127.0.0.1:7791';
const SEND = process.argv.includes('--send');
const ID_ARG = process.argv.includes('--id') ? process.argv[process.argv.indexOf('--id') + 1] : null;

const H = { 'x-admin-key': 'local', 'Content-Type': 'application/json' };
let pass = 0, fail = 0, skip = 0;

function check(name, ok, detail = '') {
  if (ok === null) { skip++; console.log(`  · ${name} — SKIP ${detail}`); return; }
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
}

async function get(path) {
  const r = await fetch(BASE + path, { headers: H });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
  return r.json();
}
async function post(path, body) {
  const r = await fetch(BASE + path, { method: 'POST', headers: H, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`POST ${path} → ${r.status}`);
  return r.json();
}

const main = async () => {
  console.log(`\n▸ target ${BASE}\n`);

  // ---- meta ----
  const meta = await get('/api/meta');
  check('meta: devin installed', meta.devin?.installed === true);
  check('meta: devin authed', meta.devin?.authed === true);

  // ---- accounts ----
  const accounts = await get('/api/accounts').catch(() => null);
  check('accounts: endpoint', accounts !== null);
  if (accounts) check('accounts: has current', !!accounts.current, JSON.stringify(Object.keys(accounts)));

  // ---- session list ----
  const list = await get('/api/admin/mirror/sessions');
  const rows = list.sessions ?? [];
  check('sessions: non-empty', rows.length > 0, `got ${rows.length}`);
  const s0 = rows[0] ?? {};
  for (const f of ['devin_id', 'title', 'status_enum', 'updated_at']) {
    check(`sessions: row has ${f}`, s0[f] !== undefined, JSON.stringify(s0).slice(0, 200));
  }

  // pick a session: explicit arg, else first non-locked-looking row
  const id = ID_ARG ?? s0.devin_id;
  console.log(`\n▸ session ${id}\n`);

  // ---- detail ----
  const detail = await get(`/api/admin/session/${id}`);
  check('detail: session object', !!(detail.session?.devin_session_id || detail.session?.devin_id));
  check('detail: share_url', detail.share_url === null || typeof detail.share_url === 'string');

  // ---- timeline: peek must not trigger a session/load ----
  const pk = await get(`/api/admin/session/${id}/timeline?peek=1&limit=50`);
  check('timeline peek: returns items array', Array.isArray(pk.items), `len=${pk.items?.length}`);
  check('timeline peek: flagged', pk.peek === true, `peek=${pk.peek}`);

  // ---- timeline: real fetch graduates to session/load; wait for replay ----
  let tl = await get(`/api/admin/session/${id}/timeline?limit=50`);
  const deadline = Date.now() + 60000;
  let sawLoading = false;
  while (Date.now() < deadline) {
    const loading = tl.activity?.text === 'Loading history…';
    sawLoading ||= loading;
    if ((tl.gen ?? 0) > 0) break;                    // replay produced live items
    if (sawLoading && !loading) break;               // replay ended with an empty log
    if (!loading && (tl.items?.length ?? 0) > 0) break; // nothing to load, snapshot only
    await new Promise((r) => setTimeout(r, 2000));
    tl = await get(`/api/admin/session/${id}/timeline?limit=50`);
  }
  check('timeline: returns items array', Array.isArray(tl.items), `len=${tl.items?.length}`);
  check('timeline: replayed to live gen', (tl.gen ?? 0) > 0 || (tl.items?.length ?? 0) === 0, `gen=${tl.gen}`);
  if (tl.items?.length) {
    const kinds = new Set(tl.items.map((i) => i.kind));
    check('timeline: valid kinds', [...kinds].every((k) => typeof k === 'string'), [...kinds].join(','));
    check('timeline: no config noise rows', !tl.items.some((i) => /config_option|current_mode|available_commands/.test(String(i.raw_type))));
  }

  // ---- config (real after the load the timeline just drove) ----
  const cfg = await get(`/api/admin/session/${id}/config`);
  const hasModel = !!cfg.model?.options?.length;
  check('config: model group present', hasModel, `model=${cfg.model?.current ?? 'n/a'}`);
  const modeOpt = (cfg.options ?? []).find((o) => o.id === 'mode' || o.id === '_mode');
  check('config: mode group present', !!modeOpt, modeOpt ? `current=${modeOpt.currentValue}` : 'no mode group');

  // ---- version pill compat ----
  if (hasModel) {
    const v = await post(`/api/admin/session/${id}/version`, { version: cfg.model.current }).catch((e) => ({ err: e.message }));
    check('version: POST accepts current model', v.err === undefined && v.error === undefined, JSON.stringify(v).slice(0, 120));
  } else {
    check('version: POST', null, 'no model config');
  }

  // ---- composer-meta / terminal / usage ----
  const cm = await get('/api/admin/composer-meta').catch((e) => ({ err: e.message }));
  check('composer-meta', cm.err === undefined, JSON.stringify(cm).slice(0, 120));
  const usage = await get('/api/usage').catch((e) => ({ err: e.message }));
  check('usage endpoint', usage.err === undefined, JSON.stringify(usage).slice(0, 120));

  // ---- optional: real prompt round-trip ----
  if (SEND) {
    const marker = `SMOKE-${Date.now() % 100000}`;
    console.log(`\n▸ sending prompt (expect reply containing ${marker})`);
    await post(`/api/admin/session/${id}/message`, { message: `Reply with exactly: ${marker}` });
    let found = false;
    for (let i = 0; i < 24 && !found; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const t = await get(`/api/admin/session/${id}/timeline?limit=300`);
      found = (t.items ?? []).some((it) => it.kind === 'message' && String(it.body ?? '').includes(marker));
      if (!found) process.stdout.write(`  waiting… ${(i + 1) * 5}s\r`);
    }
    check('message: Devin replied', found, `marker=${marker}`);
  } else {
    check('message: prompt round-trip', null, 'pass --send to enable');
  }

  console.log(`\n═══ ${pass} passed, ${fail} failed, ${skip} skipped ═══\n`);
  process.exit(fail ? 1 : 0);
};

main().catch((e) => { console.error('FATAL:', e.message); process.exit(2); });
