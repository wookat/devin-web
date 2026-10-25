/**
 * dwtailsnap — the tail-snapshot subsystem split from dwtimeline: the
 * persisted on-disk tail that paints a cold post-restart open (and covers
 * the window while a replay is still streaming its first delta).
 * Imports the builder (buildTimelineFrom) to shape entries into DwItems —
 * one-directional edge, dwtimeline never imports this file.
 */
import fs from "node:fs";
import path from "node:path";
import type { ApiContext } from "./routes.js";
import type { LogEntry } from "./sessiondb.js";
import { buildTimelineFrom, type DwItem } from "./dwtimeline.js";

/** Tail persisted to disk so a post-restart cold open also paints instantly. */
const TAIL_CACHE_MAX = 120;
const diskTailCache = new Map<string, LogEntry[]>();
function tailCacheSet(id: string, entries: LogEntry[]) {
  if (diskTailCache.has(id)) diskTailCache.delete(id);
  else if (diskTailCache.size >= TAIL_CACHE_MAX) diskTailCache.delete(diskTailCache.keys().next().value!);
  diskTailCache.set(id, entries);
}
const TAIL_KEEP = 400;
const tailWrites = new Map<string, number>();

function tailFile(ctx: ApiContext, id: string) {
  return path.join(ctx.store.dataDir, "tl", `${encodeURIComponent(id)}.json`);
}

function readDiskTail(ctx: ApiContext, id: string): LogEntry[] | null {
  if (diskTailCache.has(id)) return diskTailCache.get(id)!;
  try {
    const raw = JSON.parse(fs.readFileSync(tailFile(ctx, id), "utf8")) as LogEntry[];
    if (Array.isArray(raw) && raw.length) { tailCacheSet(id, raw); return raw; }
  } catch { /* no snapshot */ }
  // Negative-cache the miss — SessionLog.has() consults the mirror on its
  // poison-check path, and a statSync/ENOENT per call per poll per session
  // is pure waste. persistTail() overwrites the entry on the next write.
  tailCacheSet(id, []);
  return null;
}

function persistTail(ctx: ApiContext, id: string) {
  const now = Date.now();
  if (now - (tailWrites.get(id) ?? 0) < 3000) return;
  tailWrites.set(id, now);
  const entries = ctx.sessionLog.get(id).slice(-TAIL_KEEP);
  if (!entries.length) return;
  tailCacheSet(id, entries);
  try {
    const f = tailFile(ctx, id);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(entries));
  } catch { /* best-effort */ }
}

/** Raw persisted-tail entries — the session log's tail-mirror seam
 *  (SessionLog merges these rows by seq when hydrating a thin primary). */
function snapshotEntries(ctx: ApiContext, id: string): LogEntry[] | null {
  return readDiskTail(ctx, id);
}

/** Built items memoized on the SOURCE array identity — the timeline route
 *  calls snapshotItems on every poll (serve-the-richer invariant), and the
 *  cached entries array only changes identity when persistTail rewrites,
 *  so this collapses the per-poll rebuild to a map hit. */
const snapItemCache = new Map<string, { src: LogEntry[]; items: DwItem[] }>();

/** Snapshot items for a cold open / still-empty log: the persisted tail. */
function snapshotItems(ctx: ApiContext, id: string): DwItem[] | null {
  const src = readDiskTail(ctx, id);
  if (!src?.length) return null;
  const hit = snapItemCache.get(id);
  if (hit?.src === src) return hit.items;
  const items = buildTimelineFrom(src, undefined, id, (u) => ctx.sessionLog.resolveBlobs(u));
  if (items.length) {
    if (snapItemCache.size >= TAIL_CACHE_MAX) snapItemCache.delete(snapItemCache.keys().next().value!);
    snapItemCache.set(id, { src, items });
    return items;
  }
  return null;
}

export { persistTail, snapshotItems, snapshotEntries };
