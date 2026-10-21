import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import fsp from "node:fs/promises";
import type { AgentSessionRecord, StoreShape, UsageRecord } from "./types.js";

const DEFAULTS: StoreShape = {
  aliases: {},
  workspaces: [],
  usage: [],
  agentSessions: {},
  settings: {
    theme: "dark",
    soundComplete: true,
    soundNotify: true,
    desktopNotify: false,
  },
};

const MAX_USAGE_RECORDS = 50_000;

/** The project was renamed devin-workbench-local → devin-web; sessions carry
 * their spawn-time cwd inside devin's own session store, so old rows still
 * report the dead path. Remap the path SEGMENT anywhere it appears (a cwd
 * could be the repo root or a subdir). */
export function remapLegacyCwd(cwd: string): string {
  return cwd.replace(/devin-workbench-local(?=[\\/]|$)/i, "devin-web");
}

const LEGACY_HOME = ".devin-remote";

function copyMissing(src: string, dst: string, preferBigger = false) {
  if (!fs.existsSync(src)) return;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyMissing(s, d, preferBigger); continue; }
    if (!fs.existsSync(d)) fs.copyFileSync(s, d);
    else if (preferBigger && fs.statSync(s).size > fs.statSync(d).size) fs.copyFileSync(s, d);
  }
}

function readJson<T>(f: string): T | null {
  try { return JSON.parse(fs.readFileSync(f, "utf8")) as T; } catch { return null; }
}

// Bounded one-time migration — scheduled for removal in v0.6.0 once the
// installed base has migrated. Removal = delete this function + its call
// site in the Store constructor + the `.migrated-devin-remote` marker logic.
/** One-shot merge of the pre-rename `~/.devin-remote` data dir into dataDir.
 * The rename switched DEVIN_WEB_HOME's default but never carried the data —
 * session logs, uploads, pins/folders (dw.json), workspaces and account
 * cooldowns all stayed behind. Idempotent via `.migrated-devin-remote`. */
function migrateLegacyDataDir(dataDir: string) {
  if (process.env.DEVIN_WEB_HOME) return; // explicit home — not our story
  const legacy = path.join(os.homedir(), LEGACY_HOME);
  if (legacy === dataDir || !fs.existsSync(legacy)) return;
  const marker = path.join(dataDir, ".migrated-devin-remote");
  if (fs.existsSync(marker)) return;
  try {
    copyMissing(path.join(legacy, "log"), path.join(dataDir, "log"), true);
    copyMissing(path.join(legacy, "uploads"), path.join(dataDir, "uploads"));
    copyMissing(path.join(legacy, "tl"), path.join(dataDir, "tl"));

    // store.json — usage records + workspaces + agent-session cwds
    const cur = readJson<StoreShape>(path.join(dataDir, "store.json"));
    const leg = readJson<StoreShape>(path.join(legacy, "store.json"));
    if (leg) {
      if (!cur) {
        leg.workspaces = (leg.workspaces ?? []).map(remapLegacyCwd);
        for (const u of leg.usage ?? []) if (u.cwd) u.cwd = remapLegacyCwd(u.cwd);
        for (const r of Object.values(leg.agentSessions ?? {})) if (r.cwd) r.cwd = remapLegacyCwd(r.cwd);
        fs.writeFileSync(path.join(dataDir, "store.json"), JSON.stringify(leg));
      } else {
        for (const w of leg.workspaces ?? []) {
          const rw = remapLegacyCwd(w);
          if (!cur.workspaces.includes(rw)) cur.workspaces.push(rw);
        }
        const seen = new Set((cur.usage ?? []).map((u) => `${u.ts}:${u.sessionId}`));
        for (const u of leg.usage ?? []) if (!seen.has(`${u.ts}:${u.sessionId}`)) cur.usage.push(u);
        for (const [id, r] of Object.entries(leg.agentSessions ?? {})) {
          cur.agentSessions[id] ??= { ...r, cwd: r.cwd ? remapLegacyCwd(r.cwd) : r.cwd };
        }
        cur.aliases = { ...leg.aliases, ...cur.aliases };
        fs.writeFileSync(path.join(dataDir, "store.json"), JSON.stringify(cur));
      }
    }

    // dw.json — per-session meta (pins/folders/titles), deep merge
    const dwCur = readJson<Record<string, any>>(path.join(dataDir, "dw.json"));
    const dwLeg = readJson<Record<string, any>>(path.join(legacy, "dw.json"));
    if (dwLeg?.sessions) {
      const out = dwCur ?? { sessions: {}, folderOrder: [], dashboards: {} };
      for (const [id, lm] of Object.entries<Record<string, any>>(dwLeg.sessions)) {
        const cm = out.sessions[id] ?? {};
        const merged = { ...lm, ...cm };
        const lu = lm.updatedAt ?? "", cu = cm.updatedAt ?? "";
        merged.updatedAt = cu >= lu ? cu || undefined : lu;
        if (!merged.updatedAt) delete merged.updatedAt;
        out.sessions[id] = merged;
      }
      out.folderOrder = [...new Set([...(dwLeg.folderOrder ?? []), ...(out.folderOrder ?? [])])];
      out.dashboards = { ...dwLeg.dashboards, ...out.dashboards };
      out.lastConfig = { ...dwLeg.lastConfig, ...out.lastConfig };
      out.prefs = { ...dwLeg.prefs, ...out.prefs };
      fs.writeFileSync(path.join(dataDir, "dw.json"), JSON.stringify(out));
    }

    // accounts-state.json — cooldown marks, max wins
    const accLeg = readJson<{ current?: string; limited_until?: Record<string, number> }>(path.join(legacy, "accounts-state.json"));
    if (accLeg) {
      const f = path.join(dataDir, "accounts-state.json");
      const accCur = readJson<typeof accLeg>(f) ?? {};
      accCur.limited_until = accCur.limited_until ?? {};
      for (const [a, t] of Object.entries(accLeg.limited_until ?? {})) {
        accCur.limited_until[a] = Math.max(accCur.limited_until[a] ?? 0, t);
      }
      accCur.current ??= accLeg.current;
      fs.writeFileSync(f, JSON.stringify(accCur));
    }

    fs.writeFileSync(marker, new Date().toISOString());
    console.log(`[migrate] merged legacy data dir ${legacy} → ${dataDir}`);
  } catch (e) {
    console.error(`[migrate] legacy data dir merge failed: ${e instanceof Error ? e.message : e}`);
  }
}

export class Store {
  readonly dataDir: string;
  readonly uploadsDir: string;
  private file: string;
  private data: StoreShape;
  private saveTimer: NodeJS.Timeout | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private tmpSeq = 0;

  constructor() {
    this.dataDir =
      process.env.DEVIN_WEB_HOME ??
      path.join(os.homedir(), ".devin-web");
    this.uploadsDir = path.join(this.dataDir, "uploads");
    this.file = path.join(this.dataDir, "store.json");
    fs.mkdirSync(this.uploadsDir, { recursive: true });
    migrateLegacyDataDir(this.dataDir);
    // Sweep temp files left by writes interrupted before their rename.
    for (const f of fs.readdirSync(this.dataDir)) {
      if (f.startsWith("store.json.") && f.endsWith(".tmp")) {
        try {
          fs.unlinkSync(path.join(this.dataDir, f));
        } catch {
          /* already gone */
        }
      }
    }
    this.data = this.load();
  }

  private load(): StoreShape {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return {
        ...DEFAULTS,
        ...raw,
        settings: { ...DEFAULTS.settings, ...(raw.settings ?? {}) },
      };
    } catch {
      return structuredClone(DEFAULTS);
    }
  }

  private save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.persist();
    }, 250);
  }

  /**
   * Atomic write: unique temp file + rename, serialized on a chain. A direct
   * writeFile can be read back torn (crash mid-write), and a shared temp path
   * lets two overlapping writes rename half-written JSON into place.
   */
  private persist() {
    const json = JSON.stringify(this.data, null, 2);
    const tmp = `${this.file}.${process.pid}.${++this.tmpSeq}.tmp`;
    this.writeChain = this.writeChain
      .then(async () => {
        await fsp.writeFile(tmp, json);
        await fsp.rename(tmp, this.file);
      })
      .catch((err) => {
        console.error(`store: failed to write ${this.file}:`, err);
        void fsp.unlink(tmp).catch(() => {});
      });
  }

  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const tmp = `${this.file}.${process.pid}.${++this.tmpSeq}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error(`store: failed to flush ${this.file}:`, err);
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* nothing to clean */
      }
    }
  }

  get settings() {
    return this.data.settings;
  }

  setSettings(patch: Partial<StoreShape["settings"]>) {
    Object.assign(this.data.settings, patch);
    this.save();
    return this.data.settings;
  }

  alias(sessionId: string): string | undefined {
    return this.data.aliases[sessionId];
  }

  setAlias(sessionId: string, title: string) {
    if (title) this.data.aliases[sessionId] = title;
    else delete this.data.aliases[sessionId];
    this.save();
  }

  aliases(): Record<string, string> {
    return this.data.aliases;
  }

  workspaces(): string[] {
    return this.data.workspaces.map(remapLegacyCwd);
  }

  addWorkspace(cwd: string) {
    const rw = remapLegacyCwd(cwd);
    if (!this.data.workspaces.includes(rw)) {
      this.data.workspaces.push(rw);
      this.save();
    }
  }

  agentSession(sessionId: string): AgentSessionRecord | undefined {
    return this.data.agentSessions[sessionId];
  }

  agentSessions(): Record<string, AgentSessionRecord> {
    return this.data.agentSessions;
  }

  addAgentSession(sessionId: string, agent: string, cwd: string) {
    const now = Date.now();
    this.data.agentSessions[sessionId] = { agent, cwd, createdAt: now, updatedAt: now };
    this.save();
  }

  touchAgentSession(sessionId: string) {
    const rec = this.data.agentSessions[sessionId];
    if (rec) {
      rec.updatedAt = Date.now();
      this.save();
    }
  }

  recordUsage(rec: UsageRecord) {
    this.data.usage.push(rec);
    if (this.data.usage.length > MAX_USAGE_RECORDS) {
      this.data.usage = this.data.usage.slice(-MAX_USAGE_RECORDS);
    }
    this.save();
  }

  usage(): UsageRecord[] {
    return this.data.usage;
  }
}
