import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Loader2, ChevronRight, ChevronDown, ChevronLeft, Check, ArrowUp, Expand, Shrink } from 'lucide-react'
import { screenshotUrl } from '@/lib/viewer'
import { type TimelineItem } from '@/components/Timeline'
import { LocalLive } from './LocalLive'
import { cn } from '@/lib/utils'
import { time } from './timelineUtil'

type StreamQuality = 'auto' | 'sharp' | 'saver'

type ComputerShot = { key: string; ts: string; tsMs: number; title: string }
type ComputerSliderGroup = { start: number; end: number; position: number; shot: ComputerShot }

function computerSliderGroups(shots: ComputerShot[]): ComputerSliderGroup[] {
  if (!shots.length) return []
  if (shots.length === 1) return [{ start: 0, end: 100, position: 50, shot: shots[0] }]
  const first = shots[0].tsMs
  const last = shots[shots.length - 1].tsMs
  if (!Number.isFinite(first) || !Number.isFinite(last) || first === last) {
    return shots.map((shot, index) => ({
      start: (index / shots.length) * 100,
      end: ((index + 1) / shots.length) * 100,
      position: ((index + 0.5) / shots.length) * 100,
      shot,
    }))
  }
  const positions = shots.map((shot) => Math.max(0, Math.min(100, ((shot.tsMs - first) / (last - first)) * 100)))
  return shots.map((shot, index) => ({
    start: index === 0 ? 0 : (positions[index - 1] + positions[index]) / 2,
    end: index === shots.length - 1 ? 100 : (positions[index] + positions[index + 1]) / 2,
    position: positions[index],
    shot,
  }))
}

function ComputerPanel({ id, items, mt, asleep, onWake, canControl, showLiveDesktop }: { id: string; items: TimelineItem[]; mt: string; asleep: boolean; onWake?: () => void; canControl: boolean; showLiveDesktop: boolean }) {
  const { t } = useTranslation()
  const rootRef = useRef<HTMLDivElement>(null)
  const [full, setFull] = useState(false)
  const [quality, setQuality] = useState<StreamQuality>('auto')
  const [qOpen, setQOpen] = useState(false)
  const qualityRef = useRef<HTMLDivElement>(null)
  const shots = useMemo(() => {
    const list: ComputerShot[] = []
    for (const it of items) {
      if (it.kind !== 'computer') continue
      const tsMs = new Date(it.ts).getTime()
      for (const k of it.screenshotKeys || []) list.push({ key: k, ts: it.ts, tsMs, title: it.title || '' })
    }
    return list.filter((shot) => Number.isFinite(shot.tsMs)).sort((a, b) => a.tsMs - b.tsMs)
  }, [items])
  const [idx, setIdx] = useState(-1)
  const cur = idx >= 0 && idx < shots.length ? shots[idx] : shots[shots.length - 1]
  const curIdx = idx >= 0 ? idx : shots.length - 1
  const live = shots.length === 0 || curIdx === shots.length - 1
  const sliderGroups = useMemo(() => computerSliderGroups(shots), [shots])
  const currentPosition = curIdx < 0 ? 0 : sliderGroups[curIdx]?.position ?? 100
  const sliderRef = useRef<HTMLDivElement>(null)
  const setFromPosition = useCallback((clientX: number) => {
    const element = sliderRef.current
    if (!element || !sliderGroups.length) return
    const rect = element.getBoundingClientRect()
    const position = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100))
    let nearest = 0
    let distance = Infinity
    sliderGroups.forEach((group, index) => {
      const next = Math.abs(group.position - position)
      if (next < distance) {
        nearest = index
        distance = next
      }
    })
    setIdx(nearest)
  }, [sliderGroups])
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
  useEffect(() => {
    const handleFullscreenChange = () => setFull(document.fullscreenElement === rootRef.current)
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])
  useEffect(() => {
    if (!qOpen) return
    const handle = (event: MouseEvent) => {
      if (qualityRef.current && !qualityRef.current.contains(event.target as Node)) setQOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [qOpen])
  const qualityOptions: { value: StreamQuality; label: string; description: string }[] = [
    { value: 'auto', label: 'Auto', description: 'Follows your connection' },
    { value: 'sharp', label: 'Sharp', description: 'Sharpest picture, most bandwidth' },
    { value: 'saver', label: 'Data saver', description: 'Lowest bandwidth' },
  ]
  const qualityLabel = qualityOptions.find((option) => option.value === quality)?.label || 'Auto'
  if (!shots.length) {
    // Local parity: cloud use_computer shots never exist here — admins get
    // the real host desktop / managed browser instead of dead noVNC.
    if (!canControl) {
      return (
        <div className="p-4 text-xs text-muted-foreground">
          No computer activity yet.
        </div>
      )
    }
    return <LocalLive />
  }
  return (
    <div ref={rootRef} className="flex h-full flex-col gap-2 bg-background p-3">
      {canControl && showLiveDesktop && live
        ? <LocalLive />
        : cur && mt
        ? <img loading="lazy" decoding="async" src={screenshotUrl(id, cur.key, mt)} alt="Devin's Computer" className="min-h-0 h-full w-full flex-1 object-contain" />
        : <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground"><Loader2 size={14} className="mr-1.5 animate-spin" /> {t('cmp.connecting')}</div>}
      <div
        ref={sliderRef}
        role="slider"
        tabIndex={0}
        aria-label={t('cp.timeline')}
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(currentPosition)}
        aria-valuetext={cur ? time(cur.ts) : undefined}
        className="relative z-10 h-[10px] cursor-pointer select-none self-stretch overflow-visible rounded-[4px] focus:outline-none"
        onPointerDown={onPointerDown}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
            event.preventDefault()
            setIdx(Math.min(shots.length - 1, curIdx + 1))
          } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
            event.preventDefault()
            setIdx(Math.max(0, curIdx - 1))
          }
        }}
        onMouseEnter={() => sliderRef.current?.focus()}
      >
        {sliderGroups.map((group, index) => {
          const width = group.end - group.start
          const fill = currentPosition >= group.end
            ? 100
            : currentPosition > group.start
            ? ((currentPosition - group.start) / width) * 100
            : 0
          return (
            <div
              key={`${group.shot.key}-${index}`}
              className="absolute"
              title={time(group.shot.ts)}
              style={{
                left: index === 0 ? `${group.start}%` : `calc(${group.start}% + 1px)`,
                width: index === 0 ? `calc(${width}% - 0.5px)` : `calc(${width}% - 1px)`,
                height: 16,
                top: -5,
              }}
            >
              <div
                className={cn(
                  'absolute left-0 w-full overflow-hidden',
                  index === 0 && 'rounded-s-[2px]',
                  index === sliderGroups.length - 1 && 'rounded-e-[2px]',
                )}
                style={{
                  height: 10,
                  top: 3,
                  background: `linear-gradient(to right, color-mix(in srgb, var(--color-primary) 20%, var(--color-background)) 0%, var(--color-primary) 0% ${fill}%, color-mix(in srgb, var(--color-primary) 20%, var(--color-background)) ${fill}%)`,
                }}
              />
            </div>
          )
        })}
        <div
          className="pointer-events-none absolute z-20 -translate-x-1/2 bg-primary"
          style={{ left: `${currentPosition}%`, width: 3, height: 16, top: -5 }}
        />
      </div>
      <div className="relative my-1 flex w-full items-center gap-2 text-[13px] leading-[18px] text-muted-foreground">
        <button className="flex size-7 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-accent disabled:opacity-30" disabled={curIdx <= 0} onClick={() => setIdx(curIdx - 1)} aria-label={t('cp.prevFrame')}><ChevronLeft size={14} /></button>
        <button className="flex size-7 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-accent disabled:opacity-30" disabled={curIdx >= shots.length - 1} onClick={() => setIdx(curIdx + 1)} aria-label={t('cp.nextFrame')}><ChevronRight size={14} /></button>
        {asleep && onWake ? (
          <button type="button" onClick={onWake} className="inline-flex h-7 items-center rounded-full border border-black/[0.08] bg-white px-3 text-[13px] font-medium leading-[18px] text-foreground dark:border-white/[0.08] dark:bg-[#1f1f1f]">{t('cp.wake')}</button>
        ) : asleep ? (
          <button
            type="button"
            disabled
            className="flex h-7 cursor-default items-center gap-1.5 rounded-full border border-border px-2.5 disabled:opacity-100"
          >
            <span className="size-1.5 rounded-full bg-black/25" />
            Live
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setIdx(-1)}
            disabled={live}
            className="flex h-7 cursor-pointer items-center gap-1.5 rounded-full border border-black/[0.06] px-2.5 text-[13px] font-medium text-muted-foreground disabled:cursor-default disabled:opacity-100 dark:border-white/[0.06]"
          >
            <span className={cn('size-2 rounded-full', live ? 'bg-[#f53b3a]' : 'bg-black/25')} />
            Live
          </button>
        )}
        <div className="ml-auto flex items-center gap-1">
          {canControl && !asleep && (
            <div ref={qualityRef} className="relative">
              <button
                type="button"
                aria-label={t('cp.quality')}
                aria-haspopup="menu"
                aria-expanded={qOpen}
                onClick={() => setQOpen((value) => !value)}
                className="flex h-6 cursor-pointer items-center gap-1 rounded-[6px] px-2 text-[12px] font-medium text-muted-foreground hover:bg-accent"
              >
                {qualityLabel}<ChevronDown size={14} />
              </button>
              {qOpen && (
                <div role="menu" className="absolute right-0 bottom-8 z-40 min-w-[220px] rounded-[10px] border border-border bg-popover p-1 shadow-lg">
                  {qualityOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="menuitemradio"
                      aria-checked={quality === option.value}
                      onClick={() => { setQuality(option.value); setQOpen(false) }}
                      className="flex w-full cursor-pointer items-start gap-2 rounded-[6px] px-2 py-1.5 text-left hover:bg-accent"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] leading-[18px] text-foreground">{option.label}</span>
                        <span className="block text-[12px] leading-[16px] text-muted-foreground">{option.description}</span>
                      </span>
                      <span className="flex size-4 shrink-0 items-center justify-center">{quality === option.value && <Check size={13} className="text-muted-foreground" />}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button
            onClick={() => full ? void document.exitFullscreen() : void rootRef.current?.requestFullscreen()}
            aria-label={full ? 'Exit full screen' : 'Full screen'}
            className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full hover:bg-accent hover:text-foreground"
          >
            {full ? <Shrink size={13} /> : <Expand size={13} />}
          </button>
        </div>
      </div>
    </div>
  )
}

// Official attachment links, the same-origin share proxy form, and local
// web uploads staged via /api/uploads/<id>.

export { type StreamQuality, type ComputerShot, type ComputerSliderGroup, computerSliderGroups, ComputerPanel };
