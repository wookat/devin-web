/**
 * dwtimeline — ACP session-update log → web TimelineItem[].
 * Cache, incremental noteUpdate, disk tail snapshots, message/snippet shaping.
 * Extracted from localweb.ts (mechanical move, behavior unchanged).
 */
import type { ApiContext } from "./routes.js";
import fs from "node:fs";
import path from "node:path";
import { confined } from "./confined.js";
import { MAX_UPDATES_PER_SESSION } from "./sessionlog.js";
import type { LogEntry } from "./sessiondb.js";
import { loadInflight } from "./sessionplace.js";
import { terminalText } from "./sessionview.js";

// ---------------------------------------------------------------------------
// ACP session-update log → web TimelineItem[]
// ---------------------------------------------------------------------------

interface FileUpdate {
  file_path: string;
  lines_added?: number;
  lines_removed?: number;
  action_type?: string;
  /** Read/open range (ACP locations[].line + _meta.endLine) — the official
   * read row label is "name:start-end". */
  start_line?: number;
  end_line?: number;
  fileId?: string;
  prevFileId?: string;
}

interface DwItem {
  id: string;
  ts: string;
  kind: string;
  /** run_subagent card row: filled from subagent_started/subagent_completed
   * meta on the subagent's root toolCallId. */
  subagent?: {
    agentId: string; title?: string; task?: string; profile?: string;
    model?: string; isBackground?: boolean; depth?: number;
    finished: boolean; failed: boolean; summary?: string;
  };
  /** source-log index — lets the client advance its older-page cursor when it
   * trims the live window, without re-fetching what it already showed. */
  eidx?: number;
  /** delta-only tombstone: remove this id client-side (a `_local` optimistic
   * echo replaced by the real user chunk). Never appears in paged items. */
  _gone?: boolean;
  role?: "devin" | "user";
  title?: string;
  body?: string;
  durationMs?: number;
  exitCode?: string;
  output?: string;
  fileUpdates?: FileUpdate[];
  todos?: { status: string; content: string; activeForm?: string }[];
  terminal?: string;
  /** Real stdout lives in the term sidecar — this tail is the embedded
   *  preview; `terminalMore` tells the client a longer read is available. */
  terminalMore?: boolean;
  pageCursor?: string;
  startupCommand?: boolean;
  processId?: string;
  permission?: Record<string, unknown>;
  questions?: { question: string; options: string[]; allow_multiple?: boolean }[];
  answers?: string[];
  /** Staged-upload attachments, carried structurally on user messages
   * (replaces the legacy `ATTACHMENT:"url"` marker lines in body). */
  attachments?: { url: string; name?: string; mime?: string; size?: number }[];
  resultFiles?: string[];
  /** read of an image file: workspace path for inline preview via file-raw. */
  image?: { path: string };
  callout?: "error" | "warning" | "info";
  /** Machine tag on dw_notice rows: "conflict" (session open elsewhere) or
   * "error:<stage>" — lets the client localize/actionable-render it. */
  notice_kind?: string;
  suffix?: string;
  worklog?: "output" | "input";
  raw_type: string;
}

function countDiff(oldText: string | null, newText: string | null): { added: number; removed: number } {
  const a = newText ? newText.split("\n").length : 0;
  const r = oldText ? oldText.split("\n").length : 0;
  return { added: Math.max(0, a - r), removed: Math.max(0, r - a) };
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const c of content as Record<string, unknown>[]) {
    if (c.type === "content") {
      const inner = c.content as { type?: string; text?: string } | undefined;
      if (inner?.type === "text" && inner.text) out += inner.text;
    }
  }
  return out;
}

function diffsToFileUpdates(content: unknown): FileUpdate[] {
  if (!Array.isArray(content)) return [];
  const files: FileUpdate[] = [];
  for (const c of content as Record<string, unknown>[]) {
    if (c.type !== "diff") continue;
    const p = String(c.path ?? "");
    const { added, removed } = countDiff((c.oldText as string | null) ?? null, (c.newText as string | null) ?? null);
    files.push({
      file_path: p,
      lines_added: added,
      lines_removed: removed,
      action_type: c.oldText == null ? "create" : c.newText == null ? "delete" : "modify",
      fileId: `path:${encodeURIComponent(p)}`,
      prevFileId: `path:${encodeURIComponent(p)}`,
    });
  }
  return files;
}

/** ACP `locations` (read/search results) carry {path, line, _meta.endLine} —
 * same shape the official row label uses ("Read name:start-end"). */
function locationsToFileUpdates(locations: unknown): FileUpdate[] {
  if (!Array.isArray(locations)) return [];
  const out: FileUpdate[] = [];
  for (const l of locations as { path?: unknown; line?: unknown; _meta?: Record<string, unknown> }[]) {
    const p = String(l?.path ?? "");
    if (!p) continue;
    const end = l._meta?.["cognition.ai/endLine"];
    out.push({
      file_path: p,
      action_type: "open",
      start_line: typeof l.line === "number" ? l.line : undefined,
      end_line: typeof end === "number" ? end : undefined,
      fileId: `path:${encodeURIComponent(p)}`,
    });
  }
  return out;
}

const TOOL_KIND_MAP: Record<string, string> = {
  execute: "shell",
  read: "read",
  search: "search",
  fetch: "activity",
  think: "activity",
  switch_mode: "status",
};

function toolKind(u: Record<string, unknown>): string {
  const k = String(u.kind ?? "other");
  if (k === "edit" || k === "delete" || k === "move") return "edit";
  return TOOL_KIND_MAP[k] ?? "activity";
}

/** The ACP wire never links a terminal back to its tool_call: the create
 * event journals `[command, ...args]` while the tool row shows
 * rawInput.command — same line modulo quoting/whitespace, so normalize
 * both away and require a real substring overlap. */
const normCmd = (s: string) => s.replace(/["'`]/g, "").replace(/\s+/g, " ").trim();

/** Bind a shell item to its dw_term_create by command text — earliest
 * unconsumed match wins, so identical commands still pair in order. */
function bindShellTerminal(st: TlState, it: DwItem): void {
  if (st.boundTerms.has(it.id)) return;
  const cmd = normCmd(it.body ?? "");
  if (cmd.length < 4) return;
  for (const c of st.termCreates) {
    if (c.used) continue;
    const jc = normCmd(c.command);
    if (jc.length >= 4 && (jc.includes(cmd) || cmd.includes(jc))) {
      c.used = true;
      it.processId = c.terminalId;
      st.termItems.set(c.terminalId, it);
      st.boundTerms.add(it.id);
      return;
    }
  }
}

/** Exit status precedence: runner truth (dw_term_exit) > the agent's own
 * "Exited with code N" summary > the completed/failed status default. */
function realExitCode(st: TlState, it: DwItem): string | undefined {
  const te = it.processId ? st.termExit.get(it.processId) : undefined;
  if (te) return te.exitCode != null ? String(te.exitCode) : te.signal ? `sig:${te.signal}` : undefined;
  const m = /Exited with code (-?\d+)/.exec(it.output ?? "");
  return m ? m[1] : undefined;
}

/** Small stdout tail embedded on the item — enough for the expanded pane's
 * first paint; `terminalMore` lets the client lazy-read the rest. */
const TERM_EMBED_TAIL = 4 * 1024;

function embedShellOutput(it: DwItem): void {
  if (!it.processId || it.startupCommand) return;
  const t = terminalText(it.processId);
  if (!t?.text) return;
  it.terminal = t.text.length > TERM_EMBED_TAIL ? t.text.slice(-TERM_EMBED_TAIL) : t.text;
  it.terminalMore = t.text.length > TERM_EMBED_TAIL || undefined;
}

function attachShellResult(st: TlState, it: DwItem): void {
  bindShellTerminal(st, it);
  const code = realExitCode(st, it);
  if (code !== undefined) it.exitCode = code;
  embedShellOutput(it);
}

/** Incremental timeline-builder state, kept per session so each /timeline
 * poll only processes the NEW log entries instead of rebuilding thousands
 * of items every few seconds. */
interface TlState {
  items: DwItem[];
  toolItems: Map<string, DwItem>;
  /** toolCallId → first-seen iso. it.ts is bumped on every progressive
   *  update (commands stream in as deltas), so duration needs this. */
  toolStart: Map<string, string>;
  permItems: Map<string, DwItem>;
  lastMsg: DwItem | null;
  realUser: Set<string>;
  localUser: Map<string, DwItem>;
  /** Last consumed log seq (entry.seq — survives ring eviction). */
  seenSeq: number;
  /** sessionLog.gen() at the last build — a bump means the log was cleared
   * for a re-replay and every seq below belongs to a dead generation. */
  logGen: number;
  /** Generation counter — bumped on every rebuild; lets clients drop deltas
   * belonging to a generation their window doesn't show. */
  gen: number;
  /** Subagent lifecycle updates ride on their own toolCallId (= agentId) and
   * would otherwise render as stray tool items — suppress them. */
  agentToolIds: Set<string>;
  /** Spawn cards seeded from run_subagent calls — a subagent_started adopts
   * the freshest unclaimed one within 60s and hands it the real agentId. */
  pendingSpawns: DwItem[];
  /** agentId → the spawn card that owns it. */
  subCards: Map<string, DwItem>;
  /** Replay generations re-emit the same logical events — each copy keeps the
   * original cognition.ai/timestamp stamp, so a hash of (kind|stamp) collapses
   * echo rows (observed: 9 generations of one subagent run in a loaded log). */
  dedup?: Set<number>;
  /** Files the agent created/modified this turn, collected from edit tool
   * diffs; flushed onto the next (or current) devin message as attachments —
   * the official "files produced by this message" chips. path → action. */
  produced: Map<string, string>;
  /** Session id — needed to build file-raw URLs for produced attachments. */
  sid: string;
  /** Workspace root — produced attachments are only attached when the path
   *  resolves INSIDE it (confined); also enables bare-name lookups when a
   *  reply mentions a produced file by basename only. */
  cwd?: string;
  /** Swap {$blob} refs in a disk-backed update for their payloads — set by
   * build entry points that can reach sessionLog. Entries keep refs when
   * unset (message text never offloads, so snapshot builds still render). */
  resolve?: (u: Record<string, unknown>) => Record<string, unknown>;
  /** dw_term_create entries in log order — the wire never links a terminal
   *  to its tool_call, so the create's command line is the binding key. */
  termCreates: { terminalId: string; command: string; used: boolean }[];
  /** terminalId → real exit status (dw_term_exit, may precede tool done). */
  termExit: Map<string, { exitCode: number | null; signal: string | null }>;
  /** terminalId → bound shell item (for exit events arriving post-bind). */
  termItems: Map<string, DwItem>;
  /** item ids already bound to a terminal — bind once, keep FIFO order. */
  boundTerms: Set<string>;
}

/** Stored entries may offload big strings to blobs ({$blob} refs). Resolve
 * only where full content is actually consumed — diff file updates arrive
 * precomputed in _dwFileUpdates precisely to avoid this call. */
function resolveU(st: TlState, u: Record<string, unknown>): Record<string, unknown> {
  return u._dwBlobbed && st.resolve ? st.resolve(u) : u;
}

function freshTlState(sid = ""): TlState {
  return { items: [], toolItems: new Map(), toolStart: new Map(), permItems: new Map(), lastMsg: null, realUser: new Set(), localUser: new Map(), seenSeq: -1, logGen: -1, gen: 0, agentToolIds: new Set(), pendingSpawns: [], subCards: new Map(), produced: new Map(), sid, termCreates: [], termExit: new Map(), termItems: new Map(), boundTerms: new Set() };
}

/** Extract output paths a shell command is likely to CREATE: `>`/`>>`
 * redirects (incl. `2>` but not `2>&1`), `-o`/`--output*` flag values, and
 * the first arg of PowerShell write cmdlets (Set-Content/Out-File/…). */
export function shellOutputPaths(cmd: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) tokens.push(m[1] ?? m[2] ?? m[3]);
  const looksLikePath = (s0: string) => {
    // Strip shell punctuation that rides along inside PS -Command strings:
    // quotes, parens, brackets, commas, semicolons.
    const s = s0.replace(/^["'`([{]+|["'`)\]};:,]+$/g, "");
    return !!s && !/^[&|<>-]/.test(s) && !/^(nul|\/dev\/null|stderr|stdout|console)$/i.test(s)
      && !/[*?]|^\$|^%/.test(s) && /\.[A-Za-z0-9]{1,10}$|[\\/]/.test(s) ? s : null;
  };
  const out = new Set<string>();
  // Writers take the FIRST arg (Set-Content path); copy/move/download and
  // single-output converters take the LAST positional (the destination is
  // the produced file). scp/rsync args can be remote (`u@h:path`/`h::m`) —
  // strip those so uploads don't credit remote paths.
  const writeFirst = /^(set-content|add-content|out-file|tee-object|tee|certutil)$/i;
  const writeLast = /^(copy|xcopy|move|ren|rename|cp|mv|scp|rsync|convert|magick|ffmpeg|gs|pdftoppm|pandoc|tar)$/i;
  const isRemote = /^(scp|rsync)$/i;
  const remoteTok = (x: string) => /^[^\s/\\]*@[^\s]*:/.test(x) || /^[^\s/\\]+::/.test(x);
  // Positional-arg collector for copy/move commands: skip flags, redirect
  // tokens (a `scp … 2>/dev/null` tail must not become the "dest"), and stop
  // at shell control words (`for f in *; do mv $f $f.bak; done` — the mv's
  // arg list ends at `done`, not at `sort -u` on the far side of `|`).
  const CTRL = /^(;|&&?|\|\|?|done|do|then|else|elif|fi|esac|;)$/;
  // A dest that names a directory keeps the source basename: `dir/`, `.`,
  // `..`, bare separators — `mv a.png b/` produces b/a.png not b.
  const dirDest = /^(?:\.{1,2}|[\\/]+)$|[\\/]$/;
  const positionals = (from: number): string[] => {
    const out: string[] = [];
    for (const x of tokens.slice(from)) {
      if (CTRL.test(x)) break;
      if (/^[-/]/.test(x) || /^[0-9]?>>?/.test(x)) continue;
      const clean = x.replace(/[;:]+$/, "");
      if (clean) out.push(clean);
      if (x !== clean) break; // `b;` ends this statement — next token is a new command
    }
    return out;
  };
  const add = (s: string | undefined) => { const p = s && looksLikePath(s); if (p) out.add(p); };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (writeFirst.test(t)) { add(tokens.slice(i + 1).find((x) => !/^[-/]/.test(x))); continue; }
    if (isRemote.test(t)) {
      // scp/rsync: only a DOWNLOAD produces a local file — last arg local
      // while an earlier arg is remote. `scp u@h:dir/x.png .` ⇒ ./x.png.
      const raw = positionals(i + 1);
      const dest = raw[raw.length - 1];
      if (dest && !remoteTok(dest) && raw.slice(0, -1).some(remoteTok)) {
        if (dirDest.test(dest)) {
          const src = [...raw].reverse().find(remoteTok);
          const base = src?.replace(/^[^\s/\\]*@[^\s]*:/, "").replace(/^[^\s/\\]+::/, "").split(/[\\/]/).pop();
          add(base && !/^(?:\.{1,2}|[\\/]+)$/.test(dest) ? `${dest.replace(/[\\/]+$/, "")}/${base}` : base);
        } else add(dest);
      }
      continue;
    }
    if (writeLast.test(t)) {
      const args = positionals(i + 1);
      const dest = args.pop();
      if (dest) {
        if (dirDest.test(dest)) {
          // `cp a.png dir/` — produced file is dir/a.png.
          const base = args.pop()?.split(/[\\/]/).pop();
          add(base && !/^(?:\.{1,2}|[\\/]+)$/.test(dest) ? `${dest.replace(/[\\/]+$/, "")}/${base}` : base);
        } else add(dest);
      }
      continue;
    }
    // Bare redirect token first — a `(.+)` tail pattern would let `>>`
    // backtrack into r[2]='>' and swallow the real target token.
    if (/^[0-9]?>>?$/.test(t)) { add(tokens[i + 1]); continue; }
    const r = /^[0-9]?>>?(.+)$/.exec(t);
    if (r) { add(r[1]); continue; }
    if (/^(-o|-O|--out|--output|--output-file|--output-path|-output|-filepath|-file)$/i.test(t)) { add(tokens[i + 1]); continue; }
    const eq = /^(--out(?:put(?:-file|-path)?)?|-[oO])=(.+)$/.exec(t);
    if (eq) add(eq[2]);
  }
  return [...out];
}

/** A reply that names a workspace file (``fig.png``、`out/plot.pdf`) should
 * surface it inline even when the producing command was invisible to
 * shellOutputPaths (plt.savefig, remote+scp wildcards, heredoc generators).
 * Extracts path-ish tokens ending in a displayable extension, resolves them
 * inside cwd — absolute & relative hits direct, bare names by a bounded
 * basename search. */
const MEDIA_REF = /[A-Za-z0-9_./\\-]{1,240}?\.(?:png|jpe?g|gif|webp|avif|bmp|svg|mp4|webm|mov|pdf)\b/gi;
const MEDIA_SKIP = /^(?:https?|file|data|mailto):/i;
const MEDIA_DIR_SKIP = new Set([".git", "node_modules", "dist", ".next", "out", "build", ".cache", "vendor", "__pycache__"]);

function findByBasename(root: string, base: string): string | null {
  // BFS so shallow hits win; ~30k-entry cap bounds worst-case walks.
  let seen = 0;
  const q: string[] = [root];
  while (q.length && seen < 30000) {
    const dir = q.shift()!;
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (++seen > 30000) return null;
      if (e.name === base) return path.join(dir, e.name);
      if (e.isDirectory() && !MEDIA_DIR_SKIP.has(e.name) && !e.name.startsWith(".")) q.push(path.join(dir, e.name));
    }
  }
  return null;
}

function resolveMediaRef(st: TlState, token: string): string | null {
  const cwd = st.cwd;
  if (!cwd) return null;
  const t = token.replace(/[\\/]+/g, path.sep === "\\" ? "\\" : "/");
  if (/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(t)) {
    // absolute — must live inside cwd (confined does the realpath check)
    try { return confined(cwd, t) && fs.statSync(t).isFile() ? t : null; } catch { return null; }
  }
  const joined = path.join(cwd, t);
  try { if (fs.statSync(joined).isFile()) return joined; } catch { /* not a direct hit */ }
  if (/[\\/]/.test(t)) return null; // had a path shape but missed — don't basename-fallback a stale dir
  return findByBasename(cwd, path.basename(t));
}

/** Push collected produced-file paths onto the last devin message as
 * attachments (file-raw URLs the admin UI renders via AttachmentCard). */
function flushProduced(st: TlState, dirty?: DwItem[], boundary = false): void {
  if (!st.sid) return;
  // Early-exit only when there's literally nothing to do — an empty
  // `produced` map must NOT skip the body-scan: a summarizing reply that
  // names earlier media (``fig.png``) produced nothing this turn but
  // still deserves inline attachments.
  if (!st.produced.size && !st.cwd) { if (boundary) st.produced.clear(); return; }
  // lastMsg may be a thought row — walk back to the last devin message, but
  // never past a user row (files would leak into the previous turn's reply).
  let msg = st.lastMsg;
  if (!msg || msg.role !== "devin" || msg.kind !== "message") {
    msg = null;
    for (let i = st.items.length - 1; i >= 0; i--) {
      const it = st.items[i];
      if (it.role === "user") break;
      if (it.role === "devin" && it.kind === "message") { msg = it; break; }
    }
  }
  // A turn that produced files but never sent a reply: at a turn boundary
  // there's no message left to claim them — drop rather than let the NEXT
  // turn's reply take credit.
  if (!msg) { if (boundary) st.produced.clear(); return; }
  const atts = msg.attachments ?? (msg.attachments = []);
  const have = new Set(atts.map((a) => a.url));
  // Unresolved produced paths (remote-only / later-renamed files) can't be
  // told apart from a second mention of the same name — dedupe them on
  // basename so `/tmp/uw.json` and `uw.json` don't render as twin dead
  // chips. Seed with every name already on the message: one message can
  // collect attachments across several flushes (per-message + turn-end).
  const haveUnresolved = new Set(atts.map((a) => a.name ?? ""));
  for (const [p] of st.produced) {
    // Relative tokens were captured under the COMMAND's cwd (`cd pagecheck
    // && scp … f.png`), not the session's — resolve through the same
    // root-then-basename-find lookup so the chip points at the real file.
    // Remote absolute paths (`ssh h "… > /tmp/uw.json"`) can't resolve
    // locally; a basename hit (`scp h:/tmp/uw.json .`) still catches them.
    const resolved = resolveMediaRef(st, p)
      ?? (/[\\/]/.test(p) && st.cwd ? findByBasename(st.cwd, p.split(/[\\/]/).pop() || p) : null);
    const full = resolved ?? p;
    if (!resolved) {
      const base = p.split(/[\\/]/).pop() || p;
      if (haveUnresolved.has(base)) continue;
      haveUnresolved.add(base);
    }
    const url = `/api/admin/session/${st.sid}/file-raw?path=${encodeURIComponent(full)}`;
    if (have.has(url)) continue;
    have.add(url);
    atts.push({ url, name: full.split(/[\\/]/).pop() || full });
    msg.resultFiles = [...(msg.resultFiles ?? []), full];
  }
  // Catch-all: media files the reply NAMES (``fig.png``) but that no command
  // parser could see — remote+scp pulls, plt.savefig, heredoc generators.
  // Resolved paths get the same attachment chip → inline image thumbnail.
  if (st.cwd && msg.body) {
    for (const m0 of msg.body.matchAll(MEDIA_REF)) {
      const tok = m0[0];
      if (MEDIA_SKIP.test(tok)) continue;
      const full = resolveMediaRef(st, tok);
      if (!full) continue;
      const url = `/api/admin/session/${st.sid}/file-raw?path=${encodeURIComponent(full)}`;
      if (have.has(url)) continue;
      have.add(url);
      atts.push({ url, name: full.split(/[\\/]/).pop() || full });
      msg.resultFiles = [...(msg.resultFiles ?? []), full];
    }
  }
  dirty?.push(msg);
  st.produced.clear();
}

let tlGenSeq = 0;

function tlPush(st: TlState, e: { ts: number; seq?: number; update: Record<string, unknown> }, i: number, dirty?: DwItem[], forAgent?: string): void {
  const { ts, update } = e;
  // e<seq> ids are stable across ring eviction and rebuilds — the same event
  // gets the same item id whether built from the memory window or the disk
  // log, so client merges never collide across generations.
  const gidx = e.seq ?? i;
  const u = update;
  const kind = String(u.sessionUpdate ?? "");
  const iso = new Date(ts).toISOString();
  const id = `e${gidx}`;

  // Subagent-produced events carry their agent id in subagent_context — they
  // belong to that agent's stream, not the main flow ("root" is the lead).
  // `forAgent` builds a single subagent's stream instead.
  const uMeta = (u._meta ?? {}) as Record<string, unknown>;
  const ctxAgent = (uMeta["cognition.ai/subagent_context"] as { parentAgentId?: string } | undefined)?.parentAgentId;
  if (forAgent ? ctxAgent !== forAgent : ctxAgent && ctxAgent !== "root") return;
  // Collapse replay-generation echoes: copies of one event keep its creation
  // stamp. Control kinds that produce no row are skipped so their churn
  // doesn't bloat the set (usage_update alone outnumbers real rows).
  const evTs = uMeta["cognition.ai/timestamp"];
  if (typeof evTs === "string" && evTs && kind !== "usage_update" && kind !== "session_info_update" && kind !== "current_mode_update" && kind !== "config_option_update" && kind !== "available_commands_update" && kind !== "dw_turn_end") {
    const s = kind + "|" + evTs;
    let h1 = 5381, h2 = 52711;
    for (let k = 0; k < s.length; k++) { const c = s.charCodeAt(k); h1 = ((h1 << 5) + h1 + c) | 0; h2 = ((h2 << 5) + h2 + c) ^ c; }
    const hk = h1 * 4294967296 + (h2 >>> 0);
    const d = (st.dedup ??= new Set<number>());
    if (d.has(hk)) return;
    d.add(hk);
  }
  const push = (it: DwItem) => {
    it.eidx = gidx;
    st.items.push(it);
    st.lastMsg = null;
    dirty?.push(it);
    return it;
  };

  if (kind === "user_message_chunk" || kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
    const text = (u.content as { text?: string } | undefined)?.text ?? "";
    const isUser = kind === "user_message_chunk";
    // New user turn begins — flush any produced files onto the previous reply.
    if (isUser) flushProduced(st, dirty, true);
    if (isUser && !u._local) st.realUser.add(text);
    const wantKind = kind === "agent_thought_chunk" ? "thought" : "message";
    const role = isUser ? "user" : "devin";
    // When the real echo lands on a `_local` optimistic twin, CONVERT it in
    // place (same id, body := real text). Merging-then-deduping would splice
    // the item that now holds the real content — the user message vanished.
    let twinAtLast: string | null = null;
    if (isUser && !u._local && st.lastMsg && st.localUser.size) {
      for (const [t, lo] of st.localUser) if (lo === st.lastMsg) { twinAtLast = t; break; }
    }
    if (twinAtLast != null && st.lastMsg && (twinAtLast === text || twinAtLast.startsWith(text) || text.startsWith(twinAtLast))) {
      st.localUser.delete(twinAtLast);
      // Preserve ATTACHMENT marker lines — devin's echo only carries the text,
      // so without this the attachment chips vanish when the twin converts.
      const keep = (st.lastMsg.body ?? "").split("\n").filter((l) => /^ATTACHMENT:"/.test(l.trim()));
      st.lastMsg.body = text + (keep.length ? `\n${keep.join("\n")}` : "");
      // The echo's arrival ts can postdate whole turn rows (devin sometimes
      // emits it late) — the item must keep the send-time stamp or the client
      // sorts the reply ABOVE the user's message.
      if (iso < st.lastMsg.ts) st.lastMsg.ts = iso;
    } else if (twinAtLast == null && !u._local && st.lastMsg && st.lastMsg.kind === wantKind && st.lastMsg.role === role) {
      st.lastMsg.body = (st.lastMsg.body ?? "") + text;
      st.lastMsg.ts = iso;
    } else {
      const atts = isUser && Array.isArray(u.attachments)
        ? (u.attachments as { url: string; name?: string; mime?: string; size?: number }[]) : undefined;
      st.lastMsg = { id, ts: iso, kind: wantKind, role, body: text, raw_type: kind, eidx: gidx, ...(atts?.length ? { attachments: atts } : {}) };
      if (wantKind === "message") st.lastMsg.worklog = "output";
      st.items.push(st.lastMsg);
      if (isUser && u._local) st.localUser.set(text, st.lastMsg);
    }
    dirty?.push(st.lastMsg);
    // Files produced during the turn attach to the devin reply as chips.
    if (!isUser) flushProduced(st, dirty);
    // Real user chunks may arrive split — after each merge, if the merged
    // body matches a pending `_local` optimistic twin, drop the twin.
    const mergedMsg = st.lastMsg;
    if (isUser && !u._local && mergedMsg && st.localUser.size) {
      for (const [t, lo] of [...st.localUser]) {
        if (t === text || t === mergedMsg.body) {
          const ix = st.items.indexOf(lo);
          if (ix >= 0) st.items.splice(ix, 1);
          // A non-adjacent echo (arrived after reply rows) still represents
          // the send — inherit the twin's send-time stamp so the client
          // sorts it before the reply, not under it.
          if (mergedMsg !== lo && lo.ts < mergedMsg.ts) mergedMsg.ts = lo.ts;
          dirty?.push({ id: lo.id, ts: iso, kind: "other", raw_type: "gone", _gone: true });
          if (st.lastMsg === lo) st.lastMsg = null;
          st.localUser.delete(t);
        }
      }
    }
    return;
  }

  if (kind === "tool_call" || kind === "tool_call_update") {
    const isSubSpawn = uMeta["cognition.ai/inferenceToolName"] === "run_subagent";
    const subStarted = uMeta["cognition.ai/subagent_started"] as Record<string, unknown> | undefined;
    const subDone = uMeta["cognition.ai/subagent_completed"] as Record<string, unknown> | undefined;
    const toolId = String(u.toolCallId ?? id);

    // Subagent lifecycle updates arrive on the subagent's own root toolCallId
    // (= agentId) — a different id than the run_subagent call. They update the
    // spawn card only; rendering a separate tool item would duplicate the card.
    if (subStarted || subDone || st.agentToolIds.has(toolId)) {
      const aid = String(subStarted?.agentId ?? subDone?.agentId ?? toolId);
      if (subStarted) st.agentToolIds.add(toolId);
      let card = st.subCards.get(aid);
      if (!card && subStarted) {
        // Adopt an unclaimed spawn card — newest first, and only if it is
        // fresh: harness-internal run_subagent probes never emit lifecycle
        // meta, so their cards would sit unclaimed forever and steal the
        // adoption meant for the spawn that actually precedes this start.
        const idx = (() => { for (let k = st.pendingSpawns.length - 1; k >= 0; k--) { const c = st.pendingSpawns[k]; if (Math.abs(ts - Date.parse(c.ts)) < 60_000) return k } return -1 })();
        card = idx >= 0 ? st.pendingSpawns.splice(idx, 1)[0] : undefined;
        if (!card) {
          card = { id: `t${toolId}`, ts: iso, kind: "activity", title: "", worklog: "input", raw_type: "tool:other" };
          st.toolItems.set(toolId, card);
          push(card);
        }
        card.subagent = card.subagent ?? { agentId: aid, title: "", task: "", profile: "", model: "", isBackground: false, depth: 1, finished: false, failed: false };
        card.subagent.agentId = aid;
        st.subCards.set(aid, card);
      }
      if (card?.subagent) {
        const s = card.subagent;
        if (subStarted) {
          s.title = String(subStarted.title ?? s.title);
          s.task = String(subStarted.task ?? s.task);
          s.profile = String(subStarted.profile ?? s.profile);
          s.model = String(subStarted.model ?? s.model);
          s.isBackground = Boolean(subStarted.isBackground);
          s.depth = Number(subStarted.depth ?? 1);
          if (!card.title || card.title === "tool") card.title = `${s.profile || "Subagent"} · ${s.title}`;
        }
        if (subDone) {
          s.finished = true;
          s.failed = subDone.success === false;
          s.summary = String(subDone.summary ?? "");
          card.exitCode = s.failed ? "1" : "0";
        }
        dirty?.push(card);
      }
      return;
    }

    // Big payloads persist as {$blob} refs — resolve lazily, once per
    // entry, only where the code below actually reads full content.
    let uFull: Record<string, unknown> | null = null;
    const full = () => (uFull ??= resolveU(st, u));

    let it = st.toolItems.get(toolId);
    if (!it) {
      it = {
        id: `t${toolId}`, ts: iso, kind: toolKind(u), title: String(u.title ?? "tool"),
        worklog: "input", raw_type: `tool:${String(u.kind ?? "other")}`,
      };
      it.fileUpdates = (u._dwFileUpdates as FileUpdate[] | undefined) ?? diffsToFileUpdates(u._dwBlobbed ? undefined : u.content);
      const locFiles = locationsToFileUpdates(u.locations);
      if (locFiles.length && !it.fileUpdates!.length) it.fileUpdates = locFiles;
      if (it.kind === "shell") {
        const text = contentText(full().content);
        if (text) it.output = text;
        const term = Array.isArray(u.content)
          ? (u.content as Record<string, unknown>[]).find((c) => c.type === "terminal")
          : undefined;
        it.processId = String(term?.terminalId ?? u.toolCallId ?? "");
      }
      if (it.kind === "read" && u.content) {
        const text = contentText(full().content);
        if (text) it.body = text.slice(0, 20000);
        // Image reads surface only as "View image <path> (WxH)" text — the
        // pixels never ride the event, so capture the path for inline preview.
        const loc = (u.locations as { path?: string }[] | undefined)?.[0]?.path;
        const m = /View image\s+(.+?)\s*\(\d+\s*x\s*\d+\)\s*$/m.exec(text);
        const p = loc && /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(loc) ? loc : m?.[1];
        if (p) it.image = { path: p };
      }
      st.toolItems.set(toolId, it);
      st.toolStart.set(toolId, iso);
      push(it);
    } else {
      it.ts = iso;
      if (typeof u.title === "string") it.title = u.title;
      const files = (u._dwFileUpdates as FileUpdate[] | undefined) ?? diffsToFileUpdates(u._dwBlobbed ? undefined : u.content);
      if (files.length) it.fileUpdates = files;
      // The read payload (path + line range) arrives on the streaming UPDATE,
      // not the first tool_call — backfill fileUpdates so the row label can
      // show "Read name:start-end".
      if (!it.fileUpdates?.length) {
        const locFiles = locationsToFileUpdates(u.locations);
        if (locFiles.length) it.fileUpdates = locFiles;
      }
      const text = contentText(full().content);
      if (text) it.kind === "shell" ? (it.output = (it.output ?? "") + text) : (it.body = (it.body ?? "") + text);
      if (it.kind === "read") {
        const loc = (u.locations as { path?: string }[] | undefined)?.[0]?.path;
        const m = /View image\s+(.+?)\s*\(\d+\s*x\s*\d+\)\s*$/m.exec(it.body ?? "");
        const p = loc && /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(loc) ? loc : m?.[1];
        if (p) it.image = { path: p };
      }
    }
    // Produced files: edit-kind diffs whose action is create/modify. Collected
    // now, attached when the turn's reply lands (flush points below).
    if (it.kind === "edit" && it.fileUpdates?.length) {
      for (const f of it.fileUpdates) {
        if (f.action_type === "create" || f.action_type === "modify") st.produced.set(f.file_path, f.action_type);
      }
    }
    // Shell rows carry the command itself — devin puts it in rawInput.command
    // or a tool://preview resource; contentText only surfaces result text.
    // The command STREAMS in via progressive tool_call_update deltas ("cd" →
    // "cd /" → …), so always take the latest non-empty value.
    if (it.kind === "shell" || it.kind === "shell_done") {
      const ri = full().rawInput as { command?: unknown } | undefined;
      let cmd = typeof ri?.command === "string" ? ri.command : "";
      if (!cmd && Array.isArray(full().content)) {
        const blk = (full().content as Record<string, unknown>[]).find((c) => {
          const inner = (c.content ?? {}) as Record<string, unknown>;
          const res = inner.resource as { uri?: string } | undefined;
          const mmeta = (inner._meta ?? {}) as Record<string, unknown>;
          return inner.type === "resource" && (mmeta["cognition.ai/preview_is_shell_command"] === true || res?.uri === "tool://preview");
        });
        const res = blk ? ((blk.content as Record<string, unknown>).resource as { text?: string } | undefined) : undefined;
        if (res?.text) cmd = res.text;
      }
      if (cmd) {
        it.body = cmd.slice(0, 20000);
        // Commands that write files via `>` / `-o` / Set-Content etc. count as
        // produced files too (pdf/png/mp4/md generation usually goes through
        // shell, not the edit tool).
        for (const p of shellOutputPaths(cmd)) st.produced.set(p, "create");
      }
      if (it.kind === "shell") bindShellTerminal(st, it);
    }
    // run_subagent: seed the card from the tool's own args (title/task/profile/
    // is_background). The real agentId arrives later via a subagent_started
    // update on the subagent's own root toolCallId — handled in the lifecycle
    // branch above, which claims this card off pendingSpawns.
    if (isSubSpawn && !it.subagent) {
      const args = (full().rawInput ?? full().arguments ?? {}) as Record<string, unknown>;
      // A resume call (run_subagent(resume="<agentId>")) targets an existing
      // agent — tag it with the real id and keep it out of pendingSpawns so
      // the next subagent_started isn't adopted by the wrong card.
      const resumeId = typeof args.resume === "string" ? args.resume : "";
      it.subagent = {
        agentId: resumeId || `spawn:${toolId}`,
        title: String(args.title ?? u.title ?? ""),
        task: String(args.task ?? ""),
        profile: String(args.profile ?? ""),
        model: "",
        isBackground: Boolean(args.is_background),
        depth: 1,
        finished: false,
        failed: false,
      };
      if (!resumeId) st.pendingSpawns.push(it);
    }
    const st2 = String(u.status ?? "");
    // Exec duration: first-seen ts → terminal-status ts. Feeds the terminal
    // history "时长" column (official Command|Duration|Started table).
    if (st2 === "completed" || st2 === "failed") {
      const startMs = Date.parse(st.toolStart.get(toolId) ?? it.ts);
      if (Number.isFinite(startMs)) it.durationMs = Math.max(0, Date.parse(iso) - startMs);
      // Real stdout + real exit status from the terminal runner — before the
      // generic defaults below fill whatever is still missing.
      if (it.kind === "shell") attachShellResult(st, it);
    }
    if (st2 === "completed") { it.exitCode = it.exitCode ?? "0"; it.suffix = undefined; }
    else if (st2 === "failed") { it.exitCode = it.exitCode ?? "1"; it.suffix = "— failed"; it.callout = "error"; }
    else if (st2 === "in_progress" || st2 === "pending") it.suffix = "running";
    dirty?.push(it);
    return;
  }

  if (kind === "plan") {
    const entries2 = (u.entries as { content?: string; status?: string; activeForm?: string }[] | undefined) ?? [];
    push({
      id, ts: iso, kind: "todo", raw_type: "todo_write",
      todos: entries2.map((e) => ({ status: String(e.status ?? "pending"), content: String(e.content ?? ""), activeForm: e.activeForm })),
    });
    return;
  }

  if (kind === "permission_request") {
    const tc = (resolveU(st, u).toolCall ?? {}) as Record<string, unknown>;
    const it = push({
      id, ts: iso, kind: "permission", raw_type: "permission_request",
      permission: {
        requestId: String(u.requestId ?? ""),
        toolName: String(tc.title ?? "tool"),
        toolArgs: JSON.stringify(tc.rawInput ?? {}),
        options: u.options ?? [],
        status: "pending",
      },
    });
    st.permItems.set(it.permission!.requestId as string, it);
    return;
  }

  if (kind === "permission_resolved") {
    const rid = String(u.requestId ?? "");
    const it = st.permItems.get(rid)
      ?? st.items.find((x) => x.kind === "permission" && (x.permission as Record<string, unknown>)?.requestId === rid);
    if (it) {
      it.permission = { ...(it.permission as Record<string, unknown>), status: "resolved", outcome: u.optionId ?? null };
      dirty?.push(it);
    }
    return;
  }

  if (kind === "usage_update" || kind === "session_info_update") return;
  // Turn-boundary marker (interruptedTurn recovery evidence) — not a row,
  // but a flush point: produced files settle onto the turn's final reply.
  if (kind === "dw_turn_end") { flushProduced(st, dirty, true); return; }
  // Terminal lifecycle markers journaled by index.ts — binding data for the
  // shell rows, never rows themselves. The create carries the command line
  // (the only toolCallId↔terminalId link on the wire); the exit carries the
  // runner's real status and can land before OR after the completion update.
  if (kind === "dw_term_create") {
    const tid = String(u.terminalId ?? "");
    if (tid) st.termCreates.push({ terminalId: tid, command: String(u.command ?? ""), used: false });
    return;
  }
  if (kind === "dw_term_exit") {
    const tid = String(u.terminalId ?? "");
    if (!tid) return;
    st.termExit.set(tid, {
      exitCode: (u.exitCode as number | null | undefined) ?? null,
      signal: (u.signal as string | null | undefined) ?? null,
    });
    const it = st.termItems.get(tid);
    if (it) {
      const code = realExitCode(st, it);
      if (code !== undefined) it.exitCode = code;
      // Exit can postdate the completion delta — refresh the tail so the
      // embedded text ends at the real end of output.
      embedShellOutput(it);
      dirty?.push(it);
    }
    return;
  }
  if (kind === "dw_notice") {
    const notice = String(u.notice ?? "");
    // Machine-readable notice classification so the client can render an
    // actionable card instead of raw English. "already open in another
    // process" = the session is owned by another acp/desktop instance —
    // the fix lives outside this UI (close it there), hence a dedicated kind.
    const errStage = /^错误\[(\w+)\]:/.exec(notice)?.[1];
    const noticeKind = /already open in another process/i.test(notice)
      ? "conflict"
      : errStage ? `error:${errStage}` : undefined;
    push({ id, ts: iso, kind: "status", title: notice, callout: errStage ? "error" : "info", notice_kind: noticeKind, raw_type: "status_update" });
    return;
  }
  // mode/config churn is composer state, not transcript rows
  if (kind === "current_mode_update") return;
  if (kind === "config_option_update" || kind === "available_commands_update") return;
  push({ id, ts: iso, kind: "other", title: kind || "update", body: JSON.stringify(u).slice(0, 2000), raw_type: kind });
}

/** Build a full timeline from an entry array (snapshots, exports). */
function buildTimelineFrom(
  entries: { ts: number; update: Record<string, unknown> }[],
  forAgent?: string,
  sid = "",
  resolve?: (u: Record<string, unknown>) => Record<string, unknown>,
): DwItem[] {
  const st = freshTlState(sid);
  st.resolve = resolve;
  for (let i = 0; i < entries.length; i++) tlPush(st, entries[i], i, undefined, forAgent);
  return st.items;
}

/** Built timeline state per session — items arrays are the biggest
 *  per-session heap objects after rings, so the cache is LRU-capped
 *  instead of growing unboundedly across uptime. */
const TL_CACHE_MAX = 60;
const tlCache = new Map<string, TlState>();
function tlCacheSet(id: string, st: TlState) {
  if (tlCache.has(id)) tlCache.delete(id);
  else if (tlCache.size >= TL_CACHE_MAX) tlCache.delete(tlCache.keys().next().value!);
  tlCache.set(id, st);
}
/** Sessions whose timeline was rebuilt since the last /timeline response —
 * the flag must survive until the timeline endpoint itself consumes it, or a
 * detail/panel poll would eat the reset and the client would merge-collide. */
const tlReset = new Set<string>();

/** Incremental build: process only entries appended since the last call.
 * Rebuilds from the DISK log (the complete history, not just the memory
 * window) when there is no state yet, the log was cleared for a re-replay
 * (gen bump), or the ring evicted entries before they were consumed —
 * `headSeq > seenSeq+1` is a hole tlPush can't fill. Rebuilds bump `gen` and
 * set tlReset so clients REPLACE items instead of merging across ids. */
function buildTimeline(ctx: ApiContext, sessionId: string): { items: DwItem[]; rebuilt: boolean; gen: number } {
  const log = ctx.sessionLog.get(sessionId);
  let st = tlCache.get(sessionId);
  let rebuilt = false;
  const logGen = ctx.sessionLog.gen(sessionId);
  const headSeq = log.length ? (log[0].seq ?? -1) : -1;
  // Gaps mid-replay are expected (the ring evicts as it streams) — don't
  // re-read the whole disk log per poll; one rebuild after replay suffices.
  if (!st || st.logGen !== logGen || (headSeq > st.seenSeq + 1 && !loadInflight.has(sessionId))) {
    // A "rebuild" that produces zero items (first build on an empty log)
    // replaces nothing — don't burn a generation or the reset flag on it,
    // or peek mode would read tlReset and refuse to serve the disk snapshot.
    const hadData = !!st && (st.items.length > 0 || st.seenSeq >= 0);
    // Bounded tail first — a full readDisk on a near-million-event session
    // blocks the loop long enough for the supervisor to kill the backend.
    // The page gets a recent-history timeline instantly; backfillTimeline
    // then streams the complete log asynchronously and swaps the cache.
    const disk = ctx.sessionLog.readDiskTail(sessionId);
    const src = disk.length >= log.length ? disk : log;
    st = freshTlState(sessionId);
    // Must be set BEFORE the seed loop — disk entries carry blob refs that
    // resolve only through this hook.
    st.resolve = (u) => ctx.sessionLog.resolveBlobs(u);
    // Same cwd resolution file-raw uses (sub-sessions share the parent's
    // workspace) — BEFORE the replay, flushProduced's media lookup needs it.
    st.cwd = ctx.sessionCwd.get(sessionId.startsWith("sub:") ? sessionId.slice(4).split(":")[0] : sessionId) ?? ctx.primaryCwd;
    tlCacheSet(sessionId, st);
    rebuilt = true;
    for (let i = 0; i < src.length; i++) tlPush(st, src[i], i);
    st.seenSeq = src.length ? (src[src.length - 1].seq ?? src.length - 1) : -1;
    st.logGen = logGen;
    if (hadData || src.length) {
      st.gen = ++tlGenSeq;
      tlReset.add(sessionId);
    }
    // Hit the tail cap → older history almost certainly exists — deep
    // backfill streams it in chunks off the request path, then swaps st.
    if (disk.length >= MAX_UPDATES_PER_SESSION) backfillTimeline(ctx, sessionId, logGen);
  }
  st.resolve = (u) => ctx.sessionLog.resolveBlobs(u);
  // Media-reference attachment lookup needs the workspace root — same cwd
  // resolution file-raw uses (sub-sessions share the parent's workspace).
  st.cwd = ctx.sessionCwd.get(sessionId.startsWith("sub:") ? sessionId.slice(4).split(":")[0] : sessionId) ?? ctx.primaryCwd;
  for (const e of log) {
    const s = e.seq ?? -1;
    if (s > st.seenSeq) { tlPush(st, e, s); st.seenSeq = s; }
  }
  return { items: st.items, rebuilt, gen: st.gen };
}

const backfilling = new Set<string>();

/** Streams the WHOLE disk log through the item builder in event-loop-friendly
 * chunks, then atomically swaps the tlCache entry built from the bounded tail.
 * Only scheduled when the tail read hit its cap (older history exists). */
function backfillTimeline(ctx: ApiContext, sessionId: string, logGen: number) {
  if (backfilling.has(sessionId)) return;
  backfilling.add(sessionId);
  void (async () => {
    try {
      const out: LogEntry[] = [];
      let i = 0;
      for (const e of ctx.sessionLog.diskEntries(sessionId)) {
        out.push(e);
        if (++i % 4000 === 0) await new Promise((r) => setImmediate(r));
      }
      // A replay bumped the gen mid-scan — this snapshot mixes generations;
      // drop it and let the next rebuild run clean.
      if (ctx.sessionLog.gen(sessionId) !== logGen) return;
      const cur = tlCache.get(sessionId);
      if (!cur || cur.logGen !== logGen) return;
      if (out.length <= MAX_UPDATES_PER_SESSION) return; // no deeper history after all
      const st = freshTlState(sessionId);
      st.resolve = (u) => ctx.sessionLog.resolveBlobs(u);
      // Same cwd resolution buildTimeline seeds — without it a backfilled
      // state resolves every produced/media path as unresolved garbage.
      st.cwd = ctx.sessionCwd.get(sessionId.startsWith("sub:") ? sessionId.slice(4).split(":")[0] : sessionId) ?? ctx.primaryCwd;
      for (let j = 0; j < out.length; j++) {
        tlPush(st, out[j], j);
        if (j % 4000 === 3999) {
          await new Promise((r) => setImmediate(r));
          // A replay bumped the gen mid-build — same mixed-generation hazard
          // as mid-scan; drop this snapshot.
          if (ctx.sessionLog.gen(sessionId) !== logGen) return;
        }
      }
      if (ctx.sessionLog.gen(sessionId) !== logGen) return;
      st.seenSeq = out[out.length - 1].seq ?? out.length - 1;
      st.logGen = logGen;
      st.gen = ++tlGenSeq;
      tlCacheSet(sessionId, st);
      tlReset.add(sessionId);
    } catch { /* next rebuild retries */ }
    finally { backfilling.delete(sessionId); }
  })();
}

/** Live streaming: after a log append, run just the new entries through the
 * incremental builder and broadcast the produced/mutated items. Clients merge
 * them by id — no refetch needed. Skipped while a replay is in flight (the
 * whole log is being rebuilt; buildTimeline catches up in one pass) and when
 * the session has no built state yet (the first poll builds it wholesale).
 *
 * Broadcasts coalesce: during a token/tool storm every log append would
 * otherwise emit its own ws frame, and each client render re-parses the
 * streaming message's WHOLE markdown — 20+ full renders/sec of an ever-
 * growing body is what froze the page. Dirty items accumulate keyed by id
 * (later versions replace earlier, matching the client's merge) and flush
 * as ONE broadcast per window. */
const DELTA_FLUSH_MS = 120;
const pendingDelta = new Map<string, { items: Map<string, DwItem>; timer: NodeJS.Timeout; gen: number }>();

function flushDelta(ctx: ApiContext, sessionId: string) {
  const p = pendingDelta.get(sessionId);
  if (!p) return;
  pendingDelta.delete(sessionId);
  if (p.items.size) ctx.hub.broadcast({ type: "timeline_delta", sessionId, gen: p.gen, items: [...p.items.values()] });
}

function noteUpdate(ctx: ApiContext, sessionId: string) {
  if (loadInflight.has(sessionId)) return;
  const st = tlCache.get(sessionId);
  if (!st) return;
  const log = ctx.sessionLog.get(sessionId);
  // Rewound by a re-replay or the ring dropped entries before consumption —
  // the next /timeline rebuilds from the disk log; deltas would merge-corrupt.
  if (st.logGen !== ctx.sessionLog.gen(sessionId)) return;
  const headSeq = log.length ? (log[0].seq ?? -1) : -1;
  if (headSeq > st.seenSeq + 1) return;
  const dirty: DwItem[] = [];
  for (const e of log) {
    const s = e.seq ?? -1;
    if (s > st.seenSeq) { tlPush(st, e, s, dirty); st.seenSeq = s; }
  }
  if (!dirty.length) return;
  let p = pendingDelta.get(sessionId);
  if (!p) {
    p = { items: new Map(), gen: st.gen, timer: setTimeout(() => flushDelta(ctx, sessionId), DELTA_FLUSH_MS) };
    p.timer.unref?.();
    pendingDelta.set(sessionId, p);
  }
  p.gen = st.gen;
  for (const it of dirty) p.items.set(it.id, it);
}

/** Coalesce the timeline's messages for the classic chat view. */
function buildMessages(items: DwItem[]) {
  return items
    .filter((it) => it.kind === "message")
    .map((it, i) => ({ id: it.id || `m${i}`, role: it.role === "user" ? "user" : "devin", message: it.body ?? "", timestamp: it.ts, attachments: it.attachments ?? [] }));
}

function snippet(items: DwItem[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === "message" && items[i].body) return items[i].body!.replace(/\s+/g, " ").slice(0, 140);
  }
  return "";
}


/** Timeline cache occupancy — each held session keeps its built item array;
 *  surfaced on the resources page so retention is visible. */
function tlStats() {
  let items = 0;
  for (const st of tlCache.values()) items += st.items.length;
  return { sessions: tlCache.size, items };
}

export {
  type FileUpdate, type DwItem, type TlState,
  buildTimelineFrom, buildTimeline, noteUpdate, tlCache, tlReset, tlStats,
  buildMessages, snippet,
};
