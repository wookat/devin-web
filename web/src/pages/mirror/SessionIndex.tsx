import { useMemo, useState, type MutableRefObject, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { type TimelineItem } from '@/components/Timeline'
import { PrStateIcon, mergeLivePr } from '@/components/PrCards'
import { cn, fmtTime } from '@/lib/utils'
import { type SessionDetail } from './pageBits'
import { ApiOriginGlyph } from './glyphs'
import { indexPreview } from './attachments'

/* Official session index: right-edge minimap of tick bars; popup (280px, opens left) lists user
   messages, item click scrolls the timeline while the popup stays open. */
function SessionIndex({ entries, active, scrollRef, stickBottom, cursor, loadUntil, allItems, pullRequests, queued }: {
  entries: TimelineItem[]
  active: string | null
  scrollRef: RefObject<HTMLDivElement | null>
  stickBottom: MutableRefObject<boolean>
  cursor: string | null
  loadUntil: (eventId: string, ts: string) => Promise<void>
  allItems: TimelineItem[]
  pullRequests: SessionDetail['session']['pull_requests']
  queued: { id: string; text: string }[]
}) {
  const { t } = useTranslation()
  const [indexOpen, setIndexOpen] = useState(false)
  const [idxTip, setIdxTip] = useState<{ id: string; top: number; right: number } | null>(null)
  const idxTicks = useMemo(() => entries.slice(-20), [entries])
  const idxActive = active
  const indexEntries = entries
  if (indexEntries.length === 0) return null
  return (
    <>
      {indexOpen && <div className="fixed inset-0 z-20" onClick={() => setIndexOpen(false)} />}
      <div data-quote-safe-area="true" className="pointer-events-none absolute bottom-2.5 right-0 top-2.5 z-30 flex w-7 flex-col justify-center md:w-[52px]">
        <button
          type="button"
          aria-label={t('am.sessionIndex')}
          aria-haspopup="dialog"
          aria-expanded={indexOpen}
          onClick={() => setIndexOpen(!indexOpen)}
          className="pointer-events-auto mr-1 cursor-pointer py-2 md:mr-2"
        >
          <div
            className={cn(
              'flex flex-col gap-2 pl-2 pr-1 duration-300 motion-safe:transition-opacity md:pl-4 md:pr-2',
              indexOpen ? 'opacity-0' : 'opacity-100',
            )}
          >
            {idxTicks.map((t) => (
              <div
                key={t.id}
                className={cn(
                  'h-[1.5px] w-full rounded-full',
                  t.id === idxActive
                    ? 'bg-foreground'
                    : t.kind === 'git'
                      ? 'bg-purple-500'
                      : 'bg-tint-secondary',
                )}
              />
            ))}
          </div>
        </button>
        {indexOpen && (
          <div
            role="dialog"
            className="pointer-events-auto absolute right-8 top-1/2 z-40 w-[280px] -translate-y-1/2 overflow-hidden rounded-[10px] border border-border bg-card/95 p-0 shadow-lg backdrop-blur md:right-[52px]"
          >
            <div className="max-h-[min(595px,calc(100vh-16px))] overflow-y-auto rounded-[10px]">
              <div className="flex flex-col gap-0 p-1.5">
                {indexEntries.map((it) => (
                  <button
                    key={it.id}
                    onMouseEnter={(e) => {
                      if (it.kind !== 'message' || !(it.body || '').trim()) { setIdxTip(null); return }
                      const r = e.currentTarget.getBoundingClientRect()
                      setIdxTip({ id: it.id, top: r.top, right: r.left - 8 })
                    }}
                    onMouseLeave={() => setIdxTip(null)}
                    onClick={async () => {
                      // events folded into a collapsed work group have no rendered row; fall back to the nearest by timestamp
                      stickBottom.current = false
                      let node = scrollRef.current?.querySelector(`[data-eid="${CSS.escape(it.id)}"]`)
                      if (!node && cursor) {
                        // entry beyond the loaded window — backfill history first (official full-history index jump)
                        await loadUntil(it.id, it.ts)
                        await new Promise((res) => requestAnimationFrame(res))
                        node = scrollRef.current?.querySelector(`[data-eid="${CSS.escape(it.id)}"]`)
                        // backfilled toward the target but its row may be folded into a
                        // work group: land on the oldest loaded row rather than stale state
                        if (!node) node = scrollRef.current?.querySelector('[data-eid]')
                      }
                      if (!node) {
                        const target = new Date(it.ts).getTime()
                        const byDist = [...allItems].sort(
                          (a, b) => Math.abs(new Date(a.ts).getTime() - target) - Math.abs(new Date(b.ts).getTime() - target),
                        )
                        for (const cand of byDist) {
                          node = scrollRef.current?.querySelector(`[data-eid="${CSS.escape(cand.id)}"]`) ?? null
                          if (node) break
                        }
                      }
                      if (node) {
                        node.scrollIntoView({ block: 'start' })
                        // Official jump feedback: the landed row is marked once.
                        // (dw-find-hit is a static outline, not an animation —
                        // clear it on a timer, not animationend.)
                        node.classList.add('dw-find-hit')
                        window.setTimeout(() => node!.classList.remove('dw-find-hit'), 1600)
                      }
                    }}
                    className={cn('flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] hover:bg-accent', it.id === idxActive && 'bg-accent')}
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
                ))}
                {queued.map((q) => (
                  <button
                    key={`q-${q.id}`}
                    onClick={() => {
                      const el = scrollRef.current
                      if (el) el.scrollTo({ top: el.scrollHeight })
                    }}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] hover:bg-accent"
                  >
                    <span className="min-w-0 flex-1 truncate pl-6">{(q.text || '').split('\n')[0].slice(0, 80)}</span>
                  </button>
                ))}
                <button
                  onClick={() => {
                    const el = scrollRef.current
                    if (el) el.scrollTo({ top: el.scrollHeight })
                  }}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] hover:bg-accent"
                >
                  <span className="min-w-0 flex-1 truncate pl-6 text-muted-foreground">{t('am.scrollBottom')}</span>
                </button>
              </div>
            </div>
          </div>
        )}
        {indexOpen && idxTip && (() => {
          const it = indexEntries.find((x) => x.id === idxTip.id)
          if (!it) return null
          return (
            <div
              role="dialog"
              style={{ position: 'fixed', top: Math.max(8, Math.min(idxTip.top, window.innerHeight - 308)), left: idxTip.right - 280 }}
              className="pointer-events-none z-50 max-h-[300px] w-[280px] overflow-hidden whitespace-pre-wrap rounded-[10px] border border-border bg-card p-2.5 text-left text-[13px] leading-[18px] shadow-lg"
            >
              {(it.body || '').slice(0, 1200)}
            </div>
          )
        })()}
      </div>
    </>
  )
}

export { SessionIndex }
