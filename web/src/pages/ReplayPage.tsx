/* Replay — desktop ReplaySessionPage parity, local edition. Pages the full
 * session timeline (non-peek: replay is real-read intent, a cold session
 * loads like opening it would), then scrubs/plays items back on a scaled
 * clock. Read-only: nothing here can dispatch to the agent. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Play, Pause, ChevronFirst, ChevronLast, StepBack, StepForward, Terminal, Wrench, MessageSquare, Brain, Info } from 'lucide-react'
import { adminFetch } from '@/lib/api'
import Markdown from '@/components/Markdown'
import { cn } from '@/lib/utils'

interface ReplayItem {
  id: string
  ts: string
  kind: string
  role?: 'devin' | 'user'
  title?: string
  body?: string
  output?: string
  terminal?: string
  eidx?: number
  raw_type?: string
  callout?: string
}

interface TimelinePage {
  items: ReplayItem[]
  next_cursor: string | null
}

const SPEEDS = [0.5, 1, 2, 4] as const
const PAGE_LIMIT = 1000
const MAX_ITEMS = 8000

/* Per-item reveal delay: the real gap to the next event, scaled by speed
 * and clamped — replays breathe like the original turn without dead air. */
function gapMs(a: ReplayItem, b: ReplayItem | undefined, speed: number): number {
  if (!b) return 60
  const gap = new Date(b.ts).getTime() - new Date(a.ts).getTime()
  return Math.min(1500, Math.max(60, (Number.isFinite(gap) ? gap : 300) / speed))
}

function ItemRow({ it }: { it: ReplayItem }) {
  if (it.kind === 'message' && it.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-[12px] bg-accent px-3 py-2 text-[13px] leading-[18px]">
          {it.body}
        </div>
      </div>
    )
  }
  if (it.kind === 'message') {
    return (
      <div className="flex gap-2">
        <MessageSquare size={14} className="mt-1 shrink-0 text-accent-primary" />
        <div className="min-w-0 flex-1"><Markdown text={it.body ?? ''} /></div>
      </div>
    )
  }
  if (it.kind === 'thought') {
    return (
      <div className="flex gap-2 text-muted-foreground">
        <Brain size={14} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1 text-[12px] leading-[17px] italic"><Markdown text={it.body ?? ''} variant="thoughts" /></div>
      </div>
    )
  }
  if (it.kind === 'shell') {
    return (
      <div className="overflow-hidden rounded-[8px] border border-border">
        <div className="flex items-center gap-2 bg-muted px-2.5 py-1.5 text-[12px]">
          <Terminal size={12} className="shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{it.title || 'shell'}</span>
        </div>
        {it.body && <pre className="overflow-x-auto px-2.5 py-1.5 font-mono text-[11.5px] leading-[16px] text-foreground">{it.body}</pre>}
        {(it.output || it.terminal) && (
          <pre className="max-h-40 overflow-y-auto border-t border-border px-2.5 py-1.5 font-mono text-[11px] leading-[15px] text-muted-foreground">{(it.output ?? it.terminal ?? '').slice(0, 4000)}</pre>
        )}
      </div>
    )
  }
  if (it.kind === 'activity' || it.kind === 'other') {
    return (
      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
        <Wrench size={12} className="shrink-0" />
        <span className="truncate">{it.title || it.body || it.raw_type}</span>
      </div>
    )
  }
  return (
    <div className={cn('flex items-center gap-2 text-[12px]', it.callout === 'error' ? 'text-red-500' : 'text-muted-foreground')}>
      <Info size={12} className="shrink-0" />
      <span className="min-w-0 truncate">{it.title || it.body || it.kind}</span>
    </div>
  )
}

export default function ReplayPage() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const { t } = useTranslation()
  const [items, setItems] = useState<ReplayItem[] | null>(null)
  const [title, setTitle] = useState('')
  const [idx, setIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Full-history fetch: follow next_cursor to the log's head. A cold
  // session replays through session/load — same cost as opening it.
  useEffect(() => {
    let dead = false
    setItems(null); setIdx(0); setPlaying(false); setError(null)
    void adminFetch<{ session: { title?: string; devin_title?: string } }>(`/api/admin/session/${id}?slim=1`)
      .then((r) => !dead && setTitle(r.session?.title || r.session?.devin_title || ''))
      .catch(() => null)
    ;(async () => {
      const acc: ReplayItem[] = []
      let cursor: string | null = null
      for (let hops = 0; hops < 40 && acc.length < MAX_ITEMS; hops++) {
        const q: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
        const page: TimelinePage = await adminFetch<TimelinePage>(`/api/admin/session/${id}/timeline?limit=${PAGE_LIMIT}${q}`)
        const got = page.items ?? []
        // Pages arrive newest-first slices — prepend so acc stays chronological.
        acc.unshift(...got)
        cursor = page.next_cursor
        if (!cursor || got.length === 0) break
      }
      if (dead) return
      // Dedup by id (window overlap across pages) and order by eidx/ts.
      const seen = new Set<string>()
      const all = acc.filter((it) => (seen.has(it.id) ? false : (seen.add(it.id), true)))
      all.sort((a, b) => (a.eidx ?? 0) - (b.eidx ?? 0) || a.ts.localeCompare(b.ts))
      setItems(all)
    })().catch((e) => !dead && setError((e as Error).message))
    return () => { dead = true; if (timerRef.current) clearTimeout(timerRef.current) }
  }, [id])

  const total = items?.length ?? 0
  const done = idx >= total

  const advance = useCallback(() => {
    setIdx((v) => Math.min(total, v + 1))
  }, [total])

  useEffect(() => {
    if (!playing || !items) return
    if (idx >= total) { setPlaying(false); return }
    const cur = items[Math.max(0, idx - 1)]
    timerRef.current = setTimeout(advance, cur ? gapMs(cur, items[idx], speed) : 120)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [playing, idx, items, total, speed, advance])

  // Follow the reveal edge while playing; manual scroll stays free when paused.
  useEffect(() => {
    if (playing) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [idx, playing])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return
      if (e.key === ' ') { e.preventDefault(); setPlaying((v) => !done && !v) }
      if (e.key === 'ArrowRight') setIdx((v) => Math.min(total, v + 1))
      if (e.key === 'ArrowLeft') setIdx((v) => Math.max(0, v - 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [done, total])

  const revealed = useMemo(() => (items ? items.slice(0, idx) : []), [items, idx])
  const btn = 'flex size-7 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent'

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <button className={btn} onClick={() => nav(`/admin/${id}`)} title={t('replay.back')}>
          <ArrowLeft size={17} />
        </button>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{title || id}</span>
        <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
          {items ? `${idx} / ${total}` : t('common.loading')}
        </span>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[760px] flex-col gap-3 px-4 py-4">
          {error && <p className="text-[13px] text-red-500">{error}</p>}
          {items && total === 0 && <p className="py-10 text-center text-[13px] text-muted-foreground">{t('replay.empty')}</p>}
          {revealed.map((it) => <ItemRow key={it.id} it={it} />)}
          {items && done && total > 0 && (
            <p className="py-3 text-center text-[12px] text-muted-foreground">{t('replay.finished')}</p>
          )}
        </div>
      </div>

      <footer className="flex h-12 shrink-0 items-center gap-1.5 border-t border-border px-3">
        <button className={btn} disabled={!items || idx === 0} onClick={() => { setPlaying(false); setIdx(0) }} title={t('replay.toStart')}>
          <ChevronFirst size={16} />
        </button>
        <button className={btn} disabled={!items || idx === 0} onClick={() => { setPlaying(false); setIdx((v) => Math.max(0, v - 1)) }} title={t('replay.stepBack')}>
          <StepBack size={16} />
        </button>
        <button
          className={cn(btn, 'size-8')}
          disabled={!items || total === 0}
          onClick={() => { if (done) setIdx(0); setPlaying((v) => !v) }}
          title={playing ? t('replay.pause') : t('replay.play')}
        >
          {playing ? <Pause size={17} /> : <Play size={17} />}
        </button>
        <button className={btn} disabled={!items || done} onClick={() => { setPlaying(false); setIdx((v) => Math.min(total, v + 1)) }} title={t('replay.stepFwd')}>
          <StepForward size={16} />
        </button>
        <button className={btn} disabled={!items || done} onClick={() => { setPlaying(false); setIdx(total) }} title={t('replay.toEnd')}>
          <ChevronLast size={16} />
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(1, total)}
          value={idx}
          disabled={!items}
          onChange={(e) => { setPlaying(false); setIdx(Number(e.target.value)) }}
          className="mx-2 min-w-0 flex-1 accent-[var(--accent-primary)]"
          aria-label={t('replay.scrub')}
        />
        <div className="flex shrink-0 items-center rounded-[6px] border border-border">
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              className={cn('cursor-pointer px-1.5 py-1 text-[11px] tabular-nums', speed === s ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}
            >
              {s}×
            </button>
          ))}
        </div>
      </footer>
    </div>
  )
}
