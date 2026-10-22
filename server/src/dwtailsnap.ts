/**
 * dwtailsnap — the tail-snapshot subsystem split from dwtimeline: the
 * instant "newest messages" view shown while a fresh replay streams in,
 * plus the persisted on-disk tail that paints a cold post-restart open.
 * Imports the builder (buildTimelineFrom) to shape entries into DwItems —
 * one-directional edge, dwtimeline never imports this file.
 */
import fs from "node:fs";
import path from "node:path";
import type { ApiContext } from "./routes.js";
import type { LogEntry } from "./sessiondb.js";
import { buildTimelineFrom, type DwItem } from "./dwtimeline.js";

/** Complete pre-reload logs (memory only): the view to show while the fresh
 * replay streams in, so the UI stays on the newest messages instead of
 * watching mid-history scroll by. */
const tailSnapshot = new Map<string, LogEntry[]>();
/** Tail persisted to disk so a post-restart cold open also paints instantly. */
const diskTailCache = new Map<string, LogEntry[]>();
const TAIL_KEEP = 400;
const tailWrites = new Map<string, number>();

function tailFile(ctx: ApiContext, id: string) {
  return path.join(ctx.store.dataDir, "tl", `${encodeURIComponent(id)}.json`);
}

function readDiskTail(ctx: ApiContext, id: string): LogEntry[] | null {
  if (diskTailCache.has(id)) return diskTailCache.get(id)!;
  try {
    const raw = JSON.parse(fs.readFileSync(tailFile(ctx, id), "utf8")) as LogEntry[];
    if (Array.isArray(raw) && raw.length) { diskTailCache.set(id, raw); return raw; }
  } catch { /* no snapshot */ }
  return null;
}

function persistTail(ctx: ApiContext, id: string) {
  const now = Date.now();
  if (now - (tailWrites.get(id) ?? 0) < 3000) return;
  tailWrites.set(id, now);
  const entries = ctx.sessionLog.get(id).slice(-TAIL_KEEP);
  if (!entries.length) return;
  diskTailCache.set(id, entries);
  try {
    const f = tailFile(ctx, id);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(entries));
  } catch { /* best-effort */ }
}

/** Snapshot items to show while a replay is in flight (or log still empty):
 * the pre-reload log if we had one, else the persisted tail. */
function snapshotItems(ctx: ApiContext, id: string): DwItem[] | null {
  const src = tailSnapshot.get(id) ?? readDiskTail(ctx, id);
  if (!src?.length) return null;
  const items = buildTimelineFrom(src, undefined, id, (u) => ctx.sessionLog.resolveBlobs(u));
  return items.length ? items : null;
}

export { tailSnapshot, persistTail, snapshotItems };
