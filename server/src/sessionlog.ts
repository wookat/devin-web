import fs from "node:fs";
import path from "node:path";
import { SessionDb, dedupKey, lastMessageFrom } from "./sessiondb.js";
import { Sidecars, eachFileLine } from "./sessionsidecars.js";
import type { LogEntry } from "./sessiondb.js";
import { logMaxMb } from "./env.js";

export const MAX_UPDATES_PER_SESSION = 5000;
const MAX_SESSIONS = 200;
/** .jsonl mirror size cap — real sessions reach 500MB–3.7GB. Past the cap
 * append() rotates `<id>.jsonl` → `.jsonl.1` → `.jsonl.2` (two archives
 * kept) — but ONLY when the SQLite store is authoritative: readDisk then
 * serves history from the db and the file is a pure mirror. With no db the
 * file IS the store and never rotates. */
const LOG_MAX_BYTES = (() => {
  const mb = logMaxMb();
  return (Number.isFinite(mb) && mb > 0 ? mb : 128) * 1024 * 1024;
})();

/** In-memory ring buffer of session updates, write-through to a per-session
 * JSONL disk log (`<dir>/<id>.jsonl`). Memory bounds live-streaming cost; the
 * disk log keeps the COMPLETE history and is the backfill source for timeline
 * pages older than the memory window. The subagent sidecar projection lives
 * in `sidecars` (sessionsidecars.ts) — this class only feeds it host state
 * and the per-append coverage hook. */
export class SessionLog {
  private logs = new Map<string, LogEntry[]>();
  private seqs = new Map<string, number>();
  private gens = new Map<string, number>();
  private fds = new Map<string, number>();
  private dirReady = false;
  /** Ids already disk-probed by get()'s lazy hydrate this process — an
   * empty disk marks too, or every miss would rescan. Invalidated by
   * append()/restore* — anything that rewrites what a probe finds. */
  private hydrated = new Set<string>();
  /** Sessions inside a session/load replay stream — replayed copies of
   * stored rows are recognized by content key and skipped (append-only
   * replay: nothing is destroyed, a mid-replay kill leaves the transcript
   * intact and the next load simply re-dedups the same stream). */
  private dedupReplay = new Set<string>();
  /** Tail-arm timers for dedupReplay — kept armed a few seconds after the
   * load resolves so stream-lag echoes of stored rows still dedupe. */
  private dedupUnarm = new Map<string, ReturnType<typeof setTimeout>>();
  /** Content-key index for the no-db degraded path (process lifetime only —
   * the db path indexes keys on the rows themselves). */
  private dedupSeen = new Map<string, Set<string>>();
  /** SQLite event store — the authoritative query side (readDisk/diskSize/
   * seq-resume). The .jsonl stays as a write-through mirror: appends land in
   * both, .bak/restore keeps its file-level semantics, and a legacy file is
   * lazily imported on first touch. */
  private db: SessionDb | null = null;
  /** Subagent sidecar projection — consumers reach it directly
   *  (ctx.sessionLog.sidecars.*), not through this class. */
  readonly sidecars: Sidecars;

  /** @param dir disk-log directory; null disables persistence (tests). */
  constructor(private dir: string | null = null) {
    if (dir) {
      try { this.db = new SessionDb(path.join(path.dirname(dir), "sessionlog.db")); }
      catch { this.db = null; }
    }
    this.sidecars = new Sidecars({
      dir,
      db: this.db,
      file: (id) => this.file(id),
      gen: (id) => this.gens.get(id) ?? 0,
      bumpGen: (id) => { this.dropSessionFolds(id); this.gens.set(id, (this.gens.get(id) ?? 0) + 1); },
    });
    // A server killed mid-replay leaves `<id>.jsonl` partial and the last
    // complete copy stashed as `.jsonl.bak` — put it back on startup.
    // (Longer file wins: a replay that out-wrote the old log keeps its file.)
    if (!dir) return;
    try {
      for (const f of fs.readdirSync(dir)) {
        // Legacy `.subidx` sidecars are superseded by the `.sub.*`/`.subs.jsonl`
        // split — reclaim them (they run to hundreds of MB on heavy logs).
        if (f.endsWith(".jsonl.subidx")) { try { fs.rmSync(path.join(dir, f), { force: true }); } catch {} }
        if (!f.endsWith(".jsonl.bak")) continue;
        const bak = path.join(dir, f);
        const orig = path.join(dir, f.slice(0, -4));
        const origSize = (() => { try { return fs.statSync(orig).size; } catch { return -1; } })();
        const bakSize = (() => { try { return fs.statSync(bak).size; } catch { return -1; } })();
        try {
          if (bakSize > origSize) {
            fs.rmSync(orig, { force: true });
            fs.renameSync(bak, orig);
            // The DB may hold partial replay rows for this session — drop
            // them so readDisk lazily re-imports the restored file.
            try { this.db?.deleteSession(decodeURIComponent(f.slice(0, -10))); } catch {}
          } else fs.rmSync(bak, { force: true });
        } catch { /* leave it — next clear() cleans up */ }
      }
    } catch { /* dir unreadable */ }
  }

  /** SQLite store health for /api/admin/modules — null when the db failed to
   *  open at boot (file-mirror-only degraded mode). */
  dbStats(): { sessions: number; events: number; blobs: number; storedBytes: number; fileBytes: number } | null {
    if (!this.db || !this.dir) return null;
    const s = this.db.stats();
    const f = path.join(path.dirname(this.dir), "sessionlog.db");
    let fileBytes = 0;
    try { fileBytes = fs.statSync(f).size; } catch {}
    return { ...s, fileBytes };
  }

  private file(sessionId: string) {
    return path.join(this.dir!, `${encodeURIComponent(sessionId)}.jsonl`);
  }

  /** One-time migration: stream a legacy .jsonl into the event store as its
   * newest generation. Runs only while the DB has no rows — on success the
   * file is DELETED (the DB now holds the history; gen-isolated replay no
   * longer needs it as a restore source) and sidecar coverage resets so the
   * next demand rebuilds sidecars from a DB scan. New appends re-create a
   * fresh mirror containing only post-migration lines. */
  private importLegacy(sessionId: string) {
    if (!this.db || this.db.has(sessionId)) return;
    const f = this.file(sessionId);
    let imported = false;
    try {
      if (!fs.existsSync(f)) return;
      const g = this.db.importLines(sessionId, (cb) => eachFileLine(f, cb));
      this.gens.set(sessionId, g);
      imported = true;
    } catch {
      // A mid-import failure leaves earlier batches committed — drop the
      // partial rows so the next touch retries from the file.
      try { this.db.deleteSession(sessionId); } catch {}
    }
    if (!imported) return;
    try {
      const fd = this.fds.get(sessionId);
      this.fds.delete(sessionId);
      if (fd != null) { try { fs.closeSync(fd); } catch {} }
      fs.rmSync(f, { force: true });
      this.sidecars.invalidateCoverage(sessionId);
    } catch { /* file lingers — still a valid mirror */ }
  }

  /** Public wrapper for the boot-time bulk migration sweep. */
  ensureImported(sessionId: string) {
    this.importLegacy(sessionId);
  }

  /** Swap {$blob} refs in a stored update for their payloads. Only needed
   * where full-fidelity content is consumed (export, read/terminal text). */
  resolveBlobs(update: Record<string, unknown>): Record<string, unknown> {
    return this.db?.resolveBlobs(update) ?? update;
  }

  /** The seq counter lives in memory but the file survives restarts — resume
   * past whatever is already on disk before assigning the next seq, or new
   * entries would reuse seqs already present in the file. */
  private resumeSeq(sessionId: string) {
    if (!this.dir || this.seqs.get(sessionId) != null) return;
    let seq = 0;
    if (this.db) {
      // Import BEFORE assigning seqs — an append that lands first would make
      // has() true and skip the migration forever.
      this.importLegacy(sessionId);
      // The DB's stored gen persists across restarts while `gens` is
      // in-memory — seed it so post-restart replays bump past stored rows.
      if (this.gens.get(sessionId) == null) {
        const g = this.db.maxGen(sessionId);
        this.gens.set(sessionId, g < 0 ? 0 : g);
      }
      seq = this.db.maxSeq(sessionId) + 1;
    }
    if (seq) { this.seqs.set(sessionId, seq); return; }
    try {
      const f = this.file(sessionId);
      const size = fs.statSync(f).size;
      if (size) {
        const buf = Buffer.alloc(Math.min(size, 1 << 20));
        const fd = fs.openSync(f, "r");
        try { fs.readSync(fd, buf, 0, buf.length, size - buf.length); } finally { fs.closeSync(fd); }
        const lines = buf.toString("utf8").split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
          if (!lines[i]) continue;
          try {
            const s = (JSON.parse(lines[i]) as LogEntry).seq;
            if (typeof s === "number") { seq = s + 1; break; }
          } catch { /* torn/partial line — scan further back */ }
        }
        // A single line bigger than the tail window has no readable seq —
        // jump past the file's byte size instead. Byte size > line count
        // always, so new seqs can never collide with existing ones, and the
        // jump reads as a real hole → one recovery rebuild from disk.
        if (!seq) seq = size;
      }
    } catch { /* no file / unreadable → fresh */ }
    this.seqs.set(sessionId, seq);
  }

  private writer(sessionId: string): number | null {
    if (!this.dir) return null;
    const cur = this.fds.get(sessionId);
    if (cur != null) return cur;
    try {
      if (!this.dirReady) { fs.mkdirSync(this.dir, { recursive: true }); this.dirReady = true; }
      const f = this.file(sessionId);
      // 'a+': the torn-tail check below needs readSync — a plain 'a' fd is
      // write-only and readSync throws EBADF on this Node.
      const fd = fs.openSync(f, "a+");
      // Torn-tail repair: a killed writer can leave a partial last line —
      // appending behind it would glue fresh JSON onto the fragment and
      // corrupt both lines. Truncate back to the last complete line. (One
      // tail read per fd open, so the hot path stays free.)
      try {
        const size = fs.fstatSync(fd).size;
        if (size) {
          const tail = Buffer.alloc(Math.min(size, 8192));
          const n = fs.readSync(fd, tail, 0, tail.length, size - tail.length);
          const nl = tail.subarray(0, n).lastIndexOf(0x0a);
          if (nl !== n - 1) {
            // ftruncateSync on an append-mode fd is EPERM on Windows —
            // truncate via path instead. The 'a+' fd keeps appending at
            // the (new, shorter) EOF.
            fs.truncateSync(f, nl < 0 ? size - n : size - n + nl + 1);
            // The file just shrank — cached end/coverage and the persisted
            // marker can now point past EOF (a covered claim over bytes that
            // no longer exist defers sidecar routing forever). Drop them and
            // let ensureSubFiles rebuild lazily.
            this.sidecars.invalidateCoverage(sessionId);
          }
        }
      } catch { /* readers skip torn lines anyway — best effort */ }
      this.fds.set(sessionId, fd);
      return fd;
    } catch { return null; }
  }

  /** Rotate `<id>.jsonl` → `.jsonl.1` (shifting `.1` → `.2`, oldest dropped).
   * The append fd must close first — Windows can't rename an open file —
   * then writer() lazily reopens the fresh, empty file. Only runs when the
   * db is authoritative (callers gate on `this.db`): sidecars are untouched
   * because their coverage is seq-based on the db path — the .sub.* files
   * index event rows, not file bytes. (fileEnd/endOf bookkeeping can drift
   * stale across a rotation, but nothing on the db path consumes it.) */
  private rotateMirror(sessionId: string, fd: number): number | null {
    this.fds.delete(sessionId);
    try { fs.closeSync(fd); } catch {}
    const f = this.file(sessionId);
    try { fs.rmSync(f + ".2", { force: true }); } catch {}
    try { fs.renameSync(f + ".1", f + ".2"); } catch { /* no .1 yet */ }
    try { fs.renameSync(f, f + ".1"); } catch { /* file raced away */ }
    return this.writer(sessionId);
  }

  /** Returns false when the update was a replayed dupe — callers skip all
   * downstream fan-out (broadcast/rate-limit/noteUpdate) for it. */
  /** Streaming text chunks fold into ONE stored row per stream — the wire
   *  emits ~600 rows per agent reply, which dominated the db (83% of all
   *  rows are streaming fragments), the dedup-hash rate, ring coverage,
   *  and the native-alloc churn that ballooned RSS. Folding keeps the
   *  chunk kind + streamingMessageId so every read path (timeline,
   *  snippets, lastMessage, replays' content dedup — joined text is the
   *  same payload) works unchanged; only the row count drops. */
  private static readonly FOLD_KINDS = new Set(["agent_message_chunk", "user_message_chunk", "agent_thought_chunk"]);
  private static readonly FOLD_MS = 250;
  private folds = new Map<string, { sid: string; base: Record<string, unknown>; texts: string[]; timer: NodeJS.Timeout }>();

  append(sessionId: string, update: Record<string, unknown>): boolean {
    const kind = String(update.sessionUpdate ?? "");
    if (SessionLog.FOLD_KINDS.has(kind) && update._local == null) {
      const streamId = String((update._meta as Record<string, unknown> | undefined)?.["cognition.ai/streamingMessageId"] ?? kind);
      const fk = `${sessionId}|${kind}|${streamId}`;
      const text = String((update.content as Record<string, unknown> | undefined)?.text ?? "");
      const f = this.folds.get(fk);
      if (f) { f.texts.push(text); return true; }
      this.flushSessionFolds(sessionId);
      const timer = setTimeout(() => this.flushFold(fk), SessionLog.FOLD_MS);
      timer.unref();
      this.folds.set(fk, { sid: sessionId, base: { ...update }, texts: [text], timer });
      return true;
    }
    this.flushSessionFolds(sessionId);
    return this.appendRaw(sessionId, update);
  }

  private flushFold(fk: string) {
    const f = this.folds.get(fk);
    if (!f) return;
    this.folds.delete(fk);
    clearTimeout(f.timer);
    const merged = { ...f.base, content: { ...(f.base.content as Record<string, unknown> | undefined), text: f.texts.join("") } };
    // Dedup key = the FIRST chunk's key, not the joined text: pre-fold rows
    // stored per-chunk keys so a replayed fold hits on chunk 1 and skips the
    // whole message (one query instead of ~600), while folded rows replaying
    // produce the same key symmetrically.
    this.appendRaw(f.sid, merged, dedupKey(f.base));
  }

  private flushSessionFolds(sessionId: string) {
    for (const fk of [...this.folds.keys()]) if (fk.startsWith(sessionId + "|")) this.flushFold(fk);
  }

  private dropSessionFolds(sessionId: string) {
    for (const [fk, f] of this.folds) if (fk.startsWith(sessionId + "|")) { clearTimeout(f.timer); this.folds.delete(fk); }
  }

  private appendRaw(sessionId: string, update: Record<string, unknown>, dedupOverride?: string): boolean {
    // Any append makes a previous "empty disk" hydrate verdict stale.
    this.hydrated.delete(sessionId);
    const key = dedupOverride ?? dedupKey(update);
    // Replay-scoped dedup: while a session/load stream is arriving, an
    // update whose content key already sits in the store is a replayed
    // copy — skipped (and a stored `_local` optimistic row graduates to
    // its authoritative twin). `_local` sends themselves never dedup —
    // two identical optimistic texts are legitimately distinct sends.
    if (this.dedupReplay.has(sessionId) && update._local == null && this.dedupHit(sessionId, key, update)) return false;
    this.dedupSeen.get(sessionId)?.add(key);
    let log = this.logs.get(sessionId);
    if (!log) {
      if (this.logs.size >= MAX_SESSIONS) {
        const oldest = this.logs.keys().next().value!;
        this.logs.delete(oldest);
        this.hydrated.delete(oldest); // evicted rings must re-probe disk
      }
      log = [];
      this.logs.set(sessionId, log);
    }
    this.resumeSeq(sessionId);
    const seq = this.seqs.get(sessionId) ?? 0;
    this.seqs.set(sessionId, seq + 1);
    // Replayed history carries its original event time in _meta — prefer it so
    // a re-replay preserves true timestamps instead of stamping "now" (a bare
    // Date.now() collapsed every replayed entry onto its replay moment).
    const metaTs = (update._meta as Record<string, unknown> | undefined)?.["cognition.ai/timestamp"];
    const entryTs = typeof metaTs === "string" ? Date.parse(metaTs) : NaN;
    const entry: LogEntry = { ts: Number.isFinite(entryTs) ? entryTs : Date.now(), seq, update };
    log.push(entry);
    if (log.length > MAX_UPDATES_PER_SESSION) {
      log.splice(0, log.length - MAX_UPDATES_PER_SESSION);
    }
    if (this.dir) {
      // The disk/db copy may differ from the live entry: big payloads are
      // swapped for blob refs so the ref-log stays small and dedups by sha.
      let storedUpdate = update;
      if (this.db) {
        try {
          // First-db-write for a legacy session must import before it lands —
          // a lone insert would make has() true and orphan the file history.
          this.importLegacy(sessionId);
          storedUpdate = this.db.append(sessionId, seq, this.gens.get(sessionId) ?? 0, entry.ts, update, key);
        } catch { /* db is best-effort — the .jsonl mirror still records it */ }
      }
      const line = JSON.stringify({ ts: entry.ts, seq, update: storedUpdate }) + "\n";
      let fd = this.writer(sessionId);
      // Rotate an over-cap mirror BEFORE this line lands — the fresh file
      // keeps only post-rotation entries; archives are cold backups that
      // readDisk never touches (the db holds the complete history).
      if (fd != null && this.db) {
        try { if (fs.fstatSync(fd).size > LOG_MAX_BYTES) fd = this.rotateMirror(sessionId, fd); }
        catch { /* size probe failed — write through anyway */ }
      }
      // Captured BEFORE the write — noteAppended's coverage check must see
      // the end without this line already counted.
      const before = this.sidecars.endOf(sessionId);
      if (fd != null) {
        try {
          fs.writeSync(fd, line);
          // Turn boundaries are the durable commit points — fsync only
          // there (per-append fsync would tax the event loop for nothing:
          // intra-turn loss is bounded by OS cache, and recovery treats an
          // unfinished turn the same either way).
          if (update.sessionUpdate === "dw_turn_end" || update.sessionUpdate === "dw_notice") fs.fsyncSync(fd);
        } catch { /* disk is best-effort */ }
      }
      this.sidecars.noteAppended(sessionId, update, line, seq, before, fd != null);
    }
    return true;
  }

  /** Replay-window dedup probe: true when `key` matches a stored row —
   *  the incoming update is a replayed copy and must not append. A stored
   *  `_local` optimistic row hit by its authoritative twin graduates in
   *  place (same seq, real payload) rather than producing a duplicate. */
  private dedupHit(sessionId: string, key: string, update: Record<string, unknown>): boolean {
    if (this.db) {
      const hit = this.db.dedupGet(sessionId, key);
      if (!hit) return false;
      if (hit.local) {
        try { this.db.updateStored(sessionId, hit.gen, hit.seq, hit.ts, update); } catch {}
        const e = this.logs.get(sessionId)?.find((x) => x.seq === hit.seq);
        if (e) e.update = update;
      }
      return true;
    }
    return this.dedupSeen.get(sessionId)?.has(key) ?? false;
  }

  /** Arm replay dedup for a session/load stream and lazily backfill content
   *  keys for rows stored before the dedup column existed — chunked so a
   *  near-million-row history never blocks the event loop. Replays stream
   *  oldest→newest while the fill walks seq-ascending, so the fill stays
   *  ahead of the wire; a straggler at worst leaves one benign duplicate. */
  beginDedupReplay(sessionId: string) {
    const prev = this.dedupUnarm.get(sessionId);
    if (prev) { clearTimeout(prev); this.dedupUnarm.delete(sessionId); }
    this.dedupReplay.add(sessionId);
    if (this.db) {
      const it = this.db.dedupRows(sessionId);
      const step = () => {
        try {
          for (let n = 0; n < 2000; n++) {
            const r = it.next();
            if (r.done) return;
            let key: string;
            try { key = dedupKey(this.db!.resolveBlobs(JSON.parse(r.value.data))); }
            catch { continue; }
            try { this.db!.dedupSet(sessionId, r.value.gen, r.value.seq, key); } catch {}
          }
          setImmediate(step);
        } catch { /* backfill is best-effort — a missed key only risks a dupe */ }
      };
      setImmediate(step);
    } else if (this.dir) {
      const set = this.dedupSeen.get(sessionId) ?? new Set<string>();
      this.dedupSeen.set(sessionId, set);
      const it = this.diskEntries(sessionId);
      const step = () => {
        try {
          for (let n = 0; n < 8000; n++) {
            const r = it.next();
            if (r.done) return;
            set.add(dedupKey(r.value.update));
          }
          setImmediate(step);
        } catch { /* best-effort */ }
      };
      setImmediate(step);
    }
  }

  /** Disarm replay dedup after the load resolves — held a few seconds so
   *  updates flushed behind the response still dedupe stored echoes. This is
   *  also the replay's commit point: older generations are superseded, and
   *  stale rows are worse than dead weight — dedupGet matches across gens,
   *  so an invisible old-gen row can swallow a needed re-append. */
  endDedupReplay(sessionId: string) {
    const prev = this.dedupUnarm.get(sessionId);
    if (prev) clearTimeout(prev);
    this.dedupUnarm.set(sessionId, setTimeout(() => {
      this.dedupReplay.delete(sessionId);
      this.dedupUnarm.delete(sessionId);
      if (this.db) {
        try { this.db.deleteOlderGens(sessionId, this.db.maxGen(sessionId)); } catch { /* best-effort */ }
      }
    }, 15000).unref());
  }

  get(sessionId: string): LogEntry[] {
    const cur = this.logs.get(sessionId);
    if (cur?.length) return cur;
    // Lazy hydrate: the ring dies with the process while disk (sqlite or
    // .jsonl) survives — refill once per id or every post-restart read path
    // (timeline/sidebar/share) stares at an empty transcript. Bounded to
    // the ring's tail cap; an empty disk marks too, so no rescan loop.
    if (this.hydrated.has(sessionId)) return cur ?? [];
    this.hydrated.add(sessionId);
    try {
      const disk = this.readDiskTail(sessionId, MAX_UPDATES_PER_SESSION);
      if (disk.length) {
        if (!this.logs.has(sessionId) && this.logs.size >= MAX_SESSIONS) {
          const oldest = this.logs.keys().next().value!;
          this.logs.delete(oldest);
        }
        const tail = disk.length > MAX_UPDATES_PER_SESSION ? disk.slice(-MAX_UPDATES_PER_SESSION) : disk;
        this.logs.set(sessionId, tail);
        return tail;
      }
    } catch { /* mirror unreadable — stay empty, mark stands */ }
    return cur ?? [];
  }

  /** Presence probe WITHOUT the lazy hydrate — boolean "has any history"
   *  checks (loaded_here badges, list views) must not pull a 5k-entry ring
   *  into memory per call. */
  has(sessionId: string): boolean {
    if ((this.logs.get(sessionId)?.length ?? 0) > 0) return true;
    if (this.db) { this.ensureImported(sessionId); return this.db.has(sessionId); }
    if (this.dir) { try { return fs.statSync(this.file(sessionId)).size > 0; } catch { return false; } }
    return false;
  }

  /** In-memory ring if (and only if) this session is already resident —
   *  list-view readers fall back to bounded disk tails instead of hydrating
   *  a 5k-entry ring per session per poll. */
  peek(sessionId: string): LogEntry[] | null {
    return this.logs.get(sessionId) ?? null;
  }

  /** Ring occupancy for the diagnose memory panel + the resources page's
   *  per-session footprint table (top rings first). */
  stats() {
    let entries = 0;
    const perSession: { id: string; entries: number }[] = [];
    for (const [id, l] of this.logs) {
      entries += l.length;
      if (l.length) perSession.push({ id, entries: l.length });
    }
    perSession.sort((a, b) => b.entries - a.entries);
    return { sessions: this.logs.size, entries, hydrated: this.hydrated.size, top: perSession.slice(0, 15) };
  }

  /** Full VACUUM passthrough — deliberate repair action (see SessionDb). */
  vacuum(): { beforeMb: number; afterMb: number } | null {
    return this.db ? this.db.vacuum() : null;
  }

  /** Newest user/agent message text for list views — the db path is one
   *  bounded DESC query; the .jsonl path scans a 600-entry tail. */
  lastMessage(sessionId: string): { body: string; ts: number } | null {
    if (this.db) { this.ensureImported(sessionId); return this.db.lastMessage(sessionId); }
    const tail = this.readDiskTail(sessionId, 600);
    return lastMessageFrom([...tail].reverse().map((e) => ({ ts: e.ts, update: e.update as Record<string, unknown> })));
  }

  /** Bumped on every clear() — timeline builders use it to spot a re-replayed
   * log (a rewound seq stream is otherwise indistinguishable from steady
   * state, where head ≤ seenSeq is normal). */
  gen(sessionId: string): number {
    return this.gens.get(sessionId) ?? 0;
  }

  /** Everything appended since the last clear — superset of `get()` and the
   * backfill source for history older than the memory window. Reads in 16MB
   * chunks: a whole-file readFileSync dies past the ~512MB string limit,
   * silently emptying the backfill for the largest sessions. */
  readDisk(sessionId: string): LogEntry[] {
    if (this.db) {
      this.importLegacy(sessionId);
      return this.db.readAll(sessionId);
    }
    const out: LogEntry[] = [];
    this.eachDiskLine(sessionId, (line) => {
      try { out.push(JSON.parse(line) as LogEntry); } catch { /* torn line */ }
    });
    return out;
  }

  /** Last `n` entries of the disk log — the bounded read hydration paths
   * use. A full readDisk on a near-million-entry session materializes every
   * row synchronously and freezes the event loop long enough for the
   * supervisor's health probe to kill the backend. */
  readDiskTail(sessionId: string, n: number = MAX_UPDATES_PER_SESSION): LogEntry[] {
    if (this.db) {
      this.importLegacy(sessionId);
      return this.db.readTail(sessionId, n);
    }
    if (!this.dir) return [];
    const f = this.file(sessionId);
    let size = 0;
    try { size = fs.statSync(f).size; } catch { return []; }
    if (!size) return [];
    // Doubling tail windows: the common case resolves in the first 16MB
    // read; sparse/giant-line files expand up to the whole file.
    const out: LogEntry[] = [];
    for (let window = Math.min(size, 16 << 20); ;) {
      const buf = Buffer.alloc(window);
      const fd = fs.openSync(f, "r");
      try { fs.readSync(fd, buf, 0, buf.length, size - buf.length); } finally { fs.closeSync(fd); }
      const lines = buf.toString("utf8").split("\n");
      out.length = 0;
      for (let i = window === size ? 0 : 1; i < lines.length; i++) {
        if (!lines[i]) continue;
        try { out.push(JSON.parse(lines[i]) as LogEntry); } catch { /* torn line */ }
      }
      if (out.length >= n || window === size) break;
      window = Math.min(size, window * 4);
    }
    return out.length > n ? out.slice(-n) : out;
  }

  /** Full-history generator — the deep-backfill path pulls entries in
   * batches and yields the event loop between them, so a near-million-entry
   * session can be rebuilt without freezing health probes. */
  *diskEntries(sessionId: string): Generator<LogEntry> {
    if (this.db) {
      this.importLegacy(sessionId);
      yield* this.db.each(sessionId);
      return;
    }
    if (!this.dir) return;
    const f = this.file(sessionId);
    let size = 0;
    try { size = fs.statSync(f).size; } catch { return; }
    let offset = 0, rest = "";
    const fd = fs.openSync(f, "r");
    try {
      const buf = Buffer.alloc(8 << 20);
      while (offset < size) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - offset), offset);
        if (n <= 0) break;
        offset += n;
        const lines = (rest + buf.subarray(0, n).toString("utf8")).split("\n");
        rest = offset < size ? lines.pop()! : "";
        for (const line of lines) {
          if (!line) continue;
          try { yield JSON.parse(line) as LogEntry; } catch { /* torn line */ }
        }
      }
      if (rest) { try { yield JSON.parse(rest) as LogEntry; } catch { /* torn tail */ } }
    } finally { fs.closeSync(fd); }
  }

  /** mtime of the on-disk log — a cheap change signal for disk-fallback
   * readers (subagent listing for never-loaded sessions). */
  diskMtime(sessionId: string): number | null {
    if (!this.dir) return null;
    if (this.db) {
      const t = this.db.maxTs(sessionId);
      if (t != null) return t;
    }
    try { return fs.statSync(this.file(sessionId)).mtimeMs; } catch { return null; }
  }

  /** Byte size of the on-disk log — 0 when absent. Lets callers skip
   * operations whose cost scales with history (boot auto-resume). */
  diskSize(sessionId: string): number {
    const b = this.db?.totalBytes(sessionId) ?? 0;
    if (b > 0) return b;
    if (!this.dir) return 0;
    try { return fs.statSync(this.file(sessionId)).size; } catch { return 0; }
  }

  /** Streams the disk log line-by-line without materializing the file — a
   * 500MB log must never become a giant string[] or the heap dies. */
  private eachDiskLine(sessionId: string, cb: (line: string) => void) {
    if (!this.dir) return;
    eachFileLine(this.file(sessionId), cb);
  }

  /** Seed the memory ring from already-stored entries — the disk→ring
   * hydrate path. File writes are NOT re-done: disk already holds them. */
  restoreMemory(sessionId: string, entries: LogEntry[]) {
    this.hydrated.delete(sessionId);
    this.logs.set(sessionId, entries);
    const last = entries[entries.length - 1];
    this.seqs.set(sessionId, last?.seq != null ? last.seq + 1 : 0);
  }
}
