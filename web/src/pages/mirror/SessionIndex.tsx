import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { type TimelineItem } from '@/components/Timeline'
import { PrStateIcon, mergeLivePr } from '@/components/PrCards'
import { cn, fmtTime } from '@/lib/utils'
import { type SessionDetail } from './pageBits'
import { ApiOriginGlyph } from './glyphs'
import { indexPreview } from './attachments'

/* Official transcript table-of-contents (deob: table-of-contents.js / Pe).
   Right-edge minimap of tick bars. Rail width follows the SCROLL PANE width
   via ResizeObserver — not the viewport: w-7 when the pane is ≤764px, w-[52px]
   above, and the whole rail unmounts below 448px.
   Hovering a tick expands it +8px with +5/+2px falloff onto neighbours —
   a pure-CSS cascade on --tick-grow (no JS animation). The popup is a
   non-modal popover: it opens on 175ms hover intent, click, or Enter/Space,
   slides in from the right (300ms spring ease + fade), and its right edge
   always sits 12px inside the rail's right edge (sideOffset = 12 − railW). */

// Official constants
const PENDING_TICK_W = ['w-3/5', 'w-4/5', 'w-2/5'] // skeleton ticks while older pages load
const MAX_ENTRIES = 200                            // official: >200 → rail renders empty
const TICKS = 20                                   // minimap shows the last 20 entries
const POPUP_ROWS = 200                             // popup list shows the last 200
const HOVER_OPEN_MS = 175                          // ge(175) hover intent

const prTickBg: Record<string, string> = {
  open: 'bg-green',
  draft: 'bg-text-secondary',
  merged: 'bg-purple',
  closed: 'bg-red',
}

function SessionIndex({ entries, active, scrollRef, stickBottom, userTookOver, cursor, olderPending, loadUntil, allItems, pullRequests, queued, onJump, onScrollBottom }: {
  entries: TimelineItem[]
  active: string | null
  scrollRef: RefObject<HTMLDivElement | null>
  stickBottom: MutableRefObject<boolean>
  userTookOver?: MutableRefObject<boolean>
  cursor: string | null
  olderPending?: boolean
  loadUntil: (eventId: string, ts: string) => Promise<void>
  allItems: TimelineItem[]
  pullRequests: SessionDetail['session']['pull_requests']
  queued: { id: string; text: string }[]
  onJump?: (eid: string) => boolean
  onScrollBottom?: () => void
}) {
  const { t } = useTranslation()
  const [indexOpen, setIndexOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const [idxTip, setIdxTip] = useState<{ id: string; top: number; right: number } | null>(null)
  const [paneW, setPaneW] = useState(0)
  const railRef = useRef<HTMLDivElement | null>(null)
  const popListRef = useRef<HTMLDivElement | null>(null)
  const openTimer = useRef(0)

  // Official: the rail's size tracks the transcript pane width (RO on the
  // scroll element), collapsing at ≤764 and hiding below 448.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    setPaneW(el.clientWidth)
    const ro = new ResizeObserver((es) => {
      const w = es[0]?.contentRect.width
      if (w) setPaneW(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [scrollRef])

  const narrow = paneW > 0 && paneW <= 764
  const idxTicks = useMemo(() => entries.slice(-TICKS), [entries])
  const popRows = useMemo(() => entries.slice(-POPUP_ROWS), [entries])
  const idxActive = active
  // Official skeleton ticks only while an older-page fetch is actually in
  // flight (olderPending) — a non-null cursor just means history exists.
  const pending = !!olderPending

  const clearTimers = () => {
    window.clearTimeout(openTimer.current)
  }
  const hoverEnter = useCallback(() => {
    clearTimers()
    openTimer.current = window.setTimeout(() => { setClosing(false); setIndexOpen(true) }, HOVER_OPEN_MS)
  }, [])
  useEffect(() => {
    if (!closing) return
    const t = window.setTimeout(() => { setIndexOpen(false); setClosing(false) }, 80)
    return () => window.clearTimeout(t)
  }, [closing])
  useEffect(() => clearTimers, [])

  // Non-modal popover: outside press closes (official floating-ui behaviour —
  // no backdrop dim).
  useEffect(() => {
    if (!indexOpen) return
    const h = (e: PointerEvent) => {
      if (!railRef.current?.contains(e.target as Node)) setClosing(true)
    }
    document.addEventListener('pointerdown', h)
    return () => document.removeEventListener('pointerdown', h)
  }, [indexOpen])

  // Opening lands on the NEWEST entry (list bottom) — same anchor the
  // transcript itself uses; the user scrolls up from there. Also clamps the
  // popup into the viewport (floating-ui's shift() equivalent): when the
  // pane's centre sits off the viewport's centre, the centred popup can
  // spill past the top/bottom — nudge it back inside.
  useEffect(() => {
    if (!indexOpen) return
    const list = popListRef.current
    if (list) list.scrollTop = list.scrollHeight
    const pop = list?.closest<HTMLElement>('[role=dialog]')
    if (!pop) return
    const raf = requestAnimationFrame(() => {
      const r = pop.getBoundingClientRect()
      const dy = Math.max(8 - r.top, Math.min(0, window.innerHeight - 8 - r.bottom))
      if (dy) pop.style.translate = `0 calc(-50% + ${dy}px)`
    })
    return () => cancelAnimationFrame(raf)
  }, [indexOpen])

  // Roving tabindex inside the popup list (official keyboard navigation).
  const onListKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { setClosing(true); return }
    const items = Array.from(popListRef.current?.querySelectorAll<HTMLElement>('[data-roving-item]') ?? [])
    if (items.length === 0) return
    const cur = items.indexOf(document.activeElement as HTMLElement)
    let next = cur
    if (e.key === 'ArrowDown') next = Math.min(cur + 1, items.length - 1)
    else if (e.key === 'ArrowUp') next = Math.max(cur - 1, 0)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = items.length - 1
    else return
    e.preventDefault()
    items[next]?.focus()
  }, [])

  const jumpTo = useCallback(async (it: TimelineItem) => {
    // Virtualized transcript: jump by row index — rows folded into a
    // collapsed work group share the group's row.
    stickBottom.current = false
    if (userTookOver) userTookOver.current = true
    if (!(onJump?.(it.id) ?? false) && cursor) {
      // entry beyond the loaded window — backfill history first (official full-history index jump)
      await loadUntil(it.id, it.ts)
      await new Promise((res) => requestAnimationFrame(res))
    }
    if (!(onJump?.(it.id) ?? false)) {
      const target = new Date(it.ts).getTime()
      const byDist = [...allItems].sort(
        (a, b) => Math.abs(new Date(a.ts).getTime() - target) - Math.abs(new Date(b.ts).getTime() - target),
      )
      for (const cand of byDist) {
        if (onJump?.(cand.id)) break
      }
    }
    // Official jump feedback: mark the landed row once it mounts.
    requestAnimationFrame(() => {
      const node = scrollRef.current?.querySelector<HTMLElement>(`[data-eid="${CSS.escape(it.id)}"]`)
      if (node) {
        node.classList.add('dw-find-hit')
        window.setTimeout(() => node.classList.remove('dw-find-hit'), 1600)
      }
    })
  }, [allItems, cursor, loadUntil, onJump, scrollRef, stickBottom, userTookOver])

  const scrollBottom = () => {
    // Canonical bottom anchor: AdminMirror's scrollToBottom re-engages the
    // stick latch before jumping, so the resize pin lands on the REAL bottom
    // (a smooth scrollTo's stale scrollHeight target always falls short).
    onScrollBottom?.()
    setClosing(true)
  }

  // Official: the rail is always mounted (quote-safe-area anchor) but only
  // carries content when there is something to index — ≤3 entries or >200.
  const railCls = cn('pointer-events-none absolute bottom-2.5 right-0 top-2.5 z-30 flex flex-col justify-center', narrow ? 'w-7' : 'w-[52px]')
  if (paneW > 0 && paneW < 448) return null
  if (entries.length === 0 || (entries.length <= 3 && !pending) || entries.length > MAX_ENTRIES) {
    return <div data-quote-safe-area="true" ref={railRef} className={railCls} />
  }

  const tick = (it: TimelineItem) => {
    const pr = it.kind === 'git' ? mergeLivePr(it.pr || {}, pullRequests) : null
    const bg = it.id === idxActive
      ? 'bg-foreground'
      : pr
        ? (prTickBg[pr.draft ? 'draft' : (pr.state ?? 'open')] ?? 'bg-green')
        : 'bg-tint-secondary'
    return (
      // Official tick: a bare h-[1.5px] bar at gap-2 pitch inside the single
      // rail button. The grow cascade (hovered +8px, neighbours +5/+2px) lives
      // on the bar itself — expansion is leftwards via negative margin.
      <div
        key={it.id}
        className={cn('tl-tick h-[1.5px] w-full rounded-full [--tick-grow:0px] transition-[margin-left,width] duration-150 hover:[--tick-grow:8px] [.tl-tick:hover+&]:[--tick-grow:5px] [.tl-tick:hover+.tl-tick+&]:[--tick-grow:2px] [&:has(+.tl-tick:hover)]:[--tick-grow:5px] [&:has(+.tl-tick+.tl-tick:hover)]:[--tick-grow:2px]', bg)}
        style={{ marginLeft: 'calc(-1 * var(--tick-grow))', width: 'calc(100% + var(--tick-grow))' }}
      />
    )
  }

  const popRow = (it: TimelineItem) => (
    <button
      key={it.id}
      type="button"
      data-roving-item
      onMouseEnter={(e) => {
        if (it.kind !== 'message' || !(it.body || '').trim()) { setIdxTip(null); return }
        const r = e.currentTarget.getBoundingClientRect()
        setIdxTip({ id: it.id, top: r.top, right: r.left - 8 })
      }}
      onMouseLeave={() => setIdxTip(null)}
      onClick={() => { setClosing(true); void jumpTo(it) }}
      className="flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] hover:bg-accent"
    >
      {it.kind === 'git' ? (
        (() => {
          const pr = mergeLivePr(it.pr || {}, pullRequests)
          return (
            <>
              <PrStateIcon state={pr.state} draft={pr.draft} size={16} />
              <span className="min-w-0 shrink-0 truncate">{pr.pullNumber !== undefined ? `#${pr.pullNumber}` : 'PR'}</span>
              {pr.additions !== undefined || pr.deletions !== undefined ? (
                <span className="flex shrink-0 gap-0.5">
                  <span className="text-[rgb(0,165,88)]">+{pr.additions ?? 0}</span>
                  <span className="text-[#f53b3a]">−{pr.deletions ?? 0}</span>
                </span>
              ) : null}
            </>
          )
        })()
      ) : (
        <>
          {/* Official: only non-web (API) user messages get the 16px circular glyph; web messages are plain pl-6 rows */}
          {it.origin && it.origin !== 'web' ? (
            <>
              <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted">
                <ApiOriginGlyph />
              </span>
              <span className="truncate">{indexPreview(it.body || '')}</span>
            </>
          ) : (
            <span className="min-w-0 flex-1 truncate pl-6">{indexPreview(it.body || '')}</span>
          )}
          <span className="ml-auto shrink-0 pl-2 text-[11px] text-muted-foreground">{fmtTime(it.ts)}</span>
        </>
      )}
    </button>
  )

  return (
    <div
      ref={railRef}
      data-quote-safe-area="true"
      className={railCls}
      onMouseEnter={hoverEnter}
      onMouseLeave={clearTimers}
    >
      <button
        type="button"
        aria-label={t('am.sessionIndex')}
        aria-haspopup="dialog"
        aria-expanded={indexOpen}
        onClick={() => { setClosing(false); setIndexOpen((v) => !v) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setClosing(false)
            setIndexOpen(true)
          }
        }}
        className={cn('pointer-events-auto cursor-pointer py-2', narrow ? 'mr-1' : 'mr-2')}
      >
        <div
          className={cn(
            'animate-in fade-in flex flex-col gap-2 duration-300 motion-safe:transition-opacity',
            narrow ? 'pl-2 pr-1' : 'pl-4 pr-2',
            indexOpen ? 'opacity-0' : 'opacity-100',
          )}
        >
          {pending && PENDING_TICK_W.map((w) => (
            <div key={w} className={cn('h-[1.5px] rounded-full bg-tint-secondary', w)} />
          ))}
          {idxTicks.map(tick)}
        </div>
      </button>

      {indexOpen && (
        <div
          role="dialog"
          onKeyDown={onListKeyDown}
          // Official popover: side=left of the rail with sideOffset 12−railW —
          // its right edge lands 12px inside the rail's right edge at every
          // width; centred on the tick column; slide-in 20px + fade 300ms.
          // Non-modal and PERSISTENT — mouse-leave does not close it (outside
          // press / Escape / selection does), matching the official popover.
          className={cn(
            'dw-toc-pop pointer-events-auto absolute right-3 top-1/2 z-40 w-[280px] max-w-[calc(100vw-16px)] overflow-hidden rounded-[10px] border border-border bg-card/95 p-0 shadow-lg backdrop-blur',
            closing && 'dw-toc-pop-out',
          )}
        >
          <div ref={popListRef} className="max-h-[min(595px,calc(100vh-16px))] overflow-y-auto rounded-[10px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <div className="flex flex-col gap-0 p-1.5">
              {pending && PENDING_TICK_W.map((w, i) => (
                <div key={`p-${w}`} className="px-2 py-1.5 pl-8">
                  <div className={cn('h-[18px] rounded-sm bg-muted/60 animate-pulse', i === 0 && 'opacity-80')} />
                </div>
              ))}
              {popRows.map(popRow)}
              {queued.map((q) => (
                <button
                  key={`q-${q.id}`}
                  type="button"
                  data-roving-item
                  onClick={scrollBottom}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] hover:bg-accent"
                >
                  <span className="min-w-0 flex-1 truncate pl-6">{(q.text || '').split('\n')[0].slice(0, 80)}</span>
                </button>
              ))}
              <button
                type="button"
                data-roving-item
                onClick={scrollBottom}
                className="flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] hover:bg-accent"
              >
                <span className="min-w-0 flex-1 truncate pl-6 text-muted-foreground">{t('am.scrollBottom')}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {indexOpen && idxTip && (() => {
        const it = entries.find((x) => x.id === idxTip.id)
        if (!it) return null
        return (
          <div
            role="dialog"
            style={{
              position: 'fixed',
              top: Math.max(8, Math.min(idxTip.top, window.innerHeight - 308)),
              left: Math.max(8, Math.min(idxTip.right - 280, window.innerWidth - 288)),
            }}
            className="pointer-events-none z-50 max-h-[300px] w-[280px] max-w-[calc(100vw-16px)] overflow-hidden whitespace-pre-wrap rounded-[10px] border border-border bg-card p-2.5 text-left text-[13px] leading-[18px] shadow-lg"
          >
            {(it.body || '').slice(0, 1200)}
          </div>
        )
      })()}
    </div>
  )
}

export { SessionIndex }
