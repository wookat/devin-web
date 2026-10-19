import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { ArrowLeft, ChevronRight, ChevronLeft, Copy, RefreshCw, ArrowUp, Terminal, List, MessageSquare, Wrench, Pencil, FileCode2 } from 'lucide-react'
import { sessionFetch, screenshotUrl } from '@/lib/viewer'
import { type TimelineItem, heading, fileRows } from '@/components/Timeline'
import { TodoStatusIcon } from '@/components/StructuredCards'
import Markdown from '@/components/Markdown'
import { cn } from '@/lib/utils'
import { useFullTerminal, headerClock, fmtDur, clock } from './timelineUtil'
import { ChangesPanel } from './ChangesPanel'

type ProgressStep = { item: TimelineItem; id: string; tsMs: number }
type ProgressMarker = { timestamp: number; isUserInput: boolean; isNavigable: boolean; eventId: string; message?: string }
type ProgressGroup = { start: number; end: number; events: ProgressMarker[] }

function stripProgressMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_~>#-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function progressTimeline(events: ProgressMarker[]): {
  groups: ProgressGroup[]
  valueToPosition: (value: number) => number
  positionToValue: (position: number) => number
  firstNavigablePosition: number
  lastNavigablePosition: number
} {
  if (!events.length) return { groups: [], valueToPosition: () => 0, positionToValue: () => 0, firstNavigablePosition: 0, lastNavigablePosition: 100 }
  if (events.length === 1) {
    const position = events[0].isNavigable ? 50 : 0
    return {
      groups: [{ start: 0, end: 100, events }],
      valueToPosition: () => 50,
      positionToValue: () => events[0].timestamp,
      firstNavigablePosition: position,
      lastNavigablePosition: position,
    }
  }
  const grouped: ProgressMarker[][] = []
  let current: ProgressMarker[] = []
  for (const event of events) {
    if (event.isUserInput && current.length) {
      grouped.push(current)
      current = [event]
    } else {
      current.push(event)
    }
  }
  if (current.length) grouped.push(current)
  const minimum = Math.min(5, 100 / grouped.length / 4)
  let widths = grouped.map((group) => (group.length / events.length) * 100)
  const undersized = widths.map((width, index) => width < minimum ? index : -1).filter((index) => index >= 0)
  if (undersized.length && undersized.length < grouped.length) {
    const deficit = undersized.reduce((sum, index) => sum + minimum - widths[index], 0)
    const available = widths.reduce((sum, width, index) => undersized.includes(index) ? sum : sum + width, 0)
    widths = widths.map((width, index) => undersized.includes(index) ? minimum : width - (width / available) * deficit)
  }
  let cursor = 0
  const groups = grouped.map((eventsInGroup, index) => {
    const start = cursor
    cursor += widths[index]
    return { start, end: cursor, events: eventsInGroup }
  })
  const positions = new Map<number, number>()
  for (const group of groups) {
    group.events.forEach((event, index) => {
      positions.set(event.timestamp, group.events.length === 1 ? (group.start + group.end) / 2 : group.start + (index / (group.events.length - 1)) * (group.end - group.start))
    })
  }
  const nearest = (value: number) => {
    let result = 0
    let distance = Infinity
    for (const [timestamp, position] of positions) {
      const next = Math.abs(timestamp - value)
      if (next < distance) {
        result = position
        distance = next
      }
    }
    return result
  }
  const navigable = events.filter((event) => event.isNavigable)
  const navPositions = navigable.map((event) => ({ event, position: positions.get(event.timestamp) ?? nearest(event.timestamp) }))
  const positionToValue = (position: number) => {
    if (!navigable.length) return events[0].timestamp
    if (navigable.length === 1) return navigable[0].timestamp
    let before = -1
    let after = -1
    navPositions.forEach((entry, index) => {
      if (entry.position <= position) before = index
      if (entry.position >= position && after < 0) after = index
    })
    if (before < 0) return navigable[0].timestamp
    if (after < 0) return navigable[navigable.length - 1].timestamp
    if (before === after) return navigable[before].timestamp
    const left = navPositions[before]
    const right = navPositions[after]
    if (left.position === right.position) return left.event.timestamp
    return Math.round(left.event.timestamp + ((position - left.position) / (right.position - left.position)) * (right.event.timestamp - left.event.timestamp))
  }
  return {
    groups,
    valueToPosition: (value) => positions.get(value) ?? nearest(value),
    positionToValue,
    firstNavigablePosition: navPositions[0]?.position ?? 0,
    lastNavigablePosition: navPositions[navPositions.length - 1]?.position ?? 100,
  }
}

function WorklogPanel({ id, items, mt, onGoLive, onWake, jumpTo, finished, canLive, asleep }: {
  id: string
  items: TimelineItem[]
  mt: string
  onGoLive: () => void
  onWake?: () => void
  jumpTo?: string | null
  finished: boolean
  canLive: boolean
  asleep: boolean
}) {
  const steps = useMemo<ProgressStep[]>(() => {
    const doneByProcess = new Map<string, TimelineItem[]>()
    for (const item of items) {
      if (item.kind === 'shell_done' && item.processId) doneByProcess.set(item.processId, [...(doneByProcess.get(item.processId) || []), item])
    }
    return items.flatMap((item) => {
      if (item.kind === 'shell_done' || item.kind === 'status' || item.worklog === undefined) return []
      let folded = item
      if (item.kind === 'shell' && item.processId) {
        const done = doneByProcess.get(item.processId)
        if (done?.length) {
          const last = done[done.length - 1]
          folded = {
            ...item,
            exitCode: last.exitCode,
            terminal: item.startupCommand ? undefined : (last.terminal ?? item.terminal),
            terminalMore: last.terminalMore ?? item.terminalMore,
            pageCursor: last.pageCursor ?? item.pageCursor,
            output: done.map((entry) => entry.body).filter(Boolean).join('\n\n') || undefined,
          }
        }
      }
      const tsMs = new Date(item.ts).getTime()
      return [{ item: folded, id: item.id, tsMs }]
    }).filter((step) => Number.isFinite(step.tsMs))
  }, [items])
  const latestStep = useMemo(() => {
    let latest: ProgressStep | undefined
    for (const step of steps) {
      if (!latest || step.tsMs >= latest.tsMs) latest = step
    }
    return latest
  }, [steps])
  const events = useMemo<ProgressMarker[]>(() => {
    const list: { event: ProgressMarker; order: number }[] = []
    let order = 0
    steps.forEach((step) => list.push({ event: { timestamp: step.tsMs, isUserInput: false, isNavigable: true, eventId: step.id }, order: order++ }))
    items.forEach((item) => {
      if (item.kind !== 'message' || item.role !== 'user') return
      const timestamp = new Date(item.ts).getTime()
      if (!Number.isFinite(timestamp)) return
      list.push({ event: { timestamp, isUserInput: true, isNavigable: false, eventId: item.id, message: stripProgressMarkdown(item.body || item.title || '') }, order: order++ })
    })
    return list.sort((a, b) => a.event.timestamp - b.event.timestamp || a.order - b.order).map(({ event }) => event)
  }, [items, steps])
  const timeline = useMemo(() => progressTimeline(events), [events])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [stickySelectedId, setStickySelectedId] = useState<string | null>(null)
  const [replay, setReplay] = useState(false)
  const [broken, setBroken] = useState<Record<string, boolean>>({})
  const sliderRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!steps.length || !latestStep) {
      setSelectedId(null)
      return
    }
    if (jumpTo) return
    if (stickySelectedId && steps.some((step) => step.id === stickySelectedId)) {
      setSelectedId(stickySelectedId)
      return
    }
    if (stickySelectedId) setStickySelectedId(null)
    setReplay(false)
    setSelectedId(latestStep.id)
  }, [jumpTo, latestStep, stickySelectedId, steps])
  useEffect(() => {
    if (!jumpTo || !steps.length) return
    const direct = steps.find((candidate) => candidate.id === jumpTo)
    let step = direct
    if (!step) {
      const target = items.find((item) => item.id === jumpTo)
      const targetMs = target ? new Date(target.ts).getTime() : NaN
      if (Number.isFinite(targetMs)) {
        step = steps.reduce<ProgressStep | undefined>(
          (matched, candidate) => candidate.tsMs <= targetMs ? candidate : matched,
          undefined,
        )
      }
    }
    if (!step) return
    setStickySelectedId(null)
    setSelectedId(step.id)
    setReplay(step.id !== latestStep?.id)
  }, [items, jumpTo, latestStep, steps])
  const currentIndex = Math.max(0, steps.findIndex((step) => step.id === selectedId))
  const current = steps[currentIndex]
  const atEnd = !!current && current.id === latestStep?.id && !replay
  const selectStep = useCallback((index: number) => {
    if (!steps.length || !latestStep) return
    const next = Math.max(0, Math.min(steps.length - 1, index))
    setStickySelectedId(steps[next].id)
    setSelectedId(steps[next].id)
    setReplay(steps[next].id !== latestStep?.id)
  }, [latestStep, steps])
  const goToEnd = useCallback(() => {
    if (!steps.length || !latestStep) return
    setStickySelectedId(null)
    setSelectedId(latestStep.id)
    setReplay(false)
  }, [latestStep, steps.length])
  const goNext = useCallback(() => {
    if (atEnd) {
      goToEnd()
      return
    }
    selectStep(currentIndex + 1)
  }, [atEnd, currentIndex, goToEnd, selectStep])
  const goPrevious = useCallback(() => selectStep(currentIndex - 1), [currentIndex, selectStep])
  const setFromPosition = useCallback((clientX: number) => {
    const element = sliderRef.current
    if (!element || !steps.length) return
    const rect = element.getBoundingClientRect()
    const position = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100))
    const timestamp = timeline.positionToValue(position)
    let nearest = 0
    let distance = Infinity
    steps.forEach((step, index) => {
      const next = Math.abs(step.tsMs - timestamp)
      if (next < distance) {
        nearest = index
        distance = next
      }
    })
    selectStep(nearest)
  }, [selectStep, steps, timeline])
  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    setFromPosition(event.clientX)
    const move = (next: PointerEvent) => setFromPosition(next.clientX)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [setFromPosition])
  const currentPosition = current ? timeline.valueToPosition(current.tsMs) : 0
  const live = !finished && canLive
  const canWake = atEnd && live && asleep && !!onWake
  const title = current?.item
  const detailItems = useMemo(() => title ? [title] : [], [title])
  const fullTerminal = useFullTerminal(title)
  const command = title?.kind === 'shell' ? heading(title) : ''
  const fullCommand = title?.kind === 'shell' ? (title.body || command) : ''
  const hasWork = useMemo(() => items.some((it) => it.worklog === 'output'), [items])
  if (!hasWork || !steps.length) return <div className="flex h-full w-full items-center justify-center p-4 text-[13px] text-muted-foreground">Devin hasn't done any work yet...</div>
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden p-3">
      <div className="mx-1 mb-3 mt-1 shrink-0">
        {title.kind === 'thought' && title.body && <div className="mb-2 text-[14px] text-foreground"><Markdown text={title.body} variant="thoughts" /></div>}
        <div className="group/app-title relative text-[14px] text-muted-foreground">
          {title.mcp ? (
            title.mcp.list ? (
              <><List size={16} className="mr-1 inline" /><span>{title.title || 'Listed available MCP tools'}</span></>
            ) : (
              <><Wrench size={16} className="mr-1 inline" /><span>Called </span><span className="rounded bg-tint-secondary px-[3px] font-mono text-[13px] text-foreground">{title.mcp.toolName || 'tool'}</span><span> on </span><span className="rounded bg-tint-secondary px-[3px] font-mono text-[13px] text-foreground">{title.mcp.displayName || (title.mcp.server ? `${title.mcp.server} MCP server` : 'MCP server')}</span></>
            )
          ) : title.kind === 'shell' ? (
            <><Terminal size={16} className="mr-1 inline" /><span>Executed </span><span className="rounded bg-tint-secondary px-[3px] font-mono text-[13px] text-foreground [overflow-wrap:anywhere]">{command}</span></>
          ) : title.kind === 'edit' ? (
            <><Pencil size={16} className="mr-1 inline" />{fileRows(title.fileUpdates || []).length === 1 ? <><span>Edited </span><span className="rounded bg-tint-secondary px-[3px] font-mono text-[13px] text-foreground">{fileRows(title.fileUpdates || [])[0].filePath.split('/').pop() || fileRows(title.fileUpdates || [])[0].filePath}</span></> : <span>{heading(title)}</span>}</>
          ) : title.kind === 'read' ? (
            <><FileCode2 size={16} className="mr-1 inline" /><span>{heading(title)}</span></>
          ) : title.kind === 'message' && title.role === 'user' ? (
            <><MessageSquare size={16} className="mr-1 inline" /><span>You said</span></>
          ) : heading(title)}
          {command && <button type="button" aria-label="Copy command" title="Copy command" onClick={() => void navigator.clipboard.writeText(fullCommand)} className="absolute right-0 top-0 z-10 flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-within:opacity-100 group-hover/app-title:opacity-100"><Copy size={14} /></button>}
        </div>
      </div>
      <div className="-mx-2 flex min-h-0 flex-1 flex-col overflow-y-auto px-3">
        {title.mcp ? (
          <McpDetail item={title} />
        ) : title.kind === 'shell' ? (
          <div className="flex min-h-[50dvh] flex-grow flex-col overflow-hidden rounded-lg border border-border bg-background"><pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[13px] leading-4 text-foreground">{fullTerminal ?? title.terminal ?? title.output ?? ''}</pre></div>
        ) : title.kind === 'edit' ? (
          <ChangesPanel items={detailItems} embedded fileCardsOnly />
        ) : title.kind === 'read' ? (
          <ChangesPanel items={detailItems} embedded viewMode fileCardsOnly />
        ) : title.kind === 'message' && title.role === 'user' ? (
          <div className="flex flex-1 flex-col gap-2 p-4"><div className="whitespace-pre-wrap text-[14px] text-foreground">{title.body || title.title || ''}</div></div>
        ) : title.kind === 'computer' ? (
          (() => {
            const key = title.screenshotKeys?.[title.screenshotKeys.length - 1]
            if (!key) return null
            if (broken[key]) return <div className="flex min-h-0 flex-1 items-center justify-center"><div className="flex flex-col items-center gap-2 p-4 text-center"><span className="text-[14px] text-muted-foreground">Couldn't load image</span><button type="button" onClick={() => setBroken((previous) => { const next = { ...previous }; delete next[key]; return next })} className="flex cursor-pointer items-center gap-1 text-[14px] text-blue-600 hover:underline dark:text-blue-400"><RefreshCw size={14} />Retry</button></div></div>
            return <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden"><img loading="lazy" decoding="async" src={screenshotUrl(id, key, mt)} className="h-full w-full rounded-sm object-contain" alt="Browser screenshot" onError={() => setBroken((previous) => ({ ...previous, [key]: true }))} /></div>
          })()
        ) : title.body && title.kind !== 'thought' ? (
          <div className="flex flex-1 flex-col gap-2 overflow-hidden p-4"><div className="whitespace-pre-wrap text-[14px] text-muted-foreground">{title.body}</div></div>
        ) : null}
      </div>
      <div className="mx-1 mb-2 flex flex-col items-center">
        <div ref={sliderRef} role="slider" tabIndex={0} aria-label="Session timeline" aria-orientation="horizontal" aria-valuemin={Math.round(timeline.firstNavigablePosition)} aria-valuemax={100} aria-valuenow={Math.round(currentPosition)} aria-valuetext={atEnd ? 'Live' : headerClock(title.ts)} className="relative z-10 my-1 h-[10px] w-full cursor-pointer select-none self-stretch rounded-[4px] focus:outline-none" onPointerDown={onPointerDown} onKeyDown={(event) => { if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); goNext() } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); goPrevious() } }} onMouseEnter={() => sliderRef.current?.focus()}>
          {timeline.groups.map((group, index) => {
            const width = group.end - group.start
            const fill = currentPosition >= group.end ? 100 : currentPosition > group.start ? ((currentPosition - group.start) / width) * 100 : 0
            const marker = group.events[0]
            const bar = <div key={`${index}-${group.start}`} className="absolute" title={marker?.isUserInput ? `${headerClock(new Date(marker.timestamp).toISOString())}\n${marker.message || ''}` : undefined} style={{ left: index === 0 ? `${group.start}%` : `calc(${group.start}% + 1px)`, width: index === 0 ? `calc(${width}% - 0.5px)` : `calc(${width}% - 1px)`, height: 16, top: -5 }}><div className={cn('absolute left-0 w-full overflow-hidden', index === 0 && 'rounded-s-[2px]', index === timeline.groups.length - 1 && 'rounded-e-[2px]')} style={{ height: 10, top: 3, background: `linear-gradient(to right, color-mix(in srgb, var(--color-primary) 20%, var(--color-background)) 0%, var(--color-primary) 0% ${fill}%, color-mix(in srgb, var(--color-primary) 20%, var(--color-background)) ${fill}%)` }} /></div>
            return bar
          })}
          <div className="pointer-events-none absolute z-20 -translate-x-1/2 bg-primary" style={{ left: `${currentPosition}%`, width: 3, height: 16, top: -5 }} />
        </div>
        <div className="relative my-1 flex w-full items-center gap-2">
          <div className="flex items-center gap-1">
            <button type="button" aria-label="Previous step" onClick={goPrevious} disabled={currentIndex <= 0} className="flex size-7 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"><ChevronLeft size={14} /></button>
            <button type="button" aria-label="Next step" onClick={goNext} className="flex size-7 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"><ChevronRight size={14} /></button>
          </div>
          <button
            type="button"
            onClick={atEnd ? (canWake ? onWake : onGoLive) : goToEnd}
            className={!atEnd
              ? 'inline-flex items-center rounded-full border border-black/[0.08] bg-white px-[10px] py-0 text-[13px] leading-[18px] text-foreground hover:bg-accent dark:border-white/[0.08] dark:bg-[#1f1f1f]'
              : canWake
              ? 'inline-flex h-7 items-center rounded-full border border-black/[0.08] bg-white px-3 text-[13px] font-medium leading-[18px] text-foreground dark:border-white/[0.08] dark:bg-[#1f1f1f]'
              : cn(
                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] leading-[18px]',
                'bg-accent hover:bg-accent/80',
              )}
          >
            {atEnd ? (canWake ? 'Wake up to see live' : 'Go to live desktop') : 'Go to end'}
          </button>
        </div>
      </div>
    </div>
  )
}

function mcpCode(text: string | undefined): string {
  if (!text) return ''
  try {
    const parsed: unknown = JSON.parse(text)
    return JSON.stringify(parsed, null, 2)
  } catch {
    return text
  }
}

function McpSkeleton() {
  return (
    <div className="space-y-2">
      <span className="block h-3 w-3/4 animate-pulse rounded bg-muted-foreground/20" />
      <span className="block h-3 w-1/2 animate-pulse rounded bg-muted-foreground/20" />
      <span className="block h-3 w-5/6 animate-pulse rounded bg-muted-foreground/20" />
      <span className="block h-3 w-2/3 animate-pulse rounded bg-muted-foreground/20" />
      <span className="block h-3 w-3/4 animate-pulse rounded bg-muted-foreground/20" />
    </div>
  )
}

function McpDetail({ item }: { item: TimelineItem }) {
  const mcp = item.mcp
  if (!mcp) return null
  const codeClass = 'min-w-0 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-tint-secondary p-3 font-mono text-[12px] leading-[16px]'
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto">
      {!mcp.list && (
        <>
          <div>
            <div className="mb-2 text-[12px] font-medium text-muted-foreground">Input</div>
            <pre className={codeClass}>{mcpCode(mcp.input) || '{}'}</pre>
          </div>
          <div>
            <div className="mb-2 text-[12px] font-medium text-muted-foreground">Output</div>
            {mcp.pending ? <McpSkeleton /> : <pre className={codeClass}>{mcpCode(mcp.output)}</pre>}
          </div>
        </>
      )}
      {mcp.list && (
        <div>
          <div className="mb-2 text-[12px] font-medium text-muted-foreground">Output</div>
          {mcp.pending ? <McpSkeleton /> : <pre className={codeClass}>{mcpCode(mcp.output || item.body)}</pre>}
        </div>
      )}
    </div>
  )
}

function ProgressPanel({ items, id, status }: { items: TimelineItem[]; id: string; status: string }) {
  const latest = useMemo(() => [...items].reverse().find((it) => it.kind === 'todo'), [items])
  // Official Tasks panel data source: session detail latest_todo_contents —
  // covers sessions whose todo events fall outside the loaded event window.
  const [fetched, setFetched] = useState<{ content: string; status: string; activeForm?: string }[] | null>(null)
  useEffect(() => {
    if (latest?.todos?.length) return
    let alive = true
    void sessionFetch<{ tasks: { title: string; status: string }[] }>('/todos')
      .then((r) => { if (alive) setFetched(r.tasks.map((t) => ({ content: t.title, status: t.status }))) })
      .catch(() => {})
    return () => { alive = false }
  }, [id, latest])
  const todos = latest?.todos?.length ? latest.todos : fetched || []
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  const timings = useMemo(() => {
    const next = new Map<string, { startedAtMs?: number; completedAtMs?: number }>()
    for (const item of items) {
      if (item.kind !== 'todo') continue
      const ts = new Date(item.ts).getTime()
      if (!Number.isFinite(ts)) continue
      for (const todo of item.todos || []) {
        const timing = next.get(todo.content) || {}
        if (todo.status === 'in_progress' && timing.startedAtMs === undefined) timing.startedAtMs = ts
        if (todo.status === 'completed' && timing.completedAtMs === undefined) timing.completedAtMs = ts
        next.set(todo.content, timing)
      }
    }
    return next
  }, [items])
  const ago = useCallback((ts: number) => {
    const elapsed = now - ts
    return elapsed >= 0 && elapsed < 3_600_000 ? `${fmtDur(Math.floor(elapsed / 1000))} ago` : clock(new Date(ts).toISOString())
  }, [now])
  const live = status === 'working' || status === 'resumed' || status === 'restored'
  if (!todos.length) return <div className="p-4 text-[13px] leading-[18px]">No task list for this session yet.</div>
  const done = todos.filter((t) => t.status === 'completed').length
  return (
    <div className="flex flex-col gap-1.5 px-2 pb-4">
      <section className="flex flex-col gap-1.5">
        <div className="text-[12px] leading-[16px] text-muted-foreground">{done}/{todos.length} tasks completed</div>
        {todos.map((t, i) => (
          (() => {
            const timing = timings.get(t.content)
            const detail = t.status === 'in_progress' && timing?.startedAtMs !== undefined
              ? `started ${ago(timing.startedAtMs)}`
              : t.status === 'completed' && timing?.completedAtMs !== undefined
                ? `completed ${ago(timing.completedAtMs)}`
                : undefined
            const title = t.status === 'completed' && timing?.startedAtMs !== undefined && timing.completedAtMs !== undefined
              ? `Completed ${clock(new Date(timing.completedAtMs).toISOString())} · took ${fmtDur(Math.max(0, Math.floor((timing.completedAtMs - timing.startedAtMs) / 1000)))}`
              : undefined
            return (
              <div key={i} title={title} className="flex items-start gap-2.5">
                <TodoStatusIcon status={t.status} live={live} />
                <div className="min-w-0">
                  <span className={`block text-[13px] leading-[18px] ${t.status === 'completed' || t.status === 'in_progress' ? 'text-foreground' : 'text-muted-foreground'}`}>
                    {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}
                    {detail && <span className="ml-1.5 whitespace-nowrap text-muted-foreground/60">{detail}</span>}
                  </span>
                </div>
              </div>
            )
          })()
        ))}
      </section>
    </div>
  )
}


export { type ProgressStep, type ProgressMarker, type ProgressGroup, stripProgressMarkdown, progressTimeline, WorklogPanel, mcpCode, McpSkeleton, McpDetail, ProgressPanel };
