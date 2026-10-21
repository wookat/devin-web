import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  Shield, Loader2, Search, ChevronDown, X, ArrowLeft,
  MoreHorizontal, Check, CircleCheck, CircleX, CircleSlash,
  AlarmClock, Info, ListFilter, ExternalLink, Copy, Archive,
  ArchiveRestore, Pencil, Trash2, Wrench,
} from 'lucide-react'
import { OExpand } from '@/components/officialIcons'
import { adminFetch } from '@/lib/api'
import AppSidebar from '@/components/AppSidebar'
import { cn } from '@/lib/utils'
import type { MirrorTreeSession } from './mirror/treeCache'

/* Local code scans — official "Security" surface parity, ported from the
 * deobfuscated official bundles (_deob/src/security/security-uJj1dvj4.js +
 * CodeScanDetailPage-Bx9eZ-s0.js). Each scan is a real acp session rooted at
 * the scanned directory; findings are agent-emitted JSON parsed server-side
 * into the official field shape (severity/status/finding_id). */

type Sev = 'critical' | 'high' | 'medium' | 'low' | 'info'
type FStatus = 'open' | 'resolved' | 'dismissed' | 'ignored' | 'false_positive'
type SStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'awaiting_user_input' | 'waiting'

interface Finding {
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
interface SeverityCounts { critical?: number; high?: number; medium?: number; low?: number; info?: number }
interface Scan {
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
interface Profile { id: string; name: string; prompt: string; created_at: number }
interface Automation { id: string; name: string; schedule: string; enabled: boolean; lastRun?: number; created_at?: number }

const PAGE_MAX = 'max-w-[min(1200px,max(50vw,800px))]'
const SEVS: Sev[] = ['critical', 'high', 'medium', 'low', 'info']

const rel = (ts?: number): string => {
  if (!ts) return '—'
  const d = Date.now() - ts
  if (d < 60e3) return 'just now'
  if (d < 3600e3) return `${Math.floor(d / 60e3)}m ago`
  if (d < 86400e3) return `${Math.floor(d / 3600e3)}h ago`
  return new Date(ts).toLocaleDateString()
}

/* official status names — local 'done' maps to 'completed' */
const oStatus = (s: SStatus) => (s === 'done' ? 'completed' : s)

/* ---------- shared atoms (official designsystem shapes) ---------- */

function StatusDot({ s }: { s: SStatus }) {
  const { t } = useTranslation()
  const o = oStatus(s)
  const icon =
    o === 'completed' ? <CircleCheck size={16} className="shrink-0 text-text-green" /> :
    o === 'failed' || o === 'cancelled' ? <CircleX size={16} className="shrink-0 text-red-500" /> :
    o === 'awaiting_user_input' ? <AlarmClock size={16} className="shrink-0 text-orange" /> :
    <Loader2 size={16} className="shrink-0 animate-spin text-muted-foreground" />
  return <span title={t(`sec.st.${o}`)} className="relative z-[2] inline-flex">{icon}</span>
}

function CountCell({ value, colorClass }: { value: number; colorClass: string }) {
  return (
    <span className={cn('w-12 shrink-0 truncate text-right text-13 leading-[18px] tabular-nums', value > 0 ? colorClass : 'text-text-disabled')}>
      {value}
    </span>
  )
}

/* empty/error panel — official contained empty-state block */
function EmptyPanel({ title, hint }: { title: string; hint: string }) {
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
function ScanListSkeleton() {
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
function SearchToggle({ value, onChange, label, placeholder }: {
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
const STATUS_FILTERS = ['all', 'completed', 'queued', 'running', 'awaiting_input', 'failed', 'archived'] as const
function FilterPopover({ status, onStatus, label }: {
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
function CreateScanButton({ onManual }: { onManual: () => void }) {
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

function Shell({ sideOpen, setSideOpen, tree, children }: {
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

/* ---------- create-scan sheet (official: target + configuration) ---------- */

function CreateScanDialog({ profiles, onClose, onCreated }: {
  profiles: Profile[]
  onClose: () => void
  onCreated: () => void
}) {
  const { t } = useTranslation()
  const [cwd, setCwd] = useState('')
  const [workspaces, setWorkspaces] = useState<{ name: string; org: string }[]>([])
  const [effort, setEffort] = useState<'lite' | 'standard'>('lite')
  const [profileId, setProfileId] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => {
    adminFetch<{ repos: { name: string; org: string }[] }>('/api/admin/composer-meta')
      .then((r) => setWorkspaces(r.repos ?? [])).catch(() => {})
  }, [])
  const submit = async () => {
    setBusy(true); setErr('')
    try {
      await adminFetch('/api/admin/security/scans', {
        method: 'POST',
        body: JSON.stringify({ cwd: cwd.trim(), effort, profile_id: profileId || undefined }),
      })
      onCreated(); onClose()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/60" onClick={onClose}>
      <div className="w-[min(596px,calc(100vw-2rem))] rounded-[12px] border border-border-secondary bg-background shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 pb-2 pt-5">
          <h3 className="text-[15px] font-medium">{t('sec.createScan')}</h3>
          <button onClick={onClose} className="flex size-7 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary"><X size={15} /></button>
        </div>
        <div className="flex flex-col gap-4 px-5 pb-5">
          {/* official sheet section: Target */}
          <div className="flex flex-col gap-2">
            <div className="text-[13px] font-medium">{t('sec.target')}</div>
            <div className="rounded-[12px] bg-bg-elevated p-3">
              <input
                value={cwd} onChange={(e) => setCwd(e.target.value)}
                placeholder={t('sec.cwdPlaceholder')}
                className="h-9 w-full rounded-[8px] border border-border-secondary bg-background px-3 text-[13px] outline-none placeholder:text-muted-foreground"
              />
              {workspaces.length > 0 && (
                <div className="mt-2 flex max-h-[120px] flex-col gap-0.5 overflow-y-auto">
                  {workspaces.slice(0, 12).map((w) => (
                    <button key={w.org} onClick={() => setCwd(w.org)} className={cn('truncate rounded-[5px] px-2 py-1 text-left text-[12px] hover:bg-tint-secondary', cwd === w.org && 'bg-tint-secondary font-medium')}>
                      {w.name} <span className="text-muted-foreground">· {w.org}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          {/* official sheet section: Configuration */}
          <div className="flex flex-col gap-2">
            <div className="text-[13px] font-medium">{t('sec.config')}</div>
            <div className="flex flex-col gap-3 rounded-[12px] bg-bg-elevated p-3">
              <div className="flex items-center gap-2">
                <span className="w-20 shrink-0 text-[12px] text-muted-foreground">{t('sec.effort')}</span>
                <div className="flex rounded-[6px] border border-border-secondary bg-background p-0.5">
                  {(['lite', 'standard'] as const).map((e2) => (
                    <button key={e2} onClick={() => setEffort(e2)} className={cn('rounded-[5px] px-2.5 py-1 text-[12px] capitalize', effort === e2 ? 'bg-tint-secondary font-medium' : 'text-muted-foreground')}>{e2}</button>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-20 shrink-0 text-[12px] text-muted-foreground">{t('sec.profile')}</span>
                <select value={profileId} onChange={(e) => setProfileId(e.target.value)} className="h-8 flex-1 rounded-[6px] border border-border-secondary bg-background px-2 text-[13px]">
                  <option value="">{t('sec.noProfile')}</option>
                  {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            </div>
          </div>
          {err && <div className="text-[12px] text-red-500">{err}</div>}
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} className="h-8 rounded-[6px] px-3 text-[13px] text-muted-foreground hover:bg-tint-secondary">{t('sec.cancel')}</button>
            <button onClick={() => void submit()} disabled={busy || !cwd.trim()} className="flex h-8 items-center gap-1.5 rounded-[6px] bg-accent-primary px-3 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50">
              {busy ? <Loader2 size={14} className="animate-spin" /> : null}{t('sec.startScan')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ---------- scans tab — official group sections, not a card table ---------- */

function ScanRowMenu({ scan, archived, onArchive }: {
  scan: Scan; archived: boolean; onArchive: (s: Scan, unarchive: boolean) => void
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
    <div className="relative z-10" ref={ref}>
      <button
        aria-label={t('sec.scanActions')}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((o) => !o) }}
        className="flex size-7 items-center justify-center rounded-[6px] text-muted-foreground opacity-0 hover:bg-background hover:text-foreground group-hover/row:opacity-100"
      >
        <MoreHorizontal size={15} />
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-30 w-48 rounded-[8px] border border-border-secondary bg-background p-1 shadow-lg" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => { setOpen(false); void navigator.clipboard.writeText(`${location.origin}/admin/security/${scan.id}`).catch(() => {}) }}
            className="flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-left text-[13px] hover:bg-tint-secondary">
            <Copy size={13} />{t('sec.copyScanLink')}
          </button>
          {scan.session_id && (
            <Link to={`/admin/${scan.session_id}`} className="flex items-center gap-2 rounded-[5px] px-2 py-1.5 text-[13px] hover:bg-tint-secondary">
              <ExternalLink size={13} />{t('sec.viewSession')}
            </Link>
          )}
          {archived ? (
            <button onClick={() => { setOpen(false); onArchive(scan, true) }} className="flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-left text-[13px] hover:bg-tint-secondary">
              <ArchiveRestore size={13} />{t('sec.unarchive')}
            </button>
          ) : (
            <button onClick={() => { setOpen(false); onArchive(scan, false) }} className="flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-left text-[13px] hover:bg-tint-secondary">
              <Archive size={13} />{t('sec.archive')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function ScanRow({ scan, profileName, archived, onOpen, onArchive }: {
  scan: Scan; profileName: string | null; archived: boolean
  onOpen: (s: Scan) => void; onArchive: (s: Scan, unarchive: boolean) => void
}) {
  const { t } = useTranslation()
  const sc = scan.severity_counts ?? {}
  const last =
    scan.status === 'done' || scan.status === 'failed' || scan.status === 'cancelled'
      ? rel(scan.finished_at ?? scan.created_at)
      : scan.status === 'pending' || scan.status === 'running'
        ? t('sec.scanning')
        : rel(scan.created_at)
  return (
    <div
      className="group/row relative flex cursor-pointer items-center gap-6 rounded-md py-2 pl-3.5 pr-2.5 hover:bg-tint-secondary"
      onClick={() => onOpen(scan)}
      role="link" aria-label={scan.repo_name} tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(scan) }}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <StatusDot s={scan.status} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5 text-13 leading-[18px] text-text-primary">
            <span className="truncate">{scan.repo_name}</span>
            <span className="relative z-10 flex" title={t(`sec.effortTip.${scan.effort}`)}>
              <span className={cn('flex gap-[3px]', scan.effort === 'standard' ? 'text-text-secondary' : 'text-text-disabled')}>
                <span className="size-1 rounded-full bg-current" /><span className="size-1 rounded-full bg-current" /><span className={cn('size-1 rounded-full', scan.effort === 'standard' ? 'bg-current' : 'bg-border-secondary')} />
              </span>
            </span>
          </span>
          <span className="flex min-w-0 items-center gap-1 text-12 leading-4 text-text-secondary">
            {profileName ?? t('sec.noProfile')}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="hidden items-center gap-2 text-13 leading-[18px] sm:flex">
          <span className="w-16 shrink-0 truncate text-right text-text-secondary">{t('sec.typeSecurity')}</span>
          <CountCell value={scan.finding_count ?? 0} colorClass="text-text-secondary" />
          <CountCell value={sc.critical ?? 0} colorClass="text-red-500" />
          <CountCell value={sc.high ?? 0} colorClass="text-orange" />
          <CountCell value={sc.medium ?? 0} colorClass="text-text-secondary" />
        </div>
        <div className="flex w-[88px] shrink-0 items-center justify-end gap-1 whitespace-nowrap text-right text-13 leading-[18px]">
          <span className="min-w-0 flex-1 truncate text-text-secondary">{last}</span>
          <ScanRowMenu scan={scan} archived={archived} onArchive={onArchive} />
        </div>
      </div>
    </div>
  )
}

const COLLAPSE_AT = 5
function ScanGroup({ label, items, profiles, archived, onOpen, onArchive }: {
  label: string; items: Scan[]; profiles: Map<string, string>; archived: boolean
  onOpen: (s: Scan) => void; onArchive: (s: Scan, unarchive: boolean) => void
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  if (items.length === 0) return null
  const shown = !expanded && items.length > COLLAPSE_AT ? items.slice(0, COLLAPSE_AT) : items
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 pl-3.5 pr-2.5 text-12 font-medium leading-4 text-text-secondary">
        <span className="truncate">{label}</span>
        <div className="flex items-center gap-2">
          <div className="hidden items-center gap-2 sm:flex">
            <span className="w-16 text-right">{t('sec.type')}</span>
            <span className="w-12 text-right">{t('sec.total')}</span>
            <span className="w-12 text-right">{t('sec.critical')}</span>
            <span className="w-12 text-right">{t('sec.high')}</span>
            <span className="w-12 text-right">{t('sec.med')}</span>
          </div>
          <span className="w-[88px] text-right">{t('sec.lastScan')}</span>
        </div>
      </div>
      <div className="flex flex-col gap-0.5">
        {shown.map((s) => (
          <ScanRow key={s.id} scan={s} profileName={s.profile_id ? profiles.get(s.profile_id) ?? null : null} archived={archived} onOpen={onOpen} onArchive={onArchive} />
        ))}
      </div>
      {!expanded && items.length > COLLAPSE_AT && (
        <button type="button" onClick={() => setExpanded(true)}
          className="px-3 py-1 text-left text-12 font-medium leading-4 text-text-secondary hover:text-text-primary">
          {t('sec.showMore')}
        </button>
      )}
    </div>
  )
}

function ScansTab({ scans, loading, error, searching, archived, profiles, onOpen, onArchive }: {
  scans: Scan[]; loading: boolean; error: boolean; searching: boolean; archived: boolean
  profiles: Map<string, string>
  onOpen: (s: Scan) => void; onArchive: (s: Scan, unarchive: boolean) => void
}) {
  const { t } = useTranslation()
  if (loading) return <ScanListSkeleton />
  if (error) return <EmptyPanel title={t('sec.failedToLoad')} hint={t('sec.tryRefreshing')} />
  if (scans.length === 0) {
    return <EmptyPanel
      title={searching ? t('sec.noMatchingScans') : t('sec.noScansYet')}
      hint={searching ? t('sec.tryDifferentSearch') : t('sec.startScanDescription')}
    />
  }
  return (
    <div className="flex flex-col gap-6">
      <ScanGroup label={t('sec.createdByYou')} items={scans} profiles={profiles} archived={archived} onOpen={onOpen} onArchive={onArchive} />
    </div>
  )
}

/* ---------- scan detail — official master-detail ---------- */

const sevRank: Record<Sev, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
const sevColor: Record<Sev, string> = {
  critical: 'text-red-500',
  high: 'text-orange',
  medium: 'text-text-secondary',
  low: 'text-text-secondary',
  info: 'text-text-secondary',
}

function FindingDetailPane({ f, scanId, onPatch, onFix }: {
  f: Finding; scanId: string
  onPatch: (f: Finding, p: Partial<Finding>) => void
  onFix: (f: Finding) => void
}) {
  const { t } = useTranslation()
  const busy = false
  return (
    <div className="flex flex-col gap-4 px-4 py-1">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className={cn('text-12 font-medium capitalize', sevColor[f.severity])}>{t(`sec.sev.${f.severity}`)}</span>
          {f.cwe_id && <span className="rounded-[5px] bg-tint-secondary px-1.5 py-0.5 text-[11px] text-text-secondary">{f.cwe_id}</span>}
        </div>
        <h3 className="text-[15px] font-medium leading-5">{f.title}</h3>
        {f.file_path && (
          <div className="font-mono text-[12px] text-text-secondary">{f.file_path}{f.start_line != null ? `:${f.start_line}` : ''}</div>
        )}
      </div>
      <p className="whitespace-pre-wrap text-[13px] leading-[19px] text-text-secondary">{f.description}</p>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          onClick={() => onFix(f)} disabled={busy}
          className="flex h-8 items-center gap-1.5 rounded-[7px] bg-accent-primary px-3 text-[13px] font-medium text-white hover:opacity-90">
          <Wrench size={13} />{t('sec.fixWithDevin')}
        </button>
        {f.status !== 'resolved' && (
          <button onClick={() => onPatch(f, { status: 'resolved' })}
            className="flex h-8 items-center gap-1.5 rounded-[7px] border border-border-secondary px-3 text-[13px] hover:bg-tint-secondary">
            <Check size={13} />{t('sec.markResolved')}
          </button>
        )}
        {f.status !== 'dismissed' && f.status !== 'resolved' && (
          <button onClick={() => onPatch(f, { status: 'dismissed' })}
            className="flex h-8 items-center gap-1.5 rounded-[7px] border border-border-secondary px-3 text-[13px] text-muted-foreground hover:bg-tint-secondary">
            <CircleSlash size={13} />{t('sec.dismiss')}
          </button>
        )}
        {(f.status === 'resolved' || f.status === 'dismissed') && (
          <button onClick={() => onPatch(f, { status: 'open' })}
            className="flex h-8 items-center gap-1.5 rounded-[7px] border border-border-secondary px-3 text-[13px] text-muted-foreground hover:bg-tint-secondary">
            {t('sec.reopen')}
          </button>
        )}
      </div>
    </div>
  )
}

function ScanDetail({ scan, profiles, onBack, onPatch, onFix }: {
  scan: Scan; profiles: Map<string, string>
  onBack: () => void
  onPatch: (f: Finding, p: Partial<Finding>) => void
  onFix: (f: Finding) => void
}) {
  const { t } = useTranslation()
  const [statusTab, setStatusTab] = useState<'open' | 'resolved' | 'dismissed'>('open')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const findings = scan.findings ?? []
  const counts = useMemo(() => ({
    open: findings.filter((f) => f.status === 'open').length,
    resolved: findings.filter((f) => f.status === 'resolved').length,
    dismissed: findings.filter((f) => f.status === 'dismissed' || f.status === 'ignored' || f.status === 'false_positive').length,
  }), [findings])
  const filtered = useMemo(() => {
    const list = findings.filter((f) =>
      statusTab === 'open' ? f.status === 'open' :
      statusTab === 'resolved' ? f.status === 'resolved' :
      f.status !== 'open' && f.status !== 'resolved')
    return [...list].sort((a, b) => sevRank[a.severity] - sevRank[b.severity])
  }, [findings, statusTab])
  const groups = useMemo(() => {
    const m = new Map<Sev, Finding[]>()
    for (const f of filtered) { const a = m.get(f.severity) ?? []; a.push(f); m.set(f.severity, a) }
    return SEVS.filter((s) => m.has(s)).map((s) => ({ sev: s, items: m.get(s)! }))
  }, [filtered])
  const selected = findings.find((f) => f.finding_id === selectedId)
    ?? filtered[0] ?? null

  useEffect(() => { setSelectedId(null) }, [scan.id])

  const running = scan.status === 'running' || scan.status === 'pending'
  return (
    <div className="flex w-full flex-1 flex-col overflow-hidden">
      {/* header — official crumb + title + scan actions */}
      <div className="flex items-center gap-2 px-3 pb-1 pt-2">
        <button onClick={onBack} className="flex size-7 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground" aria-label={t('sec.back')}>
          <ArrowLeft size={15} />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <StatusDot s={scan.status} />
          <h3 className="truncate text-[15px] font-medium">{scan.repo_name}</h3>
          <span className="truncate text-[12px] text-text-secondary">
            {scan.profile_id && profiles.get(scan.profile_id) ? profiles.get(scan.profile_id) : t('sec.noProfile')}
            {' · '}{rel(scan.created_at)}
          </span>
        </div>
        {scan.session_id && (
          <Link to={`/admin/${scan.session_id}`} className="flex h-7 items-center gap-1 rounded-[6px] border border-border-secondary px-2 text-[12px] text-text-secondary hover:bg-tint-secondary">
            <ExternalLink size={12} />{t('sec.viewSession')}
          </Link>
        )}
      </div>
      {scan.summary && scan.status === 'done' && (
        <div className="mx-3 mb-2 rounded-[10px] border border-border-secondary bg-bg-elevated px-3 py-2 text-[12px] leading-[17px] text-text-secondary">{scan.summary}</div>
      )}
      {scan.status === 'failed' && (
        <div className="mx-3 mb-2 flex items-center gap-2 rounded-[10px] border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-500">
          <Info size={13} />{t('sec.scanFailedHint')}
        </div>
      )}
      {running ? (
        <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-muted-foreground">
          <Loader2 size={15} className="animate-spin" />{t('sec.scanning')}
        </div>
      ) : findings.length === 0 ? (
        <EmptyPanel title={t('sec.noFindings')} hint={t('sec.noFindingsHint')} />
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* findings list */}
          <div className={cn('flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-2.5', selected ? 'lg:max-w-[50%]' : '')}>
            {/* status tabs — official open/resolved/dismissed w/ counts */}
            <div className="mb-2 flex items-center gap-2">
              <div className="flex rounded-[7px] border border-border-secondary p-0.5">
                {(['open', 'resolved', 'dismissed'] as const).map((k) => (
                  <button key={k} onClick={() => setStatusTab(k)} aria-pressed={statusTab === k}
                    className={cn('flex items-center gap-1.5 rounded-[5px] px-2.5 py-1 text-[13px]', statusTab === k ? 'bg-tint-secondary font-medium' : 'text-muted-foreground hover:text-foreground')}>
                    {t(`sec.ft.${k}`)}<span className="rounded-[4px] bg-tint-secondary px-1 text-[11px] text-muted-foreground">{counts[k]}</span>
                  </button>
                ))}
              </div>
            </div>
            {filtered.length === 0 ? (
              <div className="py-10 text-center text-[13px] text-muted-foreground">{t(`sec.noStatusFindings.${statusTab}`)}</div>
            ) : (
              <div className="flex flex-col gap-3">
                {groups.map((g) => (
                  <div key={g.sev} className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-2 pl-3.5 pr-2.5 text-12 font-medium leading-4 text-text-secondary">
                      <span className={sevColor[g.sev]}>{t(`sec.sev.${g.sev}`)}</span>
                      <span className="tabular-nums">{g.items.length}</span>
                    </div>
                    {g.items.map((f) => (
                      <button key={f.finding_id} onClick={() => setSelectedId(f.finding_id)}
                        className={cn('flex w-full items-center gap-3 rounded-md py-2 pl-3.5 pr-2.5 text-left hover:bg-tint-secondary', selected?.finding_id === f.finding_id && 'bg-tint-secondary')}>
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="truncate text-13 leading-[18px] text-text-primary">{f.title}</span>
                          <span className="flex min-w-0 items-center gap-1 truncate font-mono text-[11px] leading-4 text-text-secondary">
                            {f.file_path ?? t('sec.noFile')}{f.start_line != null ? `:${f.start_line}` : ''}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
          {/* detail pane — official right-hand split */}
          {selected && (
            <div className="hidden min-h-0 w-1/2 flex-col overflow-y-auto border-l border-border-secondary py-2.5 lg:flex">
              <FindingDetailPane f={selected} scanId={scan.id} onPatch={onPatch} onFix={onFix} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ---------- profiles tab — official rows ---------- */

function ProfileRowMenu({ p, onEdit, onDelete }: { p: Profile; onEdit: (p: Profile) => void; onDelete: (p: Profile) => void }) {
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
    <div className="relative z-10" ref={ref}>
      <button aria-label={t('sec.profileActions')} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}
        className="flex size-7 items-center justify-center rounded-[6px] text-muted-foreground opacity-0 hover:bg-background hover:text-foreground group-hover/row:opacity-100">
        <MoreHorizontal size={15} />
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-30 w-44 rounded-[8px] border border-border-secondary bg-background p-1 shadow-lg" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { setOpen(false); onEdit(p) }} className="flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-left text-[13px] hover:bg-tint-secondary">
            <Pencil size={13} />{t('sec.edit')}
          </button>
          <button onClick={() => { setOpen(false); onDelete(p) }} className="flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-left text-[13px] hover:bg-tint-secondary">
            <Archive size={13} />{t('sec.archive')}
          </button>
        </div>
      )}
    </div>
  )
}

function ProfilesTab({ profiles, loading, searching, onCreate, onEdit, onDelete }: {
  profiles: Profile[]; loading: boolean; searching: boolean
  onCreate: (name: string, prompt: string) => void
  onEdit: (p: Profile, name: string, prompt: string) => void
  onDelete: (p: Profile) => void
}) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState<Profile | null>(null)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const openForm = (p: Profile | null) => {
    setEditing(p); setName(p?.name ?? ''); setPrompt(p?.prompt ?? ''); setAdding(true)
  }
  if (loading) return <ScanListSkeleton />
  const form = adding && (
    <div className="mx-1 flex flex-col gap-2 rounded-[12px] bg-bg-elevated p-3">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('sec.profileName')} className="h-8 rounded-[6px] border border-border-secondary bg-background px-2 text-[13px] outline-none" />
      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t('sec.profilePrompt')} rows={3} className="rounded-[6px] border border-border-secondary bg-background px-2 py-1.5 text-[13px] outline-none" />
      <div className="flex justify-end gap-2">
        <button onClick={() => setAdding(false)} className="h-7 rounded-[6px] px-2.5 text-[13px] text-muted-foreground hover:bg-tint-secondary">{t('sec.cancel')}</button>
        <button onClick={() => {
          if (!name.trim()) return
          if (editing) onEdit(editing, name.trim(), prompt.trim()); else onCreate(name.trim(), prompt.trim())
          setAdding(false); setEditing(null); setName(''); setPrompt('')
        }} className="h-7 rounded-[6px] bg-accent-primary px-2.5 text-[13px] font-medium text-white">{t('sec.save')}</button>
      </div>
    </div>
  )
  if (profiles.length === 0 && !adding) {
    return (
      <>
        <div className="mx-1 flex justify-end">
          <button onClick={() => openForm(null)} className="flex h-7 items-center gap-1 rounded-[6px] bg-accent-primary px-2.5 text-[13px] font-medium text-white hover:opacity-90">{t('sec.createProfile')}</button>
        </div>
        <EmptyPanel title={searching ? t('sec.noMatchingProfiles') : t('sec.noProfilesYet')} hint={searching ? t('sec.tryDifferentSearch') : t('sec.createProfileDescription')} />
      </>
    )
  }
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2 pl-3.5 pr-2.5 text-12 font-medium leading-4 text-text-secondary">
          <span className="truncate">{t('sec.createdByYou')}</span>
          <span className="w-20 text-right">{t('sec.globs')}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          {profiles.map((p) => (
            <div key={p.id} className="group/row relative flex items-center gap-6 rounded-md py-2 pl-3.5 pr-2.5 hover:bg-tint-secondary">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <Shield size={16} className="size-4 shrink-0 text-text-secondary" />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-13 leading-[18px] text-text-primary">{p.name}</span>
                  </span>
                  {p.prompt && <span className="truncate text-12 leading-4 text-text-secondary">{p.prompt}</span>}
                </div>
              </div>
              <div className="flex shrink-0 items-center justify-end gap-1 whitespace-nowrap text-right text-13 leading-[18px]">
                <span className="min-w-0 flex-1 truncate text-text-disabled tabular-nums">0</span>
                <ProfileRowMenu p={p} onEdit={(pp) => openForm(pp)} onDelete={onDelete} />
              </div>
            </div>
          ))}
        </div>
      </div>
      {form}
    </div>
  )
}

/* ---------- automations tab ---------- */

function AutomationsTab({ automations, loading, searching }: { automations: Automation[]; loading: boolean; searching: boolean }) {
  const { t } = useTranslation()
  if (loading) return <ScanListSkeleton />
  if (automations.length === 0) {
    return <EmptyPanel title={searching ? t('sec.noMatchingAutomations') : t('sec.noAutomationsYet')} hint={searching ? t('sec.tryDifferentSearch') : t('sec.findingAutomationsDescription')} />
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-end gap-5 px-3 text-12 font-medium leading-4 text-text-secondary">
        <span className="w-[91px] text-right">{t('sec.last30Days')}</span>
        <span className="w-[70px] text-right">{t('sec.created')}</span>
      </div>
      <div className="flex flex-col gap-0.5">
        {automations.map((a) => (
          <Link key={a.id} to="/admin/automations" className="group/row flex items-center gap-6 rounded-md py-2 pl-3.5 pr-2.5 hover:bg-tint-secondary">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-13 leading-[18px] text-text-primary">{a.name}</span>
                {!a.enabled && <span className="rounded-[5px] bg-tint-secondary px-1.5 py-0.5 text-[11px] text-muted-foreground">{t('sec.disabled')}</span>}
              </span>
              <span className="truncate text-12 leading-4 text-text-secondary">{a.schedule}</span>
            </div>
            <span className="w-[91px] shrink-0 text-right text-13 leading-[18px] text-text-secondary tabular-nums">{a.lastRun ? rel(a.lastRun) : '—'}</span>
            <span className="w-[70px] shrink-0 text-right text-13 leading-[18px] text-text-secondary">{a.created_at ? rel(a.created_at) : '—'}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}

/* ---------- page ---------- */

export default function SecurityPage() {
  const { t } = useTranslation()
  const { scanId } = useParams()
  const nav = useNavigate()
  const [sideOpen, setSideOpen] = useState(window.innerWidth >= 1024)
  const [tree, setTree] = useState<MirrorTreeSession[]>([])
  const [scans, setScans] = useState<Scan[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [automations, setAutomations] = useState<Automation[]>([])
  const [detail, setDetail] = useState<Scan | null>(null)
  const [tab, setTab] = useState<'scans' | 'profiles' | 'automations'>('scans')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [creating, setCreating] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)

  const load = () => {
    void adminFetch<{ scans: Scan[]; counts: Record<string, number> }>('/api/admin/security/scans')
      .then((r) => { setScans(r.scans ?? []); setCounts(r.counts ?? {}); setLoaded(true); setError(false) })
      .catch(() => { setLoaded(true); setError(true) })
    void adminFetch<{ profiles: Profile[] }>('/api/admin/security/profiles').then((r) => setProfiles(r.profiles ?? [])).catch(() => {})
    void adminFetch<{ automations: Automation[] }>('/api/admin/automations').then((r) => setAutomations(r.automations ?? [])).catch(() => {})
  }
  useEffect(() => {
    adminFetch<{ sessions: MirrorTreeSession[] }>('/api/admin/mirror/sessions').then((r) => setTree(r.sessions ?? [])).catch(() => {})
    load()
    const iv = setInterval(load, 5000)
    return () => clearInterval(iv)
  }, [])

  useEffect(() => {
    if (!scanId) { setDetail(null); return }
    void adminFetch<{ scan: Scan }>(`/api/admin/security/scans/${scanId}`).then((r) => setDetail(r.scan)).catch(() => setDetail(null))
  }, [scanId, scans])

  const openScan = (s: Scan) => nav(`/admin/security/${s.id}`)
  const archiveScan = async (s: Scan, unarchive: boolean) => {
    await adminFetch(`/api/admin/security/scans/${s.id}`, { method: 'PATCH', body: JSON.stringify({ archived: !unarchive }) })
      .catch(() => adminFetch(`/api/admin/security/scans/${s.id}`, { method: 'DELETE' }).catch(() => {}))
    load()
  }
  const patchFinding = async (f: Finding, patch: Partial<Finding>) => {
    if (!scanId) return
    await adminFetch(`/api/admin/security/scans/${scanId}/findings/${f.finding_id}`, { method: 'PATCH', body: JSON.stringify(patch) }).catch(() => {})
    void adminFetch<{ scan: Scan }>(`/api/admin/security/scans/${scanId}`).then((r) => setDetail(r.scan)).catch(() => {})
    load()
  }
  const fixWithDevin = async (f: Finding) => {
    if (!detail) return
    const task = `Fix this security finding in ${detail.cwd}:\n\n${f.title}\n\n${f.file_path ?? ''}${f.start_line != null ? `:${f.start_line}` : ''}\n\n${f.description}`
    try {
      const r = await adminFetch<{ session_id?: string; id?: string; devin_id?: string }>('/api/admin/sessions/new', { method: 'POST', body: JSON.stringify({ task, cwd: detail.cwd }) })
      const sid = r.session_id ?? r.id ?? r.devin_id
      if (sid) nav(`/admin/${sid}`)
    } catch { /* surfaced via toast-less alert for now */ }
  }
  const createProfile = async (name: string, prompt: string) => {
    await adminFetch('/api/admin/security/profiles', { method: 'POST', body: JSON.stringify({ name, prompt }) }).catch(() => {})
    void adminFetch<{ profiles: Profile[] }>('/api/admin/security/profiles').then((r) => setProfiles(r.profiles ?? [])).catch(() => {})
  }
  const editProfile = async (p: Profile, name: string, prompt: string) => {
    await adminFetch(`/api/admin/security/profiles/${p.id}`, { method: 'PATCH', body: JSON.stringify({ name, prompt }) }).catch(() => {})
    void adminFetch<{ profiles: Profile[] }>('/api/admin/security/profiles').then((r) => setProfiles(r.profiles ?? [])).catch(() => {})
  }
  const deleteProfile = async (p: Profile) => {
    await adminFetch(`/api/admin/security/profiles/${p.id}`, { method: 'DELETE' }).catch(() => {})
    void adminFetch<{ profiles: Profile[] }>('/api/admin/security/profiles').then((r) => setProfiles(r.profiles ?? [])).catch(() => {})
  }

  const profileMap = useMemo(() => new Map(profiles.map((p) => [p.id, p.name])), [profiles])
  const shownScans = useMemo(() => {
    const wantArchived = statusFilter === 'archived'
    return scans.filter((s) => {
      if (wantArchived !== !!s.archived) return false
      if (!wantArchived && statusFilter !== 'all') {
        const map: Record<string, SStatus[]> = {
          completed: ['done'], queued: ['pending'], running: ['running'],
          awaiting_input: [], failed: ['failed', 'cancelled'],
        }
        if (statusFilter !== 'all' && !(map[statusFilter] ?? []).includes(s.status)) return false
      }
      const q = search.toLowerCase()
      return !q || s.repo_name.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q)
    })
  }, [scans, search, statusFilter])
  const searching = !!search || statusFilter !== 'all'
  const shownProfiles = useMemo(() => profiles.filter((p) => !search || p.name.toLowerCase().includes(search.toLowerCase())), [profiles, search])
  const shownAutos = useMemo(() => automations.filter((a) => !search || a.name.toLowerCase().includes(search.toLowerCase())), [automations, search])
  const hasAny = scans.length > 0

  const tabBtn = (key: typeof tab, label: string, n: number | undefined) => (
    <button
      onClick={() => { setTab(key); setSearch('') }}
      className={cn('flex items-center gap-1.5 rounded-[6px] px-2.5 py-1 text-[13px]', tab === key ? 'bg-tint-secondary font-medium' : 'text-muted-foreground hover:text-foreground')}
      aria-pressed={tab === key}
    >
      {label}{n !== undefined && <span className="rounded-[4px] bg-tint-secondary px-1 text-[11px] text-muted-foreground tabular-nums">{n}</span>}
    </button>
  )

  return (
    <Shell sideOpen={sideOpen} setSideOpen={setSideOpen} tree={tree}>
      {detail && scanId ? (
        <div className="flex w-full flex-1 flex-col items-center overflow-y-auto" style={{ scrollbarGutter: 'stable' }}>
          <div className={cn('flex w-full flex-1 flex-col', PAGE_MAX, 'px-4 sm:px-6')}>
            <ScanDetail scan={detail} profiles={profileMap} onBack={() => nav('/admin/security')} onPatch={patchFinding} onFix={(f) => void fixWithDevin(f)} />
          </div>
        </div>
      ) : (
        /* official page shell: scrollbar-gutter + centered column + md:pt-[76px] */
        <div className="flex size-full flex-1 flex-col items-center overflow-y-auto md:pt-[76px]" style={{ scrollbarGutter: 'stable' }}>
          <div className={cn('flex w-full flex-col gap-10', PAGE_MAX, 'px-4 sm:px-6')}>
            {/* official header block: h2 + last-N-days dropdown + stats */}
            <div className="flex flex-col gap-10">
              <div className="mx-1 flex items-center justify-between">
                <h2 className="text-18 font-medium">{t('sec.heading')}</h2>
                {hasAny && (
                  <button className="flex h-7 items-center gap-1 rounded-[6px] px-2 text-[13px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground">
                    {t('sec.last30Days')}<ChevronDown size={13} />
                  </button>
                )}
              </div>
              {hasAny && (
                <div className="mx-1 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {(['critical', 'high', 'medium', 'low'] as const).map((sev) => (
                    <div key={sev} className="rounded-[10px] border border-border-secondary bg-bg-elevated px-3 py-2.5">
                      <div className="text-[12px] text-text-secondary">{t(`sec.sev.${sev}`)}</div>
                      <div className={cn('text-[17px] font-medium tabular-nums', sev === 'critical' ? 'text-red-500' : sev === 'high' ? 'text-orange' : 'text-text-primary')}>
                        {counts[sev] ?? 0}
                      </div>
                      <div className="text-[11px] text-text-secondary">{t('sec.openFindings')}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="flex flex-col">
              <div className="mx-1 flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="flex rounded-[7px] border border-border-secondary p-0.5">
                  {tabBtn('scans', t('sec.tabScans'), scans.filter((s) => !s.archived).length)}
                  {tabBtn('profiles', t('sec.tabProfiles'), profiles.length)}
                  {tabBtn('automations', t('sec.tabAutomations'), automations.length)}
                </div>
                <div className="flex items-center gap-2">
                  {tab === 'scans' && (
                    <>
                      <div className="flex items-center gap-0.5">
                        <SearchToggle value={search} onChange={setSearch} label={t('sec.searchScans')} placeholder={t('sec.searchScansPlaceholder')} />
                        <FilterPopover status={statusFilter} onStatus={setStatusFilter} label={t('sec.filterScansByStatusAndPrState')} />
                      </div>
                      <CreateScanButton onManual={() => setCreating(true)} />
                    </>
                  )}
                  {tab === 'profiles' && (
                    <>
                      <div className="flex items-center gap-0.5">
                        <SearchToggle value={search} onChange={setSearch} label={t('sec.searchProfiles')} placeholder={t('sec.searchProfilesPlaceholder')} />
                      </div>
                    </>
                  )}
                  {tab === 'automations' && (
                    <>
                      <SearchToggle value={search} onChange={setSearch} label={t('sec.searchAutomations')} placeholder={t('sec.searchAutomationsPlaceholder')} />
                      <Link to="/admin/automations" className="flex h-8 items-center rounded-[7px] bg-accent-primary px-3 text-[13px] font-medium text-white hover:opacity-90">
                        {t('sec.createAutomation')}
                      </Link>
                    </>
                  )}
                </div>
              </div>
              <div className="flex flex-col gap-5 pt-4">
                {tab === 'scans' ? (
                  <ScansTab scans={shownScans} loading={!loaded} error={error} searching={searching} archived={statusFilter === 'archived'} profiles={profileMap} onOpen={openScan} onArchive={(s, u) => void archiveScan(s, u)} />
                ) : tab === 'profiles' ? (
                  <ProfilesTab profiles={shownProfiles} loading={!loaded} searching={!!search} onCreate={(n, p) => void createProfile(n, p)} onEdit={(p, n, pr) => void editProfile(p, n, pr)} onDelete={(p) => void deleteProfile(p)} />
                ) : (
                  <AutomationsTab automations={shownAutos} loading={!loaded} searching={!!search} />
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {creating && <CreateScanDialog profiles={profiles} onClose={() => setCreating(false)} onCreated={load} />}
    </Shell>
  )
}
