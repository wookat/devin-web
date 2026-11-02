/**
 * notifcenter — local notification inbox (official Notifications parity).
 *
 * A bounded ring of notable events (turn finished, permission requests,
 * rate-limits, history rewinds, mcp auth) journaled to
 * <dataDir>/notifications.json and pushed live as WS `{type:"notification"}`
 * (unscoped — every client sees the badge). `readAt` is the read watermark:
 * items strictly newer are unread. The bell dropdown in the session rail
 * lists items newest-first and marks all-read on open.
 *
 * Turn-finished notices ride sessionprompt's turnEndHooks — registered on
 * import exactly like persona.ts does (no import cycle).
 */
import fs from "node:fs";
import path from "node:path";
import type { ApiContext } from "./routes.js";
import { meta } from "./dwstore.js";
import { turnEndHooks } from "./sessionprompt.js";

export interface NotifItem {
  id: string;
  ts: number;
  /** turn_end | permission | account | rewind | mcp_auth | notice */
  type: string;
  sessionId?: string;
  title: string;
  body?: string;
}

const CAP = 200;
let items: NotifItem[] = [];
let readAt = 0;
let file = "";
let saveT: ReturnType<typeof setTimeout> | null = null;

function initFile(dataDir: string) {
  if (file) return;
  file = path.join(dataDir, "notifications.json");
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8")) as { items?: NotifItem[]; readAt?: number };
    items = Array.isArray(j.items) ? j.items.slice(0, CAP) : [];
    readAt = Number(j.readAt) || 0;
  } catch { /* fresh */ }
}

function save() {
  if (saveT) return;
  saveT = setTimeout(() => {
    saveT = null;
    try { fs.writeFileSync(file, JSON.stringify({ items, readAt })); } catch { /* best effort */ }
  }, 500);
}

let seq = 0;

/** Push an inbox item + live WS event. */
export function notify(ctx: ApiContext, n: Omit<NotifItem, "id" | "ts">) {
  initFile(ctx.store.dataDir);
  const item: NotifItem = {
    id: `n-${Date.now().toString(36)}-${(seq++).toString(36)}`,
    ts: Date.now(),
    ...n,
  };
  items.unshift(item);
  if (items.length > CAP) items.length = CAP;
  ctx.hub.broadcast({ type: "notification", item });
  save();
  return item;
}

/** GET payload — items + the read watermark (client computes unread). */
export function notifList(ctx: ApiContext) {
  initFile(ctx.store.dataDir);
  return { items: items.slice(0, 60), readAt };
}

/** Advance the read watermark (`all`) or to a given item's ts. */
export function notifRead(ctx: ApiContext, at?: number) {
  initFile(ctx.store.dataDir);
  readAt = Math.max(readAt, at ?? Date.now());
  save();
  return { ok: true, readAt };
}

/** Session display title for a notification row. */
function sessionTitle(ctx: ApiContext, id: string) {
  return meta(ctx, id).title || id;
}

// Turn finished → a row the user can click straight back into the session.
// Hooks are fire-and-forget; failures never break a settle (sessionprompt).
turnEndHooks.add((ctx, id) => {
  try { notify(ctx, { type: "turn_end", sessionId: id, title: sessionTitle(ctx, id) }); } catch { /* never break settle */ }
});
