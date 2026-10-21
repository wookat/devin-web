/**
 * sessionqueue — the per-session message queue.
 *
 * Ctrl+Enter while working parks a prompt here; the queue flushes FIFO when
 * the turn settles. Persisted to queues.json (write-through via sessioncfg's
 * persistJson) — under the broker a restart is invisible, so queued user
 * messages must survive it too.
 *
 * Flush contract: a non-empty queue always implies a turn WAS in flight
 * (idle sends never enter the queue), so the queue drains only from settle
 * paths — never a blind boot sweep. dispatchPrompt + the busy predicate are
 * injected (bindQueueDeps) because they live downstream in sessionio —
 * storage must not import its consumers.
 */
import fs from "node:fs";
import path from "node:path";
import type { ApiContext } from "./routes.js";
import { persistJson } from "./sessioncfg.js";
import { noteUpdate } from "./dwtimeline.js";

export interface QueuedMsg {
  id: string;
  text: string;
  attachments?: { url: string; name?: string; mime?: string; size?: number }[];
  /** Subagent relay context — queueing must not silently retarget the
   * message to the main chain. */
  subagentId?: string;
  respawnRow?: { title: string; task: string; profile: string };
}

const promptQueues = new Map<string, QueuedMsg[]>();
let queueSeq = 0;
const saveQueues = () => persistJson("queues.json", Object.fromEntries(promptQueues));

/** Downstream capabilities the flush needs — injected once by sessionio at
 *  module init. isBusy: "turn in flight or drain gate shut" → don't dequeue. */
let busy: (id: string) => boolean = () => false;
let dispatch: (ctx: ApiContext, id: string, m: QueuedMsg) => void = () => {};
export function bindQueueDeps(deps: {
  isBusy: (id: string) => boolean;
  dispatch: (ctx: ApiContext, id: string, m: QueuedMsg) => void;
}) { busy = deps.isBusy; dispatch = deps.dispatch; }

/** Restore queues.json — sessionio calls this from its boot hook. */
export function restoreQueues(dir: string) {
  try {
    const q = JSON.parse(fs.readFileSync(path.join(dir, "queues.json"), "utf8")) as Record<string, QueuedMsg[]>;
    for (const [sid, msgs] of Object.entries(q)) {
      const ok = Array.isArray(msgs) ? msgs.filter((m) => m && typeof m.id === "string" && typeof m.text === "string") : [];
      if (ok.length) promptQueues.set(sid, ok);
    }
  } catch { /* cold start */ }
}

export function queueList(id: string): QueuedMsg[] {
  return promptQueues.get(id) ?? [];
}

/** Enqueue a message; callers GET the list back for the queue band. */
export function queueAdd(ctx: ApiContext, id: string, text: string, attachments: QueuedMsg["attachments"] = [], extra?: Pick<QueuedMsg, "subagentId" | "respawnRow">): QueuedMsg {
  const m: QueuedMsg = { id: `q${(++queueSeq).toString(36)}${Date.now().toString(36)}`, text, ...(attachments?.length ? { attachments } : {}), ...extra };
  const q = promptQueues.get(id) ?? [];
  q.push(m);
  promptQueues.set(id, q);
  saveQueues();
  noteUpdate(ctx, id);
  return m;
}

export function queueRemove(ctx: ApiContext, id: string, qid: string): boolean {
  const q = promptQueues.get(id);
  if (!q) return false;
  const i = q.findIndex((m) => m.id === qid);
  if (i < 0) return false;
  q.splice(i, 1);
  if (!q.length) promptQueues.delete(id);
  saveQueues();
  noteUpdate(ctx, id);
  return true;
}

/** Dispatch the next queued prompt if nothing is in flight. */
export function queueFlush(ctx: ApiContext, id: string) {
  // Leave the queue untouched while busy — dequeuing into a dead-end
  // dispatch would silently drop the message.
  if (busy(id)) return;
  const q = promptQueues.get(id);
  const next = q?.shift();
  if (!next) return;
  if (q && !q.length) promptQueues.delete(id);
  saveQueues();
  dispatch(ctx, id, next);
}
