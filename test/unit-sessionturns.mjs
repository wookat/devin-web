// unit-sessionturns — node:test coverage for the dead-window correlation
// logic in sessionturns (journaled prompt reqId → owning session). Runs
// against the COMPILED dist (npm run build:server first): the module is
// pure storage + a Map, so no ctx/acp fixtures are needed — persistJson
// no-ops until initCfgState points it at a temp dir.
//
//   node --test test/unit-sessionturns.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "server");
const turns = await import(pathToFileURL(path.join(dist, "sessionturns.js")).href);
const cfg = await import(pathToFileURL(path.join(dist, "sessioncfg.js")).href);
const { openTurns, openTurnsLoad, notePromptReq, sessionByReqId, clearOpenTurns } = turns;

const ctxOf = (dir) => ({ store: { dataDir: dir } });

before(() => { openTurns.clear(); });

test("notePromptReq is a no-op for sessions without an open turn", () => {
  notePromptReq("ghost", 7, "a1");
  assert.equal(openTurns.has("ghost"), false);
});

test("notePromptReq journals reqId+acpId onto the open turn", () => {
  openTurns.set("s1", { text: "go", ts: Date.now() });
  notePromptReq("s1", 42, "acp-a");
  assert.equal(openTurns.get("s1").reqId, 42);
  assert.equal(openTurns.get("s1").acpId, "acp-a");
});

test("sessionByReqId: exact acp match wins over same-id foreign turn", () => {
  openTurns.clear();
  openTurns.set("sA", { text: "a", ts: 1, reqId: 42, acpId: "acp-a" });
  openTurns.set("sB", { text: "b", ts: 1, reqId: 42, acpId: "acp-b" });
  assert.equal(sessionByReqId(42, "acp-a"), "sA");
  assert.equal(sessionByReqId(42, "acp-b"), "sB");
  // Same request id, different live acp — the dead window answer belongs
  // to neither: foreign-attributed entries are skipped, null returned.
  assert.equal(sessionByReqId(42, "acp-c"), null);
});

test("sessionByReqId: unattributed (legacy) entries match only when unique", () => {
  openTurns.clear();
  openTurns.set("s1", { text: "a", ts: 1, reqId: 9 });
  assert.equal(sessionByReqId(9, "acp-a"), "s1");
  openTurns.set("s2", { text: "b", ts: 1, reqId: 9 });
  assert.equal(sessionByReqId(9, "acp-a"), null); // ambiguous — refuse to guess
});

test("sessionByReqId: attributed match beats a loose duplicate", () => {
  openTurns.clear();
  openTurns.set("loose", { text: "a", ts: 1, reqId: 5 });
  openTurns.set("exact", { text: "b", ts: 1, reqId: 5, acpId: "acp-x" });
  assert.equal(sessionByReqId(5, "acp-x"), "exact");
});

test("journal round-trips through open-turns.json (tmp+rename persist)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-turns-"));
  cfg.initCfgState(dir);
  openTurns.clear();
  openTurns.set("sx", { text: "resumeme", ts: 2, kind: "continue" });
  notePromptReq("sx", "req-99", "acp-z");
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "open-turns.json"), "utf8"));
  assert.equal(onDisk.sx.reqId, "req-99");
  assert.equal(onDisk.sx.acpId, "acp-z");
  assert.equal(fs.existsSync(path.join(dir, "open-turns.json.tmp")), false, "no torn tmp left");
});

test("clearOpenTurns removes a single id and persists the tombstone", () => {
  openTurns.clear();
  openTurns.set("k1", { text: "a", ts: 1 });
  openTurns.set("k2", { text: "b", ts: 1 });
  assert.equal(clearOpenTurns(ctxOf(os.tmpdir()), "k1"), 1);
  assert.equal(openTurns.has("k1"), false);
  assert.equal(openTurns.has("k2"), true);
  assert.equal(clearOpenTurns(ctxOf(os.tmpdir())), 1);
  assert.equal(openTurns.size, 0);
});
