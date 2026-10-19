/**
 * wbstore — wb.json registry: per-session overrides + folder order + dashboards.
 * Extracted from localwb.ts (mechanical move, behavior unchanged).
 */
import fs from "node:fs";
import path from "node:path";
import type { ApiContext } from "./routes.js";

// ---------------------------------------------------------------------------
// registry (wb.json): per-session overrides + folder order + dashboards
// ---------------------------------------------------------------------------

interface WbSessionMeta {
  title?: string;
  folder?: string | null;
  pinned?: boolean;
  archived?: boolean;
  permission?: string;
  /** last real updatedAt seen from session/list — survives restarts so the
   * sidebar never has to fall back to "now". */
  updatedAt?: string;
}

interface WbRegistry {
  sessions: Record<string, WbSessionMeta>;
  folderOrder: string[];
  dashboards: Record<string, unknown>;
  /** Last model/mode/effort/speed picked — applied to new sessions. */
  lastConfig?: Record<string, string>;
  /** Server-side workbench preferences — unlike browser localStorage these
   * act even with no tab open (auto-resume runs on boot). */
  prefs?: { autoResume?: boolean };
}

let reg: WbRegistry | null = null;
let regFile = "";

function loadReg(ctx: ApiContext): WbRegistry {
  if (reg) return reg;
  regFile = path.join(ctx.store.dataDir, "wb.json");
  try {
    reg = JSON.parse(fs.readFileSync(regFile, "utf8")) as WbRegistry;
  } catch {
    reg = { sessions: {}, folderOrder: [], dashboards: {} };
  }
  reg!.sessions ??= {};
  reg!.folderOrder ??= [];
  reg!.dashboards ??= {};
  reg!.prefs ??= {};
  return reg!;
}

function saveReg() {
  try {
    fs.mkdirSync(path.dirname(regFile), { recursive: true });
    fs.writeFileSync(regFile, JSON.stringify(reg));
  } catch { /* best-effort */ }
}

function meta(ctx: ApiContext, id: string): WbSessionMeta {
  const r = loadReg(ctx);
  return (r.sessions[id] ??= {});
}


/** Last model/mode/effort/speed the user picked — applied to new sessions. */
function noteLastUsed(ctx: ApiContext, configId: string, value: string) {
  const r = loadReg(ctx);
  r.lastConfig = { ...(r.lastConfig ?? {}), [configId]: value };
  saveReg();
}

export { type WbSessionMeta, type WbRegistry, loadReg, saveReg, meta, noteLastUsed };
