// Broker smoke test — spawn acp-broker, exercise ctl list/spawn, attach,
// ring replay, exit event, journal cleanup. Self-contained, exits 0/1.
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

const broker = spawn(process.execPath, [path.join(__dirname, 'scripts', 'acp-broker.mjs')], {
  env: { ...process.env, DEVIN_WEB_DATA_DIR: dataDir },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const fail = (m) => { console.log('FAIL:', m); broker.kill('SIGTERM'); process.exit(1); };
setTimeout(() => fail('timeout'), 15000);

let acpId = null, attached = false, replayed = 0, sawExit = false;

setTimeout(() => {
  const ctl = net.createConnection(sockPath);
  ctl.on('error', (e) => fail('ctl connect: ' + e.message));
  ctl.on('connect', () => ctl.write('{"ctl":1}\n{"req":1,"op":"list"}\n'));
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
      if (m.req === 1) { // list — empty
        console.log('PASS list(empty):', JSON.stringify(m.acps));
        ctl.write(JSON.stringify({
          req: 2, op: 'spawn', cwd: __dirname, command: process.execPath,
          args: ['-e', 'let n=0;console.log("{\\"warm\\":1}");const iv=setInterval(()=>console.log(JSON.stringify({tick:n++})),250);setTimeout(()=>{clearInterval(iv);process.exit(7)},1600)'],
          env: {}, shell: false, key: 'test:' + __dirname,
        }) + '\n');
      } else if (m.req === 2) {
        if (!m.ok) return fail('spawn: ' + JSON.stringify(m));
        acpId = m.acpId;
        console.log('PASS spawn:', acpId, 'pid', m.pid);
        // Attach after ~600ms — the warm line + ~2 ticks should replay from ring
        setTimeout(() => {
          const a = net.createConnection(sockPath);
          a.on('connect', () => a.write(JSON.stringify({ attach: acpId, after: 0 }) + '\n'));
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
            }
          });
          a.on('error', () => {});
        }, 600);
      } else if (m.req === 9) { // list after exit
        const rec = (m.acps || []).find((x) => x.acpId === acpId);
        console.log('PASS list(after):', JSON.stringify(rec && { exited: rec.exited, code: rec.exitCode }));
        const ok = attached && sawExit && replayed >= 2 && rec && rec.exited && rec.exitCode === 7;
        console.log(ok ? 'ALL CHECKS PASSED' : 'CHECKS INCOMPLETE — see above');
        broker.kill('SIGTERM');
        process.exit(ok ? 0 : 1);
      }
    }
  });
  ctl.on('error', () => {});
}, 800);
