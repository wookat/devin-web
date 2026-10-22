/**
 * sessionsidecars — the subagent sidecar projection of the session log.
 *
 * Derived views, maintained alongside the authoritative append in
 * sessionlog (which owns the ring/mirror/DB store and injects the host
 * state below via SidecarDeps):
 *   <id>.sub.<aid>.jsonl — every event belonging to child agent <aid>'s
 *       stream (context tag, lifecycle meta, its root-call updates). A
 *       Claude-Code-style sidechain: the child timeline reads this small
 *       file and never re-scans the main log.
 *   <id>.subs.jsonl — spawn-call + lifecycle lines only (tiny): the sidebar
 *       listing builds its rows from this journal.
 *   <id>.subscan — {"off":N}|{"seq":N} marker: bytes (file mode) or event
 *       seqs (db mode) of the main log whose sidecar coverage is
 *       guaranteed. Live appends advance it; ensureSubFiles scans whatever
 *       lies beyond (legacy logs bootstrap this way).
 * Leaf module — never imports a consumer.
 */
import fs from "node:fs";
import path from "node:path";
import type { SessionDb, LogEntry } from "./sessiondb.js";

/** A live sidecar scan's open fds; `dead` stops routing after a mid-scan
 * wipe so a dead generation never repopulates fresh sidecar files. */
interface ScanOuts {
  dead: boolean;
  fds: Map<string, number>;
}

/** Host state the projection needs from SessionLog — injected at
 *  construction so this module stays a leaf (no import of its consumer). */
export interface SidecarDeps {
  /** disk-log directory; null disables persistence (tests). */
  dir: string | null;
  /** SQLite event store — seq-mode coverage on the db path, byte-mode on
   *  the legacy file path. */
  db: SessionDb | null;
  /** `<dir>/<id>.jsonl` — the main log path the sidecars derive from. */
  file(sessionId: string): string;
  /** SessionLog's generation counter — a wipe bumps it and in-flight scans
   *  gate their coverage claim on it still matching. */
  gen(sessionId: string): number;
  bumpGen(sessionId: string): void;
}

/** Streams a file line-by-line without materializing it — a 500MB log must
 * never become a giant string[] or the heap dies. startOff must be a line
 * boundary (our writes are line-atomic and offsets are recorded as
 * bytes-written), so reading can start right there. */
export function eachFileLine(filePath: string, cb: (line: string) => void, startOff = 0, endOff = Infinity) {
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

export class Sidecars {
  private sideFds = new Map<string, number>();
  private coverOff = new Map<string, number>();
  /** Seq-mode coverage (db path): sidecars cover event seqs [0, coverSeq). */
  private coverSeq = new Map<string, number>();
  private fileEnd = new Map<string, number>();
  private aidSets = new Map<string, Set<string>>();
  private subScanning = new Set<string>();
  /** Live scans' sidecar fds — registered so wipe can close them
   * (an rmSync on an open fd is delete-pending on Windows: the name lingers
   * in listings at 0 bytes and writes land in a doomed file object). */
  private scanOuts = new Map<string, ScanOuts>();

  constructor(private d: SidecarDeps) {}

  private sideFile(sessionId: string, aid: string) {
    // aid comes from stream meta / URLs — encode or a crafted parentAgentId
    // could steer the sidecar filename outside the log dir.
    return this.d.file(sessionId) + ".sub." + encodeURIComponent(aid) + ".jsonl";
  }
  private subsJournalFile(sessionId: string) {
    return this.d.file(sessionId) + ".subs.jsonl";
  }
  private subScanFile(sessionId: string) {
    return this.d.file(sessionId) + ".subscan";
  }

  private knownAids(sessionId: string): Set<string> {
    let s = this.aidSets.get(sessionId);
    if (!s) { s = new Set(); this.aidSets.set(sessionId, s); }
    return s;
  }

  /** Bytes written to the main log so far, tracked in memory so appends
   * don't statSync per line. Initialised from the file's pre-existing size. */
  endOf(sessionId: string): number {
    let end = this.fileEnd.get(sessionId);
    if (end == null) {
      try { end = fs.statSync(this.d.file(sessionId)).size; } catch { end = 0; }
      this.fileEnd.set(sessionId, end);
    }
    return end;
  }

  /** Drop cached coverage + end + the persisted marker — the main file
   * shrank (torn-tail repair) or was replaced (db import), so a cached
   * cover could claim sidecars hold bytes that no longer exist.
   * ensureSubFiles rebuilds lazily. */
  invalidateCoverage(sessionId: string) {
    this.fileEnd.delete(sessionId);
    this.coverOff.delete(sessionId);
    this.coverSeq.delete(sessionId);
    try { fs.rmSync(this.subScanFile(sessionId), { force: true }); } catch {}
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

  /** Seq-mode coverage (db path): reads the same .subscan marker, `seq`
   * field. A legacy {off}-only marker reads as -1 → full rescan owed. */
  private coveredSeq(sessionId: string): number {
    let s = this.coverSeq.get(sessionId);
    if (s == null) {
      s = -1;
      try {
        const fd = fs.openSync(this.subScanFile(sessionId), "r");
        try {
          const b = Buffer.alloc(128);
          const n = fs.readSync(fd, b, 0, 128, 0);
          const j = JSON.parse(b.subarray(0, n).toString("utf8").split("\n", 1)[0] || "{}") as Record<string, unknown>;
          s = typeof j.seq === "number" ? j.seq : -1;
        } finally { fs.closeSync(fd); }
      } catch { /* no marker */ }
      if (s < 0 && !this.hasData(sessionId)) s = 0; // empty history: nothing to scan
      this.coverSeq.set(sessionId, s);
    }
    return s;
  }

  private hasData(sessionId: string): boolean {
    if (this.d.db) return this.d.db.has(sessionId);
    return this.endOf(sessionId) > 0;
  }

  private bumpCoverSeq(sessionId: string, seq: number) {
    this.coverSeq.set(sessionId, seq);
    try { fs.writeFileSync(this.subScanFile(sessionId), `{"seq":${seq}}\n`); } catch { /* best-effort */ }
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

  /** Append-path coverage hook — call AFTER the main-log line is written
   * (`wrote` false when the mirror fd failed). `before` is the file's byte
   * end captured BEFORE the line landed (the caller's endOf read), so a
   * fileEnd that already counts this line can't fake a legacy gap.
   *
   * Sidecar coverage invariant: the derived sidecars cover EXACTLY the
   * main file's prefix [0, coverOff) — or event seqs [0, coverSeq) on the
   * db path. When cover == end before this append the line is ours to
   * write; a cover that lags means an unscanned gap exists (legacy file or
   * scan in flight) and the line belongs to the next scan's range —
   * writing it here would double it. Only claim coverage when every routed
   * write landed — a failed open (delete-pending name on Windows, EPERM,
   * ENOSPC) must leave cover behind so subFilesStale schedules a healing
   * rescan. */
  noteAppended(sessionId: string, u: Record<string, unknown>, line: string, seq: number, before: number, wrote: boolean) {
    if (wrote) {
      if (this.d.db) {
        // Seq-based coverage: sidecars cover event seqs [0, coverSeq).
        if (this.coveredSeq(sessionId) === seq) {
          if (this.writeSidecars(sessionId, u, line)) this.bumpCoverSeq(sessionId, seq + 1);
        }
      } else if (this.coveredOff(sessionId) === before) {
        if (this.writeSidecars(sessionId, u, line))
          this.bumpCover(sessionId, before + Buffer.byteLength(line));
      }
    }
    this.fileEnd.set(sessionId, before + Buffer.byteLength(line));
  }

  /** Route one update to its derived sidecars. `line` is the serialized
   * main-log row — sidecars store the identical JSONL so readers share the
   * LogEntry shape. Returns false when any routed write failed, so the
   * caller leaves coverage behind for a healing rescan. */
  private writeSidecars(sessionId: string, u: Record<string, unknown>, line: string): boolean {
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
    let ok = true;
    const w = (file: string) => {
      const fd = this.sideWriter(file);
      if (fd == null) { ok = false; return; }
      try { fs.writeSync(fd, line); } catch { ok = false; }
    };
    for (const aid of aids) w(this.sideFile(sessionId, aid));
    const isSpawn = m?.["cognition.ai/inferenceToolName"] === "run_subagent";
    const title = String(u.title ?? "");
    const prof = String(((u.rawInput ?? u.arguments) as Record<string, unknown> | undefined)?.profile ?? "");
    if (isSpawn || st || dn || (u.sessionUpdate === "tool_call" && /subagent/i.test(title)) || prof.startsWith("subagent"))
      w(this.subsJournalFile(sessionId));
    return ok;
  }

  /** The scan-time twin of writeSidecars — routes a raw line (string, not a
   * parsed update) and writes through per-file fds opened for the scan. */
  private routeSubLine(sessionId: string, line: string, scan: ScanOuts, known: Set<string>) {
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
    for (const aid of aids) this.scanWrite(scan, this.sideFile(sessionId, aid), line);
    const isSpawn = m?.["cognition.ai/inferenceToolName"] === "run_subagent";
    const title = String(u.title ?? "");
    const prof = String(((u.rawInput ?? u.arguments) as Record<string, unknown> | undefined)?.profile ?? "");
    if (isSpawn || st || dn || (u.sessionUpdate === "tool_call" && /subagent/i.test(title)) || prof.startsWith("subagent"))
      this.scanWrite(scan, this.subsJournalFile(sessionId), line);
  }

  private scanWrite(scan: ScanOuts, file: string, line: string) {
    if (scan.dead) return; // wiped mid-scan — do not repopulate a dead generation
    let fd = scan.fds.get(file);
    if (fd == null) {
      try { fd = fs.openSync(file, "a"); scan.fds.set(file, fd); } catch { return; }
    }
    try { fs.writeSync(fd, line + "\n"); } catch { /* best-effort */ }
  }

  private closeScan(scan: ScanOuts) {
    scan.dead = true;
    for (const fd of scan.fds.values()) { try { fs.closeSync(fd); } catch {} }
    scan.fds.clear();
  }

  /** True when the store has events beyond guaranteed sidecar coverage —
   * i.e. a scan is owed (legacy bootstrap or scan-window tail). Seq-based
   * on the DB path, byte-based on the legacy file path. */
  subFilesStale(sessionId: string): boolean {
    if (!this.d.dir) return false;
    if (this.d.db) {
      const g = this.d.db.maxGen(sessionId);
      if (g < 0) return false;
      return this.coveredSeq(sessionId) <= this.d.db.maxSeqInGen(sessionId, g);
    }
    try { return fs.statSync(this.d.file(sessionId)).size > Math.max(0, this.coveredOff(sessionId)); }
    catch { return false; }
  }

  /** Cover [coverSeq, maxSeq] of the current generation into the sidecars —
   * an indexed, LIKE-prefiltered scan of the event store (no byte spans, no
   * background chunked pass needed). */
  private scanSubsFromDb(sessionId: string): void {
    const db = this.d.db!;
    let covered = this.coveredSeq(sessionId);
    const dgen = db.maxGen(sessionId);
    const max = dgen < 0 ? -1 : db.maxSeqInGen(sessionId, dgen);
    if (max < 0 || covered > max) return;
    if (covered <= 0) { this.wipe(sessionId); covered = this.coveredSeq(sessionId) <= 0 ? 0 : covered; }
    const known = this.knownAids(sessionId);
    const memGen = this.d.gen(sessionId);
    this.subScanning.add(sessionId);
    const scan: ScanOuts = { dead: false, fds: new Map() };
    this.scanOuts.set(sessionId, scan);
    try {
      for (const row of db.scanRows(sessionId, dgen, Math.max(0, covered), max)) {
        if (scan.dead) break;
        // Rebuild the LogEntry line verbatim — same shape the file wrote.
        this.routeSubLine(sessionId, `{"ts":${row.ts},"seq":${row.seq},"update":${row.data}}`, scan, known);
      }
      if (!scan.dead && this.d.gen(sessionId) === memGen) this.bumpCoverSeq(sessionId, max + 1);
    } catch { /* retried on next poll */ }
    finally { this.closeScan(scan); this.scanOuts.delete(sessionId); this.subScanning.delete(sessionId); }
  }

  /** Cover [coverOff, size) of the main log into the sidecars. Small spans
   * scan inline; large ones scan in a chunked background pass so the event
   * loop never stalls on a multi-GB log. */
  ensureSubFiles(sessionId: string): void {
    if (!this.d.dir || this.subScanning.has(sessionId)) return;
    if (this.d.db) { this.scanSubsFromDb(sessionId); return; }
    let size: number;
    try { size = fs.statSync(this.d.file(sessionId)).size; } catch { return; }
    let off = this.coveredOff(sessionId);
    if (off > size) off = 0; // file shrank (clear/restore) — rebuild
    if (off < 0) off = 0;    // legacy marker — scan from the top
    if (off === size) return;
    if (off === 0) this.wipe(sessionId); // fresh generation
    const known = this.knownAids(sessionId);
    const genAtStart = this.d.gen(sessionId);
    const SPAN = size - off;
    const SMALL = 32 << 20;
    if (SPAN <= SMALL) {
      const scan: ScanOuts = { dead: false, fds: new Map() };
      this.scanOuts.set(sessionId, scan);
      try {
        eachFileLine(this.d.file(sessionId), (l) => this.routeSubLine(sessionId, l, scan, known), off, size);
        // A clear() mid-scan starts a new generation — this scan's output
        // belongs to the dead one; only claim coverage when it still matches.
        // Claim only what still exists on disk (Math.min): a mid-scan
        // truncation must not be covered by bytes we scanned but lost.
        if (this.d.gen(sessionId) === genAtStart) {
          const now = this.statSize(sessionId);
          this.bumpCover(sessionId, Math.min(size, now));
          this.fileEnd.set(sessionId, Math.max(now, this.fileEnd.get(sessionId) ?? 0));
        }
      } catch { /* partial — retried on next poll */ }
      finally { this.closeScan(scan); this.scanOuts.delete(sessionId); }
      return;
    }
    this.subScanning.add(sessionId);
    void (async () => {
      const fsp = fs.promises;
      const CHUNK = 16 << 20;
      const scan: ScanOuts = { dead: false, fds: new Map() };
      this.scanOuts.set(sessionId, scan);
      let fd: fs.promises.FileHandle | null = null;
      try {
        fd = await fsp.open(this.d.file(sessionId), "r");
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
              if (line) this.routeSubLine(sessionId, line, scan, known);
            }
          }
        }
        if (carry.length) this.routeSubLine(sessionId, carry.toString("utf8"), scan, known);
        if (this.d.gen(sessionId) === genAtStart) {
          const now = this.statSize(sessionId);
          this.bumpCover(sessionId, Math.min(size, now));
          this.fileEnd.set(sessionId, Math.max(now, this.fileEnd.get(sessionId) ?? 0));
        }
      } catch { /* retried on next poll */ }
      finally {
        if (fd) { try { await fd.close(); } catch {} }
        this.closeScan(scan);
        this.scanOuts.delete(sessionId);
        this.subScanning.delete(sessionId);
      }
    })();
  }

  private statSize(sessionId: string): number {
    try { return fs.statSync(this.d.file(sessionId)).size; } catch { return 0; }
  }

  /** Remove all derived sidecars + marker for a session (generation change).
   * Also kills any in-flight scan: its fds are closed FIRST so the rm below
   * never hits an open handle (delete-pending on Windows — the name then
   * lingers in listings at 0 bytes and writes go to a doomed file object),
   * and its `dead` flag stops it from repopulating afterwards. The cached
   * byte end goes too — a wiped generation's fileEnd is meaningless. */
  wipe(sessionId: string) {
    if (!this.d.dir) return;
    // A wipe IS a generation change — stale scans keyed on genAtStart must
    // not claim coverage over files this call just removed. (clear() bumps
    // too; a double-bump is harmless.)
    this.d.bumpGen(sessionId);
    const scan = this.scanOuts.get(sessionId);
    if (scan) { this.closeScan(scan); this.scanOuts.delete(sessionId); }
    const base = `${encodeURIComponent(sessionId)}.jsonl`;
    try {
      for (const f of fs.readdirSync(this.d.dir)) {
        if (!f.startsWith(base + ".sub")) continue;
        const p = path.join(this.d.dir, f);
        const fd = this.sideFds.get(p);
        if (fd != null) { this.sideFds.delete(p); try { fs.closeSync(fd); } catch {} }
        try { fs.rmSync(p, { force: true }); } catch {}
      }
    } catch { /* dir unreadable */ }
    this.coverOff.delete(sessionId);
    this.aidSets.delete(sessionId);
    this.fileEnd.delete(sessionId);
  }

  /** The spawn/lifecycle journal — row source for the sidebar subagent
   * listing. Always tiny (no content lines). */
  readSubsJournal(sessionId: string): LogEntry[] | null {
    if (!this.d.dir) return null;
    try { fs.statSync(this.subsJournalFile(sessionId)); } catch { return null; }
    return this.parseSubFile(this.subsJournalFile(sessionId));
  }

  subsJournalMtime(sessionId: string): number | null {
    if (!this.d.dir) return null;
    try { return fs.statSync(this.subsJournalFile(sessionId)).mtimeMs; } catch { return null; }
  }

  /** One child agent's own event stream — the child timeline's disk source. */
  readSubStream(sessionId: string, aid: string): LogEntry[] | null {
    if (!this.d.dir) return null;
    const f = this.sideFile(sessionId, aid);
    try { fs.statSync(f); } catch { return null; }
    return this.parseSubFile(f);
  }

  subStreamMtime(sessionId: string, aid: string): number | null {
    if (!this.d.dir) return null;
    try { return fs.statSync(this.sideFile(sessionId, aid)).mtimeMs; } catch { return null; }
  }

  /** Sidecar lines can interleave when a scan races live appends (scan
   * claims a byte range while appends write past it) — sort on seq and drop
   * exact duplicates so readers always see one ordered stream. */
  private parseSubFile(file: string): LogEntry[] {
    const out: LogEntry[] = [];
    const seen = new Set<number>();
    eachFileLine(file, (line) => {
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
}
