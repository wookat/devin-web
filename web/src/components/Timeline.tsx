import { Brain, Terminal, CheckCircle2, XCircle, Activity, Monitor, ListTodo, MessageSquare, MessageCircleQuestion, Info, FilePen, Eye, GitBranch, Search, Workflow, Bot, ShieldQuestion, Flag, Lightbulb, KeyRound, Globe, AlertTriangle, AlertCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import i18n from '@/i18n'
import { cn } from '@/lib/utils'
import { FileIcon } from '@/lib/fileIcon'
import type { QuoteAttachment, QuoteMeta } from '../../shared/quotes'

export interface FileUpdate {
  file_path: string
  action_type?: string
  lines_added?: number
  lines_removed?: number
  start_line?: number
  end_line?: number
  contents_key?: string
  prev_contents_key?: string
  /** visitor projection: opaque per-session handles for /file-contents (admin items carry the raw keys instead) */
  fileId?: string
  prevFileId?: string
}

/** One official file worklog row: updates of the same (path, action) collapse with summed counts (bundle `Cp`/`wp`). */
export interface FileRow {
  label: string
  filePath: string
  actionType?: string
  added: number
  removed: number
}

export function baseName(path: string): string {
  const t = path.replace(/\/+$/, '').split('/')
  return t[t.length - 1] || 'a file'
}

/** Official read label (`yp`): "name:start-end" when the open carried a line range. */
export function readLabel(f: FileUpdate): string {
  const n = baseName(f.file_path)
  if (f.action_type === 'rename' || f.action_type === 'delete') return n
  return f.start_line !== undefined && f.end_line !== undefined && f.start_line >= 1 ? `${n}:${f.start_line}-${f.end_line}` : n
}

export function fileRows(updates: FileUpdate[]): FileRow[] {
  const map = new Map<string, FileRow>()
  for (const f of updates) {
    const counted = f.action_type === 'edit' || f.action_type === 'create' || f.action_type === 'open' || !f.action_type
    const key = `${f.file_path}\u0000${f.action_type || 'edit'}`
    const row = map.get(key)
    const added = counted ? f.lines_added ?? 0 : 0
    const removed = counted ? f.lines_removed ?? 0 : 0
    if (row) { row.added += added; row.removed += removed; continue }
    const n = baseName(f.file_path)
    const label = f.action_type === 'open' ? `Read ${n}`
      : f.action_type === 'create' ? `Created ${n}`
        : f.action_type === 'delete' ? `Deleted ${n}`
          : f.action_type === 'rename' ? `Renamed ${n}`
            : `Edited ${n}`
    map.set(key, { label, filePath: f.file_path, actionType: f.action_type, added, removed })
  }
  return [...map.values()]
}

/** Display-only PR / branch fields projected by the Worker (same shape for admin and visitor). */
export interface PrInfo {
  prUrl?: string
  repo?: string
  repoUrl?: string
  owner?: string
  pullNumber?: number
  title?: string
  authorLogin?: string
  additions?: number
  deletions?: number
  state?: string
  draft?: boolean
  merged?: boolean
  baseRefName?: string
  headRefName?: string
  branch?: string
  branchUrl?: string
  commitUrl?: string
  shortSha?: string
  forced?: boolean
  muted?: boolean
  sender?: string
  jobId?: string
  count?: number
}

/** Live PR summary from the session PR list (state + diff counts merged into PR cards). */
export interface SessionPr {
  state: string
  pr_url: string
  draft: boolean
  number?: number
  additions?: number
  deletions?: number
}

/** environment_config_suggestion card state; visitors receive display fields only (no storage keys / ids). */
export interface EnvSuggestionInfo {
  repo?: string
  summary?: string
  filePath?: string
  yaml?: string
  sink?: string
  contentsKey?: string
  oldContentsKey?: string
  dismissed?: boolean
  target?: 'org' | 'repo'
  scope?: string
  blueprintId?: string
  resolution?: EnvResolution
  supersededBy?: string
}

export type EnvResolution =
  | { state: 'accepted'; prUrl?: string; pullNumber?: number; buildJobId?: string }
  | { state: 'error'; error?: string; retryable: boolean }

/** environment_config_completed / _error / _dismissed marker; folded into its suggestion card, never rendered. */
export interface EnvLifecycle {
  originalEventId: string
  resolution?: EnvResolution
  dismissed?: boolean
}

export interface TimelineItem {
  id: string
  ts: string
  /** Local backend: index of the source log entry — used to slide the
   * older-page cursor forward when the live window is trimmed. */
  eidx?: number
  /** Delta-only tombstone from the local backend: remove this id. */
  _gone?: boolean
  kind:
    | 'message' | 'thought' | 'activity' | 'shell' | 'shell_done' | 'status'
    | 'computer' | 'todo' | 'edit' | 'read' | 'git' | 'search' | 'question' | 'answer'
    | 'workflow' | 'workflow_agent' | 'permission' | 'bot_flag' | 'env_suggestion'
    | 'secret_request' | 'secrets_sent' | 'other'
  role?: 'devin' | 'user'
  /** `cognition.ai/clientMessageId` — the ACP revert anchor: rewindable
   *  steps (revert/stepsUpdated) are keyed by it. Local backend only. */
  userMessageId?: string
  /** Whether this user-authored event belongs to the current upstream viewer. */
  own?: boolean
  title?: string
  body?: string
  durationMs?: number
  exitCode?: string
  output?: string
  screenshotKeys?: string[]
  /** Computer / browser action labels, one official worklog row each. */
  actions?: string[]
  fileUpdates?: FileUpdate[]
  todos?: TodoRow[]
  todoAction?: { action?: string; subject?: string; createdCount?: number }
  processId?: string
  shellId?: string
  /** Platform clone/maintenance command: titled by purpose, command text hidden. */
  startupCommand?: boolean
  terminal?: string
  terminalMore?: boolean
  pageCursor?: string
  questions?: { question: string; options: string[]; allow_multiple?: boolean }[]
  answers?: string[]
  answeredEventId?: string
  translation?: string
  origin?: string
  workflow?: { runId: string; name?: string; status?: string; resumed?: boolean }
  agent?: { runId: string; resultId: string; status: string; phase?: string; label?: string; mode?: string; vmMode?: string; sessionId?: string }
  permission?: PermissionInfo
  botFlag?: { commentBody?: string; commentUrl?: string; prUrl?: string; allowlistMode?: string; botUsername?: string }
  envSuggestion?: EnvSuggestionInfo
  envLifecycle?: EnvLifecycle
  /** request_secret metadata; the value is never part of the timeline. */
  secretRequest?: { requestId: string; name: string; secretType: 'plain' | 'totp'; note?: string; shouldSave?: boolean; save?: boolean; saveScope?: string }
  /** send_secrets: answered request ids + names of ad-hoc secrets (rendered as a `secrets` attachment row). */
  secretsSent?: { requestIds: string[]; names?: string[] }
  /** Official worklog classification: output events establish that Progress has work; input events feed its step list. */
  worklog?: 'output' | 'input'
  /** Upstream editor events remain Progress steps but are omitted from the transcript when the official row is represented by a paired multi-edit event. */
  hiddenTranscript?: boolean
  /** user_message: screenshot per quote block (same order as the `<quoted_artifact>` markup). */
  quoteMeta?: (QuoteMeta | null)[]
  /** user_message (share projection): quotes already parsed server-side, body carries no quote markup. */
  quotes?: QuoteAttachment[]
  /** Staged-upload attachments carried structurally (local backend). Legacy
   * items may still embed `ATTACHMENT:"url"` markers in body — splitAttachments
   * remains the fallback parser. */
  attachments?: { url: string; name?: string; mime?: string; size?: number }[]
  /** read of an image file: workspace path, preview via file-raw endpoint. */
  image?: { path: string }
  pr?: PrInfo
  /** Secondary-tint pill after the title (official subagent profile / agent id). */
  badge?: string
  /** MCP call/list detail payload projected by the Worker. */
  mcp?: { toolName?: string; server?: string; displayName?: string; input?: string; output?: string; pending?: boolean; list?: boolean }
  /** Secondary trailing text ("— failed", "Canceled"). */
  suffix?: string
  /** Prominent callout variant (official ReportBlockerCard banner). */
  callout?: 'error' | 'warning' | 'info'
  /** dw_notice machine tag: 'conflict' = session open in another process;
   * 'error:<stage>' otherwise. Localizes the card into actionable guidance. */
  notice_kind?: string
  subagent?: { finished: boolean; failed: boolean; actions?: { label: string; ts: string }[]; truncated?: boolean; agentId?: string; title?: string; task?: string; profile?: string; model?: string; isBackground?: boolean; depth?: number; summary?: string }
  /** Official scripted_tools_group children (tool rows emitted inside the script). */
  nested?: { label: string; ts: string }[]
  /** search_files: repo-relative matched files (expandable list). */
  resultFiles?: string[]
  /** Scripted run this row belongs to when its `scripted_tools_started` row is on another page. */
  runId?: string
  raw_type: string
}

/** Official subagent worklog: title, profile pill, " — failed" when the run ended unsuccessfully. */
export function RowDecor({ item }: { item: TimelineItem }) {
  const failed = item.subagent?.finished && item.subagent.failed
  if (!item.badge && !item.suffix && !failed) return null
  return (
    <>
      {item.badge && (
        <span className="ml-1 inline-flex h-[18px] shrink-0 items-center rounded-[4px] bg-muted px-1.5 text-[11px] font-medium leading-none text-muted-foreground">{item.badge}</span>
      )}
      {failed && <span className="shrink-0 text-muted-foreground">{' — failed'}</span>}
      {item.suffix && <span className="ml-1 shrink-0 text-muted-foreground">{item.suffix}</span>}
    </>
  )
}

/**
 * Official `browser_preview` chip (`Uf`): 360px tinted button with a globe tile,
 * the preview name and `localhost:<port><path>`. The mirror has no preview tunnel,
 * so the chip is static.
 */
export function BrowserPreviewChip({ item }: { item: TimelineItem }) {
  const { t } = useTranslation()
  return (
    <div className="pb-2.5" data-eid={item.id}>
      <div
        aria-label={item.title || t('tl.preview')}
        data-testid="transcript-browser-preview"
        className="flex w-[360px] max-w-full items-center gap-2.5 rounded-[10px] bg-tint-tertiary p-1.5 pr-3 text-left"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-[6px] bg-card text-muted-foreground shadow-sm">
          <Globe size={16} />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[13px] font-medium leading-[18px] text-foreground">{item.title || 'Preview'}</span>
          <span className="truncate text-[12px] leading-[16px] tabular-nums text-muted-foreground">{item.body || item.title || 'Preview'}</span>
        </span>
      </div>
    </div>
  )
}

/** Official prominent callout (`ReportBlockerCard` hard/soft-blocked banner): variant-tinted card with title + headline. */
export function CalloutCard({ item, timestamp }: { item: TimelineItem; timestamp?: string }) {
  const { t } = useTranslation()
  const conflict = item.notice_kind === 'conflict'
  const v = item.callout || 'warning'
  const tone = v === 'error'
    ? 'border-red-500/30 bg-red-500/[0.06] text-red-700 dark:text-red-300'
    : v === 'info'
      ? 'border-blue-500/30 bg-blue-500/[0.06] text-blue-700 dark:text-blue-300'
      : 'border-amber-500/30 bg-amber-500/[0.06] text-amber-700 dark:text-amber-300'
  const Icon = conflict ? Monitor : v === 'error' ? XCircle : v === 'info' ? AlertCircle : AlertTriangle
  return (
    <div className="my-2 w-full min-w-0" data-eid={item.id} data-testid="transcript-report-blocker">
      <div className={cn('flex items-start gap-2.5 rounded-[12px] border px-3 py-2.5', tone)}>
        <Icon size={16} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <span className="min-w-0 flex-1 text-[13px] font-medium leading-[18px]">{conflict ? t('tl.conflictTitle') : item.title}</span>
            {timestamp && <span className="shrink-0 text-[12px] leading-[18px] text-muted-foreground">{timestamp}</span>}
          </div>
          {conflict && <p className="mt-0.5 break-words text-[13px] leading-[18px] text-foreground">{t('tl.conflictBody')}</p>}
          {conflict && <p className="mt-1 break-words font-mono text-[11px] leading-[15px] opacity-60">{item.title}</p>}
          {!conflict && item.body && <p className="mt-0.5 break-words text-[13px] leading-[18px] text-foreground">{item.body}</p>}
        </div>
      </div>
    </div>
  )
}

/** Official search_files expansion: 200px capped list, basename + muted parent path per match. */
export function SearchResultFiles({ files }: { files: string[] }) {
  return (
    <div data-testid="transcript-search-results" className="flex max-h-[200px] flex-col gap-0.5 overflow-y-auto">
      {files.map((f) => {
        const parts = f.split('/').filter(Boolean)
        const name = parts[parts.length - 1] ?? f
        const dir = parts.slice(0, -1).join('/')
        return (
          <div key={f} title={f} className="flex shrink-0 items-center gap-1 truncate text-nowrap text-[12px] text-muted-foreground">
            <FileIcon path={f} size={14} className="shrink-0" />
            <span>{name}</span>
            {dir && <span className="min-w-0 flex-1 truncate text-[11px] opacity-70">{dir}</span>}
          </div>
        )
      })}
    </div>
  )
}

/** Official scripted_tools_group nested body: the run row itself, then each child tool row. */
export function ScriptedChildren({ item, time }: { item: TimelineItem; time: (ts: string) => string }) {
  const rows = [{ label: item.kind === 'shell_done' ? i18n.t('tl.ranScripted') : i18n.t('tl.runningScripted'), ts: item.ts }, ...(item.nested || [])]
  return (
    <ol data-testid="transcript-scripted-children" className="mt-1 rounded-[10px] border border-border bg-card py-1 text-[13px] leading-[18px] text-muted-foreground">
      {rows.map((a, i) => (
        <li key={i} className="flex items-start gap-2 px-2.5 py-0.5">
          <span className="min-w-0 flex-1 truncate">{a.label}</span>
          {a.ts && <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground/70">{time(a.ts)}</span>}
        </li>
      ))}
    </ol>
  )
}

/** Expanded body of an official subagent row: one line per aggregated action with its time. */
export function SubagentActions({ run, time }: { run: NonNullable<TimelineItem['subagent']>; time: (ts: string) => string }) {
  const { t } = useTranslation()
  return (
    <ol className="mt-1 max-h-[300px] overflow-y-auto rounded-[10px] border border-border bg-card py-1 text-[12px] leading-[18px] text-muted-foreground">
      {(run.actions ?? []).map((a, i) => (
        <li key={i} className="flex items-start gap-2 px-2.5 py-0.5">
          <span className="min-w-0 flex-1 break-words">{a.label}</span>
          {a.ts && <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground/70">{time(a.ts)}</span>}
        </li>
      ))}
      {run.truncated && <li className="px-2.5 py-0.5 text-[11px] text-muted-foreground/70">{t('ti.earlier')}</li>}
      {(run.actions?.length ?? 0) === 0 && <li className="px-2.5 py-0.5 text-[11px] text-muted-foreground/70">{run.finished ? t('tl.finished') : t('tl.running')}</li>}
    </ol>
  )
}

/** Official permission_request projection (server-derived; raw `toolArgs` only ever present for admins). */
export interface PermissionInfo {
  requestId: string
  toolName?: string
  permissionType?: string
  toolArgs?: string
  resolved?: 'approved' | 'denied'
  title?: string
  resolvedTitles?: { approved: string; denied: string }
  actionLabel?: string
  actionPrimary?: boolean
  resourceTitle?: string
  resourceBody?: string
  resourceMetadata?: { label: string; value: string }[]
  details?: { label: string; value: string }[]
  localMachine?: boolean
  workflow?: { name?: string; scriptLineCount?: number; timeoutSecs?: number }
  sessionRequests?: { title: string; prompt: string }[]
  automationAction?: 'create' | 'update' | 'delete' | 'run'
  mcpInstall?: boolean
}

export interface TodoRow {
  status: string
  content: string
  activeForm?: string
}

/** Official todo row label: active_form only while in progress, else content. */
export function todoLabel(t: TodoRow): string {
  return t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content
}

/**
 * Official todo_update row title (transcript bundle `cd`/`id`): action-based
 * wording when the event carries one, otherwise "Created N task(s)" or
 * "<done-or-active>/<total> <active label>".
 */
export function todoTitle(item: TimelineItem): string {
  const todos = item.todos || []
  const a = item.todoAction
  const action = a?.action || (todos.length > 0 && todos.every((t) => t.status !== 'completed') ? 'created' : undefined)
  const subject = a?.subject ? ` ${a.subject}` : ''
  switch (action) {
    case 'created': {
      const n = a?.action === 'created' && typeof a.createdCount === 'number' ? a.createdCount : todos.length
      return i18n.t('tl.todoCreated', { count: n })
    }
    case 'deleted': return i18n.t('tl.todoDeleted', { subject })
    case 'updated': return i18n.t('tl.todoUpdated', { subject })
    case 'started': return i18n.t('tl.todoStarted', { subject })
    case 'completed': return i18n.t('tl.todoCompleted', { subject })
  }
  if (todos.length === 0) return i18n.t('tl.planUpdated')
  const done = todos.filter((t) => t.status === 'completed').length
  let idx = todos.findIndex((t) => t.status === 'in_progress')
  const pos = idx === -1 ? done : idx + 1
  if (idx === -1) {
    for (let i = todos.length - 1; i >= 0; i--) if (todos[i].status === 'completed') { idx = i; break }
  }
  const label = idx === -1 ? '' : todoLabel(todos[idx])
  return `${pos}/${todos.length}${label ? ` ${label}` : ''}`
}

/**
 * Official standalone set (`Se`/`Ce` in app-initial): these never fold into a "Worked for"
 * group. Split by renderer: git rows/cards vs. plain worklog rows. Everything else
 * (incl. `pr_merged`, `ci_failed`, `stop_command`, `note_used`) is grouped.
 */
export const STANDALONE_GIT_TYPES = new Set(['pr_created', 'ack_branch_push', 'pr_merge_conflict', 'pr_comment'])
export const STANDALONE_ROW_TYPES = new Set([
  'knowledge_update', 'mcp_auth_request', 'mcp_auth_success', 'mcp_auth_error', 'skill_pr_suggestion',
  'first_session_message', 'devin_suspended', 'model_degradation', 'remote_provisioning_status', 'report_blocker',
  'auto_route_decision', 'wait_command_start', 'browser_preview', 'network_access_request', 'local_access_requested',
])

/** Official grouper `Li`: a thought's end is its timestamp plus thinking duration. */
export function itemEndMs(it: TimelineItem): number {
  const t = new Date(it.ts).getTime()
  if (Number.isNaN(t)) return NaN
  return it.kind === 'thought' && it.durationMs ? t + it.durationMs : t
}

/** Official grouper: consecutive worklog events more than 5 minutes apart start a new group (`va=5`). */
export const GROUP_GAP_MS = 5 * 60 * 1000

/** "Worked for" span: first member timestamp → last member end (`duration_start_ms` → `duration_end_ms`). */
export function workSeconds(items: TimelineItem[]): number {
  const first = new Date(items[0].ts).getTime()
  const last = itemEndMs(items[items.length - 1])
  return Number.isNaN(first) || Number.isNaN(last) ? 0 : Math.max(1, Math.round((last - first) / 1000))
}

export const ICONS = {
  message: MessageSquare,
  thought: Brain,
  activity: Activity,
  shell: Terminal,
  shell_done: CheckCircle2,
  status: Info,
  computer: Monitor,
  todo: ListTodo,
  edit: FilePen,
  read: Eye,
  git: GitBranch,
  search: Search,
  question: MessageCircleQuestion,
  answer: MessageSquare,
  workflow: Workflow,
  workflow_agent: Bot,
  permission: ShieldQuestion,
  bot_flag: Flag,
  env_suggestion: Lightbulb,
  secret_request: KeyRound,
  secrets_sent: KeyRound,
  other: Info,
} as const

function time(ts: string): string {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('zh-CN', { hour12: false })
}

/** Official thought duration: ceil to seconds, "1m 30s" / "2m" / "45s". */
export function fmtThoughtDur(ms: number): string {
  const total = Math.ceil(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`
  return `${s}s`
}

/** Official "Worked for" duration: h/m/s parts, seconds dropped once hours appear, "a bit" for 0. */
export function fmtWorkedDur(ms: number, fallback = i18n.t('tl.aBit')): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const parts: string[] = []
  if (h > 0) parts.push(`${h}h`)
  if (m > 0) parts.push(`${m}m`)
  if (s > 0 && h === 0) parts.push(`${s}s`)
  return parts.length ? parts.join(' ') : fallback
}

/** Official `fx`: the shell row label is the command itself — quoted strings
 * longer than 20 chars collapse to `"..."`, then the text caps at Ax=3 words
 * with `...`. Empty body falls back to the devin-provided title. */
export function shellLabel(cmd: string): string {
  const t = cmd.replace(/(["'])([\s\S]*?)\1/g, (m, q: string, inner: string) =>
    inner.length > 20 ? `${q}...${q}` : m,
  )
  const words = t.split(' ')
  return words.length > 3 ? `${words.slice(0, 3).join(' ').trimEnd()}...` : t
}

/** Row labels use the same wording as the official session page (sampled from app.devin.ai). */
export function heading(item: TimelineItem): string {
  switch (item.kind) {
    case 'thought':
      return item.durationMs ? i18n.t('tl.thoughtFor', { dur: fmtThoughtDur(item.durationMs) }) : i18n.t('tl.thoughts')
    case 'shell':
      return shellLabel(item.body ?? '') || item.title || i18n.t('tl.ranCmd')
    case 'shell_done':
      return shellLabel(item.body ?? '') || item.title || i18n.t('tl.exitCode', { code: item.exitCode ?? '?' })
    case 'message':
      return item.role === 'user' ? item.title || i18n.t('common.user') : 'Devin'
    case 'status':
      return item.title || i18n.t('tl.status')
    case 'computer':
      return item.actions?.length ? item.actions[0] : item.title && item.title !== 'browser' ? item.title : i18n.t('tl.browsed')
    case 'todo':
      return todoTitle(item)
    case 'secret_request':
      return `${item.secretRequest?.save ? i18n.t('scc.saveSecret') : i18n.t('scc.credsReq')}${item.secretRequest?.name || ''}`
    case 'activity':
      return item.title || i18n.t('tl.activity')
    case 'edit': {
      const rows = fileRows(item.fileUpdates || [])
      if (rows.length === 0) return i18n.t('tl.editedFiles')
      if (rows.length === 1) return rows[0].label
      return i18n.t('tl.editedN', { n: rows.length })
    }
    case 'read':
      // Official row: "Read <name>:<range>, <name>" (multi_edit_result with read-only opens).
      return i18n.t('tl.read', { files: (item.fileUpdates || []).map(readLabel).join(', ') })
    case 'git':
      return item.title || 'Git'
    case 'search':
      return item.title || i18n.t('tl.searched')
    case 'question':
      return item.questions?.[0]?.question || i18n.t('ti.question')
    case 'answer':
      return item.answers?.join('、') || item.body || i18n.t('ti.answered')
    case 'workflow':
      return item.workflow?.status === 'running'
        ? (item.workflow.resumed ? i18n.t('tl.wfResuming') : i18n.t('tl.wfRunning'))
        : i18n.t('tl.wfRan')
    case 'workflow_agent':
      return i18n.t('tl.wfAgent', { label: item.agent?.label || '', status: item.agent?.status || '' }).trim()
    case 'bot_flag':
      return item.title || i18n.t('tl.botIgnored')
    case 'permission':
      return item.permission?.resolved
        ? i18n.t('tl.permDone', { tool: item.permission.toolName || i18n.t('tl.actionWord'), state: i18n.t(item.permission.resolved === 'approved' ? 'scc.approved' : 'scc.denied') })
        : item.title || i18n.t('tl.allowAction')
    default:
      return item.title || item.raw_type
  }
}

export default function Timeline({ items, error }: { items: TimelineItem[]; error?: string | null }) {
  const { t } = useTranslation()
  if (error === 'mirror_not_configured') {
    return <p className="text-xs text-muted-foreground">{t('ti.noMirror')}</p>
  }
  if (error === 'token_expired') {
    return <p className="text-xs text-amber-600">{t('ti.tokenExpired')}</p>
  }
  if (error) return <p className="text-xs text-red-600">{t('ti.mirrorFail')}{error}</p>
  if (!items.length) return <p className="text-xs text-muted-foreground">{t('ti.noEvents')}</p>

  return (
    <ol className="space-y-2.5">
      {items.map((item) => {
        const Icon = ICONS[item.kind]
        const failed = item.kind === 'shell_done' && item.exitCode !== '0'
        const FinalIcon = failed ? XCircle : Icon
        return (
          <li key={item.id} className="flex gap-2.5">
            <div className="flex flex-col items-center pt-0.5">
              <FinalIcon
                size={14}
                className={cn(
                  'shrink-0',
                  failed ? 'text-red-500' : item.kind === 'thought' ? 'text-violet-500' : 'text-muted-foreground',
                )}
              />
              <span className="mt-1 w-px flex-1 bg-border" />
            </div>
            <div className="min-w-0 flex-1 pb-1">
              <div className="flex items-baseline gap-2">
                <span className="text-xs font-medium">{heading(item)}</span>
                <span className="text-[10px] text-muted-foreground">{time(item.ts)}</span>
              </div>
              {item.body && (
                <pre
                  className={cn(
                    'mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted px-2.5 py-1.5 text-[11px] leading-relaxed',
                    item.kind === 'shell' || item.kind === 'shell_done' ? 'font-mono' : 'font-sans',
                  )}
                >
                  {item.body}
                </pre>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
