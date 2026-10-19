import { useEffect, useState } from 'react'
import { Code } from 'lucide-react'
import { viewer, sessionFetch } from '@/lib/viewer'
import { type TimelineItem, STANDALONE_GIT_TYPES, STANDALONE_ROW_TYPES, workSeconds, itemEndMs, GROUP_GAP_MS, mergeScriptedRuns, mergeShellPairs, mergeEnvLifecycle } from '@/components/Timeline'
import { cn } from '@/lib/utils'
import { type Group, isLifecycleStatus } from './composerMeta'

const COACH_RECOMMENDATIONS: Record<string, string> = {
  no_plan_before_impl: 'Ask Devin to confirm a plan before writing code to avoid mid-session rework',
  non_work_usage: 'Keep sessions focused on engineering work so your usage goes toward delivering results',
  overkill_devin_mode: 'Switch to a lighter mode for small, simple tasks',
  parallelizable_prompt: 'Run independent tasks in parallel child sessions',
  unrelated_followup_new_session: 'Start a new session so a fresh task gets a clean context',
  use_code_scan: 'Run a Code Scan to find every instance across whole repositories and track each finding',
}

// Official coach finding action labels (en locale bundle, verbatim).
const COACH_ACTIONS: Record<string, string> = {
  no_plan_before_impl: 'Create plan',
  non_work_usage: 'Clear prompt',
  overkill_devin_mode: 'Switch mode',
  parallelizable_prompt: 'Split into child sessions',
  unrelated_followup_new_session: 'Start new session',
  use_code_scan: 'Start a Code Scan',
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
  interrupted?: { text: string; ts: number; kind?: 'continue' | 'resend'; attachments?: { url: string; name?: string; size?: number; mime?: string }[] } | null
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
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
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
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (days === 0) return time
  if (days > 0 && days <= 6) {
    return d.toLocaleDateString('en-US', { weekday: 'short' }) + ` ${time}`
  }
  return d.toLocaleDateString('en-US', {
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

/** Full terminal replay for a shell process. */
function TerminalBlock({ text, className, fill }: { text: string; className?: string; fill?: boolean }) {
  return (
    <div className={cn('mt-1 overflow-hidden rounded-[4px] border border-border bg-white', className)}>
      <pre
        className={cn('overflow-auto whitespace-pre px-2 py-2 text-[12px] leading-[16px] text-[rgb(25,25,25)]', fill ? 'h-full min-h-0' : 'max-h-80')}
        style={{ fontFamily: '"Roboto Mono", ui-monospace, SFMono-Regular, Menlo, monospace' }}
      >
        {text}
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


export { COACH_RECOMMENDATIONS, COACH_ACTIONS, type TimelinePage, mergeItems, groupItems, fmtDur, time, rowClock, clock, headerClock, editStats, preview, TerminalBlock, terminalCache, terminalRequests, useFullTerminal, FullTerminal };
