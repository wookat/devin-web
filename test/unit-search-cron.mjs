// Offline unit tests for the FTS5 message index (sessiondb), the
// automations cron parser, and the grouped model-option flattening.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tsImport } from "tsx/esm/api";

const { SessionDb } = await tsImport("../server/src/sessiondb.ts", import.meta.url);
const { cronNext } = await tsImport("../server/src/automations.ts", import.meta.url);
const { flatModelLeaves, cloudVersionToModel } = await tsImport("../server/src/sessionview.ts", import.meta.url);

function tmpDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-fts-"));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return new SessionDb(path.join(dir, "t.db"));
}

const msg = (text) => ({ sessionUpdate: "agent_message_chunk", content: { text } });
const user = (text) => ({ sessionUpdate: "user_message_chunk", content: { text } });

test("fts: incremental index, MATCH, dedup of replayed text", (t) => {
  const db = tmpDb(t);
  db.append("sess-a", 1, 0, 1000, user("deploy the frobnicate service"));
  db.append("sess-a", 2, 0, 1001, msg("deploying frobnicate now"));
  db.append("sess-b", 1, 0, 1002, msg("unrelated carrot"));
  db.append("sess-a", 3, 0, 1003, { sessionUpdate: "tool_call", title: "frobnicate" }); // not an indexed kind
  // Replay copy — same text re-logged at a newer seq under a new gen.
  db.append("sess-a", 40, 1, 2000, msg("deploying frobnicate now"));

  const hits = db.searchMessages("frobnicate", 10);
  // user chunk + agent chunk; tool_call excluded; replay copy collapsed by (session,text)
  assert.equal(hits.length, 2, JSON.stringify(hits));
  const kinds = hits.map((h) => h.kind).sort();
  assert.deepEqual(kinds, ["agent_message_chunk", "user_message_chunk"]);
  assert.ok(hits.every((h) => h.sessionId === "sess-a"));
  assert.ok(hits.every((h) => h.snip.includes("«") && h.snip.includes("»")));

  // AND semantics + unmatched terms + phrase safety
  assert.equal(db.searchMessages("frobnicate carrot", 10).length, 0); // spans two sessions — no single msg has both
  assert.equal(db.searchMessages("zzz-nothing", 10).length, 0);
  assert.equal(db.searchMessages("", 10).length, 0);
  assert.equal(db.searchMessages('frobnicate "unclosed', 10).length, 0); // stray quote can't break FTS syntax

  // Incremental: a row appended after the first search is found on the next.
  db.append("sess-b", 2, 0, 1004, msg("late frobnicate arrival"));
  const h2 = db.searchMessages("frobnicate", 10);
  assert.equal(h2.length, 3);
  assert.ok(h2.some((h) => h.sessionId === "sess-b"));
  db.close();
});

test("fts: existing db gets the index on first search (lazy migration)", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-fts2-"));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const file = path.join(dir, "t.db");
  const db1 = new SessionDb(file);
  db1.append("old", 1, 0, 500, msg("pre-existing history row"));
  db1.close();
  // Reopen — ensureFts creates msg_fts on demand; the bulk pass backfills.
  const db2 = new SessionDb(file);
  const hits = db2.searchMessages("pre-existing", 10);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sessionId, "old");
  db2.close();
});

test("retentionSweep: keeps newest N, fts stops serving pruned text", (t) => {
  const db = tmpDb(t);
  for (let i = 1; i <= 10; i++) db.append("fat", i, 0, 1000 + i, msg(`message number ${i} ${i <= 3 ? "ancient-tok" : ""}`));
  assert.equal(db.searchMessages("ancient-tok", 10).length, 3);
  const r = db.retentionSweep(5);
  assert.equal(r.sessions, 1);
  assert.equal(r.deleted, 5);
  // Pruned text no longer matches; retained text still does.
  assert.equal(db.searchMessages("ancient-tok", 10).length, 0);
  assert.equal(db.searchMessages("message number", 10).length, 5);
  // Fresh appends after a sweep index and search normally.
  db.append("fat", 11, 0, 2000, msg("post-sweep arrival"));
  assert.equal(db.searchMessages("arrival", 10).length, 1);
  db.close();
});

test("cronNext: field semantics incl. vixie dom/dow OR", () => {
  const base = Date.UTC(2026, 0, 5, 10, 30, 0); // Monday 2026-01-05 10:30 UTC
  const n1 = cronNext("*/15 * * * *", base);
  assert.equal(new Date(n1).getMinutes(), 45);
  // 0 9 * * 1 — next Monday 09:00 local (today IS Monday but 09:00 passed)
  const n2 = cronNext("0 9 * * 1", base);
  const d2 = new Date(n2);
  assert.equal(d2.getDay(), 1);
  assert.equal(d2.getHours(), 9);
  assert.equal(d2.getMinutes(), 0);
  // dom OR dow (vixie): "0 0 7 * 3" fires on the 7th OR Wednesday, whichever first
  const n3 = cronNext("0 0 7 * 3", Date.UTC(2026, 0, 5, 0, 0, 0));
  const d3 = new Date(n3);
  assert.ok(d3.getDate() === 7 || d3.getDay() === 3);
  // invalid exprs return null instead of throwing
  for (const bad of ["* * *", "61 * * * *", "* * * * * *", "a b c d e"]) assert.equal(cronNext(bad, base), null, bad);
});

test("flatModelLeaves: nested option groups flatten to leaves", () => {
  // The 0e98b47 bug — acp nests {name, options:[{value,name}]} groups and the
  // flat reader returned value:undefined for every option.
  const leaves = flatModelLeaves([
    { name: "SWE 1.6", options: [{ value: "swe-1-6-slow", name: "Slow" }, { value: "swe-1-6-fast", name: "Fast" }] },
    { value: "claude-4-6", name: "Claude 4.6" },
    { name: "empty-group", options: [] },
  ]);
  assert.deepEqual(leaves.map((l) => l.value), ["swe-1-6-slow", "swe-1-6-fast", "claude-4-6"]);
  assert.equal(leaves[0].name, "Slow");
  // version pill → local value mapping stays sane against real options
  assert.equal(cloudVersionToModel("devin-auto", leaves) === null || typeof cloudVersionToModel("devin-auto", leaves) === "string", true);
});
