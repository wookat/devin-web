/**
 * sessiondb — SQLite event store for session logs.
 *
 * Layout (Cursor-CLI-style claim-check):
 *   events(session_id, gen, seq, ts, kind, bytes, data) — one row per logged
 *     update. PK (session_id, gen, seq): `gen` is the replay generation —
 *     clear() bumps it, replay appends write the new gen while the OLD gen
 *     rows stay put, so a failed replay rolls back by deleting the partial
 *     gen (no file dependency) and a successful one deletes all older gens
 *     (physically erasing replay-duplicated history). All reads serve the
 *     max gen only.
 *   blobs(sha, data) — content-addressed payload store. Strings >BLOB_MIN
 *     inside a >OFFLOAD_MIN update persist as {"$blob": sha} refs; identical
 *     payloads (replay wrote the same tool_call 4×) share one row.
 *
 * Display-critical fields stay inline: message text (user/agent/thought
 * chunks) never offloads — the timeline renders chat without blob reads.
 * Diff metadata is PRECOMPUTED at store time into `_dwFileUpdates` (counting
 * lines needs the old/new texts — resolving blobs per row would defeat the
 * point), so `fileUpdates` needs no blobs either. Consumers that genuinely
 * need a payload call resolveBlobs().
 *
 * The .jsonl file remains a write-through MIRROR of the transformed
 * (ref-carrying) entries; a session with no DB rows lazily imports its
 * legacy file on first touch, then the file is deleted (the DB holds the
 * history; future appends re-create the mirror with only new lines).
 */
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";

const BLOB_MIN = 16 * 1024;
const OFFLOAD_MIN = 64 * 1024;
const IMPORT_BATCH = 4000;
/** Which sessionUpdate kinds are streamable text chunks — the storage layer
 *  owns this fact (it decides blob-offload eligibility); export.ts reuses it
 *  for transcript merging. */
export const MSG_KINDS = new Set(["user_message_chunk", "agent_message_chunk", "agent_thought_chunk"]);

export interface StoredEntry {
  ts: number;
  seq: number;
  update: Record<string, unknown>;
}

/** One session-log line (file or memory) — the canonical LogEntry, owned by
 * the storage layer so every consumer imports from here (previously
 * duplicated in dwtimeline and sessionsidecars). */
export interface LogEntry {
  ts: number;
  /** Per-session monotonic sequence — survives ring eviction and gives
   * timeline items stable `e<seq>` ids across rebuilds and disk backfills. */
  seq?: number;
  update: Record<string, unknown>;
}

interface FileUpdateLike {
  file_path: string;
  lines_added: number;
  lines_removed: number;
  action_type: string;
  fileId: string;
  prevFileId: string;
}

/** Precomputed dwtimeline.diffsToFileUpdates — identical output shape. */
function fileUpdatesOf(content: unknown): FileUpdateLike[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const files: FileUpdateLike[] = [];
  for (const c of content as Record<string, unknown>[]) {
    if (c?.type !== "diff") continue;
    // Blob refs in a re-imported transformed entry aren't countable — the
    // row already carries _dwFileUpdates from the first store.
    if (c.oldText != null && typeof c.oldText !== "string") continue;
    if (c.newText != null && typeof c.newText !== "string") continue;
    const p = String(c.path ?? "");
    const a = typeof c.newText === "string" ? c.newText.split("\n").length : 0;
    const r = typeof c.oldText === "string" ? c.oldText.split("\n").length : 0;
    files.push({
      file_path: p,
      lines_added: Math.max(0, a - r),
      lines_removed: Math.max(0, r - a),
      action_type: c.oldText == null ? "create" : c.newText == null ? "delete" : "modify",
      fileId: `path:${encodeURIComponent(p)}`,
      prevFileId: `path:${encodeURIComponent(p)}`,
    });
  }
  return files.length ? files : undefined;
}

function isBlobRef(v: unknown): v is { $blob: string } {
  return (
    typeof v === "object" && v !== null &&
    typeof (v as Record<string, unknown>).$blob === "string" &&
    Object.keys(v as Record<string, unknown>).length === 1
  );
}

/** Canonical dedup key for an update — sha256 over a normalized form that
 * drops volatile decorations (`_local`, `_dwBlobbed`, the live-stream-only
 * streamingMessageId). devin's session/load replays its transcript verbatim,
 * so a stored row and its replayed twin produce the same key — the replay
 * then appends only the delta it actually has. */
export function dedupKey(update: Record<string, unknown>): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) {
        if (k === "_local" || k === "_dwBlobbed") continue;
        out[k] = canon(o[k]);
      }
      return out;
    }
    return v;
  };
  const u = canon(update) as Record<string, unknown>;
  const meta = u._meta as Record<string, unknown> | undefined;
  if (meta && "cognition.ai/streamingMessageId" in meta) {
    const m = { ...meta };
    delete m["cognition.ai/streamingMessageId"];
    u._meta = m;
  }
  return crypto.createHash("sha256").update(JSON.stringify(u)).digest("hex").slice(0, 24);
}

/** WHERE expression matching the current (max) generation of a session. */
const CUR_GEN = "gen=(SELECT COALESCE(MAX(gen),0) FROM events WHERE session_id=?)";

export class SessionDb {
  private db: DatabaseSync;
  private sInsEvent;
  private sInsBlob;
  private sAll;
  private sTail;
  private sHas;
  private sMaxSeq;
  private sMaxSeqInGen;
  private sMaxGen;
  private sMaxTs;
  private sSumBytes;
  private sDel;
  private sDelGen;
  private sDelOlder;
  private sBlob;
  private sDedupGet;
  private sDedupSet;
  private sDedupPage;
  private sPage;
  private sScanPage;
  private sLastMsg;
  private sUpdEntry;
  /** Write batching: every streamed chunk used to be its own autocommit —
   *  fsync + WAL frame + native alloc churn per entry, which ballooned the
   *  process arena (2GB RSS on a ~150MB heap). Appends queue here and land
   *  in one transaction per ~120ms window; reads that need consistency
   *  flush first, and pendByKey/pendSids keep the hot dedup/probe paths
   *  correct without flushing. */
  private pend: { sid: string; seq: number; gen: number; ts: number; kind: string; bytes: number; data: string; dedup: string | null }[] = [];
  private pendOps: (() => void)[] = [];
  private pendByKey = new Map<string, { seq: number; gen: number; ts: number; local: boolean }>();
  private pendSids = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=NORMAL");
    // Schema check: an events table without gen in the PK is the pre-gen
    // layout — drop it; rows re-import from the .jsonl mirror on next touch.
    const sqlRow = this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='events'",
    ).get() as { sql?: string } | undefined;
    if (sqlRow?.sql && !sqlRow.sql.includes("PRIMARY KEY (session_id, gen, seq)")) {
      this.db.exec("DROP TABLE events");
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS events(
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      gen INTEGER NOT NULL DEFAULT 0,
      ts INTEGER NOT NULL,
      kind TEXT,
      bytes INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL,
      PRIMARY KEY (session_id, gen, seq))`);
    this.db.exec("CREATE TABLE IF NOT EXISTS blobs(sha TEXT PRIMARY KEY, data TEXT NOT NULL)");
    // Migration v1 (one-shot, user_version-gated):
    //  a) restore ORIGINAL event timestamps — sessionlog.append() stamped
    //     Date.now() on every append, so each replay collapsed its entries to
    //     the replay moment; the true time survives inside
    //     data._meta["cognition.ai/timestamp"].
    //  b) adopt orphan-generation fragments into the current gen — killed
    //     replays left disjoint seq windows stranded under old gens, invisible
    //     to CUR_GEN reads. INSERT OR IGNORE dedupes overlapping seqs.
    const uv = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (uv < 1) {
      const jt = `$._meta."cognition.ai/timestamp"`;
      this.db.exec(`UPDATE events SET ts =
        CAST(strftime('%s', json_extract(data,'${jt}')) AS INTEGER)*1000
        + (CAST(strftime('%f', json_extract(data,'${jt}'))*1000 AS INTEGER) % 1000)
        WHERE data LIKE '%"cognition.ai/timestamp"%'
          AND json_extract(data,'${jt}') IS NOT NULL`);
      this.db.exec(`INSERT OR IGNORE INTO events(session_id,seq,gen,ts,kind,bytes,data)
        SELECT e.session_id, e.seq,
          (SELECT MAX(g.gen) FROM events g WHERE g.session_id=e.session_id),
          e.ts, e.kind, e.bytes, e.data
        FROM events e
        WHERE e.gen < (SELECT MAX(h.gen) FROM events h WHERE h.session_id=e.session_id)`);
      this.db.exec(`DELETE FROM events
        WHERE gen < (SELECT MAX(g.gen) FROM events g WHERE g.session_id=events.session_id)`);
      this.db.exec("PRAGMA user_version=1");
    }
    // Schema v2: the `dedup` column keys every row by content — the
    // append-only replay model recognizes replayed copies by key and skips
    // them instead of the old clear()+rewrite (which re-stamped timestamps
    // and left invisible generation fragments when killed mid-stream).
    const hasDedupCol = this.db.prepare(
      "SELECT 1 AS x FROM pragma_table_info('events') WHERE name='dedup'",
    ).get() != null;
    if (!hasDedupCol) this.db.exec("ALTER TABLE events ADD COLUMN dedup TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_events_dedup ON events(session_id,dedup)");
    // (session_id,kind,seq) serves the lastMessage tail probe — without it
    // a per-session message lookup scans every tool_call row since the last
    // message, which on noisy sessions is thousands of rows per list poll.
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_events_kind ON events(session_id,kind,seq DESC)");
    this.db.exec("PRAGMA user_version=2");
    this.sInsEvent = this.db.prepare(
      "INSERT OR REPLACE INTO events(session_id,seq,gen,ts,kind,bytes,data,dedup) VALUES (?,?,?,?,?,?,?,?)",
    );
    this.sInsBlob = this.db.prepare("INSERT OR IGNORE INTO blobs(sha,data) VALUES (?,?)");
    this.sAll = this.db.prepare(
      `SELECT seq,ts,data FROM events WHERE session_id=? AND ${CUR_GEN} ORDER BY seq`,
    );
    this.sTail = this.db.prepare(
      `SELECT seq,ts,data FROM events WHERE session_id=? AND ${CUR_GEN} ORDER BY seq DESC LIMIT ?`,
    );
    this.sHas = this.db.prepare("SELECT 1 AS x FROM events WHERE session_id=? LIMIT 1");
    this.sMaxSeq = this.db.prepare(
      `SELECT MAX(seq) AS m FROM events WHERE session_id=? AND ${CUR_GEN}`,
    );
    this.sMaxSeqInGen = this.db.prepare(
      "SELECT MAX(seq) AS m FROM events WHERE session_id=? AND gen=?",
    );
    this.sMaxGen = this.db.prepare("SELECT COALESCE(MAX(gen),-1) AS g FROM events WHERE session_id=?");
    this.sMaxTs = this.db.prepare("SELECT MAX(ts) AS t FROM events WHERE session_id=?");
    this.sSumBytes = this.db.prepare("SELECT COALESCE(SUM(bytes),0) AS b FROM events WHERE session_id=?");
    this.sDel = this.db.prepare("DELETE FROM events WHERE session_id=?");
    this.sDelGen = this.db.prepare("DELETE FROM events WHERE session_id=? AND gen=?");
    this.sDelOlder = this.db.prepare("DELETE FROM events WHERE session_id=? AND gen<?");
    this.sBlob = this.db.prepare("SELECT data FROM blobs WHERE sha=?");
    this.sDedupGet = this.db.prepare(
      "SELECT seq,gen,ts,json_extract(data,'$._local') AS loc FROM events WHERE session_id=? AND dedup=? LIMIT 1",
    );
    this.sDedupSet = this.db.prepare(
      "UPDATE events SET dedup=? WHERE session_id=? AND gen=? AND seq=?",
    );
    this.sDedupPage = this.db.prepare(
      "SELECT seq,gen,data FROM events WHERE session_id=? AND dedup IS NULL AND (gen>? OR (gen=? AND seq>?)) ORDER BY gen,seq LIMIT ?",
    );
    this.sPage = this.db.prepare(
      `SELECT seq,ts,data FROM events WHERE session_id=? AND ${CUR_GEN} AND seq>? ORDER BY seq LIMIT ?`,
    );
    this.sScanPage = this.db.prepare(
      "SELECT seq,ts,data FROM events WHERE session_id=? AND gen=? AND seq>? AND seq<=? AND data LIKE '%subagent%' ORDER BY seq LIMIT ?",
    );
    this.sLastMsg = this.db.prepare(
      "SELECT ts,data FROM events WHERE session_id=? AND kind IN ('agent_message_chunk','user_message_chunk','agent_message','user_message','message') ORDER BY seq DESC LIMIT ?",
    );
    this.sUpdEntry = this.db.prepare(
      "UPDATE events SET ts=?,data=? WHERE session_id=? AND gen=? AND seq=?",
    );
    // WAL maintenance: passive autocheckpoint can stall for hours under a
    // busy read mix; a periodic TRUNCATE guarantees the wal file drains and
    // shrinks. Iterators must never pin readers between event-loop turns —
    // every streaming accessor below pages via .all() instead.
    setInterval(() => {
      try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* busy — next round */ }
    }, 60_000).unref();
    // A kill mid-window must not strand queued writes — 'exit' runs them
    // synchronously (better-sqlite3 calls are sync, safe in exit handlers).
    process.once("exit", () => { try { this.flush(); } catch {} });
  }

  private armFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), 120);
    this.flushTimer.unref();
  }

  /** Commit the queued write batch — one BEGIN/COMMIT for the whole window.
   *  Called by the timer, by read paths needing consistency, and on exit. */
  flush() {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (!this.pend.length && !this.pendOps.length) return;
    const rows = this.pend; this.pend = [];
    const ops = this.pendOps; this.pendOps = [];
    this.pendByKey.clear();
    this.pendSids.clear();
    try {
      this.db.exec("BEGIN");
      for (const r of rows) this.sInsEvent.run(r.sid, r.seq, r.gen, r.ts, r.kind, r.bytes, r.data, r.dedup);
      for (const op of ops) op();
      this.db.exec("COMMIT");
    } catch { try { this.db.exec("ROLLBACK"); } catch {} }
  }

  private putBlob(text: string): string {
    const sha = crypto.createHash("sha256").update(text).digest("hex");
    this.sInsBlob.run(sha, text);
    return sha;
  }

  /** Replace big strings in `node` with {$blob} refs (in place). `path`
   * tracks the JSON path so display-critical fields can be spared. */
  private blobify(node: unknown, path: string, kind: string) {
    const visit = (v: unknown, p: string): unknown => {
      if (typeof v === "string") {
        // Message body text is display-critical — keep it inline so the
        // timeline never needs a blob round-trip for a chat row.
        if (v.length > BLOB_MIN && !(MSG_KINDS.has(kind) && p.endsWith("text"))) {
          return { $blob: this.putBlob(v) };
        }
        return v;
      }
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) v[i] = visit(v[i], `${p}.${i}`);
        return v;
      }
      if (typeof v === "object" && v !== null) {
        for (const [k, val] of Object.entries(v)) {
          if (isBlobRef(val)) continue;
          (v as Record<string, unknown>)[k] = visit(val, p ? `${p}.${k}` : k);
        }
        return v;
      }
      return v;
    };
    return visit(node, path);
  }

  /** Storage transform: returns the (possibly blob-ref) update to persist
   * plus the ORIGINAL serialized size for diskSize-style heuristics. */
  private transform(update: Record<string, unknown>): { update: Record<string, unknown>; bytes: number } {
    const raw = JSON.stringify(update);
    const bytes = Buffer.byteLength(raw);
    if (bytes < OFFLOAD_MIN) return { update, bytes };
    const kind = String(update.sessionUpdate ?? "");
    // Deep clone via the serialization we already paid for — blobify mutates
    // nested arrays in place, and a shallow copy would corrupt the live
    // memory-ring entry sharing them.
    const out: Record<string, unknown> = JSON.parse(raw);
    out._dwBlobbed = true;
    if ((kind === "tool_call" || kind === "tool_call_update") && out._dwFileUpdates == null) {
      const fu = fileUpdatesOf(update.content);
      if (fu) out._dwFileUpdates = fu;
    }
    return { update: this.blobify(out, "", kind) as Record<string, unknown>, bytes };
  }

  /** Append one event; returns the TRANSFORMED update so callers writing a
   * JSONL mirror persist the identical ref-log line. `dedup` is the
   * pre-blob content key — replayed twins hash-match on it even though
   * their stored form may carry {$blob} refs. */
  append(sessionId: string, seq: number, gen: number, ts: number, update: Record<string, unknown>, dedup: string | null = null): Record<string, unknown> {
    const t = this.transform(update);
    this.pend.push({ sid: sessionId, seq, gen, ts, kind: String(update.sessionUpdate ?? ""), bytes: t.bytes, data: JSON.stringify(t.update), dedup });
    this.pendSids.add(sessionId);
    if (dedup) this.pendByKey.set(`${sessionId}|${dedup}`, { seq, gen, ts, local: update._local === true || update._local === 1 });
    this.armFlush();
    return t.update;
  }

  /** Look up a stored row by its content key (any generation — a dupe is a
   *  dupe wherever it lives). `local` flags `_local` optimistic rows so a
   *  replayed authoritative twin can graduate them — hot path never parses
   *  row payloads. */
  dedupGet(sessionId: string, dedup: string): { seq: number; gen: number; ts: number; local: boolean } | null {
    const p = this.pendByKey.get(`${sessionId}|${dedup}`);
    if (p) return p; // queued row — authoritative, no flush needed
    const r = this.sDedupGet.get(sessionId, dedup) as { seq: number; gen: number; ts: number; loc: unknown } | undefined;
    if (!r) return null;
    return { seq: r.seq, gen: r.gen, ts: r.ts, local: r.loc === true || r.loc === 1 };
  }

  /** Rows still missing a content key — the lazy backfill feed for
   *  sessions whose history predates the dedup column. */
  *dedupRows(sessionId: string): Generator<{ seq: number; gen: number; data: string }> {
    this.flush();
    let g = -1, q = -1;
    for (;;) {
      const rows = this.sDedupPage.all(sessionId, g, g, q, 2000) as { seq: number; gen: number; data: string }[];
      if (!rows.length) return;
      for (const r of rows) { g = r.gen; q = r.seq; yield r; }
    }
  }

  dedupSet(sessionId: string, gen: number, seq: number, dedup: string) {
    this.pendOps.push(() => this.sDedupSet.run(dedup, sessionId, gen, seq));
    this.pendByKey.set(`${sessionId}|${dedup}`, { seq, gen, ts: 0, local: false });
    this.armFlush();
  }

  /** Overwrite a stored row in place — the `_local` graduation path: a
   *  replayed authoritative twin replaces the optimistic copy under the
   *  same seq, so nothing shifts and no duplicate appears. */
  updateStored(sessionId: string, gen: number, seq: number, ts: number, update: Record<string, unknown>) {
    const t = this.transform(update);
    const data = JSON.stringify(t.update);
    this.pendOps.push(() => this.sUpdEntry.run(ts, data, sessionId, gen, seq));
    this.armFlush();
  }

  readAll(sessionId: string): StoredEntry[] {
    this.flush();
    const rows = this.sAll.all(sessionId, sessionId) as { seq: number; ts: number; data: string }[];
    const out: StoredEntry[] = [];
    for (const r of rows) {
      try { out.push({ seq: r.seq, ts: r.ts, update: JSON.parse(r.data) }); } catch { /* corrupt row */ }
    }
    return out;
  }

  /** Last `limit` entries in ascending order — the hydration path for
   * memory rings; a full readAll on a near-million-row session blocks the
   * event loop for tens of seconds (supervisor then kills the backend). */
  readTail(sessionId: string, limit: number): StoredEntry[] {
    this.flush();
    const rows = this.sTail.all(sessionId, sessionId, limit) as { seq: number; ts: number; data: string }[];
    const out: StoredEntry[] = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      try { out.push({ seq: r.seq, ts: r.ts, update: JSON.parse(r.data) }); } catch { /* corrupt row */ }
    }
    return out;
  }

  /** Row-by-row generator — lets callers pull the full history in batches
   * and yield the event loop between them (deep backfill). */
  *each(sessionId: string): Generator<StoredEntry> {
    this.flush();
    let after = -1;
    for (;;) {
      const rows = this.sPage.all(sessionId, sessionId, after, 2000) as { seq: number; ts: number; data: string }[];
      if (!rows.length) return;
      for (const r of rows) {
        after = r.seq;
        try { yield { seq: r.seq, ts: r.ts, update: JSON.parse(r.data) }; } catch { /* corrupt row */ }
      }
    }
  }

  has(sessionId: string): boolean {
    if (this.pendSids.has(sessionId)) return true; // queued-only session
    this.flush();
    return this.sHas.get(sessionId) != null;
  }

  /** Max seq of the current gen — the resume point for seq assignment. */
  maxSeq(sessionId: string): number {
    this.flush();
    const r = this.sMaxSeq.get(sessionId, sessionId) as { m: number | null } | undefined;
    return r?.m ?? -1;
  }

  maxSeqInGen(sessionId: string, gen: number): number {
    this.flush();
    const r = this.sMaxSeqInGen.get(sessionId, gen) as { m: number | null } | undefined;
    return r?.m ?? -1;
  }

  /** Highest stored gen for the session (-1 when none) — the live slice. */
  maxGen(sessionId: string): number {
    this.flush();
    const r = this.sMaxGen.get(sessionId) as { g: number } | undefined;
    return r?.g ?? -1;
  }

  maxTs(sessionId: string): number | null {
    this.flush();
    const r = this.sMaxTs.get(sessionId) as { t: number | null } | undefined;
    return r?.t ?? null;
  }

  /** Sum of ORIGINAL serialized event sizes — the true history weight,
   * unaffected by blob dedup. */
  totalBytes(sessionId: string): number {
    this.flush();
    const r = this.sSumBytes.get(sessionId) as { b: number } | undefined;
    return r?.b ?? 0;
  }

  deleteSession(sessionId: string) {
    this.flush();
    this.sDel.run(sessionId);
  }

  /** Drop one generation — failed-replay rollback: the previous gen's rows
   * immediately become visible again under the max-gen filter. */
  deleteGen(sessionId: string, gen: number) {
    this.flush();
    this.sDelGen.run(sessionId, gen);
  }

  /** Successful replay commits — drop every older generation's rows. */
  deleteOlderGens(sessionId: string, gen: number) {
    this.flush();
    this.sDelOlder.run(sessionId, gen);
  }

  /** Subagent-relevant rows of one generation in seq order — the DB-side
   * sidecar scan source (replaces byte-range file scans). */
  *scanRows(sessionId: string, gen: number, fromSeq: number, toSeq: number) {
    this.flush();
    let after = fromSeq - 1;
    for (;;) {
      const rows = this.sScanPage.all(sessionId, gen, after, toSeq, 500) as { seq: number; ts: number; data: string }[];
      if (!rows.length) return;
      for (const r of rows) { after = r.seq; yield r; }
    }
  }

  /** Newest user/agent message assembled from the chunk tail — cheap enough
   *  for list views (one bounded DESC query, no ring hydration). */
  lastMessage(sessionId: string): { body: string; ts: number } | null {
    this.flush();
    const rows = this.sLastMsg.all(sessionId, 600) as { ts: number; data: string }[];
    const updates: { ts: number; update: Record<string, unknown> }[] = [];
    for (const r of rows) {
      try { updates.push({ ts: r.ts, update: JSON.parse(r.data) }); } catch { /* corrupt row */ }
    }
    return lastMessageFrom(updates);
  }

  /** Deep-copy `update` with every {$blob} ref swapped for its payload. */
  resolveBlobs(update: Record<string, unknown>): Record<string, unknown> {
    const visit = (v: unknown): unknown => {
      if (isBlobRef(v)) {
        const r = this.sBlob.get(v.$blob) as { data: string } | undefined;
        return r?.data ?? "";
      }
      if (Array.isArray(v)) return v.map(visit);
      if (typeof v === "object" && v !== null) {
        const o: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v)) o[k] = visit(val);
        return o;
      }
      return v;
    };
    return visit(update) as Record<string, unknown>;
  }

  /** Bulk-import JSONL lines (LogEntry-shaped) for one session — becomes the
   * new top generation (prior rows, if any, stay hidden under older gens).
   * `eachLine(cb)` supplies the streaming line reader so a near-GB file
   * never materializes as one string. Returns the gen written. */
  importLines(sessionId: string, eachLine: (cb: (line: string) => void) => void): number {
    this.flush(); // own BEGIN below must not nest inside the write batch
    const gen = this.maxGen(sessionId) + 1;
    let n = 0;
    this.db.exec("BEGIN");
    try {
      eachLine((line) => {
        let e: { ts?: number; seq?: number; update?: Record<string, unknown> };
        try { e = JSON.parse(line); } catch { return; }
        const t = this.transform(e.update ?? {});
        this.sInsEvent.run(
          sessionId,
          typeof e.seq === "number" ? e.seq : n,
          gen,
          typeof e.ts === "number" ? e.ts : Date.now(),
          String(e.update?.sessionUpdate ?? ""),
          t.bytes,
          JSON.stringify(t.update),
          // Mirror lines may carry {$blob} refs — resolve before hashing so
          // the key matches the original-content form a replay produces.
          dedupKey(this.resolveBlobs(e.update ?? {})),
        );
        if (++n % IMPORT_BATCH === 0) { this.db.exec("COMMIT"); this.db.exec("BEGIN"); }
      });
      this.db.exec("COMMIT");
    } catch (err) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw err;
    }
    return gen;
  }

  /** Aggregate counters for the /api/admin/modules health surface — three
   * indexed COUNTs, cheap on a multi-GB db. */
  stats(): { sessions: number; events: number; blobs: number; storedBytes: number } {
    this.flush();
    const g = (sql: string, col: string) =>
      Number((this.db.prepare(sql).get() as Record<string, unknown> | undefined)?.[col] ?? 0);
    return {
      sessions: g("SELECT COUNT(DISTINCT session_id) AS n FROM events", "n"),
      events: g("SELECT COUNT(*) AS n FROM events", "n"),
      blobs: g("SELECT COUNT(*) AS n FROM blobs", "n"),
      storedBytes: g("SELECT COALESCE(SUM(bytes),0) AS b FROM events", "b"),
    };
  }

  close() {
    this.flush();
    try { this.db.close(); } catch {}
  }
}

/** Assemble the newest user/agent message from a DESC-ordered tail of
 *  entries (newest first). Chunks sharing one streamingMessageId glue back
 *  together; a whole non-chunk message only wins when no chunks precede it. */
export function lastMessageFrom(entries: { ts: number; update: Record<string, unknown> }[]): { body: string; ts: number } | null {
  let mid: string | null = null;
  let firstTs = 0;
  const parts: string[] = [];
  for (const e of entries) {
    const u = e.update;
    const k = u.sessionUpdate as string | undefined;
    if (!k || (!k.endsWith("_chunk") && k !== "agent_message" && k !== "user_message" && k !== "message")) continue;
    const m = ((u._meta as Record<string, unknown> | undefined)?.["cognition.ai/streamingMessageId"] as string) ?? null;
    if (k.endsWith("_chunk")) {
      if (mid === null && !parts.length) { mid = m; firstTs = e.ts; }
      else if (m !== mid) break; // crossed into the previous message — done
      const t = (u.content as Record<string, unknown> | undefined)?.text;
      parts.unshift(typeof t === "string" ? t : "");
    } else {
      if (parts.length) break; // chunks of a newer message win
      const c = u.content as Record<string, unknown> | undefined;
      const t = c?.text ?? u.text ?? u.body;
      if (typeof t === "string" && t) return { body: t, ts: e.ts };
    }
  }
  return parts.length ? { body: parts.join(""), ts: firstTs } : null;
}
