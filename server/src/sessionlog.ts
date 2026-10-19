import fs from "node:fs";
import path from "node:path";

const MAX_UPDATES_PER_SESSION = 5000;
const MAX_SESSIONS = 200;

interface LogEntry {
  ts: number;
  /** Per-session monotonic sequence — survives ring eviction and gives
   * timeline items stable `e<seq>` ids across rebuilds and disk backfills. */
  seq?: number;
  update: Record<string, unknown>;
}

/** In-memory ring buffer of session updates, write-through to a per-session
 * JSONL disk log (`<dir>/<id>.jsonl`). Memory bounds live-streaming cost; the
 * disk log keeps the COMPLETE history and is the backfill source for timeline
 * pages older than the memory window. */
export class SessionLog {
  private logs = new Map<string, LogEntry[]>();
  private seqs = new Map<string, number>();
  private gens = new Map<string, number>();
  private fds = new Map<string, number>();
  private dirReady = false;

  /** @param dir disk-log directory; null disables persistence (tests). */
  constructor(private dir: string | null = null) {
    // A server killed mid-replay leaves `<id>.jsonl` partial and the last
    // complete copy stashed as `.jsonl.bak` — put it back on startup.
    // (Longer file wins: a replay that out-wrote the old log keeps its file.)
    if (!dir) return;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".jsonl.bak")) continue;
        const bak = path.join(dir, f);
        const orig = path.join(dir, f.slice(0, -4));
        const origSize = (() => { try { return fs.statSync(orig).size; } catch { return -1; } })();
        const bakSize = (() => { try { return fs.statSync(bak).size; } catch { return -1; } })();
        try {
          if (bakSize > origSize) { fs.rmSync(orig, { force: true }); fs.renameSync(bak, orig); }
          else fs.rmSync(bak, { force: true });
        } catch { /* leave it — next clear() cleans up */ }
      }
    } catch { /* dir unreadable */ }
  }

  private file(sessionId: string) {
    return path.join(this.dir!, `${encodeURIComponent(sessionId)}.jsonl`);
  }

  /** The seq counter lives in memory but the file survives restarts — resume
   * past whatever is already on disk before assigning the next seq, or new
   * entries would reuse seqs already present in the file. */
  private resumeSeq(sessionId: string) {
    if (!this.dir || this.seqs.get(sessionId) != null) return;
    let seq = 0;
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
      const fd = fs.openSync(this.file(sessionId), "a");
      this.fds.set(sessionId, fd);
      return fd;
    } catch { return null; }
  }

  append(sessionId: string, update: Record<string, unknown>) {
    let log = this.logs.get(sessionId);
    if (!log) {
      if (this.logs.size >= MAX_SESSIONS) {
        const oldest = this.logs.keys().next().value!;
        this.logs.delete(oldest);
      }
      log = [];
      this.logs.set(sessionId, log);
    }
    this.resumeSeq(sessionId);
    const seq = this.seqs.get(sessionId) ?? 0;
    this.seqs.set(sessionId, seq + 1);
    const entry: LogEntry = { ts: Date.now(), seq, update };
    log.push(entry);
    if (log.length > MAX_UPDATES_PER_SESSION) {
      log.splice(0, log.length - MAX_UPDATES_PER_SESSION);
    }
    const fd = this.writer(sessionId);
    if (fd != null) {
      try { fs.writeSync(fd, JSON.stringify(entry) + "\n"); } catch { /* disk is best-effort */ }
    }
  }

  get(sessionId: string): LogEntry[] {
    return this.logs.get(sessionId) ?? [];
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
    const out: LogEntry[] = [];
    this.eachDiskLine(sessionId, (line) => {
      try { out.push(JSON.parse(line) as LogEntry); } catch { /* torn line */ }
    });
    return out;
  }

  /** mtime of the on-disk log — a cheap change signal for disk-fallback
   * readers (subagent listing for never-loaded sessions). */
  diskMtime(sessionId: string): number | null {
    if (!this.dir) return null;
    try { return fs.statSync(this.file(sessionId)).mtimeMs; } catch { return null; }
  }

  // ---- subagent sidecar index ------------------------------------------------
  // A 2GB log must never be fully re-parsed just to find the few lines that
  // mention subagents. The sidecar `<id>.jsonl.subidx` holds ONLY matching
  // raw lines + a `{"#off":N}` first line = bytes of the main file scanned so
  // far. Append-only ⇒ scans resume at the offset. Everything stays
  // event-loop-friendly: small files (<32MB) scan inline once, big files scan
  // in the background and consumers see results on the next poll.
  private subIdxBusy = new Set<string>();

  private subIndexFile(sessionId: string) {
    return this.file(sessionId) + ".subidx";
  }

  /** Parsed subagent-related entries from the sidecar, or null when no index
   * exists yet (caller should `ensureSubIndex` and treat as empty for now).
   * Streamed line-by-line — a subagent-heavy session's index can itself be
   * hundreds of MB, past the readFileSync string ceiling. */
  readSubIndex(sessionId: string): LogEntry[] | null {
    if (!this.dir) return null;
    try { fs.statSync(this.subIndexFile(sessionId)); } catch { return null; }
    const out: LogEntry[] = [];
    this.eachFileLine(this.subIndexFile(sessionId), (line) => {
      if (!line || line.startsWith('{"#off"')) return;
      try { out.push(JSON.parse(line) as LogEntry); } catch { /* torn */ }
    });
    return out;
  }

  /** Sidecar file mtime — freshness key for consumers caching parsed rows. */
  subIndexMtime(sessionId: string): number | null {
    if (!this.dir) return null;
    try { return fs.statSync(this.subIndexFile(sessionId)).mtimeMs; } catch { return null; }
  }

  /** Is the sidecar behind the main log (new appends not yet indexed)? */
  subIndexStale(sessionId: string): boolean {
    if (!this.dir) return false;
    try {
      // Read only the header line — the index body can be hundreds of MB.
      const fd = fs.openSync(this.subIndexFile(sessionId), "r");
      let head = "";
      try {
        const b = Buffer.alloc(256);
        const n = fs.readSync(fd, b, 0, 256, 0);
        head = b.subarray(0, n).toString("utf8").split("\n", 1)[0];
      } finally { fs.closeSync(fd); }
      const off = Number((JSON.parse(head || "{}") as Record<string, unknown>)["#off"]);
      if (!off) return true;
      return fs.statSync(this.file(sessionId)).size > off;
    } catch { return true; }
  }

  /** Scan the main log for subagent-bearing lines, writing/updating the
   * sidecar. Inline when the file is small, background-chunked otherwise —
   * never blocks the loop on a multi-GB log. */
  ensureSubIndex(sessionId: string): void {
    if (!this.dir || this.subIdxBusy.has(sessionId)) return;
    let size: number;
    try { size = fs.statSync(this.file(sessionId)).size; } catch { return; }
    let off = 0;
    try {
      const first = fs.readFileSync(this.subIndexFile(sessionId), "utf8").split("\n", 1)[0];
      off = Number(JSON.parse(first || "{}")["#off"]) || 0;
    } catch { /* no index yet */ }
    if (off > size) off = 0; // file shrank (clear/restore) — rebuild
    if (off === size) return; // already fresh
    const SMALL = 32 << 20;
    if (!off && size <= SMALL) {
      // One inline pass — a few MB is milliseconds.
      try {
        const lines: string[] = [`{"#off":${size}}`];
        this.eachDiskLine(sessionId, (l) => { if (l.includes("subagent")) lines.push(l); });
        fs.writeFileSync(this.subIndexFile(sessionId) + ".tmp", lines.join("\n") + "\n");
        fs.renameSync(this.subIndexFile(sessionId) + ".tmp", this.subIndexFile(sessionId));
      } catch { /* leave it */ }
      return;
    }
    // Large file → async chunked scan (temp + atomic swap). Matching lines
    // are streamed out as they are found — accumulating them in memory would
    // blow past the string-length limit on subagent-heavy logs.
    this.subIdxBusy.add(sessionId);
    void (async () => {
      const fsp = fs.promises;
      const CHUNK = 16 << 20;
      const idx = this.subIndexFile(sessionId);
      const tmp = idx + ".tmp";
      let fd: fs.promises.FileHandle | null = null;
      let outFd: number | null = null;
      try {
        fd = await fsp.open(this.file(sessionId), "r");
        outFd = fs.openSync(tmp, "w");
        if (off) {
          // Resume: carry over the existing index body (skip its #off
          // header), then land on the next '\n' in the main file. Streamed —
          // the body can be hundreds of MB on subagent-heavy logs.
          this.eachFileLine(idx, (l) => {
            if (!l.startsWith('{"#off"')) fs.writeSync(outFd!, l + "\n");
          });
          const probe = Buffer.alloc(4096);
          const { bytesRead } = await fd.read(probe, 0, 4096, off);
          const nl = probe.subarray(0, bytesRead).indexOf(0x0a);
          off = nl < 0 ? size : off + nl + 1;
          if (off > size) off = size;
        }
        const buf = Buffer.alloc(CHUNK);
        let carry = Buffer.alloc(0);
        let pos = off;
        while (pos < size) {
          const { bytesRead } = await fd.read(buf, 0, Math.min(CHUNK, size - pos), pos);
          if (bytesRead <= 0) break;
          pos += bytesRead;
          const piece = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
          const lastNl = piece.lastIndexOf(0x0a);
          carry = lastNl < 0 ? Buffer.from(piece) : Buffer.from(piece.subarray(lastNl + 1));
          const region = lastNl > 0 ? piece.subarray(0, lastNl) : Buffer.alloc(0);
          if (region.length) {
            for (const line of region.toString("utf8").split("\n")) {
              if (line && line.includes("subagent")) fs.writeSync(outFd, line + "\n");
            }
          }
        }
        if (carry.length) {
          const tail = carry.toString("utf8");
          if (tail.includes("subagent")) fs.writeSync(outFd, tail + "\n");
        }
        fs.closeSync(outFd); outFd = null;
        // Prepend the fresh offset header via chunked copy — the body can be
        // hundreds of MB on subagent-heavy logs, so no readFileSync(tmp).
        const hdrFd = fs.openSync(tmp + ".h", "w");
        fs.writeSync(hdrFd, `{"#off":${size}}\n`);
        const tmpFd = fs.openSync(tmp, "r");
        try {
          const cbuf = Buffer.alloc(CHUNK);
          let cpos = 0;
          const csize = fs.fstatSync(tmpFd).size;
          while (cpos < csize) {
            const n = fs.readSync(tmpFd, cbuf, 0, Math.min(CHUNK, csize - cpos), cpos);
            if (n <= 0) break;
            fs.writeSync(hdrFd, cbuf.subarray(0, n));
            cpos += n;
          }
        } finally { try { fs.closeSync(tmpFd); } catch {} }
        fs.closeSync(hdrFd);
        fs.rmSync(tmp, { force: true });
        fs.renameSync(tmp + ".h", idx);
      } catch { /* retry next poll */ }
      finally {
        if (fd) { try { await fd.close(); } catch {} }
        if (outFd != null) { try { fs.closeSync(outFd); } catch {} }
        this.subIdxBusy.delete(sessionId);
      }
    })();
  }

  /** Streams the disk log line-by-line without materializing the file — a
   * 500MB log must never become a giant string[] or the heap dies. */
  private eachDiskLine(sessionId: string, cb: (line: string) => void) {
    if (!this.dir) return;
    this.eachFileLine(this.file(sessionId), cb);
  }

  private eachFileLine(filePath: string, cb: (line: string) => void) {
    const CHUNK = 16 << 20;
    let fd = -1;
    try {
      fd = fs.openSync(filePath, "r");
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(CHUNK);
      // Carry the tail line as BYTES — a UTF-8 char split across chunk reads
      // must not be decoded to U+FFFD before the next chunk arrives.
      let carry = Buffer.alloc(0);
      const eat = (raw: Buffer) => {
        for (const line of raw.toString("utf8").split("\n")) {
          if (line) cb(line);
        }
      };
      let pos = 0;
      while (pos < size) {
        const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
        if (n <= 0) break;
        pos += n;
        const piece = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
        const lastNl = piece.lastIndexOf(0x0a);
        carry = lastNl < 0 ? Buffer.from(piece) : Buffer.from(piece.subarray(lastNl + 1));
        if (lastNl > 0) eat(piece.subarray(0, lastNl));
      }
      if (carry.length) eat(carry);
    } catch { /* missing/unreadable */ }
    if (fd >= 0) { try { fs.closeSync(fd); } catch {} }
  }

  /** Drop a session's buffered updates — used before a session/load re-replay.
   * The disk file is stashed aside as `.bak` rather than deleted: a replay
   * that never delivers (session_locked, dead acp) must not destroy the only
   * complete copy — `restoreFile`/`restoreMemory` put it back, `dropBackup`
   * commits a successful replay. */
  clear(sessionId: string) {
    this.logs.delete(sessionId);
    this.seqs.delete(sessionId);
    this.gens.set(sessionId, (this.gens.get(sessionId) ?? 0) + 1);
    const fd = this.fds.get(sessionId);
    this.fds.delete(sessionId);
    if (fd != null) { try { fs.closeSync(fd); } catch {} }
    if (this.dir) {
      const f = this.file(sessionId), bak = f + ".bak";
      try { fs.rmSync(bak, { force: true }); } catch {}
      try { fs.renameSync(f, bak); } catch { /* no file / rename failed */ }
      // The subagent sidecar indexes the OLD generation — drop it.
      try { fs.rmSync(this.subIndexFile(sessionId), { force: true }); } catch {}
    }
  }

  /** Replay succeeded — the fresh log is authoritative; drop the stash. */
  dropBackup(sessionId: string) {
    if (!this.dir) return;
    try { fs.rmSync(this.file(sessionId) + ".bak", { force: true }); } catch {}
  }

  /** Replay failed — put the stashed disk log back (replacing whatever the
   * partial replay wrote). The write fd must be closed first: it still
   * points at the doomed file and would silently swallow later appends. */
  restoreFile(sessionId: string) {
    const fd = this.fds.get(sessionId);
    this.fds.delete(sessionId);
    if (fd != null) { try { fs.closeSync(fd); } catch {} }
    if (!this.dir) return;
    const f = this.file(sessionId), bak = f + ".bak";
    try { fs.rmSync(f, { force: true }); } catch {}
    try { fs.renameSync(bak, f); } catch { /* nothing stashed */ }
    try { fs.rmSync(this.subIndexFile(sessionId), { force: true }); } catch {}
  }

  /** Re-install the pre-clear memory window after a failed replay. File
   * writes are NOT re-done — `restoreFile` already recovered the full log;
   * re-appending here would double it. */
  restoreMemory(sessionId: string, entries: LogEntry[]) {
    this.logs.set(sessionId, entries);
    const last = entries[entries.length - 1];
    this.seqs.set(sessionId, last?.seq != null ? last.seq + 1 : 0);
  }
}
