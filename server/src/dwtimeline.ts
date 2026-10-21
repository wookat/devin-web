/**
 * dwtimeline — ACP session-update log → web TimelineItem[].
 * Cache, incremental noteUpdate, disk tail snapshots, message/snippet shaping.
 * Extracted from localweb.ts (mechanical move, behavior unchanged).
 */
import fs from "node:fs";
import path from "node:path";
import type { ApiContext } from "./routes.js";
import { loadInflight } from "./sessionplace.js";

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

/** Incremental timeline-builder state, kept per session so each /timeline
 * poll only processes the NEW log entries instead of rebuilding thousands
 * of items every few seconds. */
interface TlState {
  items: DwItem[];
  toolItems: Map<string, DwItem>;
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
  /** Swap {$blob} refs in a disk-backed update for their payloads — set by
   * build entry points that can reach sessionLog. Entries keep refs when
   * unset (message text never offloads, so snapshot builds still render). */
  resolve?: (u: Record<string, unknown>) => Record<string, unknown>;
}

/** Stored entries may offload big strings to blobs ({$blob} refs). Resolve
 * only where full content is actually consumed — diff file updates arrive
 * precomputed in _dwFileUpdates precisely to avoid this call. */
function resolveU(st: TlState, u: Record<string, unknown>): Record<string, unknown> {
  return u._dwBlobbed && st.resolve ? st.resolve(u) : u;
}

function freshTlState(sid = ""): TlState {
  return { items: [], toolItems: new Map(), permItems: new Map(), lastMsg: null, realUser: new Set(), localUser: new Map(), seenSeq: -1, logGen: -1, gen: 0, agentToolIds: new Set(), pendingSpawns: [], subCards: new Map(), produced: new Map(), sid };
}

/** Extract output paths a shell command is likely to CREATE: `>`/`>>`
 * redirects (incl. `2>` but not `2>&1`), `-o`/`--output*` flag values, and
 * the first arg of PowerShell write cmdlets (Set-Content/Out-File/…). */
function shellOutputPaths(cmd: string): string[] {
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
  // Writers take the FIRST arg (Set-Content path); copy/move/ren take the
  // LAST positional (the destination is the produced file).
  const writeFirst = /^(set-content|add-content|out-file|tee-object|tee|certutil)$/i;
  const writeLast = /^(copy|xcopy|move|ren|rename)$/i;
  const add = (s: string | undefined) => { const p = s && looksLikePath(s); if (p) out.add(p); };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (writeFirst.test(t)) { add(tokens.slice(i + 1).find((x) => !/^[-/]/.test(x))); continue; }
    if (writeLast.test(t)) { add(tokens.slice(i + 1).filter((x) => !/^[-/]/.test(x)).pop()); continue; }
    // Bare redirect token first — a `(.+)` tail pattern would let `>>`
    // backtrack into r[2]='>' and swallow the real target token.
    if (/^[0-9]?>>?$/.test(t)) { add(tokens[i + 1]); continue; }
    const r = /^[0-9]?>>?(.+)$/.exec(t);
    if (r) { add(r[1]); continue; }
    if (/^(-o|--out|--output|--output-file|--output-path|-output|-filepath|-file)$/i.test(t)) { add(tokens[i + 1]); continue; }
    const eq = /^(--out(?:put(?:-file|-path)?)?|-o)=(.+)$/.exec(t);
    if (eq) add(eq[2]);
  }
  return [...out];
}

/** Push collected produced-file paths onto the last devin message as
 * attachments (file-raw URLs the admin UI renders via AttachmentCard). */
function flushProduced(st: TlState, dirty?: DwItem[], boundary = false): void {
  if (!st.produced.size || !st.sid) return;
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
  for (const [p] of st.produced) {
    const url = `/api/admin/session/${st.sid}/file-raw?path=${encodeURIComponent(p)}`;
    if (have.has(url)) continue;
    have.add(url);
    atts.push({ url, name: p.split(/[\\/]/).pop() || p });
    msg.resultFiles = [...(msg.resultFiles ?? []), p];
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
      st.lastMsg.ts = iso;
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
    if (st2 === "completed") { it.exitCode = it.exitCode ?? "0"; it.suffix = undefined; }
    else if (st2 === "failed") { it.exitCode = "1"; it.suffix = "— failed"; it.callout = "error"; }
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

const tlCache = new Map<string, TlState>();
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
    const disk = ctx.sessionLog.readDisk(sessionId);
    const src = disk.length >= log.length ? disk : log;
    st = freshTlState(sessionId);
    // Must be set BEFORE the seed loop — disk entries carry blob refs that
    // resolve only through this hook.
    st.resolve = (u) => ctx.sessionLog.resolveBlobs(u);
    tlCache.set(sessionId, st);
    rebuilt = true;
    for (let i = 0; i < src.length; i++) tlPush(st, src[i], i);
    st.seenSeq = src.length ? (src[src.length - 1].seq ?? src.length - 1) : -1;
    st.logGen = logGen;
    if (hadData || src.length) {
      st.gen = ++tlGenSeq;
      tlReset.add(sessionId);
    }
  }
  st.resolve = (u) => ctx.sessionLog.resolveBlobs(u);
  for (const e of log) {
    const s = e.seq ?? -1;
    if (s > st.seenSeq) { tlPush(st, e, s); st.seenSeq = s; }
  }
  return { items: st.items, rebuilt, gen: st.gen };
}

/** Live streaming: after a log append, run just the new entries through the
 * incremental builder and broadcast the produced/mutated items. Clients merge
 * them by id — no refetch needed. Skipped while a replay is in flight (the
 * whole log is being rebuilt; buildTimeline catches up in one pass) and when
 * the session has no built state yet (the first poll builds it wholesale). */
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
  if (dirty.length) ctx.hub.broadcast({ type: "timeline_delta", sessionId, gen: st.gen, items: dirty });
}

// ---------------------------------------------------------------------------
// tail snapshot — instant "newest messages" view while a replay is in flight
// ---------------------------------------------------------------------------

type LogEntry = { ts: number; seq?: number; update: Record<string, unknown> };

/** Complete pre-reload logs (memory only): the view to show while the fresh
 * replay streams in, so the UI stays on the newest messages instead of
 * watching mid-history scroll by. */
const tailSnapshot = new Map<string, LogEntry[]>();
/** Tail persisted to disk so a post-restart cold open also paints instantly. */
const diskTailCache = new Map<string, LogEntry[]>();
const TAIL_KEEP = 400;
const tailWrites = new Map<string, number>();

function tailFile(ctx: ApiContext, id: string) {
  return path.join(ctx.store.dataDir, "tl", `${encodeURIComponent(id)}.json`);
}

function readDiskTail(ctx: ApiContext, id: string): LogEntry[] | null {
  if (diskTailCache.has(id)) return diskTailCache.get(id)!;
  try {
    const raw = JSON.parse(fs.readFileSync(tailFile(ctx, id), "utf8")) as LogEntry[];
    if (Array.isArray(raw) && raw.length) { diskTailCache.set(id, raw); return raw; }
  } catch { /* no snapshot */ }
  return null;
}

function persistTail(ctx: ApiContext, id: string) {
  const now = Date.now();
  if (now - (tailWrites.get(id) ?? 0) < 3000) return;
  tailWrites.set(id, now);
  const entries = ctx.sessionLog.get(id).slice(-TAIL_KEEP);
  if (!entries.length) return;
  diskTailCache.set(id, entries);
  try {
    const f = tailFile(ctx, id);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(entries));
  } catch { /* best-effort */ }
}

/** Snapshot items to show while a replay is in flight (or log still empty):
 * the pre-reload log if we had one, else the persisted tail. */
function snapshotItems(ctx: ApiContext, id: string): DwItem[] | null {
  const src = tailSnapshot.get(id) ?? readDiskTail(ctx, id);
  if (!src?.length) return null;
  const items = buildTimelineFrom(src, undefined, id, (u) => ctx.sessionLog.resolveBlobs(u));
  return items.length ? items : null;
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


export {
  type FileUpdate, type DwItem, type TlState, type LogEntry,
  tlPush, buildTimelineFrom, buildTimeline, noteUpdate, tlCache, tlReset,
  tailSnapshot, readDiskTail, persistTail, snapshotItems, buildMessages, snippet,
};
