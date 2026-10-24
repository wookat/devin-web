import { useEffect, useState, type ReactNode } from 'react'
import { Code } from 'lucide-react'
import { viewer, sessionFetch } from '@/lib/viewer'
import { type TimelineItem, STANDALONE_GIT_TYPES, STANDALONE_ROW_TYPES, workSeconds, itemEndMs, GROUP_GAP_MS } from '@/components/Timeline'
import { mergeScriptedRuns, mergeShellPairs, mergeEnvLifecycle } from '@/components/TimelineMerges'
import { cn } from '@/lib/utils'
import { type Group, isLifecycleStatus } from './composerMeta'
import { dateLoc } from '@/lib/datetime'

const COACH_RECOMMENDATIONS: Record<string, string> = {
  no_plan_before_impl: 'composer.recPlan',
  non_work_usage: 'composer.recFocus',
  overkill_devin_mode: 'composer.recLighter',
  parallelizable_prompt: 'composer.recParallel',
  unrelated_followup_new_session: 'composer.recNewSession',
  use_code_scan: 'composer.recCodeScan',
}

// Official coach finding action labels (en locale bundle, verbatim).
const COACH_ACTIONS: Record<string, string> = {
  no_plan_before_impl: 'composer.coachPlan',
  non_work_usage: 'composer.coachClear',
  overkill_devin_mode: 'composer.coachMode',
  parallelizable_prompt: 'composer.coachParallel',
  unrelated_followup_new_session: 'composer.coachNewSession',
  use_code_scan: 'composer.coachScan',
}

interface TimelinePage {
  items: TimelineItem[]
  next_cursor: string | null
  error: string | null
  queue?: { id: string; text: string }[] | null
  activity?: { text: string } | null
  /** Server rebuilt the log (replay/ring-buffer): replace, don't merge —
   * `e${i}` ids collide across rebuilds and would overwrite real content. */
  reset?: boolean
  /** Log generation these items belong to; 0 = snapshot window (peek). WS
   * deltas carry the same field — mismatched generations are dropped. */
  gen?: number
  /** Peek response: served from snapshot, no session/load was performed. */
  peek?: boolean
  /** The last turn never settled (server died mid-prompt / turn cut) — the
   * original message so the composer area can offer a one-click resend. */
  interrupted?: { text: string; ts: number; kind?: 'continue' | 'resend'; attachments?: { url: string; name?: string; size?: number; mime?: string }[] }
  persona?: { mode: string; escalated: boolean } | null
}

/** Merge a freshly polled page into what we already have, keeping ids unique and order by time. */
function mergeItems(prev: TimelineItem[], next: TimelineItem[]): TimelineItem[] {
  const byId = new Map(prev.map((i) => [i.id, i]))
  // A server-side user twin (e<seq> `_local` echo or the replayed real one)
  // supersedes the optimistic local-* echo — otherwise the sent message
  // renders twice until send()'s delayed dedup gets around to removing it.
  const newUserTexts = new Set(
    next.filter((i) => i.kind === 'message' && i.role === 'user').map((i) => (i.body || '').trim()),
  )
  let changed = false
  if (newUserTexts.size) {
    for (const [id, it] of [...byId]) {
      if (id.startsWith('local-') && newUserTexts.has((it.body || '').trim())) { byId.delete(id); changed = true }
    }
  }
  for (const i of next) {
    const p = byId.get(i.id)
    // Same id ≠ same content: streaming chunks merge server-side into one item
    // (growing body, newer ts); tool rows update output/status in place. Keep
    // the OLD reference for untouched rows — memoized EventRows can then skip
    // re-rendering hundreds of items on every streaming delta.
    if (!p || p.ts !== i.ts || p.body !== i.body || p.title !== i.title || p.output !== i.output || p.durationMs !== i.durationMs || p.exitCode !== i.exitCode) {
      changed = true
      byId.set(i.id, i)
    }
  }
  if (!changed) return prev
  return [...byId.values()].sort((a, b) => a.ts.localeCompare(b.ts))
}

function groupItems(items: TimelineItem[], working = false): Group[] {
  items = mergeShellPairs(mergeEnvLifecycle(mergeScriptedRuns(items)))
  const groups: Group[] = []
  let buf: TimelineItem[] = []
  // Official Lm tracks the buffer's running end (`u`); a member whose own
  // start lands more than Vh=5 minutes past it closes the group.
  let bufEnd = 0
  const flush = (isLast = false) => {
    if (!buf.length) return
    // Official: a lone worklog event is not wrapped — EXCEPT the live tail,
    // where a single in-flight tool call/thought still gets its "Working for"
    // group instead of floating bare.
    if (buf.length < 2 && !(working && isLast)) {
      groups.push({ type: 'row', item: buf[0] })
    } else {
      groups.push({ type: 'work', items: buf, seconds: workSeconds(buf) })
    }
    buf = []
    bufEnd = 0
  }
  for (const it of items) {
    if (it.hiddenTranscript) continue
    if (isLifecycleStatus(it)) continue
    if (it.kind === 'workflow_agent' || (it.kind === 'workflow' && it.raw_type === 'workflow_run_completed')) {
      // aggregation-only events; the started row is the single transcript node, like the official page
      continue
    }
    if (it.kind === 'permission' && it.raw_type !== 'permission_request') continue
    // send_secrets: request answers only flip request cards to "Secret provided" (no row);
    // ad-hoc secrets render as a user message whose content is the `secrets` attachment group
    if (it.kind === 'secrets_sent') {
      if (it.secretsSent?.names?.length) { flush(); groups.push({ type: 'item', item: it }) }
      continue
    }
    if (it.raw_type === 'stop_command' || (it.kind === 'status' && it.title === 'Devin chose to stop working')) {
      buf.push(it)
      flush()
      continue
    }
    if (it.kind === 'message' || it.kind === 'workflow' || it.kind === 'permission' || it.kind === 'secret_request' || it.kind === 'env_suggestion' || it.kind === 'bot_flag' || STANDALONE_GIT_TYPES.has(it.raw_type || '') || (it.kind === 'status' && (it.title === 'Question skipped' || it.callout))) {
      flush()
      groups.push({ type: 'item', item: it })
    } else if (STANDALONE_ROW_TYPES.has(it.raw_type || '')) {
      flush()
      groups.push({ type: 'row', item: it })
    } else {
      const startMs = Date.parse(it.ts)
      if (bufEnd && !Number.isNaN(startMs) && startMs - bufEnd > GROUP_GAP_MS) flush()
      buf.push(it)
      const end = itemEndMs(it)
      if (!Number.isNaN(end)) bufEnd = Math.max(bufEnd, end)
    }
  }
  flush(true)
  return groups
}

function fmtDur(s: number): string {
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function time(ts: string): string {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(dateLoc(), { hour: 'numeric', minute: '2-digit' })
}

/** Official worklog-row / group gutter clock: h:mm without the AM/PM suffix. */
function rowClock(ts: string): string {
  return clock(ts).replace(/ [AP]M$/, '')
}

/** Official rows show a locale clock ("7:43 PM" / "22:07") on the right edge. */
function clock(ts: string): string {
  const d = new Date(ts)
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** Official participant-header timestamp: time today, weekday for the last six days, then date. */
function headerClock(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const day = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const days = Math.floor((day(now) - day(d)) / 86_400_000)
  const time = d.toLocaleTimeString(dateLoc(), { hour: 'numeric', minute: '2-digit' })
  if (days === 0) return time
  if (days > 0 && days <= 6) {
    return d.toLocaleDateString(dateLoc(), { weekday: 'short' }) + ` ${time}`
  }
  return d.toLocaleDateString(dateLoc(), {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  }) + `, ${time}`
}

/** Total added/removed lines of an edit event, rendered inline like the official page. */
function editStats(item: TimelineItem): { added: number; removed: number } | null {
  if (item.kind !== 'edit' || !item.fileUpdates?.length) return null
  let added = 0
  let removed = 0
  for (const f of item.fileUpdates) {
    added += f.lines_added ?? 0
    removed += f.lines_removed ?? 0
  }
  return { added, removed }
}

/** One-line summary shown next to the event heading, official-style. */
function preview(item: TimelineItem): string {
  if (item.kind === 'shell' || item.kind === 'shell_done') return (item.body || '').split('\n')[0].slice(0, 90)
  return ''
}

/** ANSI SGR → themed span colors (8 base + 8 bright). Non-SGR control
 * sequences (cursor motion, OSC) are stripped; \r overwrites are folded. */
const ANSI_FG: Record<number, string> = {
  30: 'text-neutral-800 dark:text-neutral-300', 31: 'text-red-600 dark:text-red-400', 32: 'text-emerald-600 dark:text-emerald-400',
  33: 'text-amber-600 dark:text-amber-400', 34: 'text-blue-600 dark:text-blue-400', 35: 'text-purple-600 dark:text-purple-400',
  36: 'text-cyan-600 dark:text-cyan-400', 37: 'text-neutral-500 dark:text-neutral-400',
  90: 'text-neutral-500', 91: 'text-red-500', 92: 'text-emerald-500', 93: 'text-amber-500',
  94: 'text-blue-500', 95: 'text-purple-500', 96: 'text-cyan-500', 97: 'text-neutral-300',
}
function foldCarriage(text: string): string {
  return text.split('\n').map((line) => {
    if (!line.includes('\r')) return line
    let buf = ''
    for (const part of line.split('\r')) buf = part.length >= buf.length ? part : part + buf.slice(part.length)
    return buf
  }).join('\n')
}
function AnsiText({ text }: { text: string }) {
  const cleaned = foldCarriage(text).replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[^0-9;?m\x1b]|\x1b\[[0-9;?]*m/g, (m) => (m.endsWith('m') ? m : ''))
  const spans: ReactNode[] = []
  let cls = ''
  let key = 0
  const re = /\x1b\[([0-9;]*)m/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(cleaned))) {
    if (match.index > last) spans.push(<span key={key++} className={cls || undefined}>{cleaned.slice(last, match.index)}</span>)
    for (const raw of match[1].split(';')) {
      const code = raw === '' ? 0 : Number(raw)
      if (code === 0) cls = ''
      else if (code === 1) cls += ' font-semibold'
      else if (code === 2) cls += ' opacity-70'
      else if (code === 3) cls += ' italic'
      else if (code === 4) cls += ' underline'
      else if (ANSI_FG[code]) cls = `${cls.replace(/ text-\S+/g, '')} ${ANSI_FG[code]}`
    }
    last = match.index + match[0].length
  }
  if (last < cleaned.length) spans.push(<span key={key++} className={cls || undefined}>{cleaned.slice(last)}</span>)
  return <>{spans}</>
}

/** Full terminal replay for a shell process. */
function TerminalBlock({ text, className, fill }: { text: string; className?: string; fill?: boolean }) {
  return (
    <div className={cn('mt-1 overflow-hidden rounded-[4px] border border-border bg-card', className)}>
      <pre
        className={cn('overflow-auto whitespace-pre px-2 py-2 text-[12px] leading-[16px] text-foreground', fill ? 'h-full min-h-0' : 'max-h-80')}
        style={{ fontFamily: '"Roboto Mono", ui-monospace, SFMono-Regular, Menlo, monospace' }}
      >
        <AnsiText text={text} />
      </pre>
    </div>
  )
}

const terminalCache = new Map<string, string>()
const terminalRequests = new Map<string, Promise<string | null>>()

function useFullTerminal(item: TimelineItem | null | undefined): string | undefined {
  const [text, setText] = useState(item?.terminal)
  const key = item?.terminalMore && item.processId
    ? `${viewer().id}:${item.processId}:${item.pageCursor ?? ''}:${item.terminal?.length}`
    : null
  useEffect(() => {
    let alive = true
    setText(item?.terminal)
    if (!item?.terminalMore || !item.processId || !key) return () => { alive = false }
    const cached = terminalCache.get(key)
    if (cached !== undefined) {
      setText(cached)
      return () => { alive = false }
    }
    let request = terminalRequests.get(key)
    if (!request) {
      request = sessionFetch<{ text: string | null }>(`/terminal?pid=${encodeURIComponent(item.processId)}${item.pageCursor ? `&cursor=${encodeURIComponent(item.pageCursor)}` : ''}`)
        .then((result) => {
          if (result.text != null) terminalCache.set(key, result.text)
          return result.text
        })
        .finally(() => { terminalRequests.delete(key) })
      terminalRequests.set(key, request)
    }
    request.then((full) => {
      if (alive && full != null) setText(full)
    }).catch(() => {})
    return () => { alive = false }
  }, [item, key])
  return text
}

function FullTerminal({ item }: { item: TimelineItem }) {
  const text = useFullTerminal(item)
  return text !== undefined ? <TerminalBlock text={text} /> : null
}


export { COACH_RECOMMENDATIONS, COACH_ACTIONS, type TimelinePage, mergeItems, groupItems, fmtDur, time, rowClock, clock, headerClock, editStats, preview, AnsiText, TerminalBlock, terminalCache, terminalRequests, useFullTerminal, FullTerminal };
