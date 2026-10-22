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
  private sScan;
  private sBlob;

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
    this.sInsEvent = this.db.prepare(
      "INSERT OR REPLACE INTO events(session_id,seq,gen,ts,kind,bytes,data) VALUES (?,?,?,?,?,?,?)",
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
    this.sScan = this.db.prepare(
      "SELECT seq,ts,data FROM events WHERE session_id=? AND gen=? AND seq>=? AND seq<=? AND data LIKE '%subagent%' ORDER BY seq",
    );
    this.sBlob = this.db.prepare("SELECT data FROM blobs WHERE sha=?");
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
   * JSONL mirror persist the identical ref-log line. */
  append(sessionId: string, seq: number, gen: number, ts: number, update: Record<string, unknown>): Record<string, unknown> {
    const t = this.transform(update);
    this.sInsEvent.run(sessionId, seq, gen, ts, String(update.sessionUpdate ?? ""), t.bytes, JSON.stringify(t.update));
    return t.update;
  }

  readAll(sessionId: string): StoredEntry[] {
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
    for (const r of this.sAll.iterate(sessionId, sessionId) as Iterable<{ seq: number; ts: number; data: string }>) {
      try { yield { seq: r.seq, ts: r.ts, update: JSON.parse(r.data) }; } catch { /* corrupt row */ }
    }
  }

  has(sessionId: string): boolean {
    return this.sHas.get(sessionId) != null;
  }

  /** Max seq of the current gen — the resume point for seq assignment. */
  maxSeq(sessionId: string): number {
    const r = this.sMaxSeq.get(sessionId, sessionId) as { m: number | null } | undefined;
    return r?.m ?? -1;
  }

  maxSeqInGen(sessionId: string, gen: number): number {
    const r = this.sMaxSeqInGen.get(sessionId, gen) as { m: number | null } | undefined;
    return r?.m ?? -1;
  }

  /** Highest stored gen for the session (-1 when none) — the live slice. */
  maxGen(sessionId: string): number {
    const r = this.sMaxGen.get(sessionId) as { g: number } | undefined;
    return r?.g ?? -1;
  }

  maxTs(sessionId: string): number | null {
    const r = this.sMaxTs.get(sessionId) as { t: number | null } | undefined;
    return r?.t ?? null;
  }

  /** Sum of ORIGINAL serialized event sizes — the true history weight,
   * unaffected by blob dedup. */
  totalBytes(sessionId: string): number {
    const r = this.sSumBytes.get(sessionId) as { b: number } | undefined;
    return r?.b ?? 0;
  }

  deleteSession(sessionId: string) {
    this.sDel.run(sessionId);
  }

  /** Drop one generation — failed-replay rollback: the previous gen's rows
   * immediately become visible again under the max-gen filter. */
  deleteGen(sessionId: string, gen: number) {
    this.sDelGen.run(sessionId, gen);
  }

  /** Successful replay commits — drop every older generation's rows. */
  deleteOlderGens(sessionId: string, gen: number) {
    this.sDelOlder.run(sessionId, gen);
  }

  /** Subagent-relevant rows of one generation in seq order — the DB-side
   * sidecar scan source (replaces byte-range file scans). */
  *scanRows(sessionId: string, gen: number, fromSeq: number, toSeq: number) {
    for (const r of this.sScan.iterate(sessionId, gen, fromSeq, toSeq) as Iterable<{ seq: number; ts: number; data: string }>) {
      yield r;
    }
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
    try { this.db.close(); } catch {}
  }
}
