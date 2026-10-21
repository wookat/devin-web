// Pending-request replay smoke — the protocol-aware broker: an agent→client
// request emitted while no backend is attached (or left unanswered by a dead
// one) must be re-emitted to the next attach; once answered via the stdin
// tee, a further attach must NOT re-emit. Self-contained, exits 0/1.
const { spawn } = require('child_process');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(require('os').homedir(), '.devin-web-brokerreq');
fs.mkdirSync(dataDir, { recursive: true });
const sockPath = process.platform === 'win32'
  ? `\\\\.\\pipe\\devin-web-acp-${crypto.createHash('sha1').update(dataDir).digest('hex').slice(0, 10)}`
  : path.join(dataDir, 'acp-broker.sock');

const broker = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'acp-broker.mjs')], {
  env: { ...process.env, DEVIN_WEB_DATA_DIR: dataDir },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const token = () => fs.readFileSync(path.join(dataDir, 'broker.token'), 'utf8').trim();
const fail = (m) => { console.log('FAIL:', m); broker.kill('SIGTERM'); process.exit(1); };
const pass = (m) => console.log('PASS:', m);
setTimeout(() => fail('timeout'), 15000);

const REQ = { jsonrpc: '2.0', id: 77, method: 'session/request_permission', params: { toolCallId: 't1' } };
// Mock acp: emits a warm line, then the request, then ticks until killed.
const MOCK = `console.log(${JSON.stringify(JSON.stringify({ warm: 1 }))});`
  + `console.log(${JSON.stringify(JSON.stringify(REQ))});`
  + 'setInterval(()=>console.log(JSON.stringify({tick:Date.now()})),3000)';

const attach = (after, onLine) => new Promise((resolve) => {
  const s = net.createConnection(sockPath);
  let buf = Buffer.alloc(0), head = false;
  s.on('connect', () => s.write(JSON.stringify({ attach: attach.acpId, after, token: token() }) + '\n'));
  s.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (!head) {
      const nl = buf.indexOf(0x0a); if (nl < 0) return;
      head = true;
      const h = JSON.parse(buf.subarray(0, nl).toString('utf8'));
      if (!h.ok) return fail('attach: ' + JSON.stringify(h));
      buf = buf.subarray(nl + 1);
    }
    let i;
    while ((i = buf.indexOf(0x0a)) >= 0) {
      const l = buf.subarray(0, i).toString('utf8').trim();
      buf = buf.subarray(i + 1);
      if (l) onLine(l, s);
    }
  });
  s.on('error', () => {});
  resolve(s);
});

setTimeout(() => {
  const ctl = net.createConnection(sockPath);
  ctl.on('connect', () => ctl.write(JSON.stringify({ ctl: 1, token: token() }) + '\n' + JSON.stringify({
    req: 1, op: 'spawn', cwd: __dirname, command: process.execPath,
    args: ['-e', MOCK], env: {}, shell: false, key: 'reqtest',
  }) + '\n'));
  let buf = '';
  ctl.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.req !== 1) continue;
      if (!m.ok) return fail('spawn: ' + JSON.stringify(m));
      attach.acpId = m.acpId;
      pass('spawn ' + m.acpId);
      run();
    }
  });
}, 700);

async function run() {
  const seen1 = [];
  const c1 = await attach(0, (l) => seen1.push(l));
  await new Promise((r) => setTimeout(r, 400));
  const gotReq = seen1.some((l) => l.includes('"id":77'));
  if (!gotReq) return fail('attach1 did not see the request frame');
  pass('attach1 saw request (never answered — simulates dead backend)');
  c1.destroy();

  // Re-attach at live edge (crash path): ring skipped, pending req re-emitted.
  const seen2 = [];
  const c2 = await attach(Number.MAX_SAFE_INTEGER, (l) => seen2.push(l));
  await new Promise((r) => setTimeout(r, 400));
  if (!seen2.some((l) => l.includes('"id":77'))) return fail('attach2: pending request NOT re-emitted');
  pass('attach2 re-emitted pending request at live edge');

  // Answer it via stdin tee → broker must clear pending.
  c2.write(JSON.stringify({ jsonrpc: '2.0', id: 77, result: { outcome: { outcome: 'approved' } } }) + '\n');
  await new Promise((r) => setTimeout(r, 300));
  c2.destroy();

  const seen3 = [];
  await attach(Number.MAX_SAFE_INTEGER, (l) => seen3.push(l));
  await new Promise((r) => setTimeout(r, 400));
  if (seen3.some((l) => l.includes('"id":77'))) return fail('attach3 re-emitted an ANSWERED request');
  pass('answered request cleared — attach3 clean');
  console.log('ALL CHECKS PASSED');
  broker.kill('SIGTERM');
  process.exit(0);
}
