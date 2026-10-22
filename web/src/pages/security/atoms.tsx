import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import {
  Shield, Loader2, Search, ChevronDown, X,
  Check, CircleCheck, CircleX,
  AlarmClock, ListFilter,
} from 'lucide-react'
import { OExpand } from '@/components/officialIcons'
import { adminFetch } from '@/lib/api'
import AppSidebar from '@/components/AppSidebar'
import { cn } from '@/lib/utils'
import type { MirrorTreeSession } from '@/pages/mirror/treeCache'

/* Local code scans — official "Security" surface parity, ported from the
 * deobfuscated official bundles (_deob/src/security/security-uJj1dvj4.js +
 * CodeScanDetailPage-Bx9eZ-s0.js). Each scan is a real acp session rooted at
 * the scanned directory; findings are agent-emitted JSON parsed server-side
 * into the official field shape (severity/status/finding_id). */

export type Sev = 'critical' | 'high' | 'medium' | 'low' | 'info'
export type FStatus = 'open' | 'resolved' | 'dismissed' | 'ignored' | 'false_positive'
export type SStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'awaiting_user_input' | 'waiting'

export interface Finding {
  finding_id: string
  title: string
  description: string
  file_path: string | null
  start_line: number | null
  severity: Sev
  category: string | null
  cwe_id: string | null
  status: FStatus
  stage: 'unassigned' | 'triaged' | 'fixing' | 'resolved'
}
export interface SeverityCounts { critical?: number; high?: number; medium?: number; low?: number; info?: number }
export interface Scan {
  id: string
  repo_name: string
  cwd: string
  status: SStatus
  effort: 'lite' | 'standard'
  profile_id: string | null
  session_id: string | null
  finding_count?: number
  open_count?: number
  severity_counts?: SeverityCounts
  findings?: Finding[]
  summary: string
  created_at: number
  finished_at?: number
  archived?: boolean
}
export interface Profile { id: string; name: string; prompt: string; created_at: number }
export interface Automation { id: string; name: string; schedule: string; enabled: boolean; lastRun?: number; created_at?: number }

export const PAGE_MAX = 'max-w-[min(1200px,max(50vw,800px))]'
export const SEVS: Sev[] = ['critical', 'high', 'medium', 'low', 'info']

export const rel = (ts?: number): string => {
  if (!ts) return '—'
  const d = Date.now() - ts
  if (d < 60e3) return 'just now'
  if (d < 3600e3) return `${Math.floor(d / 60e3)}m ago`
  if (d < 86400e3) return `${Math.floor(d / 3600e3)}h ago`
  return new Date(ts).toLocaleDateString()
}

/* official status names — local 'done' maps to 'completed' */
export const oStatus = (s: SStatus) => (s === 'done' ? 'completed' : s)

/* ---------- shared atoms (official designsystem shapes) ---------- */

export function StatusDot({ s }: { s: SStatus }) {
  const { t } = useTranslation()
  const o = oStatus(s)
  const icon =
    o === 'completed' ? <CircleCheck size={16} className="shrink-0 text-text-green" /> :
    o === 'failed' || o === 'cancelled' ? <CircleX size={16} className="shrink-0 text-red-500" /> :
    o === 'awaiting_user_input' ? <AlarmClock size={16} className="shrink-0 text-orange" /> :
    <Loader2 size={16} className="shrink-0 animate-spin text-muted-foreground" />
  return <span title={t(`sec.st.${o}`)} className="relative z-[2] inline-flex">{icon}</span>
}

export function CountCell({ value, colorClass }: { value: number; colorClass: string }) {
  return (
    <span className={cn('w-12 shrink-0 truncate text-right text-13 leading-[18px] tabular-nums', value > 0 ? colorClass : 'text-text-disabled')}>
      {value}
    </span>
  )
}

/* empty/error panel — official contained empty-state block */
export function EmptyPanel({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-12">
      <span className="flex size-10 items-center justify-center rounded-[10px] border border-border-secondary bg-bg-elevated text-muted-foreground">
        <Shield size={18} />
      </span>
      <h3 className="pt-1 text-[15px] font-medium">{title}</h3>
      <p className="text-[13px] text-muted-foreground">{hint}</p>
    </div>
  )
}

/* skeleton rows — official 4-row shimmer */
export function ScanListSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <div className="ml-3.5 h-4 w-24 animate-pulse rounded bg-tint-secondary" />
      <div className="flex flex-col gap-0.5">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-3 py-2 pl-3.5 pr-2.5">
            <div className="size-4 shrink-0 animate-pulse rounded-full bg-tint-secondary" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="h-[14px] w-48 animate-pulse rounded bg-tint-secondary" />
              <div className="h-[14px] w-32 animate-pulse rounded bg-tint-secondary" />
            </div>
            <div className="h-[14px] w-16 shrink-0 animate-pulse rounded bg-tint-secondary" />
          </div>
        ))}
      </div>
    </div>
  )
}

/* search icon ⇄ expanding input — official SearchToggle */
export function SearchToggle({ value, onChange, label, placeholder }: {
  value: string; onChange: (v: string) => void; label: string; placeholder: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(!!value)
  if (!open) {
    return (
      <button title={label} aria-label={label} onClick={() => setOpen(true)}
        className="flex size-7 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground">
        <Search size={15} />
      </button>
    )
  }
  return (
    <div className="flex h-7 w-56 items-center gap-1.5 rounded-[6px] border border-border-secondary bg-bg-elevated px-2">
      <Search size={13} className="shrink-0 text-muted-foreground" />
      <input
        autoFocus value={value} onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') { onChange(''); setOpen(false) } }}
        placeholder={placeholder} aria-label={placeholder}
        className="h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
      />
      <button aria-label={t('sec.closeSearch')} onClick={() => { onChange(''); setOpen(false) }}
        className="flex size-5 shrink-0 items-center justify-center rounded-[4px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground">
        <X size={12} />
      </button>
    </div>
  )
}

/* status + PR-state filter popover — official shape */
export const STATUS_FILTERS = ['all', 'completed', 'queued', 'running', 'awaiting_input', 'failed', 'archived'] as const
export function FilterPopover({ status, onStatus, label }: {
  status: string; onStatus: (v: string) => void; label: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  return (
    <div className="relative" ref={ref}>
      <button title={label} aria-label={label} onClick={() => setOpen((o) => !o)}
        className="flex size-7 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground">
        <ListFilter size={15} />
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-30 w-44 rounded-[8px] border border-border-secondary bg-background p-1 shadow-lg">
          <div className="px-2 py-1 text-[12px] font-medium text-muted-foreground">{t('sec.filterStatus')}</div>
          {STATUS_FILTERS.map((v) => (
            <button key={v} onClick={() => { onStatus(v); setOpen(false) }}
              className="flex w-full items-center justify-between rounded-[5px] px-2 py-1.5 text-left text-[13px] hover:bg-tint-secondary">
              {t(`sec.filter.${v}`)}
              {status === v && <Check size={13} className="text-accent-primary" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* "Create scan" primary split-button — official: Manual / Generate with Devin */
export function CreateScanButton({ onManual }: { onManual: () => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)}
        className="flex h-8 items-center gap-1 rounded-[7px] bg-accent-primary px-3 text-[13px] font-medium text-white hover:opacity-90">
        {t('sec.createScan')}<ChevronDown size={13} className="ml-0.5" />
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-30 w-[220px] rounded-[8px] border border-border-secondary bg-background p-1 shadow-lg">
          <button onClick={() => { setOpen(false); onManual() }}
            className="flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-left text-[13px] hover:bg-tint-secondary">
            {t('sec.manual')}
          </button>
          <button disabled title={t('sec.devinSoon')}
            className="flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-left text-[13px] text-muted-foreground opacity-50">
            <Shield size={13} />{t('sec.withDevin')}
          </button>
        </div>
      )}
    </div>
  )
}

/* ---------- page shell ---------- */

export function Shell({ sideOpen, setSideOpen, tree, children }: {
  sideOpen: boolean; setSideOpen: (b: boolean) => void
  tree: MirrorTreeSession[]; children: React.ReactNode
}) {
  const { t } = useTranslation()
  const nav = useNavigate()
  return (
    <div className="flex h-screen bg-background text-foreground">
      <AppSidebar
        open={sideOpen} onToggle={setSideOpen} active="security"
        tree={tree.filter((s) => s.status_enum !== 'archived')}
        archivedTree={tree.filter((s) => s.status_enum === 'archived')}
        onOpen={(s) => nav(`/admin/${s.devin_id}`)}
        onRefresh={() => adminFetch<{ sessions: MirrorTreeSession[] }>('/api/admin/mirror/sessions').then(() => {}).catch(() => {})}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border-secondary px-2 pr-[7px]">
          {!sideOpen && (
            <button onClick={() => setSideOpen(true)} className="flex size-7 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground" aria-label={t('sp.expandSb')} title={t('sp.expandSb')}>
              <OExpand size={16} />
            </button>
          )}
        </header>
        {children}
      </div>
    </div>
  )
}
