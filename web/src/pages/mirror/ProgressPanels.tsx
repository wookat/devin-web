import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '@/i18n'
import { ArrowLeft, ChevronRight, ChevronLeft, Copy, RefreshCw, ArrowUp, Terminal, List, MessageSquare, Wrench, Pencil, FileCode2, Loader2 } from 'lucide-react'
import { sessionFetch, screenshotUrl, fetchFileContents, viewer } from '@/lib/viewer'
import { FileIcon } from '@/lib/fileIcon'
import { type TimelineItem, type FileUpdate, heading, fileRows } from '@/components/Timeline'
import { useShikiTokens } from '@/components/CodeView'
import { TodoStatusIcon } from '@/components/StructuredCards'
import Markdown from '@/components/Markdown'
import { cn } from '@/lib/utils'
import { useFullTerminal, headerClock, fmtDur, clock, AnsiText } from './timelineUtil'
import { ChangesPanel } from './ChangesPanel'
import { copyText } from '../../lib/clipboard'

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
  const { t } = useTranslation()
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
  if (!hasWork || !steps.length) return <div className="flex h-full w-full items-center justify-center p-4 text-[13px] text-muted-foreground">{t('pp.noWork')}</div>
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden p-3">
      <div className="mx-1 mb-3 mt-1 shrink-0">
        {title.kind === 'thought' && title.body && <div className="mb-2 text-[14px] text-foreground"><Markdown text={title.body} variant="thoughts" /></div>}
        <div className="group/app-title relative text-[14px] text-muted-foreground">
          {title.mcp ? (
            title.mcp.list ? (
              <><List size={16} className="mr-1 inline" /><span>{title.title || t('pp.mcpListed')}</span><McpTitleChip item={title} /></>
            ) : (
              <><Wrench size={16} className="mr-1 inline" /><span>{t('pp.called')}</span><span className="rounded bg-tint-secondary px-[3px] font-mono text-[13px] text-foreground">{title.mcp.toolName || 'tool'}</span><span> {t('pp.onServer')} </span><span className="rounded bg-tint-secondary px-[3px] font-mono text-[13px] text-foreground">{title.mcp.displayName || (title.mcp.server ? t('pp.mcpServer', { name: title.mcp.server }) : t('pp.mcpServerGeneric'))}</span><McpTitleChip item={title} /></>
            )
          ) : title.kind === 'shell' ? (
            <><Terminal size={16} className="mr-1 inline" /><span>{t('pp.executed')}</span><span className="rounded bg-tint-secondary px-[3px] font-mono text-[13px] text-foreground [overflow-wrap:anywhere]">{command}</span></>
          ) : title.kind === 'edit' ? (
            <><Pencil size={16} className="mr-1 inline" />{fileRows(title.fileUpdates || []).length === 1 ? <><span>{t('pp.edited')}</span><span className="rounded bg-tint-secondary px-[3px] font-mono text-[13px] text-foreground">{fileRows(title.fileUpdates || [])[0].filePath.split('/').pop() || fileRows(title.fileUpdates || [])[0].filePath}</span></> : <span>{heading(title)}</span>}</>
          ) : title.kind === 'read' ? (
            <><FileCode2 size={16} className="mr-1 inline" /><span>{heading(title)}</span></>
          ) : title.kind === 'message' && title.role === 'user' ? (
            <><MessageSquare size={16} className="mr-1 inline" /><span>{t('pp.youSaid')}</span></>
          ) : heading(title)}
          {command && <button type="button" aria-label={t('pp.copyCmd')} title={t('pp.copyCmd')} onClick={() => void copyText(fullCommand)} className="absolute right-0 top-0 z-10 flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-within:opacity-100 group-hover/app-title:opacity-100"><Copy size={14} /></button>}
        </div>
      </div>
      <div className="-mx-2 flex min-h-0 flex-1 flex-col overflow-y-auto px-3">
        {title.mcp ? (
          <McpDetail item={title} />
        ) : title.kind === 'shell' ? (
          // Official ShellOutputRow: bordered card, "Command" + "Output"
          // sections, ANSI-rendered output, exit-code chip.
          <div className="flex min-h-[50dvh] flex-grow flex-col overflow-hidden rounded-lg border border-border bg-background">
            <div className="border-b border-border-secondary px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('pp.command')}</div>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words border-b border-border px-3 py-2 font-mono text-[12px] leading-[16px] text-foreground">{fullCommand || command}</pre>
            <div className="border-b border-border-secondary px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('pp.output')}</div>
            <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[13px] leading-4 text-foreground"><AnsiText text={fullTerminal ?? title.terminal ?? title.output ?? ''} /></pre>
            {title.exitCode !== undefined && title.exitCode !== null && (
              <div className="flex items-center gap-2 border-t border-border px-3 py-1.5">
                <span className={cn('rounded px-1.5 py-0.5 font-mono text-[11px]', title.exitCode === '0' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-red-500/10 text-red-600 dark:text-red-400')}>{t('pp.exitCode', { code: title.exitCode })}</span>
              </div>
            )}
          </div>
        ) : title.kind === 'edit' ? (
          <ChangesPanel items={detailItems} embedded fileCardsOnly />
        ) : title.kind === 'read' ? (
          <ReadView item={title} />
        ) : title.kind === 'message' && title.role === 'user' ? (
          <div className="flex flex-1 flex-col gap-2 p-4"><div className="whitespace-pre-wrap text-[14px] text-foreground">{title.body || title.title || ''}</div></div>
        ) : title.kind === 'computer' ? (
          (() => {
            const key = title.screenshotKeys?.[title.screenshotKeys.length - 1]
            if (!key) return null
            if (broken[key]) return <div className="flex min-h-0 flex-1 items-center justify-center"><div className="flex flex-col items-center gap-2 p-4 text-center"><span className="text-[14px] text-muted-foreground">{t('pp.imgFail')}</span><button type="button" onClick={() => setBroken((previous) => { const next = { ...previous }; delete next[key]; return next })} className="flex cursor-pointer items-center gap-1 text-[14px] text-blue-600 hover:underline dark:text-blue-400"><RefreshCw size={14} />{t('common.retry')}</button></div></div>
            return <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden"><img loading="lazy" decoding="async" src={screenshotUrl(id, key, mt)} className="h-full w-full rounded-sm object-contain" alt={t('pp.shotAlt')} onError={() => setBroken((previous) => ({ ...previous, [key]: true }))} /></div>
          })()
        ) : title.body && title.kind === 'message' ? (
          <div className="flex flex-1 flex-col gap-2 overflow-hidden p-4"><div className="text-[14px] text-foreground"><Markdown text={title.body} /></div></div>
        ) : title.body && title.kind !== 'thought' ? (
          <div className="flex flex-1 flex-col gap-2 overflow-hidden p-4"><div className="whitespace-pre-wrap text-[14px] text-muted-foreground">{title.body}</div></div>
        ) : null}
      </div>
      <div className="mx-1 mb-2 flex flex-col items-center">
        <div ref={sliderRef} role="slider" tabIndex={0} aria-label={t('pp.timeline')} aria-orientation="horizontal" aria-valuemin={Math.round(timeline.firstNavigablePosition)} aria-valuemax={100} aria-valuenow={Math.round(currentPosition)} aria-valuetext={atEnd ? t('pp.live') : headerClock(title.ts)} className="relative z-10 my-1 h-[10px] w-full cursor-pointer select-none self-stretch rounded-[4px] focus:outline-none" onPointerDown={onPointerDown} onKeyDown={(event) => { if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); goNext() } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); goPrevious() } }} onMouseEnter={() => sliderRef.current?.focus()}>
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
            <button type="button" aria-label={t('pp.prevStep')} onClick={goPrevious} disabled={currentIndex <= 0} className="flex size-7 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"><ChevronLeft size={14} /></button>
            <button type="button" aria-label={t('pp.nextStep')} onClick={goNext} className="flex size-7 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"><ChevronRight size={14} /></button>
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
            {atEnd ? (canWake ? t('pp.wakeLive') : t('pp.goLive')) : t('pp.goEnd')}
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

/** Mirror projections may carry untyped lifecycle fields alongside the
 * declared ones — read them defensively (local items only set pending/list). */
type McpInfo = NonNullable<TimelineItem['mcp']> & { status?: string; error?: string; rejected?: boolean; canceled?: boolean; cancelled?: boolean }

type McpState = 'pending' | 'canceled' | 'rejected' | 'failed' | 'done'

/** Normalize every signal a call can end with — explicit flags first, then
 * status strings, then the row-level markers failed tools carry. */
function mcpState(item: TimelineItem, mcp: McpInfo): McpState {
  const status = (mcp.status ?? '').toLowerCase()
  if (mcp.rejected === true || /reject|denied/.test(status)) return 'rejected'
  if (mcp.canceled === true || mcp.cancelled === true || /cancel/.test(status) || item.suffix === 'Canceled') return 'canceled'
  if (!!mcp.error || /fail|error/.test(status) || item.callout === 'error' || (item.suffix ?? '').includes('failed')) return 'failed'
  if (mcp.pending || /pending|progress|running/.test(status)) return 'pending'
  return 'done'
}

/** Small inline status pill for a non-normal MCP outcome (title row + detail). */
function McpTitleChip({ item }: { item: TimelineItem }) {
  const { t } = useTranslation()
  const mcp = item.mcp as McpInfo | undefined
  if (!mcp) return null
  const state = mcpState(item, mcp)
  if (state === 'done') return null
  const cls = state === 'failed'
    ? 'bg-red-500/10 text-red-600 dark:text-red-400'
    : state === 'pending'
      ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
      : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
  const label = state === 'pending' ? t('pp.mcpPending', { defaultValue: 'Running' })
    : state === 'rejected' ? t('pp.mcpRejected', { defaultValue: 'Rejected' })
      : state === 'canceled' ? t('pp.mcpCanceled', { defaultValue: 'Canceled' })
        : t('pp.mcpFailed', { defaultValue: 'Failed' })
  return (
    <span className={cn('ml-1.5 inline-flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 align-middle text-[11px] font-medium leading-none', cls)}>
      {state === 'pending' && <Loader2 size={10} className="animate-spin" />}{label}
    </span>
  )
}

/** Collapsible Input/Output block — long payloads stay foldable. */
function McpSection({ label, children }: { label: string; children: ReactNode }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(true)
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${open ? t('pp.collapse', { defaultValue: 'Collapse' }) : t('pp.expand', { defaultValue: 'Expand' })}: ${label}`}
        onClick={() => setOpen(!open)}
        className="mb-2 flex cursor-pointer items-center gap-1 text-[12px] font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronRight size={12} className={cn('shrink-0 transition-transform duration-150', open && 'rotate-90')} />{label}
      </button>
      {open && children}
    </div>
  )
}

function McpDetail({ item }: { item: TimelineItem }) {
  const { t } = useTranslation()
  const mcp = item.mcp as McpInfo | undefined
  if (!mcp) return null
  const state = mcpState(item, mcp)
  const codeClass = 'min-w-0 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-tint-secondary p-3 font-mono text-[12px] leading-[16px]'
  const output = (fallback?: string) => (
    state === 'pending' ? <McpSkeleton />
      : state === 'canceled' || state === 'rejected'
        ? <p className="px-1 text-[12px] text-muted-foreground">{t('pp.mcpNoOutput', { defaultValue: 'No output — the call did not complete.' })}</p>
        : <pre className={codeClass}>{mcpCode(mcp.output || fallback)}</pre>
  )
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto">
      {state === 'failed' && !!mcp.error && (
        <p className="break-words rounded-md border border-red-500/30 bg-red-500/[0.06] px-2.5 py-1.5 text-[12px] text-red-700 dark:text-red-300">{mcp.error}</p>
      )}
      {!mcp.list && (
        <>
          <McpSection label={t('pp.input')}><pre className={codeClass}>{mcpCode(mcp.input) || '{}'}</pre></McpSection>
          <McpSection label={t('pp.output')}>{output(state === 'failed' ? mcp.error : undefined)}</McpSection>
        </>
      )}
      {mcp.list && <McpSection label={t('pp.output')}>{output(item.body)}</McpSection>}
    </div>
  )
}

const READ_CONTEXT_LINES = 3

/**
 * Read-step detail: the actually-read line range inside the file — the range
 * ±3 lines of context, numbered, read lines tinted green (official read
 * region view). ChangesPanel's viewMode dumps the whole file body; this is
 * the compact per-range variant. */
function ReadView({ item }: { item: TimelineItem }) {
  const { t } = useTranslation()
  const files = item.fileUpdates ?? []
  const keys = useMemo(
    () => [...new Set(files.map((f) => f.fileId || f.contents_key || `path:${encodeURIComponent(f.file_path)}`))],
    [files],
  )
  const keysKey = keys.join('\n')
  const [texts, setTexts] = useState<Record<string, string> | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    setTexts(null)
    setFailed(false)
    if (!keys.length) return
    fetchFileContents(keys)
      .then((r) => { if (alive) { setTexts(r.files); setFailed(!!r.error) } })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
    // `keys` is derived from item.fileUpdates — the joined string is the
    // stable identity; re-running on array identity would refetch every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysKey])
  if (item.image) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        <img src={`/api/admin/session/${viewer().id}/file-raw?path=${encodeURIComponent(item.image.path)}`} alt={item.image.path} className="max-h-full max-w-full rounded-md border border-border object-contain" />
      </div>
    )
  }
  if (!files.length) {
    return item.body
      ? <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-card p-3 font-mono text-[12px] leading-[16px] text-muted-foreground">{item.body}</pre>
      : <div className="p-4 text-[13px] text-muted-foreground">{t('pp.readEmpty', { defaultValue: 'No file content captured for this read.' })}</div>
  }
  const textOf = (f: FileUpdate): string | null => {
    if (!texts) return null
    const k = f.fileId || f.contents_key || `path:${encodeURIComponent(f.file_path)}`
    return texts[k] ?? ''
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto">
      {files.map((f, i) => {
        const text = textOf(f)
        return (
          <div key={`${f.file_path}:${i}`} className="shrink-0 overflow-hidden rounded-lg border border-border bg-background">
            <div className="flex items-center gap-2 border-b border-border-secondary bg-wash px-3 py-1.5">
              <FileIcon path={f.file_path} size={13} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground" title={f.file_path}>{f.file_path.split(/[\\/]/).pop() || f.file_path}</span>
              {f.start_line !== undefined && f.end_line !== undefined && (
                <span className="shrink-0 rounded-[4px] bg-tint-green px-1.5 py-0.5 text-[11px] tabular-nums leading-none text-emerald-800 dark:text-emerald-300">{t('pp.readRange', { start: f.start_line, end: f.end_line, defaultValue: 'lines {{start}}–{{end}}' })}</span>
              )}
            </div>
            {text === null
              ? <div className="flex items-center gap-2 px-3 py-3 text-[12px] text-muted-foreground"><Loader2 size={13} className="animate-spin" />{t('common.loading')}</div>
              : text === ''
                ? <pre className="max-h-[50dvh] overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[12px] leading-[16px] text-muted-foreground">{item.body || t('chg.readFail')}</pre>
                : <ReadFileBody file={f} text={text} />}
          </div>
        )
      })}
      {failed && <p className="px-1 text-[11px] text-amber-600 dark:text-amber-400">{t('chg.readFail')}</p>}
    </div>
  )
}

/** One read file's range: numbered code lines, read region ±3 context lines,
 * green tint on the lines Devin actually opened, shiki token colors. */
function ReadFileBody({ file, text }: { file: FileUpdate; text: string }) {
  const lines = useMemo(() => text.split('\n'), [text])
  const start = file.start_line !== undefined && file.start_line >= 1 ? file.start_line : 1
  const end = file.end_line !== undefined && file.end_line >= start ? Math.min(file.end_line, lines.length) : lines.length
  const from = Math.max(1, start - READ_CONTEXT_LINES)
  const to = Math.min(lines.length, end + READ_CONTEXT_LINES)
  const windowText = useMemo(() => lines.slice(from - 1, to).join('\n'), [lines, from, to])
  const toks = useShikiTokens(windowText, file.file_path)
  const rows: ReactNode[] = []
  for (let lineNo = from; lineNo <= to; lineNo++) {
    const read = lineNo >= start && lineNo <= end
    const lineToks = toks?.[lineNo - from]
    rows.push(
      <div key={lineNo} className="col-span-2 grid grid-cols-subgrid" data-line-number={lineNo}>
        <div className={cn('select-none border-r border-border pl-[2ch] pr-[1ch] text-right text-[11px] leading-[20px]', read ? 'bg-tint-green text-foreground' : 'bg-card text-muted-foreground')}>
          {lineNo}
        </div>
        <div className={cn('whitespace-break-spaces break-all px-2 [overflow-wrap:anywhere]', read ? 'bg-tint-green' : 'bg-card')}>
          <code className="select-text break-all text-foreground">
            {lineToks?.length
              ? lineToks.map((tk, j) => (
                <span key={j} className={tk.color || tk.darkColor ? 'text-[var(--shiki-light)] dark:text-[var(--shiki-dark)]' : undefined} style={tk.color || tk.darkColor ? ({ '--shiki-light': tk.color, '--shiki-dark': tk.darkColor } as React.CSSProperties) : undefined}>{tk.content}</span>
              ))
              : lines[lineNo - 1] || '​'}
          </code>
        </div>
      </div>,
    )
  }
  return <div className="grid w-full grid-cols-[min-content_1fr] font-mono text-[12px] leading-[20px]">{rows}</div>
}

function ProgressPanel({ items, id, status }: { items: TimelineItem[]; id: string; status: string }) {
  const { t } = useTranslation()
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
  if (!todos.length) return <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center"><List size={18} className="text-muted-foreground" /><p className="text-[13px] leading-[18px] font-medium">{t('pp.noTodos')}</p></div>
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
              ? i18n.t('pp.todoDoneTip', { at: clock(new Date(timing.completedAtMs).toISOString()), dur: fmtDur(Math.max(0, Math.floor((timing.completedAtMs - timing.startedAtMs) / 1000))) })
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


export { type ProgressStep, type ProgressMarker, type ProgressGroup, stripProgressMarkdown, progressTimeline, WorklogPanel, mcpCode, McpSkeleton, type McpInfo, type McpState, mcpState, McpTitleChip, McpSection, McpDetail, ReadView, ReadFileBody, READ_CONTEXT_LINES, ProgressPanel };
