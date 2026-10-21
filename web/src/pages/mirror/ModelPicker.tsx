import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Pin, PinOff, Search, SlidersHorizontal, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import DwMark from '@/components/DwMark'
import type { LocalCfgOption } from './pageBits'

// Official-style capability picker (sampled app.devin.ai 2026-10): left column
// = search + Adaptive/Fusion + Pinned / Recently Used / Recommended sections;
// each row carries a vendor glyph + cost-spectrum bar. Hover opens a right-side
// detail card: variant title, context size, per-FAMILY effort dropdown (the
// catalog advertises e.g. low→xhigh per family — never intersect with the
// current model's global thought_level set), fast mode, cost gradient +
// Input/Cached/Output pricing, pin toggle.
//
// Non-Devin agents: `family`/`efforts`/`prices` are undefined → rows render
// plainly and the detail card falls back to the agent-advertised groups.

type Opt = LocalCfgOption
type Group = { id?: unknown; name?: string; currentValue?: string; options?: { value: string; name?: string; description?: string }[] }

const EFFORT_ORDER = ['none', 'minimal', 'min', 'low', 'medium', 'high', 'xhigh', 'max']
const effortRank = (e: string) => { const i = EFFORT_ORDER.indexOf(e); return i < 0 ? 99 : i }
const effortName = (e: string) => e === 'xhigh' ? 'XHigh' : e.charAt(0).toUpperCase() + e.slice(1)
const EFFORT_RE = /-(none|min|minimal|low|medium|high|xhigh|max)$/
const suffixEffort = (v: string) => v.match(EFFORT_RE)?.[1] ?? null
const stripName = (n: string) => n.replace(/(\s+(none|min|minimal|low|medium|high|xhigh|max|thinking|fast|1m|priority|lightning))+$/i, '').trim()

const PINS_KEY = 'dw-model-pins'
const RECENT_KEY = 'dw-model-recent'
const readList = (k: string): string[] => { try { const v = JSON.parse(localStorage.getItem(k) ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [] } catch { return [] } }
const writeList = (k: string, v: string[]) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* unavailable */ } }

// ---- vendor glyphs (minimal monochrome marks, currentColor) ----
function VendorGlyph({ family, value }: { family?: string; value: string }) {
  const f = family ?? value
  const cls = 'size-4 shrink-0'
  if (value === 'adaptive' || f === 'adaptive') return <SlidersHorizontal size={14} className={cn(cls, 'text-violet-500')} />
  if (f.startsWith('swe') || f.startsWith('fusion') || f.startsWith('devin')) return <DwMark size={16} className={cls} />
  if (f.startsWith('claude')) return (
    <svg viewBox="0 0 16 16" className={cn(cls, 'text-amber-500')} fill="currentColor" aria-hidden>
      <path d="M8 1.5 9 6l3.5-2.2L10.4 7 15 8l-4.6 1 2.1 3.2L9 10 8 14.5 7 10l-3.5 2.2L5.6 9 1 8l4.6-1-2.1-3.2L7 6z" />
    </svg>
  )
  if (f.startsWith('gpt') || f.startsWith('o1') || f.startsWith('o3') || f.startsWith('o4')) return (
    <svg viewBox="0 0 16 16" className={cls} fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <path d="M8 1.8 13.2 4.8v6.4L8 14.2 2.8 11.2V4.8z" />
      <path d="M8 5v6M5.2 6.5l5.6 3M10.8 6.5l-5.6 3" />
    </svg>
  )
  if (f.startsWith('gemini')) return (
    <svg viewBox="0 0 16 16" className={cn(cls, 'text-sky-500')} fill="currentColor" aria-hidden>
      <path d="M8 1.5c.4 3.4 2.6 5.6 6 6-3.4.4-5.6 2.6-6 6-.4-3.4-2.6-5.6-6-6 3.4-.4 5.6-2.6 6-6z" />
    </svg>
  )
  if (f.startsWith('glm')) return (
    <svg viewBox="0 0 16 16" className={cls} fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <path d="M4 3.5h8L5.5 12.5H13" />
    </svg>
  )
  if (f.startsWith('kimi') || f.startsWith('moonshot')) return (
    <svg viewBox="0 0 16 16" className={cn(cls, 'text-indigo-400')} fill="currentColor" aria-hidden>
      <path d="M10.5 2A6 6 0 1 0 14 9.5 5 5 0 0 1 10.5 2z" />
    </svg>
  )
  if (f.startsWith('grok') || f.startsWith('x-')) return (
    <svg viewBox="0 0 16 16" className={cls} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
    </svg>
  )
  if (f.startsWith('muse')) return (
    <svg viewBox="0 0 16 16" className={cn(cls, 'text-rose-400')} fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <path d="M3 13V4l5 6 5-6v9" />
    </svg>
  )
  return <Sparkles size={14} className={cn(cls, 'text-muted-foreground')} />
}

// ---- cost spectrum bar ----
const COST_GRADIENT = 'linear-gradient(90deg,#34d399 0%,#a3e635 35%,#fbbf24 62%,#f472b6 82%,#a78bfa 100%)'
function costPos(p?: { input?: number; cached?: number; output?: number }) {
  const ref = p?.output ?? p?.input
  if (!ref) return null
  // log-scale across the observed catalog range (~$0.03 – $60 /1M output)
  const lo = Math.log10(0.03), hi = Math.log10(60)
  return Math.min(1, Math.max(0, (Math.log10(ref) - lo) / (hi - lo)))
}
function CostBar({ prices, className }: { prices?: { input?: number; cached?: number; output?: number }; className?: string }) {
  const pos = costPos(prices)
  if (pos === null) return <span className={cn('inline-block h-[3px] w-9 rounded-full bg-muted', className)} />
  return (
    <span className={cn('relative inline-block h-[3px] w-9 rounded-full', className)} style={{ background: COST_GRADIENT }}>
      <span className="absolute top-1/2 size-[7px] -translate-y-1/2 rounded-full border border-black/20 bg-white shadow-sm" style={{ left: `calc(${(pos * 100).toFixed(1)}% - 3.5px)` }} />
    </span>
  )
}

const fmt$ = (v?: number) => (v === undefined ? '—' : `$${v % 1 === 0 ? v.toFixed(0) : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}`)

interface Row {
  key: string
  label: string
  base: Opt
  siblings: Opt[]
  known: boolean
  special?: 'adaptive' | 'fusion'
}

export default function ModelPicker({ model, effortGroup, speedGroup, extraGroups, onPick, onPickMulti, onClose }: {
  model: { id: string; current: string; currentName: string; options: Opt[] }
  effortGroup?: Group | null
  speedGroup?: Group | null
  extraGroups: Group[]
  onPick: (configId: string, value: string) => void
  onPickMulti: (pairs: { configId: string; value: string }[]) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const [pins, setPins] = useState<string[]>(() => readList(PINS_KEY))
  const [recent, setRecent] = useState<string[]>(() => readList(RECENT_KEY))
  const [hover, setHover] = useState<Row | null>(null)
  const [detailPos, setDetailPos] = useState<{ left: number; top: number } | null>(null)
  const [effortMenu, setEffortMenu] = useState(false)
  const [grpSub, setGrpSub] = useState<{ id: string; left: number; top: number } | null>(null)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelLeave = () => { if (leaveTimer.current) { clearTimeout(leaveTimer.current); leaveTimer.current = null } }
  const scheduleLeave = () => { cancelLeave(); leaveTimer.current = setTimeout(() => { setHover(null); setEffortMenu(false) }, 120) }

  // ---- rows ----
  const { topRows, famRows } = useMemo(() => {
    const byFam = new Map<string, Opt[]>()
    for (const m of model.options) {
      if (m.value === 'adaptive') continue
      const f = m.family ?? m.value
      const arr = byFam.get(f) ?? []
      arr.push(m)
      byFam.set(f, arr)
    }
    const fusion: Opt[] = []
    const fams: Row[] = []
    for (const [f, ms] of byFam) {
      ms.sort((a, b) => a.value.length - b.value.length)
      if (f.startsWith('fusion')) { fusion.push(...ms); continue }
      const base = ms[0]
      fams.push({ key: f, label: stripName(base.name ?? base.value) || base.name || base.value, base, siblings: ms.slice(1), known: ms.some((m) => m.family !== undefined) })
    }
    const tops: Row[] = []
    const ad = model.options.find((m) => m.value === 'adaptive')
    if (ad) tops.push({ key: 'adaptive', label: 'Adaptive', base: ad, siblings: [], known: false, special: 'adaptive' })
    if (fusion.length) {
      fusion.sort((a, b) => a.value.length - b.value.length)
      tops.push({ key: 'fusion', label: 'Fusion', base: fusion[0], siblings: fusion.slice(1), known: false, special: 'fusion' })
    }
    return { topRows: tops, famRows: fams }
  }, [model.options])

  const isCur = (row: Row) => [row.base, ...row.siblings].some((m) => model.current === m.value)
  const pinOf = (row: Row) => row.base.value
  const togglePin = (row: Row) => {
    const v = pinOf(row)
    const next = pins.includes(v) ? pins.filter((x) => x !== v) : [...pins, v]
    setPins(next); writeList(PINS_KEY, next)
  }
  const pick = (row: Row, value: string) => {
    const next = [value, ...recent.filter((x) => x !== value)].slice(0, 6)
    setRecent(next); writeList(RECENT_KEY, next)
    onPick(model.id, value)
  }

  // ---- effort options: per-FAMILY set (canonical order) — the global
  // thought_level group only advertises the CURRENT model's levels, so it is
  // the fallback for catalog-unknown families only.
  const effortOptsFor = (row: Row): { value: string; name: string }[] => {
    const fam = new Set([row.base, ...row.siblings].flatMap((m) => m.efforts ?? []))
    const ctl = row.known ? [row.base, ...row.siblings].some((m) => m.effortCtl) : fam.size > 0
    if (ctl && fam.size) return [...fam].sort((a, b) => effortRank(a) - effortRank(b)).map((v) => ({ value: v, name: effortName(v) }))
    if (ctl || !row.known) return (effortGroup?.options ?? []).map((o) => ({ value: o.value, name: o.name ?? o.value }))
    return []
  }
  const rowEffort = (row: Row) => isCur(row)
    ? String(effortGroup?.currentValue ?? '') || suffixEffort(model.current)
    : suffixEffort(row.base.value)
  const rowLabel = (row: Row) => {
    const e = rowEffort(row)
    return row.label + (e && row.known ? ` ${effortName(e)}` : '')
  }

  const showSpeed = (row: Row) => (speedGroup?.options?.length ?? 0) > 0 && (!row.known || [row.base, ...row.siblings].some((m) => m.fast))
  const showCtx = (row: Row) => [row.base, ...row.siblings].some((m) => m.ctx1m)

  // ---- sections ----
  const needle = q.trim().toLowerCase()
  const match = (row: Row) => !needle || row.label.toLowerCase().includes(needle) || row.base.value.toLowerCase().includes(needle)
  const pinnedRows = famRows.filter((r) => pins.includes(pinOf(r)) && match(r))
  const recentRows = recent.map((v) => famRows.find((r) => [r.base, ...r.siblings].some((m) => m.value === v))).filter((r): r is Row => !!r && !pins.includes(pinOf(r)) && match(r))
  const restRows = famRows.filter((r) => !pins.includes(pinOf(r)) && !recentRows.includes(r) && match(r))
  const topFiltered = topRows.filter(match)

  const openDetail = (row: Row, el: HTMLElement) => {
    cancelLeave()
    const r = el.getBoundingClientRect()
    setHover(row)
    setEffortMenu(false)
    setDetailPos({ left: r.right + 6, top: Math.min(r.top - 6, Math.max(8, window.innerHeight - 380)) })
  }

  const Section = ({ title, rows }: { title: string; rows: Row[] }) => rows.length === 0 ? null : (
    <>
      <div className="px-2 pb-0.5 pt-2 text-[11px] font-medium text-muted-foreground">{title}</div>
      {rows.map(renderRow)}
    </>
  )

  const renderRow = (row: Row) => {
    const cur = isCur(row)
    return (
      <div key={row.key} onMouseEnter={(e) => openDetail(row, e.currentTarget)} onMouseLeave={scheduleLeave}>
        <button
          role="menuitemradio"
          aria-checked={cur}
          onClick={() => pick(row, row.base.value)}
          className={cn('flex h-8 w-full cursor-pointer select-none items-center gap-2 rounded-[7px] px-2 text-[13px] outline-none', hover?.key === row.key ? 'bg-tint-secondary' : 'hover:bg-tint-secondary')}
        >
          <VendorGlyph family={row.base.family ?? row.key} value={row.base.value} />
          <span className="min-w-0 flex-1 truncate text-left">{rowLabel(row)}</span>
          <CostBar prices={row.base.prices} />
          <span className="flex w-4 shrink-0 items-center justify-center">{cur && <Check size={14} className="text-muted-foreground" />}</span>
        </button>
      </div>
    )
  }

  useEffect(() => () => cancelLeave(), [])

  return (
    <div className="flex w-[248px] flex-col">
      <div className="flex items-center gap-2 border-b border-border/60 px-2.5 py-2">
        <Search size={14} className="shrink-0 text-muted-foreground" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search all models"
          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
        />
        <SlidersHorizontal size={14} className="shrink-0 text-muted-foreground" />
      </div>
      <div className="max-h-[52vh] overflow-y-auto p-1">
        {topFiltered.map(renderRow)}
        {needle ? (
          <>
            <div className="px-2 pb-0.5 pt-2 text-[11px] font-medium text-muted-foreground">Models</div>
            {famRows.filter(match).map(renderRow)}
          </>
        ) : (
          <>
            <Section title="Pinned" rows={pinnedRows} />
            <Section title="Recently Used" rows={recentRows} />
            <Section title="Recommended" rows={restRows} />
          </>
        )}
        {extraGroups.length > 0 && (
          <>
            <div className="px-2 pb-0.5 pt-2 text-[11px] font-medium text-muted-foreground">Settings</div>
            {extraGroups.map((o) => {
              const gid = String(o.id ?? '')
              const cur = String(o.currentValue ?? '')
              const curName = o.options!.find((x) => x.value === cur)?.name ?? cur
              return (
                <div key={gid} onMouseEnter={(e) => { setHover(null); const r = e.currentTarget.getBoundingClientRect(); setGrpSub({ id: gid, left: r.right + 6, top: r.top - 4 }) }} onMouseLeave={() => setGrpSub(null)}>
                  <div role="menuitem" className="flex h-8 w-full cursor-pointer select-none items-center gap-2 rounded-[7px] px-2 text-[13px] hover:bg-tint-secondary">
                    <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"><SlidersHorizontal size={13} /></span>
                    <span className="shrink-0">{o.name ?? gid}</span>
                    <span className="min-w-0 flex-1 truncate text-right text-[12px] text-muted-foreground">{curName || '—'}</span>
                    <ChevronDown size={13} className="shrink-0 -rotate-90 text-muted-foreground" />
                  </div>
                  {grpSub?.id === gid && createPortal(
                    <div role="menu" onMouseEnter={() => setGrpSub(grpSub)} onMouseLeave={() => setGrpSub(null)} style={{ left: grpSub.left, top: grpSub.top }} className="fixed z-50 w-[200px] overflow-y-auto rounded-[10px] bg-[rgba(255,255,255,0.96)] p-1 shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)] outline outline-1 outline-black/[0.06] backdrop-blur-[8px] dark:bg-[#1f1f1f]/[0.96] dark:outline-white/[0.06]">
                      {o.options!.map((opt) => (
                        <button key={opt.value} role="menuitemradio" aria-checked={cur === opt.value} onClick={() => onPick(gid, opt.value)} className="flex h-[30px] w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-[5px] text-[13px] outline-none hover:bg-tint-secondary">
                          <span className="flex h-4 w-[18px] shrink-0 items-center justify-center text-muted-foreground">{cur === opt.value && <Check size={14} />}</span>
                          <span className="min-w-0 flex-1 truncate text-left">{opt.name || opt.value}</span>
                        </button>
                      ))}
                    </div>,
                    document.body,
                  )}
                </div>
              )
            })}
          </>
        )}
      </div>
      {hover && detailPos && createPortal(
        <div
          onMouseEnter={cancelLeave}
          onMouseLeave={scheduleLeave}
          style={{ left: detailPos.left, top: detailPos.top }}
          className="fixed z-50 w-[240px] rounded-[12px] bg-[rgba(255,255,255,0.96)] p-3 shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)] outline outline-1 outline-black/[0.06] backdrop-blur-[8px] dark:bg-[#1f1f1f]/[0.96] dark:outline-white/[0.06]"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-[15px] font-medium leading-5">{rowLabel(hover)}</div>
              {showCtx(hover) && <div className="mt-0.5 text-[12px] text-muted-foreground">1M context</div>}
            </div>
            <button onClick={() => togglePin(hover)} aria-label="Pin model" className="shrink-0 cursor-pointer rounded-[6px] p-1 text-muted-foreground hover:bg-tint-secondary hover:text-foreground">
              {pins.includes(pinOf(hover)) ? <Pin size={15} className="fill-current" /> : <Pin size={15} />}
            </button>
          </div>
          {effortOptsFor(hover).length > 0 && (
            <div className="relative mt-2.5">
              <button
                onClick={() => setEffortMenu((v) => !v)}
                className="flex h-8 w-full cursor-pointer items-center justify-between rounded-[8px] px-1 text-[13px] hover:bg-tint-secondary"
              >
                <span>Effort</span>
                <span className="flex items-center gap-1 text-muted-foreground">
                  {effortOptsFor(hover).find((o) => o.value === rowEffort(hover))?.name ?? effortOptsFor(hover)[0]?.name}
                  <ChevronDown size={14} />
                </span>
              </button>
              {effortMenu && (
                <div role="menu" className="absolute right-0 top-9 z-10 w-[160px] rounded-[10px] bg-[rgba(255,255,255,0.98)] p-1 shadow-lg outline outline-1 outline-black/[0.06] dark:bg-[#242424] dark:outline-white/[0.08]">
                  {effortOptsFor(hover).map((lvl) => (
                    <button
                      key={lvl.value}
                      role="menuitemradio"
                      aria-checked={rowEffort(hover) === lvl.value}
                      onClick={() => {
                        setEffortMenu(false)
                        const pairs = [{ configId: model.id, value: hover.base.value }]
                        if (effortGroup?.id != null) pairs.push({ configId: String(effortGroup.id), value: lvl.value })
                        onPickMulti(pairs)
                      }}
                      className="flex h-[30px] w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-[5px] text-[13px] outline-none hover:bg-tint-secondary"
                    >
                      <span className="min-w-0 flex-1 truncate text-left">{lvl.name}</span>
                      {rowEffort(hover) === lvl.value && <Check size={14} className="shrink-0" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {showSpeed(hover) && (
            <div className="mt-1 flex h-8 items-center justify-between px-1 text-[13px]">
              <span>Fast Mode</span>
              <span className="flex items-center gap-1">
                {speedGroup!.options!.map((sp) => (
                  <button
                    key={sp.value}
                    onClick={() => onPickMulti([
                      { configId: model.id, value: hover.base.value },
                      { configId: String(speedGroup!.id), value: sp.value },
                    ])}
                    className={cn('cursor-pointer rounded-[6px] px-1.5 py-0.5 text-[12px]', speedGroup!.currentValue === sp.value ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-tint-secondary')}
                  >
                    {sp.name || sp.value}
                  </button>
                ))}
              </span>
            </div>
          )}
          {hover.siblings.filter((v) => !/-fast$/.test(v.value)).length > 0 && (
            <div className="mt-1.5">
              <div className="px-1 pb-1 text-[11px] font-medium text-muted-foreground">Variants</div>
              {[hover.base, ...hover.siblings.filter((v) => !/-fast$/.test(v.value))].map((v) => (
                <button
                  key={v.value}
                  onClick={() => pick(hover, v.value)}
                  className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-[6px] px-1 text-[13px] hover:bg-tint-secondary"
                >
                  <span className="min-w-0 flex-1 truncate text-left">{v === hover.base ? 'Standard' : (v.name ?? v.value).replace(hover.label, '').replace(/\b(none|min|minimal|low|medium|high|xhigh|max)\b/gi, '').trim() || v.name || v.value}</span>
                  {model.current === v.value && <Check size={13} className="shrink-0" />}
                </button>
              ))}
            </div>
          )}
          {hover.base.prices && (hover.base.prices.input !== undefined || hover.base.prices.output !== undefined) && (
            <div className="mt-2.5">
              <div className="px-1 text-[12px] text-muted-foreground"><span className="text-foreground">Cost</span> Higher effort consumes more tokens</div>
              <div className="mt-1 px-1"><CostBar prices={hover.base.prices} className="h-1.5 w-full" /></div>
              <div className="mt-2 grid grid-cols-3 gap-1.5 px-1">
                {([['Input', hover.base.prices.input], ['Cached', hover.base.prices.cached], ['Output', hover.base.prices.output]] as const).map(([k, v]) => (
                  <div key={k} className="rounded-[8px] bg-tint-secondary px-2 py-1.5">
                    <div className="text-[10px] text-muted-foreground">{k === 'Cached' ? 'Cached input' : k}</div>
                    <div className="text-[12px] font-medium">{fmt$(v)} / 1M</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}
