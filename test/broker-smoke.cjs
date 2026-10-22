// Broker smoke test — spawn acp-broker, exercise ctl list/spawn, attach,
// ring replay, request-id remux (client ids rewritten to unique broker ids
// on the agent's wire, restored on the way back — including a response that
// arrives after its requesting connection died), the prompt ledger,
// prompt-start/prompt-done ctl events, exit event, journal cleanup.
// Self-contained, exits 0/1.
const { spawn } = require('child_process');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(require('os').homedir(), '.devin-web-brokertest');
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
setTimeout(() => fail('timeout'), 15000);

let acpId = null, attached = false, replayed = 0, sawExit = false;
let saw42 = false, sawPending42 = false;
let sawPromptStart = false, sawPromptDone = false;
const pings = new Set();   // broker-side ids the agent saw for the two id:41 requests
const rawIds = new Set();  // result frames that reached a client with an un-restored broker id

// Fake acp: writes {"warm":1} + ticks; answers each inbound request echoing
// the id it actually saw in result.wire; session/prompt answers after 400ms
// so its response outlives the requesting attach (dead-window delivery).
const CHILD = 'let b="";process.stdin.on("data",d=>{b+=d;let i;'
  + 'while((i=b.indexOf("\\n"))>=0){const l=b.slice(0,i);b=b.slice(i+1);let m;'
  + 'try{m=JSON.parse(l)}catch{continue}if(m!=null&&m.id!=null){'
  + 'const r=()=>process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{ok:true,wire:m.id}})+"\\n");'
  + 'm.method==="session/prompt"?setTimeout(r,400):r()}}});'
  + 'let n=0;console.log("{\\"warm\\":1}");'
  + 'const iv=setInterval(()=>console.log(JSON.stringify({tick:n++})),250);'
  + 'setTimeout(()=>{clearInterval(iv);process.exit(7)},3000)';

const onStreamLine = (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (!m || m.result == null) return;
  // A result frame whose top-level id is a low broker-space number means an
  // un-restored id leaked onto a client stream (ring or live). The test only
  // ever uses client ids 41/42, so broker ids 1..3 must never appear.
  if (typeof m.id === 'number' && m.id <= 3) rawIds.add(m.id);
  if (m.id === 41) pings.add(m.result.wire);
  if (m.id === 42 && !saw42) {
    saw42 = true;
    console.log('PASS remux: dead-window response restored to client id 42 (agent saw broker id', m.result.wire + ')');
  }
};

const attach = (after, withReqs) => {
  const a = net.createConnection(sockPath);
  a.on('connect', () => a.write(
    JSON.stringify({ attach: acpId, after, token: token() }) + '\n'
    + (withReqs
      // Two requests sharing client id 41 (a re-attached backend reuses its
      // counter) — remux must give them distinct broker ids and restore 41.
      ? JSON.stringify({ jsonrpc: '2.0', id: 41, method: 'test/ping' }) + '\n'
      + JSON.stringify({ jsonrpc: '2.0', id: 41, method: 'test/ping' }) + '\n'
      + JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'session/prompt', params: { sessionId: 'sess-42' } }) + '\n'
      : '')));
  let ab = Buffer.alloc(0), headDone = false;
  a.on('data', (c) => {
    ab = Buffer.concat([ab, c]);
    if (!headDone) {
      const nl = ab.indexOf(0x0a); if (nl < 0) return;
      headDone = true; attached = true;
      const head = JSON.parse(ab.subarray(0, nl).toString('utf8'));
      console.log('PASS attach head:', JSON.stringify(head));
      if (!head.ok) return fail('attach not ok');
      ab = ab.subarray(nl + 1);
    }
    let j; while ((j = ab.indexOf(0x0a)) >= 0) {
      const l = ab.subarray(0, j).toString('utf8').trim(); ab = ab.subarray(j + 1);
      if (!l) continue;
      replayed++;
      console.log('  stream:', l);
      onStreamLine(l);
    }
  });
  a.on('error', () => {});
  return a;
};

setTimeout(() => {
  const ctl = net.createConnection(sockPath);
  ctl.on('error', (e) => fail('ctl connect: ' + e.message));
  ctl.on('connect', () => ctl.write(JSON.stringify({ ctl: 1, token: token() }) + '\n{"req":1,"op":"list"}\n'));
  let buf = '';
  ctl.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.ev === 'exit') {
        sawExit = true;
        console.log('PASS exit event:', JSON.stringify(m));
        ctl.write('{"req":9,"op":"list"}\n');
        continue;
      }
      if (m.ev === 'prompt-start') {
        // Fires when the session/prompt frame is forwarded to the acp —
        // client reqId "42" (stringified), brokerReqId 3 (ids 1/2 = pings).
        if (m.id === acpId && m.sessionId === 'sess-42' && m.reqId === '42' && m.brokerReqId === 3 && typeof m.ts === 'number') {
          sawPromptStart = true;
          console.log('PASS prompt-start event:', JSON.stringify(m));
        } else {
          console.log('  prompt-start (bad shape):', JSON.stringify(m));
        }
        continue;
      }
      if (m.ev === 'prompt-done') {
        // Fires when the delayed session/prompt response clears the ledger —
        // must name the CLIENT reqId even though the wire carried broker id.
        if (m.id === acpId && m.sessionId === 'sess-42' && m.reqId === '42' && m.brokerReqId === 3 && m.ok === true && typeof m.ts === 'number') {
          sawPromptDone = true;
          console.log('PASS prompt-done event:', JSON.stringify(m));
        } else {
          console.log('  prompt-done (bad shape):', JSON.stringify(m));
        }
        continue;
      }
      if (m.req === 1) { // list — empty
        console.log('PASS list(empty):', JSON.stringify(m.acps));
        ctl.write(JSON.stringify({
          req: 2, op: 'spawn', cwd: __dirname, command: process.execPath,
          args: ['-e', CHILD],
          env: {}, shell: false, key: 'test:' + __dirname,
        }) + '\n');
      } else if (m.req === 2) {
        if (!m.ok) return fail('spawn: ' + JSON.stringify(m));
        acpId = m.acpId;
        console.log('PASS spawn:', acpId, 'pid', m.pid);
        // Attach after ~600ms — the warm line + ~2 ticks should replay from ring
        setTimeout(() => {
          const a = attach(0, true);
          // The session/prompt answer is still in its 400ms delay — the
          // broker's prompt ledger must report it under the CLIENT reqId.
          setTimeout(() => ctl.write('{"req":5,"op":"list"}\n'), 60);
          // Kill the requesting connection before the delayed response — a
          // second attach must still receive it, id restored to 42.
          setTimeout(() => { a.destroy(); attach(0, false); }, 150);
        }, 600);
      } else if (m.req === 5) { // list — prompt ledger probe
        const rec = (m.acps || []).find((x) => x.acpId === acpId);
        const p42 = rec && (rec.pendingPrompts || []).find((p) => p.reqId === '42');
        if (p42 && p42.sessionId === 'sess-42' && p42.brokerReqId === 3) {
          sawPending42 = true;
          console.log('PASS prompt ledger (client reqId "42", brokerReqId', p42.brokerReqId + ')');
        } else {
          console.log('  ledger probe:', JSON.stringify(rec && rec.pendingPrompts));
        }
      } else if (m.req === 9) { // list after exit
        const rec = (m.acps || []).find((x) => x.acpId === acpId);
        console.log('PASS list(after):', JSON.stringify(rec && { exited: rec.exited, code: rec.exitCode }));
        console.log('  remux summary: broker ids agent saw for client id 41 =', JSON.stringify([...pings]),
          '| raw broker ids leaked =', JSON.stringify([...rawIds]), '| dead-window id42 =', saw42);
        const ok = attached && sawExit && replayed >= 2 && rec && rec.exited && rec.exitCode === 7
          && saw42 && sawPending42 && sawPromptStart && sawPromptDone
          && pings.size === 2 && !pings.has(41) && rawIds.size === 0;
        console.log(ok ? 'ALL CHECKS PASSED' : 'CHECKS INCOMPLETE — see above');
        broker.kill('SIGTERM');
        process.exit(ok ? 0 : 1);
      }
    }
  });
  ctl.on('error', () => {});
}, 800);
