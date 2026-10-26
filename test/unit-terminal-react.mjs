// Real React commits, state rerenders and callback refs; no browser/DOM package
// is needed because this fixture renders only hook-bearing components (no host
// elements). The hook and editor below are the production implementations.
import { test } from "node:test";
import assert from "node:assert/strict";
import React, { act, forwardRef, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { tsImport } from "tsx/esm/api";

const { useTerminalHandle } = await tsImport("../web/src/components/term/terminalHandle.ts", import.meta.url);
const { TerminalEditor } = await tsImport("../web/src/components/term/terminalEditor.ts", import.meta.url);

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function fixture(t, run) {
  // Only the root's event/selection plumbing is touched: no fake React hooks,
  // fake reconciler or simulated useImperativeHandle implementation.
  const old = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const document = { nodeType: 9, addEventListener() {}, removeEventListener() {}, activeElement: null };
  const window = { document, HTMLIFrameElement: class {} };
  document.defaultView = window;
  globalThis.window = window; globalThis.document = document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = { nodeType: 1, tagName: "DIV", ownerDocument: document, addEventListener() {}, removeEventListener() {} };
  const root = createRoot(container);
  const f = { current: null, instances: [], refEvents: [], request: null, pending: null, busy: false, controls: null };
  const Child = forwardRef(function Child(_, ref) {
    const instance = useRef(null);
    if (instance.current === null) {
      const record = { revision: 0, live: true, sends: [], prompts: [], interrupts: 0, factories: 0, editor: null };
      record.editor = new TerminalEditor({
        write() {}, send: (d) => record.sends.push(d),
        interrupt: () => { record.interrupts++; record.live = false; record.editor.connection(false); },
        agentLine: (line) => { record.prompts.push(line); f.request?.(line); },
        cancelAgent: () => record.revision++, cols: () => 80,
      });
      record.editor.connection(true, "pipe"); record.editor.mode(true);
      instance.current = record; f.instances.push(record);
    }
    const r = instance.current;
    useTerminalHandle(ref, () => {
      r.factories++;
      return {
        send: (d) => r.sends.push(d.replace(/\r\n?/g, "\n")),
        setLine: (s) => r.editor.setLine(s), write() {}, clear() {}, focus() {},
        isLive: () => r.live, revision: () => r.revision,
        shellHint: () => "Windows PowerShell 5.1 command",
        agentSettled: () => r.editor.agentSettled(),
      };
    });
    useEffect(() => () => r.editor.dispose(), []);
    return null;
  });
  function Parent() {
    const [busy, setBusy] = useState(false);
    const [mounted, setMounted] = useState(true);
    const [incarnation, setIncarnation] = useState(0);
    f.busy = busy;
    f.controls = { close: () => setMounted(false), replace: () => setIncarnation((n) => n + 1) };
    f.request = () => {
      const h = f.current, revision = h.revision();
      setBusy(true); // the exact rerender that invalidated the old handle
      const response = deferred();
      f.pending = response;
      response.promise.then((command) => {
        // TermPanel's mounted-incarnation + live + revision guard.
        if (f.current !== h || !h.isLive() || h.revision() !== revision) return;
        if (run === "ask") h.setLine(command);
        else h.send(command + "\r");
      }).finally(() => { h.agentSettled(); setBusy(false); });
    };
    return mounted ? React.createElement(Child, {
      key: incarnation,
      // Deliberately inline: React detaches/reattaches this ref every render.
      ref: (h) => { f.refEvents.push(h); f.current = h; },
    }) : null;
  }
  await act(async () => { root.render(React.createElement(Parent)); });
  t.after(async () => {
    await act(async () => { root.unmount(); });
    globalThis.window = old.window; globalThis.document = old.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = old.act;
  });
  f.start = async () => {
    const h = f.current, r = f.instances.at(-1);
    const before = f.refEvents.length;
    await act(async () => { r.editor.feed("list files\r"); });
    assert.equal(f.busy, true);
    assert.ok(f.refEvents.length > before, "React did not exercise callback-ref churn");
    assert.ok(f.refEvents.slice(before).includes(null), "old callback ref was not detached");
    assert.equal(f.current, h, "ordinary busy-state rerender changed the terminal incarnation");
    assert.equal(r.factories, 1, "the handle factory ran again after ref churn");
    return r;
  };
  f.answer = async (command = "Write-Output ONCE") => {
    await act(async () => { f.pending.resolve(command); await f.pending.promise; });
    assert.equal(f.busy, false);
  };
  return f;
}

for (const run of ["ask", "exec"]) {
  test(`React inline ref + busy rerender: ordinary ${run} response survives and executes once`, async (t) => {
    const f = await fixture(t, run), r = await f.start();
    await f.answer();
    if (run === "ask") {
      assert.deepEqual(r.sends, []);
      assert.equal(r.editor.buf, "Write-Output ONCE");
      await act(async () => { r.editor.feed("\r"); });
    }
    assert.deepEqual(r.sends, ["Write-Output ONCE\n"]);
    f.request = null;
    await act(async () => { r.editor.feed("next natural-language question\r"); });
    assert.deepEqual(r.prompts, ["list files", "next natural-language question"]);
    assert.deepEqual(r.sends, ["Write-Output ONCE\n"]);
  });
  test(`React ${run} delivery settles inference state so empty agent-mode Ctrl+C interrupts the shell`, async (t) => {
    const f = await fixture(t, run), r = await f.start();
    await f.answer("Start-Sleep -Seconds 100");
    if (run === "ask") await act(async () => { r.editor.feed("\r"); });
    assert.equal(r.editor.agent, true);
    assert.deepEqual(r.sends, ["Start-Sleep -Seconds 100\n"]);
    await act(async () => { r.editor.feed("\x03"); });
    assert.equal(r.interrupts, 1, "agent mode swallowed Ctrl+C after a shell command");
    assert.equal(r.live, false);
    assert.deepEqual(r.sends, ["Start-Sleep -Seconds 100\n"]);
  });
}

for (const reason of ["Ctrl+C", "mode flip", "new input", "reconnect", "closed tab", "new incarnation"]) {
  test(`React ref stability does not weaken stale-response protection: ${reason}`, async (t) => {
    const f = await fixture(t, "exec"), r = await f.start();
    const original = f.current;
    await act(async () => {
      if (reason === "Ctrl+C") r.editor.feed("\x03");
      else if (reason === "mode flip") r.editor.mode(false);
      else if (reason === "new input") r.editor.feed("new draft");
      else if (reason === "reconnect") { r.editor.connection(false); r.editor.connection(true, "pipe"); }
      else if (reason === "closed tab") f.controls.close();
      else f.controls.replace();
    });
    if (reason === "new incarnation") {
      f.instances.at(-1).revision = r.revision; // revision counters can coincide
      assert.notEqual(f.current, original);
      assert.equal(original.isLive(), true); assert.equal(f.current.isLive(), true);
      assert.equal(original.revision(), f.current.revision()); // identity is essential
    }
    await f.answer("MUST_NOT_EXECUTE");
    assert.deepEqual(r.sends, []);
    assert.equal(r.editor.buf.includes("MUST_NOT_EXECUTE"), false);
    if (reason === "Ctrl+C") {
      assert.equal(r.interrupts, 0, "canceling an inference must not reset the idle shell");
      assert.equal(r.live, true);
    }
    if (reason === "new incarnation") assert.deepEqual(f.instances.at(-1).sends, []);
  });
}
