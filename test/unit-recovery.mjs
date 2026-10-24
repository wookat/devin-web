// unit-recovery — node:test coverage for the recovery/data-integrity core
// (dedup keys, message reassembly, session→acp placement, metrics). Runs
// against the COMPILED dist (npm run build:server first); all modules under
// test are pure storage/Maps, no ctx needed.
//
//   node --test test/unit-recovery.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "server");
const { dedupKey, lastMessageFrom } = await import(pathToFileURL(path.join(dist, "sessiondb.js")).href);
const { loadedOn, sessionHost, isSessionPinned, markLoadedOn } = await import(pathToFileURL(path.join(dist, "sessionplace.js")).href);
const { incMetric, metricsSnapshot } = await import(pathToFileURL(path.join(dist, "metrics.js")).href);

// ---- dedupKey -----------------------------------------------------------

test("dedupKey: identical updates produce the same key (replay twin)", () => {
  const u = { sessionUpdate: "agent_message_chunk", content: { text: "hi" }, _meta: { "cognition.ai/timestamp": "2026-10-24T10:00:00Z" } };
  assert.equal(dedupKey(u), dedupKey(structuredClone(u)));
});

test("dedupKey: volatile decorations are stripped — stored vs live twin match", () => {
  const base = { sessionUpdate: "tool_call", toolCallId: "t1", _meta: {} };
  const live = structuredClone(base);
  live._local = true;
  live._dwBlobbed = "sha:abc";
  live._meta["cognition.ai/streamingMessageId"] = "m-9";
  assert.equal(dedupKey(base), dedupKey(live));
});

test("dedupKey: object key order doesn't matter, content does", () => {
  assert.equal(
    dedupKey({ a: 1, b: { x: 2, y: 3 } }),
    dedupKey({ b: { y: 3, x: 2 }, a: 1 }));
  assert.notEqual(dedupKey({ a: 1 }), dedupKey({ a: 2 }));
});

// ---- lastMessageFrom ----------------------------------------------------

test("lastMessageFrom: newest whole message wins when no chunks precede it", () => {
  const entries = [
    { ts: 3, update: { sessionUpdate: "agent_message", content: { text: "new" } } },
    { ts: 2, update: { sessionUpdate: "user_message", content: { text: "old" } } },
  ];
  assert.deepEqual(lastMessageFrom(entries), { body: "new", ts: 3 });
});

test("lastMessageFrom: same-mid chunks glue in order; older message ignored", () => {
  const meta = (id) => ({ "cognition.ai/streamingMessageId": id });
  const entries = [
    { ts: 4, update: { sessionUpdate: "agent_message_chunk", content: { text: "world" }, _meta: meta("m1") } },
    { ts: 3, update: { sessionUpdate: "agent_message_chunk", content: { text: "hello " }, _meta: meta("m1") } },
    { ts: 2, update: { sessionUpdate: "user_message", content: { text: "q" } } },
  ];
  assert.deepEqual(lastMessageFrom(entries), { body: "hello world", ts: 4 });
});

test("lastMessageFrom: a different mid boundary stops the glue", () => {
  const meta = (id) => ({ "cognition.ai/streamingMessageId": id });
  const entries = [
    { ts: 4, update: { sessionUpdate: "agent_message_chunk", content: { text: "B" }, _meta: meta("m2") } },
    { ts: 3, update: { sessionUpdate: "agent_message_chunk", content: { text: "A" }, _meta: meta("m1") } },
    { ts: 2, update: { sessionUpdate: "agent_message_chunk", content: { text: "0" }, _meta: meta("m1") } },
  ];
  // Only the m2 chunk belongs to the newest message.
  assert.deepEqual(lastMessageFrom(entries), { body: "B", ts: 4 });
});

test("lastMessageFrom: empty/no-message tail → null", () => {
  assert.equal(lastMessageFrom([]), null);
  assert.equal(lastMessageFrom([{ ts: 1, update: { sessionUpdate: "tool_call" } }]), null);
});

// ---- sessionplace -------------------------------------------------------

test("markLoadedOn pins the session to its host acp; exit unpins", () => {
  const acp = { exited: false };
  markLoadedOn("s1", acp);
  assert.equal(sessionHost.get("s1"), acp);
  assert.equal(loadedOn.get(acp)?.has("s1"), true);
  assert.equal(isSessionPinned("s1"), true);
  acp.exited = true;
  assert.equal(isSessionPinned("s1"), false); // dead host → lock is stale
});

test("isSessionPinned: unknown session → false", () => {
  assert.equal(isSessionPinned("never-loaded"), false);
});

// ---- metrics ------------------------------------------------------------

test("metrics: inc accumulates, snapshot serializes", () => {
  incMetric("test.counter", 2);
  incMetric("test.counter");
  const snap = metricsSnapshot();
  assert.equal(snap["test.counter"], 3);
});
