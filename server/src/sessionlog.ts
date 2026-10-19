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
        // Legacy `.subidx` sidecars are superseded by the `.sub.*`/`.subs.jsonl`
        // split — reclaim them (they run to hundreds of MB on heavy logs).
        if (f.endsWith(".jsonl.subidx")) { try { fs.rmSync(path.join(dir, f), { force: true }); } catch {} }
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
            // The file just shrank — any cached end/coverage is stale.
            this.fileEnd.delete(sessionId);
          }
        }
      } catch { /* readers skip torn lines anyway — best effort */ }
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
    if (this.dir) {
      const line = JSON.stringify(entry) + "\n";
      const fd = this.writer(sessionId);
      const before = this.endOf(sessionId);
      if (fd != null) {
        try {
          fs.writeSync(fd, line);
          // Turn boundaries are the durable commit points — fsync only
          // there (per-append fsync would tax the event loop for nothing:
          // intra-turn loss is bounded by OS cache, and recovery treats an
          // unfinished turn the same either way).
          if (update.sessionUpdate === "wb_turn_end" || update.sessionUpdate === "wb_notice") fs.fsyncSync(fd);
        } catch { /* disk is best-effort */ }
      }
      // Sidecar coverage invariant: the derived sidecars cover EXACTLY the
      // main file's prefix [0, coverOff). When cover == file end before this
      // append the line is ours to write; a cover that lags means an
      // unscanned gap exists (legacy file or scan in flight) and the line
      // belongs to the next scan's range — writing it here would double it.
      // Evaluated BEFORE fileEnd advances: coveredOff treats a 0-end file as
      // fresh, and fileEnd already including this line would fake a legacy gap.
      if (fd != null && this.coveredOff(sessionId) === before) {
        this.writeSidecars(sessionId, update, line);
        this.bumpCover(sessionId, before + Buffer.byteLength(line));
      }
      this.fileEnd.set(sessionId, before + Buffer.byteLength(line));
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

  /** Byte size of the on-disk log — 0 when absent. Lets callers skip
   * operations whose cost scales with history (boot auto-resume). */
  diskSize(sessionId: string): number {
    if (!this.dir) return 0;
    try { return fs.statSync(this.file(sessionId)).size; } catch { return 0; }
  }

  // ---- subagent sidecars -----------------------------------------------------
  // Derived projections, maintained alongside the authoritative append:
  //   <id>.sub.<aid>.jsonl — every event belonging to child agent <aid>'s
  //       stream (context tag, lifecycle meta, its root-call updates). A
  //       Claude-Code-style sidechain: the child timeline reads this small
  //       file and never re-scans the main log.
  //   <id>.subs.jsonl — spawn-call + lifecycle lines only (tiny): the sidebar
  //       listing builds its rows from this journal.
  //   <id>.subscan — {"off":N} marker: bytes of the main file whose sidecar
  //       coverage is guaranteed. Live appends advance it; ensureSubFiles
  //       scans whatever lies beyond (legacy logs bootstrap this way).
  private sideFds = new Map<string, number>();
  private coverOff = new Map<string, number>();
  private fileEnd = new Map<string, number>();
  private aidSets = new Map<string, Set<string>>();
  private subScanning = new Set<string>();

  private sideFile(sessionId: string, aid: string) {
    return this.file(sessionId) + ".sub." + aid + ".jsonl";
  }
  private subsJournalFile(sessionId: string) {
    return this.file(sessionId) + ".subs.jsonl";
  }
  private subScanFile(sessionId: string) {
    return this.file(sessionId) + ".subscan";
  }

  private knownAids(sessionId: string): Set<string> {
    let s = this.aidSets.get(sessionId);
    if (!s) { s = new Set(); this.aidSets.set(sessionId, s); }
    return s;
  }

  /** Bytes written to the main log so far, tracked in memory so appends
   * don't statSync per line. Initialised from the file's pre-existing size. */
  private endOf(sessionId: string): number {
    let end = this.fileEnd.get(sessionId);
    if (end == null) {
      try { end = fs.statSync(this.file(sessionId)).size; } catch { end = 0; }
      this.fileEnd.set(sessionId, end);
    }
    return end;
  }

  /** Main-log byte offset up to which sidecars are complete. -1 = a legacy
   * prefix exists that no scan has covered yet (marker absent + content). */
  private coveredOff(sessionId: string): number {
    let off = this.coverOff.get(sessionId);
    if (off == null) {
      off = -1;
      try {
        const fd = fs.openSync(this.subScanFile(sessionId), "r");
        try {
          const b = Buffer.alloc(128);
          const n = fs.readSync(fd, b, 0, 128, 0);
          const v = Number((JSON.parse(b.subarray(0, n).toString("utf8").split("\n", 1)[0] || "{}") as Record<string, unknown>).off);
          off = Number.isFinite(v) ? v : -1;
        } finally { fs.closeSync(fd); }
      } catch { /* no marker */ }
      if (off < 0 && !this.endOf(sessionId)) off = 0; // empty log: nothing to scan
      this.coverOff.set(sessionId, off);
    }
    return off;
  }

  private bumpCover(sessionId: string, off: number) {
    this.coverOff.set(sessionId, off);
    try { fs.writeFileSync(this.subScanFile(sessionId), `{"off":${off}}\n`); } catch { /* best-effort */ }
  }

  private sideWriter(file: string): number | null {
    const cur = this.sideFds.get(file);
    if (cur != null) return cur;
    try {
      const fd = fs.openSync(file, "a");
      this.sideFds.set(file, fd);
      return fd;
    } catch { return null; }
  }

  /** Route one update to its derived sidecars. `line` is the serialized
   * main-log row — sidecars store the identical JSONL so readers share the
   * LogEntry shape. */
  private writeSidecars(sessionId: string, u: Record<string, unknown>, line: string) {
    const m = u._meta as Record<string, unknown> | undefined;
    const aids = new Set<string>();
    const cx = (m?.["cognition.ai/subagent_context"] as { parentAgentId?: string } | undefined)?.parentAgentId;
    if (cx && cx !== "root") aids.add(cx);
    const st = m?.["cognition.ai/subagent_started"] as { agentId?: string } | undefined;
    const dn = m?.["cognition.ai/subagent_completed"] as { agentId?: string } | undefined;
    if (st?.agentId) { const a = String(st.agentId); aids.add(a); this.knownAids(sessionId).add(a); }
    if (dn?.agentId) { const a = String(dn.agentId); aids.add(a); this.knownAids(sessionId).add(a); }
    const tc = u.toolCallId;
    if (tc != null && this.knownAids(sessionId).has(String(tc))) aids.add(String(tc));
    for (const aid of aids) {
      const fd = this.sideWriter(this.sideFile(sessionId, aid));
      if (fd != null) { try { fs.writeSync(fd, line); } catch { /* best-effort */ } }
    }
    const isSpawn = m?.["cognition.ai/inferenceToolName"] === "run_subagent";
    const title = String(u.title ?? "");
    const prof = String(((u.rawInput ?? u.arguments) as Record<string, unknown> | undefined)?.profile ?? "");
    if (isSpawn || st || dn || (u.sessionUpdate === "tool_call" && /subagent/i.test(title)) || prof.startsWith("subagent")) {
      const fd = this.sideWriter(this.subsJournalFile(sessionId));
      if (fd != null) { try { fs.writeSync(fd, line); } catch { /* best-effort */ } }
    }
  }

  /** The scan-time twin of writeSidecars — routes a raw line (string, not a
   * parsed update) and writes through per-file fds opened for the scan. */
  private routeSubLine(sessionId: string, line: string, outs: Map<string, number>, known: Set<string>) {
    if (!line.includes("subagent") && !line.includes("run_subagent")) return;
    let e: LogEntry;
    try { e = JSON.parse(line) as LogEntry; } catch { return; }
    const u = e.update;
    if (!u || typeof u !== "object") return;
    const m = u._meta as Record<string, unknown> | undefined;
    const aids = new Set<string>();
    const cx = (m?.["cognition.ai/subagent_context"] as { parentAgentId?: string } | undefined)?.parentAgentId;
    if (cx && cx !== "root") aids.add(cx);
    const st = m?.["cognition.ai/subagent_started"] as { agentId?: string } | undefined;
    const dn = m?.["cognition.ai/subagent_completed"] as { agentId?: string } | undefined;
    if (st?.agentId) { const a = String(st.agentId); aids.add(a); known.add(a); }
    if (dn?.agentId) { const a = String(dn.agentId); aids.add(a); known.add(a); }
    const tc = u.toolCallId;
    if (tc != null && known.has(String(tc))) aids.add(String(tc));
    for (const aid of aids) this.scanWrite(outs, this.sideFile(sessionId, aid), line);
    const isSpawn = m?.["cognition.ai/inferenceToolName"] === "run_subagent";
    const title = String(u.title ?? "");
    const prof = String(((u.rawInput ?? u.arguments) as Record<string, unknown> | undefined)?.profile ?? "");
    if (isSpawn || st || dn || (u.sessionUpdate === "tool_call" && /subagent/i.test(title)) || prof.startsWith("subagent"))
      this.scanWrite(outs, this.subsJournalFile(sessionId), line);
  }

  private scanWrite(outs: Map<string, number>, file: string, line: string) {
    let fd = outs.get(file);
    if (fd == null) {
      try { fd = fs.openSync(file, "a"); outs.set(file, fd); } catch { return; }
    }
    try { fs.writeSync(fd, line + "\n"); } catch { /* best-effort */ }
  }

  private closeScan(outs: Map<string, number>) {
    for (const fd of outs.values()) { try { fs.closeSync(fd); } catch {} }
    outs.clear();
  }

  /** True when the main log has bytes beyond the guaranteed sidecar
   * coverage — i.e. a scan is owed (legacy bootstrap or scan-window tail). */
  subFilesStale(sessionId: string): boolean {
    if (!this.dir) return false;
    try { return fs.statSync(this.file(sessionId)).size > Math.max(0, this.coveredOff(sessionId)); }
    catch { return false; }
  }

  /** Cover [coverOff, size) of the main log into the sidecars. Small spans
   * scan inline; large ones scan in a chunked background pass so the event
   * loop never stalls on a multi-GB log. */
  ensureSubFiles(sessionId: string): void {
    if (!this.dir || this.subScanning.has(sessionId)) return;
    let size: number;
    try { size = fs.statSync(this.file(sessionId)).size; } catch { return; }
    let off = this.coveredOff(sessionId);
    if (off > size) off = 0; // file shrank (clear/restore) — rebuild
    if (off < 0) off = 0;    // legacy marker — scan from the top
    if (off === size) return;
    if (off === 0) this.wipeSidecars(sessionId); // fresh generation
    const known = this.knownAids(sessionId);
    const genAtStart = this.gens.get(sessionId) ?? 0;
    const SPAN = size - off;
    const SMALL = 32 << 20;
    if (SPAN <= SMALL) {
      const outs = new Map<string, number>();
      try {
        this.eachFileLine(this.file(sessionId), (l) => this.routeSubLine(sessionId, l, outs, known), off, size);
        // A clear() mid-scan starts a new generation — this scan's output
        // belongs to the dead one; only claim coverage when it still matches.
        if ((this.gens.get(sessionId) ?? 0) === genAtStart) {
          this.bumpCover(sessionId, size);
          this.fileEnd.set(sessionId, size);
        }
      } catch { /* partial — retried on next poll */ }
      this.closeScan(outs);
      return;
    }
    this.subScanning.add(sessionId);
    void (async () => {
      const fsp = fs.promises;
      const CHUNK = 16 << 20;
      const outs = new Map<string, number>();
      let fd: fs.promises.FileHandle | null = null;
      try {
        fd = await fsp.open(this.file(sessionId), "r");
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
              if (line) this.routeSubLine(sessionId, line, outs, known);
            }
          }
        }
        if (carry.length) this.routeSubLine(sessionId, carry.toString("utf8"), outs, known);
        if ((this.gens.get(sessionId) ?? 0) === genAtStart) {
          this.bumpCover(sessionId, size);
          this.fileEnd.set(sessionId, size);
        }
      } catch { /* retried on next poll */ }
      finally {
        if (fd) { try { await fd.close(); } catch {} }
        this.closeScan(outs);
        this.subScanning.delete(sessionId);
      }
    })();
  }

  /** Remove all derived sidecars + marker for a session (generation change). */
  private wipeSidecars(sessionId: string) {
    if (!this.dir) return;
    const base = `${encodeURIComponent(sessionId)}.jsonl`;
    try {
      for (const f of fs.readdirSync(this.dir)) {
        if (!f.startsWith(base + ".sub")) continue;
        const p = path.join(this.dir, f);
        const fd = this.sideFds.get(p);
        if (fd != null) { this.sideFds.delete(p); try { fs.closeSync(fd); } catch {} }
        try { fs.rmSync(p, { force: true }); } catch {}
      }
    } catch { /* dir unreadable */ }
    this.coverOff.delete(sessionId);
    this.aidSets.delete(sessionId);
  }

  /** The spawn/lifecycle journal — row source for the sidebar subagent
   * listing. Always tiny (no content lines). */
  readSubsJournal(sessionId: string): LogEntry[] | null {
    if (!this.dir) return null;
    try { fs.statSync(this.subsJournalFile(sessionId)); } catch { return null; }
    return this.parseSubFile(this.subsJournalFile(sessionId));
  }

  subsJournalMtime(sessionId: string): number | null {
    if (!this.dir) return null;
    try { return fs.statSync(this.subsJournalFile(sessionId)).mtimeMs; } catch { return null; }
  }

  /** One child agent's own event stream — the child timeline's disk source. */
  readSubStream(sessionId: string, aid: string): LogEntry[] | null {
    if (!this.dir) return null;
    const f = this.sideFile(sessionId, aid);
    try { fs.statSync(f); } catch { return null; }
    return this.parseSubFile(f);
  }

  subStreamMtime(sessionId: string, aid: string): number | null {
    if (!this.dir) return null;
    try { return fs.statSync(this.sideFile(sessionId, aid)).mtimeMs; } catch { return null; }
  }

  /** Sidecar lines can interleave when a scan races live appends (scan
   * claims a byte range while appends write past it) — sort on seq and drop
   * exact duplicates so readers always see one ordered stream. */
  private parseSubFile(file: string): LogEntry[] {
    const out: LogEntry[] = [];
    const seen = new Set<number>();
    this.eachFileLine(file, (line) => {
      try {
        const e = JSON.parse(line) as LogEntry;
        const s = e.seq ?? -1;
        if (seen.has(s)) return;
        seen.add(s);
        out.push(e);
      } catch { /* torn */ }
    });
    out.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    return out;
  }

  /** The last text an agent produced — sidebar snippet fill for cold rows
   * without parsing the whole stream. */
  subTailText(sessionId: string, aid: string): string {
    const f = this.sideFile(sessionId, aid);
    try {
      const size = fs.statSync(f).size;
      const fd = fs.openSync(f, "r");
      try {
        const n = Math.min(size, 64 << 10);
        const buf = Buffer.alloc(n);
        fs.readSync(fd, buf, 0, n, size - n);
        const lines = buf.toString("utf8").split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
          if (!lines[i]) continue;
          try {
            const text = ((JSON.parse(lines[i]) as LogEntry).update.content as { text?: string } | undefined)?.text;
            if (text) return text.replace(/\s+/g, " ").slice(0, 160);
          } catch { /* torn */ }
        }
      } finally { fs.closeSync(fd); }
    } catch { /* no stream */ }
    return "";
  }

  /** Streams the disk log line-by-line without materializing the file — a
   * 500MB log must never become a giant string[] or the heap dies. */
  private eachDiskLine(sessionId: string, cb: (line: string) => void) {
    if (!this.dir) return;
    this.eachFileLine(this.file(sessionId), cb);
  }

  private eachFileLine(filePath: string, cb: (line: string) => void, startOff = 0, endOff = Infinity) {
    const CHUNK = 16 << 20;
    let fd = -1;
    try {
      fd = fs.openSync(filePath, "r");
      const size = Math.min(fs.fstatSync(fd).size, endOff);
      const buf = Buffer.alloc(CHUNK);
      // Carry the tail line as BYTES — a UTF-8 char split across chunk reads
      // must not be decoded to U+FFFD before the next chunk arrives.
      let carry = Buffer.alloc(0);
      const eat = (raw: Buffer) => {
        for (const line of raw.toString("utf8").split("\n")) {
          if (line) cb(line);
        }
      };
      // startOff is always a line boundary (our writes are line-atomic and
      // offsets are recorded as bytes-written) — start reading right there.
      let pos = Math.min(Math.max(0, startOff), size);
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
      // All derived sidecars index the OLD generation — drop them.
      this.wipeSidecars(sessionId);
      this.fileEnd.delete(sessionId);
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
    this.wipeSidecars(sessionId);
    this.fileEnd.delete(sessionId);
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
