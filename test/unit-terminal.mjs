// Offline deterministic tests of the editor actually used by TermSession.
// Source imports keep web tests independent of Vite output filenames.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { tsImport } from "tsx/esm/api";
import { createRequire } from "node:module";
const { Terminal } = createRequire(import.meta.url)("@xterm/xterm");

const { TerminalEditor, TerminalLifecycle, cellWidth } = await tsImport("../web/src/components/term/terminalEditor.ts", import.meta.url);
const { translatePsInput } = await tsImport("../server/src/psops.ts", import.meta.url);
const { ShellDecoder } = await tsImport("../server/src/shelltext.ts", import.meta.url);
const { killTerminalTree } = await tsImport("../server/src/termprocess.ts", import.meta.url);
const E = "\x1b[";
const plain = (s) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

function harness(t, shell = "pipe", cols = 80) {
  const writes = [], sends = [], agent = [];
  let interrupts = 0, revision = 0;
  const editor = new TerminalEditor({
    write: (d) => writes.push(d), send: (d) => sends.push(d),
    interrupt: () => { interrupts++; editor.connection(false); },
    agentLine: (s) => agent.push(s), cancelAgent: () => revision++,
    cols: () => cols,
  });
  editor.connection(true, shell);
  t.after(() => editor.dispose());
  return { editor, writes, sends, agent, interrupts: () => interrupts, revision: () => revision };
}

test("ask suggestion is editable, executes exactly once; next NL goes to agent", (t) => {
  const h = harness(t), e = h.editor;
  e.mode(true);
  e.feed("list files\r");
  assert.deepEqual(h.agent, ["list files"]);
  e.setLine("echo on");
  e.feed(`${E}D`); e.feed("e"); e.feed("\r"); e.feed("\n"); // CRLF split across callbacks
  assert.deepEqual(h.sends, ["echo oen\n"]);
  e.feed("explain the files\r");
  assert.deepEqual(h.agent, ["list files", "explain the files"]);
  assert.equal(e.fromAgent, false);
});

test("cancel, erase and mode flips discard suggestion provenance and pending revisions", (t) => {
  const h = harness(t), e = h.editor;
  e.mode(true); e.setLine("danger");
  const rev = h.revision();
  e.feed("\x03");
  assert.ok(h.revision() > rev);
  e.feed("new question\r");
  assert.deepEqual(h.agent, ["new question"]);
  assert.equal(h.interrupts(), 0);
  e.setLine("danger"); e.mode(false); e.mode(true);
  e.feed("another question\r");
  assert.deepEqual(h.agent, ["new question", "another question"]);
  assert.deepEqual(h.sends, []);
  e.setLine("danger"); e.feed("\x15"); e.feed("after erase\r");
  assert.equal(h.agent.at(-1), "after erase");
});

test("chunked bracketed paste never submits, including all marker split points", (t) => {
  const payload = `${E}200~echo first\r\necho second\nthird${E}201~`;
  for (let split = 1; split < payload.length; split++) {
    const h = harness(t);
    h.editor.feed(payload.slice(0, split));
    h.editor.feed(payload.slice(split));
    assert.deepEqual(h.sends, [], `split ${split}`);
    assert.equal(h.editor.buf.replace(/\s+/g, " "), "echo first echo second third");
    h.editor.feed("\r");
    assert.equal(h.sends.length, 1);
    assert.ok(!h.sends[0].includes("\x1b"));
  }
});

test("split CSI, history draft restoration, Home/Delete/End and Unicode Ctrl+U", (t) => {
  const h = harness(t), e = h.editor;
  e.feed("first\r"); e.feed("second\r");
  e.feed("草稿🙂e\u0301");
  e.feed("\x1b"); e.feed("["); e.feed("A");
  assert.equal(e.buf, "second");
  e.feed(`${E}A`); assert.equal(e.buf, "first");
  e.feed(`${E}B${E}B`); assert.equal(e.buf, "草稿🙂e\u0301");
  e.feed(`${E}D\x15`); assert.equal(e.buf, "e\u0301"); assert.equal(e.cur, 0);
  e.feed("\x1b["); e.feed("3"); e.feed("~");
  assert.equal(e.buf, "");
  e.feed("中文ab"); e.feed(`${E}H${E}3~${E}F\x7f`);
  assert.equal(e.buf, "文a");
  e.feed("\x01X\x05Y");
  assert.equal(e.buf, "X文aY");
});

test("PTY output and input are byte-transparent, with no synthetic idle prompts", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(t, "pty");
  const raw = "\x1b[2Jremote$ 中文\r\n\x1b[?2004h";
  h.editor.output(raw);
  t.mock.timers.tick(1000);
  assert.deepEqual(h.writes, [raw]);
  h.editor.feed(`ls\r${E}D\x03`);
  assert.deepEqual(h.sends, [`ls\r${E}D\x03`]);
  assert.equal(h.interrupts(), 0);
});

test("async output preserves draft, cursor and suggestion routing; disconnect cancels idle", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(t), e = h.editor;
  e.mode(true); e.setLine("echo 中文");
  e.feed(`${E}D`);
  const cursor = e.cur;
  h.writes.length = 0;
  e.output("background "); e.output("output\r\n");
  assert.equal(e.buf, "echo 中文"); assert.equal(e.cur, cursor);
  t.mock.timers.tick(450);
  assert.ok(plain(h.writes.join("")).includes("❯ echo 中文"));
  assert.equal(e.fromAgent, true);
  e.feed("\r"); assert.deepEqual(h.sends, ["echo 中文\n"]);
  e.output("later");
  e.connection(false);
  const count = h.writes.length;
  t.mock.timers.tick(1000);
  assert.equal(h.writes.length, count);
});

test("long CJK drafts clear all wrapped rows and position the cursor by cells", (t) => {
  const h = harness(t, "pipe", 12);
  h.editor.feed("中文中文中文abcd");
  h.editor.feed(`${E}D${E}D`);
  for (const w of h.writes) {
    if (!w.startsWith(`\r${E}J`)) continue;
    for (const row of plain(w).replace(/^\r/, "").split("\r\n")) {
      assert.ok(cellWidth(row) < 12, JSON.stringify(w));
    }
  }
  assert.equal(cellWidth("中文e\u0301"), 5);
  assert.ok(h.writes.some((w) => w.includes(`\r${E}1A${E}J`)), "old wrapped draft was not fully cleared");
  assert.equal(h.writes.at(-1), `\r${E}6C`);
  h.editor.feed("\r");
  assert.deepEqual(h.sends, ["中文中文中文abcd\n"]);
});

test("real xterm buffer: wrapped redraw, CJK/combining cursor, async output and resize preserve the draft", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const term = new Terminal({ cols: 12, rows: 8, allowProposedApi: true, scrollback: 100 });
  const editor = new TerminalEditor({
    write: (d) => term.write(d), send: () => {}, interrupt: () => {},
    agentLine: () => {}, cancelAgent: () => {}, cols: () => term.cols, rows: () => term.rows,
  });
  t.after(() => { editor.dispose(); term.dispose(); });
  // xterm's write queue uses setTimeout; flush it deterministically.
  const flush = async () => {
    let done = false;
    term.write("", () => { done = true; });
    for (let i = 0; i < 20 && !done; i++) { t.mock.timers.tick(0); await Promise.resolve(); }
    assert.equal(done, true);
  };
  const lines = () => Array.from({ length: term.buffer.active.length },
    (_, i) => term.buffer.active.getLine(i).translateToString(true));
  editor.connection(true, "pipe");
  editor.feed("中e\u0301文🙂");
  await flush();
  assert.equal(term.buffer.active.cursorX, 8); // xterm Unicode6: 🙂 is one cell
  editor.feed("\x15");
  const command = 'Write-Output "中文中文abcdEND"';
  editor.feed(command);
  editor.feed(`${E}H${E}3~W${E}F${E}D${E}D`);
  await flush();
  assert.equal(editor.buf, command);
  assert.equal(lines().join("").split(command).length - 1, 1);
  const cursor = editor.cur;
  editor.output("ASYNC\r\n");
  await flush();
  t.mock.timers.tick(450);
  await flush();
  assert.equal(editor.buf, command); assert.equal(editor.cur, cursor);
  assert.equal(lines().join("").split(command).length - 1, 1);
  assert.ok(lines().includes("ASYNC"));
  editor.hideForResize();
  await flush();
  term.resize(10, 8);
  editor.redraw();
  await flush();
  assert.equal(lines().join("").split(command).length - 1, 1);
});

test("pre-ready/reconnect input is not queued or replayed; clean exit never respawns", (t) => {
  const h = harness(t), e = h.editor;
  e.connection(false);
  e.feed("uncertain command\r".repeat(10000));
  e.connection(true, "pipe");
  assert.equal(e.buf, "");
  assert.deepEqual(h.sends, []);
  e.feed("once\r"); e.connection(false); e.connection(true);
  assert.deepEqual(h.sends, ["once\n"]);
  const lifecycle = new TerminalLifecycle();
  assert.equal(lifecycle.shouldReconnect(false), true);
  lifecycle.exit();
  assert.equal(lifecycle.shouldReconnect(false), false);
  lifecycle.exit(true);
  assert.equal(lifecycle.shouldReconnect(false), true);
  assert.equal(lifecycle.shouldReconnect(true), false);
});

test("pipe Ctrl+C cancels drafts locally, then explicitly interrupts an empty shell", (t) => {
  const h = harness(t);
  h.editor.feed("draft\x03");
  assert.equal(h.interrupts(), 0);
  h.editor.feed("running\r\x03");
  assert.equal(h.interrupts(), 1);
  assert.deepEqual(h.sends, ["running\n"]); // NOT a fake 0x03 stdin interrupt
  assert.equal(h.editor.live, false);
});

test("agent-mode PTY Ctrl+C cancels pending inference locally, then signals the actual remote command", (t) => {
  const h = harness(t, "pty"), e = h.editor;
  e.mode(true); e.feed("run something\r"); e.feed("\x03");
  assert.deepEqual(h.sends, []); assert.equal(e.live, true);
  e.setLine("sleep 100"); e.feed("\r"); e.feed("\x03");
  assert.deepEqual(h.sends, ["sleep 100\r", "\x03"]);
  assert.equal(h.interrupts(), 0); // never kill/reconnect a PTY for Ctrl+C
});

test("UTF-8 output split across chunks and stdout/stderr stays intact", () => {
  const a = new ShellDecoder(false), b = new ShellDecoder(false);
  const chinese = Buffer.from("中文🙂");
  let out = "";
  for (const byte of chinese) { out += a.push(Buffer.from([byte])); b.push(Buffer.from("!")); }
  assert.equal(out + a.flush(), "中文🙂");
});

const ps = process.platform === "win32" ? spawnSync("powershell.exe",
  ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8", windowsHide: true }) : null;
const psAvailable = ps?.status === 0 && ps.stdout.trim() === "5";

test("PS lexer preserves quotes, backticks, comments, nested groups and trailing newline", () => {
  for (const command of [
    `Write-Output 'a && b'`, `Write-Output "a \`" && b"`,
    `Write-Output 'it''s || literal'`, "Write-Output a`&`&b",
    "$(Write-Output 'a && b')", "# a && b\nWrite-Output ok\n",
    `Write-Output @"\na && b\n"@\n`,
  ]) assert.equal(translatePsInput(command), command);
  assert.ok(translatePsInput("cmd /c exit 1 && echo no; echo yes\n").includes(" }" + "; echo yes\n"));
  assert.ok(translatePsInput("echo a &&\necho b\n").endsWith(" }\n"));
  assert.equal(translatePsInput("echo a &&\n"), "echo a &&\n");
});

test("actual Windows PS5.1 mixed short circuit, semicolon precedence, quote/backtick/newline semantics",
  { skip: !psAvailable }, () => {
    const cases = [
      ["cmd /c exit 1 && echo BAD && echo BAD || echo fallback", ["fallback"]],
      ["cmd /c exit 0 || echo BAD && echo success", ["success"]],
      ["cmd /c exit 1 || cmd /c exit 0 && echo recovered", ["recovered"]],
      ["cmd /c exit 0 && cmd /c exit 1 || echo fallback", ["fallback"]],
      ["cmd /c exit 1 && echo BAD; echo independent", ["independent"]],
      ["cmd /c exit 1 && echo BAD\n echo independent\n", ["independent"]],
      ['Write-Output "a `" && b" && Write-Output \'it\'\'s || fine\'\n', ['a " && b', "it's || fine"]],
      ["Write-Output a`&`&b && echo after", ["a&&b", "after"]],
      ["cmd /c exit 1 && echo BAD # comment || ignored\n echo after", ["after"]],
      ["cmd /c exit 0 &&\n echo continued\n", ["continued"]],
      ["Get-Item definitely-missing-terminal-test-file -ErrorAction SilentlyContinue || echo recovered", ["recovered"]],
    ];
    for (const [input, expected] of cases) {
      const translated = translatePsInput(input);
      const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"],
        { input: translated + "\n", encoding: "utf8", windowsHide: true, timeout: 15000 });
      assert.equal(result.stderr, "", `${input}\n${translated}`);
      assert.deepEqual(result.stdout.trim().split(/\r?\n/).filter(Boolean), expected, `${input}\n${translated}`);
    }
  });

test("owned terminal process-tree interruption kills a real local parent and child", { timeout: 15000 }, async (t) => {
  const code = `const {spawn}=require("node:child_process"); const p=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",windowsHide:true}); console.log(p.pid); setInterval(()=>{},1000)`;
  const parent = spawn(process.execPath, ["-e", code], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32",
  });
  t.after(() => { try { parent.kill("SIGKILL"); } catch {} });
  const [chunk] = await once(parent.stdout, "data");
  const childPid = Number(String(chunk).trim());
  assert.ok(childPid > 0);
  const closed = once(parent, "close");
  await killTerminalTree(parent, process.platform !== "win32");
  await closed;
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
});

test("backend-style process.exit cleans registered terminal children, not just ACP helpers", { timeout: 15000 }, async (t) => {
  const module = new URL("../server/src/termprocess.ts", import.meta.url).href;
  const code = `import {spawn} from "node:child_process"; import {trackTerminalProcess} from ${JSON.stringify(module)};
    const pids=[1,2].map(()=>{ const p=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",windowsHide:true,detached:process.platform!=="win32"});
      trackTerminalProcess(p,process.platform!=="win32"); return p.pid; });
    console.log(pids.join(",")); setTimeout(()=>process.exit(0),50);`;
  const backend = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const [chunk] = await once(backend.stdout, "data");
  const pids = String(chunk).trim().split(",").map(Number);
  t.after(() => { for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} } });
  assert.equal(pids.length, 2); assert.ok(pids.every((pid) => pid > 0));
  await once(backend, "close");
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
