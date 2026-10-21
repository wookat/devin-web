/**
 * sessionturns — the open-turns journal (interrupted-turn recovery storage).
 *
 * dispatchPrompt records the outgoing message in open-turns.json at send
 * time and clears it when the prompt settles; an entry still present at
 * boot means a server died mid-turn. A successful settle also appends
 * `dw_turn_end` to the session log so replayed logs keep a durable turn
 * boundary. Pure storage — interruptedTurn/autoResume/watchAdoptedTurn are
 * consumers and stay downstream in sessionload/sessionprompt.
 */
import fs from "node:fs";
import path from "node:path";
import { persistJson } from "./sessioncfg.js";
import type { ApiContext } from "./routes.js";

export interface OpenTurn {
  text: string;
  ts: number;
  attachments?: { url: string; name?: string; mime?: string; size?: number }[];
  /** 'continue' = the turn reached the agent → a "继续" nudge resumes it;
   * 'resend' = the prompt died before any echo → resend the original text. */
  kind?: "continue" | "resend";
  /** Auto-resume attempts already made — caps a resume→crash→resume loop. */
  resumeCount?: number;
}

export const openTurns = new Map<string, OpenTurn>();
let openTurnsLoaded = false;

export function openTurnsLoad(ctx: ApiContext) {
  if (openTurnsLoaded) return;
  openTurnsLoaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ctx.store.dataDir, "open-turns.json"), "utf8")) as Record<string, OpenTurn>;
    for (const [id, t] of Object.entries(raw)) if (t && typeof t.text === "string") openTurns.set(id, t);
  } catch { /* no file / corrupt — nothing to recover */ }
}

export function openTurnsSave(_ctx: ApiContext) {
  persistJson("open-turns.json", Object.fromEntries(openTurns));
}

/** Drop open-turn entries — all of them, or one id. The tombstone case: an
 * entry that hit the resumeCount cap sits in the map forever otherwise
 * (clearing only the file gets resurrected by the next openTurnsSave). */
export function clearOpenTurns(ctx: ApiContext, id?: string): number {
  const n = id ? (openTurns.delete(id) ? 1 : 0) : openTurns.size;
  if (!id) openTurns.clear();
  openTurnsSave(ctx);
  return n;
}
