import { useEffect, useState } from 'react'
import { Combo } from '@/components/ui'

/* Shared official-settings atoms — markup replicated from
 * app.devin.ai/settings/preferences (DOM extracted live 2026-10-19):
 * content column `flex flex-col gap-[36px] max-w-[700px]`; each section =
 * `gap-[12px]` → `text-14` heading + double-layer card
 * (`bg-tint-tertiary rounded-[10px]` shell ⊃ `bg-elevated border rounded-[10px]
 * p-[6px]` body); each row `min-h-[60px] px-[12px] py-[10px]` with
 * `text-13` title + `text-13 text-secondary` desc, control right. */

// Official row: [icon?] title+desc column | control — min-h-60px, 13px both lines.
export const Row = ({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) => (
  <div className="flex min-h-[60px] flex-col justify-center gap-[14px] rounded-[6px] px-[12px] py-[10px]">
    <div className="flex flex-row flex-wrap items-center justify-between gap-2 md:flex-nowrap">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex min-w-0 flex-col gap-[2px]">
          <h4 className="text-[13px] font-normal text-foreground">{title}</h4>
          <div className="text-[13px] text-muted-foreground">{desc}</div>
        </div>
      </div>
      <div className="relative flex items-center gap-1.5">{children}</div>
    </div>
  </div>
)
// Official section: heading + nested elevated card.
export const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-[12px]">
    <div className="flex flex-col gap-[2px]"><h3 className="text-[14px] font-medium text-foreground">{title}</h3></div>
    <div className="overflow-hidden rounded-[10px] bg-tint-tertiary">
      <div className="flex flex-col gap-[2px] rounded-[10px] border border-border bg-card p-[6px]">{children}</div>
    </div>
  </div>
)
// Shared official combobox lives in components/ui.tsx (Combo) — trigger
// content-sized, popup listbox. `width` lets a row pin a fixed trigger size.
export const Sel = ({ value, options, onPick, width = 'w-fit' }: { value: string; options: { v: string; l: string }[]; onPick: (v: string) => void; width?: string }) => (
  <Combo className={width} value={value} options={options} onPick={onPick} />
)

// Official switch: 36×20 p-2; unchecked tint-secondary, checked accent
// blue #317CFF; 16px white thumb w/ border.
export const Sw = ({ on, onToggle, busy }: { on: boolean; onToggle: () => void; busy?: boolean }) => (
  <button
    role="switch"
    aria-checked={on}
    onClick={onToggle}
    disabled={busy}
    className={`inline-flex h-[20px] w-[36px] shrink-0 cursor-pointer items-center justify-start rounded-full border border-transparent p-[2px] outline-none transition-colors duration-150 disabled:opacity-50 ${on ? 'bg-[#317CFF]' : 'bg-tint-secondary hover:bg-tint-primary'}`}
  >
    <span className={`pointer-events-none block size-4 rounded-full border-[0.5px] border-border bg-white shadow-sm transition-transform ${on ? 'translate-x-[16px]' : 'translate-x-0'}`} />
  </button>
)
// Official secondary button (measured "Enable"/"Display"): h-28, bg-white,
// border .08, radius-6, text-13 fw-500.
export const Btn2 = ({ children, onClick, disabled, title }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; title?: string }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={title}
    className="flex h-[28px] cursor-pointer items-center gap-1 rounded-[6px] border border-border bg-card px-2 text-[13px] font-medium text-foreground outline-none hover:bg-tint-tertiary disabled:cursor-not-allowed disabled:opacity-50"
  >
    {children}
  </button>
)

/* Supervisor status — these ride the SUPERVISOR's own /api/_super/* endpoints
 * (served even while the backend is dead). In unmanaged dev mode they degrade
 * to 'down'. Polled every 5s per consumer. */
export interface SuperStatus {
  ok: boolean; state: string; pid: number | null; backendPort: number
  uptime: number; recentExits: number; supervisorPid: number
  publicPort?: number; version?: string; node?: string
  platform?: string; repoRoot?: string; dataDir?: string
}
export const useSuperStatus = () => {
  const [st, setSt] = useState<SuperStatus | null | 'down'>(null)
  useEffect(() => {
    let alive = true
    const tick = () => void fetch('/api/_super/status')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j) => alive && setSt(j))
      .catch(() => alive && setSt('down'))
    tick()
    const iv = setInterval(tick, 5000)
    return () => { alive = false; clearInterval(iv) }
  }, [])
  return st
}
export const fmtUptime = (s: number) =>
  s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
