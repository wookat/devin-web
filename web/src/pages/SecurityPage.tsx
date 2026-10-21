import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  Shield, Loader2, Search, ChevronDown, Plus, X, ArrowLeft,
  ExternalLink, AlertTriangle, MoreHorizontal, Trash2, Play,
} from 'lucide-react'
import { OExpand } from '@/components/officialIcons'
import { adminFetch } from '@/lib/api'
import AppSidebar from '@/components/AppSidebar'
import { cn } from '@/lib/utils'
import type { MirrorTreeSession } from './mirror/treeCache'

/* Local code scans — official "Security" surface parity. Each scan is a real
 * acp session rooted at the scanned directory; findings are agent-emitted
 * JSON parsed server-side into the official field shape
 * (severity/status/stage/finding_id — see server/src/security.ts). */

interface Finding {
  finding_id: string
  title: string
  description: string
  file_path: string | null
  start_line: number | null
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  category: string | null
  cwe_id: string | null
  status: 'open' | 'resolved' | 'ignored' | 'false_positive'
  stage: 'unassigned' | 'triaged' | 'fixing' | 'resolved'
}
interface Scan {
  id: string
  repo_name: string
  cwd: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled'
  effort: 'lite' | 'standard'
  session_id: string | null
  finding_count?: number
  open_count?: number
  findings?: Finding[]
  summary: string
  created_at: number
  finished_at?: number
}
interface Profile { id: string; name: string; prompt: string; created_at: number }
interface Automation { id: string; name: string; schedule: string; enabled: boolean }

const PAGE_MAX = 'max-w-[min(1200px,max(50vw,800px))]'
const PAGE_PAD_X = 'px-4 sm:px-6'
const PAGE_PAD_Y = 'py-4 sm:py-8'

const rel = (ts?: number): string => {
  if (!ts) return '—'
  const d = Date.now() - ts
  if (d < 60e3) return 'just now'
  if (d < 3600e3) return `${Math.floor(d / 60e3)}m ago`
  if (d < 86400e3) return `${Math.floor(d / 3600e3)}h ago`
  return new Date(ts).toLocaleDateString()
}

const SEV_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const
const sevCls: Record<string, string> = {
  critical: 'bg-red-500/15 text-red-600 dark:text-red-400',
  high: 'bg-orange-500/15 text-orange-600 dark:text-orange-400',
  medium: 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-400',
  low: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  info: 'bg-tint-secondary text-muted-foreground',
}
const statusCls: Record<string, string> = {
  pending: 'bg-tint-secondary text-muted-foreground',
  running: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  done: 'bg-green-500/15 text-green-700 dark:text-green-400',
  failed: 'bg-red-500/15 text-red-600 dark:text-red-400',
  cancelled: 'bg-tint-secondary text-muted-foreground',
}

function SevBadge({ s }: { s: string }) {
  return <span className={cn('rounded-[5px] px-1.5 py-0.5 text-[11px] font-medium capitalize', sevCls[s] ?? sevCls.info)}>{s}</span>
}
function StatusBadge({ s }: { s: string }) {
  return <span className={cn('inline-flex items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-[11px] font-medium capitalize', statusCls[s] ?? statusCls.pending)}>
    {s === 'running' && <Loader2 size={10} className="animate-spin" />}{s}
  </span>
}

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

/* ---------------- create-scan dialog (official sheet: target + config) ---------------- */

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
          {/* Target */}
          <div className="flex flex-col gap-2">
            <div className="text-[13px] font-medium">{t('sec.target')}</div>
            <input
              value={cwd} onChange={(e) => setCwd(e.target.value)}
              placeholder={t('sec.cwdPlaceholder')}
              className="h-9 w-full rounded-[8px] border border-border-secondary bg-bg-elevated px-3 text-[13px] outline-none placeholder:text-muted-foreground"
            />
            {workspaces.length > 0 && (
              <div className="flex max-h-[120px] flex-col gap-0.5 overflow-y-auto rounded-[8px] border border-border-secondary p-1">
                {workspaces.slice(0, 12).map((w) => (
                  <button key={w.org} onClick={() => setCwd(w.org)} className={cn('truncate rounded-[5px] px-2 py-1 text-left text-[12px] hover:bg-tint-secondary', cwd === w.org && 'bg-tint-secondary font-medium')}>
                    {w.name} <span className="text-muted-foreground">· {w.org}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {/* Configuration */}
          <div className="flex flex-col gap-2">
            <div className="text-[13px] font-medium">{t('sec.config')}</div>
            <div className="flex items-center gap-2">
              <span className="w-20 shrink-0 text-[12px] text-muted-foreground">{t('sec.effort')}</span>
              <div className="flex rounded-[6px] border border-border-secondary p-0.5">
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
          {err && <div className="text-[12px] text-red-500">{err}</div>}
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} className="h-8 rounded-[6px] px-3 text-[13px] text-muted-foreground hover:bg-tint-secondary">{t('sec.cancel')}</button>
            <button onClick={() => void submit()} disabled={busy || !cwd.trim()} className="flex h-8 items-center gap-1.5 rounded-[6px] bg-accent-primary px-3 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={13} />}{t('sec.startScan')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ---------------- scans list ---------------- */

function ScansTab({ scans, counts, search, onOpen, onArchive, onRefresh }: {
  scans: Scan[]
  counts: Record<string, number>
  search: string
  onOpen: (s: Scan) => void
  onArchive: (s: Scan) => void
  onRefresh: () => void
}) {
  const { t } = useTranslation()
  const [menuFor, setMenuFor] = useState('')
  const shown = scans.filter((s) => !search || s.repo_name.toLowerCase().includes(search) || s.cwd.toLowerCase().includes(search))
  if (!scans.length) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-center">
        <Shield size={28} className="text-muted-foreground opacity-50" />
        <h3 className="text-[15px] font-medium">{t('sec.noScans')}</h3>
        <p className="text-[13px] text-muted-foreground">{t('sec.noScansHint')}</p>
      </div>
    )
  }
  return (
    <div className="mx-1 overflow-clip rounded-lg border border-border-secondary bg-bg-elevated">
      <div className="flex items-center gap-5 border-b border-border-secondary px-4 py-2 text-[12px] font-medium text-muted-foreground">
        <span className="min-w-0 flex-1">{t('sec.colScan')}</span>
        <span className="w-24 shrink-0">{t('sec.colFindings')}</span>
        <span className="w-24 shrink-0 text-right">{t('sec.colCreated')}</span>
        <span className="w-8 shrink-0" />
      </div>
      {shown.map((s) => (
        <div key={s.id} onClick={() => onOpen(s)} className="group/row relative flex cursor-pointer items-center gap-5 overflow-clip rounded-md px-3 py-2 hover:bg-tint-secondary">
          <Shield size={16} className="shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-2">
              <span className="truncate text-[13px] font-medium">{s.repo_name}</span>
              <StatusBadge s={s.status} />
            </div>
            <div className="truncate text-[12px] text-muted-foreground">{s.cwd}</div>
          </div>
          <div className="flex w-24 shrink-0 items-center gap-1">
            {s.status === 'done' && (s.open_count ?? 0) === 0
              ? <span className="text-[12px] text-green-600 dark:text-green-400">{t('sec.clean')}</span>
              : <span className="text-[13px]">{s.open_count ?? 0}<span className="text-muted-foreground">/{s.finding_count ?? 0}</span></span>}
          </div>
          <span className="w-24 shrink-0 text-right text-[12px] text-muted-foreground">{rel(s.created_at)}</span>
          <div className="relative w-8 shrink-0">
            <button
              onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === s.id ? '' : s.id) }}
              className="flex size-7 items-center justify-center rounded-[6px] text-muted-foreground opacity-0 hover:bg-background hover:text-foreground group-hover/row:opacity-100"
            >
              <MoreHorizontal size={15} />
            </button>
            {menuFor === s.id && (
              <div className="absolute right-0 top-8 z-20 w-44 rounded-[8px] border border-border-secondary bg-background p-1 shadow-lg" onClick={(e) => e.stopPropagation()}>
                {s.session_id && (
                  <Link to={`/admin/${s.session_id}`} className="flex items-center gap-2 rounded-[5px] px-2 py-1.5 text-[13px] hover:bg-tint-secondary">
                    <ExternalLink size={13} />{t('sec.viewSession')}
                  </Link>
                )}
                <button onClick={() => { setMenuFor(''); onArchive(s) }} className="flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-left text-[13px] text-red-500 hover:bg-tint-secondary">
                  <Trash2 size={13} />{t('sec.archive')}
                </button>
              </div>
            )}
          </div>
        </div>
      ))}
      {!shown.length && <div className="py-10 text-center text-[13px] text-muted-foreground">{t('sec.noMatch')}</div>}
    </div>
  )
}

/* ---------------- scan detail (findings table) ---------------- */

function ScanDetail({ scan, onBack, onPatch }: {
  scan: Scan
  onBack: () => void
  onPatch: (f: Finding, patch: Partial<Finding>) => void
}) {
  const { t } = useTranslation()
  const findings = [...(scan.findings ?? [])].sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity))
  return (
    <div className="flex flex-col gap-4">
      <div className="mx-1 flex items-center gap-3">
        <button onClick={onBack} className="flex size-7 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground"><ArrowLeft size={15} /></button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-[15px] font-medium">{scan.repo_name}</h3>
            <StatusBadge s={scan.status} />
          </div>
          <div className="truncate text-[12px] text-muted-foreground">{scan.cwd} · {rel(scan.created_at)}{scan.session_id && <> · <Link className="text-accent-primary hover:underline" to={`/admin/${scan.session_id}`}>{t('sec.viewSession')}</Link></>}</div>
        </div>
      </div>
      {scan.summary && <div className="mx-1 rounded-[10px] border border-border-secondary bg-bg-elevated px-4 py-3 text-[13px] text-muted-foreground">{scan.summary}</div>}
      {scan.status === 'running' || scan.status === 'pending' ? (
        <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-muted-foreground"><Loader2 size={15} className="animate-spin" />{t('sec.scanning')}</div>
      ) : findings.length === 0 ? (
        <div className="py-12 text-center text-[13px] text-muted-foreground">{t('sec.noFindings')}</div>
      ) : (
        <div className="mx-1 overflow-clip rounded-lg border border-border-secondary bg-bg-elevated">
          <div className="flex items-center gap-4 border-b border-border-secondary px-4 py-2 text-[12px] font-medium text-muted-foreground">
            <span className="w-20 shrink-0">{t('sec.colSeverity')}</span>
            <span className="min-w-0 flex-1">{t('sec.colFinding')}</span>
            <span className="w-28 shrink-0">{t('sec.colStatus')}</span>
          </div>
          {findings.map((f) => (
            <div key={f.finding_id} className="flex items-start gap-4 border-b border-border-secondary px-4 py-3 last:border-0">
              <span className="w-20 shrink-0 pt-0.5"><SevBadge s={f.severity} /></span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium">{f.title}</div>
                {f.file_path && <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{f.file_path}{f.start_line ? `:${f.start_line}` : ''}{f.cwe_id ? ` · ${f.cwe_id}` : ''}</div>}
                <div className="mt-1 whitespace-pre-wrap text-[12px] leading-[17px] text-muted-foreground">{f.description}</div>
              </div>
              <select
                value={f.status}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => onPatch(f, { status: e.target.value as Finding['status'] })}
                className="w-28 shrink-0 rounded-[6px] border border-border-secondary bg-background px-1.5 py-1 text-[12px] capitalize"
              >
                {['open', 'resolved', 'ignored', 'false_positive'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
              </select>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ---------------- profiles + automations tabs ---------------- */

function ProfilesTab({ profiles, onCreate, onDelete }: {
  profiles: Profile[]
  onCreate: (name: string, prompt: string) => void
  onDelete: (p: Profile) => void
}) {
  const { t } = useTranslation()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  return (
    <div className="flex flex-col gap-3">
      <div className="mx-1 flex justify-end">
        <button onClick={() => setAdding((a) => !a)} className="flex h-7 items-center gap-1 rounded-[6px] bg-accent-primary px-2.5 text-[13px] font-medium text-white hover:opacity-90"><Plus size={14} />{t('sec.createProfile')}</button>
      </div>
      {adding && (
        <div className="mx-1 flex flex-col gap-2 rounded-[10px] border border-border-secondary bg-bg-elevated p-3">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('sec.profileName')} className="h-8 rounded-[6px] border border-border-secondary bg-background px-2 text-[13px] outline-none" />
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t('sec.profilePrompt')} rows={3} className="rounded-[6px] border border-border-secondary bg-background px-2 py-1.5 text-[13px] outline-none" />
          <div className="flex justify-end gap-2">
            <button onClick={() => setAdding(false)} className="h-7 rounded-[6px] px-2.5 text-[13px] text-muted-foreground hover:bg-tint-secondary">{t('sec.cancel')}</button>
            <button onClick={() => { if (name.trim()) { onCreate(name.trim(), prompt.trim()); setName(''); setPrompt(''); setAdding(false) } }} className="h-7 rounded-[6px] bg-accent-primary px-2.5 text-[13px] font-medium text-white">{t('sec.save')}</button>
          </div>
        </div>
      )}
      {profiles.length === 0 ? (
        <div className="py-12 text-center text-[13px] text-muted-foreground">{t('sec.noProfiles')}</div>
      ) : (
        <div className="mx-1 overflow-clip rounded-lg border border-border-secondary bg-bg-elevated">
          {profiles.map((p) => (
            <div key={p.id} className="group flex items-center gap-4 border-b border-border-secondary px-4 py-2.5 last:border-0 hover:bg-tint-secondary">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{p.name}</div>
                <div className="truncate text-[12px] text-muted-foreground">{p.prompt || t('sec.defaultPrompt')}</div>
              </div>
              <span className="text-[12px] text-muted-foreground">{rel(p.created_at)}</span>
              <button onClick={() => onDelete(p)} className="flex size-7 items-center justify-center rounded-[6px] text-muted-foreground opacity-0 hover:bg-background hover:text-red-500 group-hover:opacity-100"><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function AutomationsTab({ automations }: { automations: Automation[] }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-3">
      <div className="mx-1 flex items-center justify-between">
        <span className="text-[12px] text-muted-foreground">{t('sec.autoHint')}</span>
        <Link to="/admin/automations" className="flex h-7 items-center gap-1 rounded-[6px] bg-accent-primary px-2.5 text-[13px] font-medium text-white hover:opacity-90"><Plus size={14} />{t('sec.newAutomation')}</Link>
      </div>
      {automations.length === 0 ? (
        <div className="py-12 text-center text-[13px] text-muted-foreground">{t('sec.noAutomations')}</div>
      ) : (
        <div className="mx-1 overflow-clip rounded-lg border border-border-secondary bg-bg-elevated">
          {automations.map((a) => (
            <Link key={a.id} to="/admin/automations" className="flex items-center gap-4 border-b border-border-secondary px-4 py-2.5 last:border-0 hover:bg-tint-secondary">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{a.name}</div>
                <div className="truncate text-[12px] text-muted-foreground">{a.schedule}</div>
              </div>
              {!a.enabled && <span className="rounded-[5px] bg-tint-secondary px-1.5 py-0.5 text-[11px] text-muted-foreground">{t('sec.disabled')}</span>}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

/* ---------------- page ---------------- */

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
  const [creating, setCreating] = useState(false)
  const [createMenu, setCreateMenu] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const load = () => {
    void adminFetch<{ scans: Scan[]; counts: Record<string, number> }>('/api/admin/security/scans')
      .then((r) => { setScans(r.scans ?? []); setCounts(r.counts ?? {}); setLoaded(true) }).catch(() => setLoaded(true))
    void adminFetch<{ profiles: Profile[] }>('/api/admin/security/profiles').then((r) => setProfiles(r.profiles ?? [])).catch(() => {})
    void adminFetch<{ automations: Automation[] }>('/api/admin/automations').then((r) => setAutomations(r.automations ?? [])).catch(() => {})
  }
  useEffect(() => {
    adminFetch<{ sessions: MirrorTreeSession[] }>('/api/admin/mirror/sessions').then((r) => setTree(r.sessions ?? [])).catch(() => {})
    load()
    const iv = setInterval(load, 5000) // live-ish status while a scan runs
    return () => clearInterval(iv)
  }, [])

  useEffect(() => {
    if (!scanId) { setDetail(null); return }
    void adminFetch<{ scan: Scan }>(`/api/admin/security/scans/${scanId}`).then((r) => setDetail(r.scan)).catch(() => setDetail(null))
  }, [scanId, scans])

  const openScan = (s: Scan) => nav(`/admin/security/${s.id}`)
  const archive = async (s: Scan) => { await adminFetch(`/api/admin/security/scans/${s.id}`, { method: 'DELETE' }).catch(() => {}); load() }
  const patchFinding = async (f: Finding, patch: Partial<Finding>) => {
    if (!scanId) return
    await adminFetch(`/api/admin/security/scans/${scanId}/findings/${f.finding_id}`, { method: 'PATCH', body: JSON.stringify(patch) }).catch(() => {})
    void adminFetch<{ scan: Scan }>(`/api/admin/security/scans/${scanId}`).then((r) => setDetail(r.scan)).catch(() => {})
    load()
  }
  const createProfile = async (name: string, prompt: string) => {
    await adminFetch('/api/admin/security/profiles', { method: 'POST', body: JSON.stringify({ name, prompt }) }).catch(() => {})
    void adminFetch<{ profiles: Profile[] }>('/api/admin/security/profiles').then((r) => setProfiles(r.profiles ?? [])).catch(() => {})
  }
  const deleteProfile = async (p: Profile) => {
    await adminFetch(`/api/admin/security/profiles/${p.id}`, { method: 'DELETE' }).catch(() => {})
    void adminFetch<{ profiles: Profile[] }>('/api/admin/security/profiles').then((r) => setProfiles(r.profiles ?? [])).catch(() => {})
  }

  const tabBtn = (key: typeof tab, label: string, n: number) => (
    <button
      onClick={() => setTab(key)}
      className={cn('flex items-center gap-1.5 rounded-[6px] px-2.5 py-1 text-[13px]', tab === key ? 'bg-tint-secondary font-medium' : 'text-muted-foreground hover:text-foreground')}
      aria-pressed={tab === key}
    >
      {label}<span className="rounded-[4px] bg-tint-secondary px-1 text-[11px] text-muted-foreground">{n}</span>
    </button>
  )

  return (
    <Shell sideOpen={sideOpen} setSideOpen={setSideOpen} tree={tree}>
      <div className="flex w-full flex-1 flex-col items-center overflow-y-auto" style={{ scrollbarGutter: 'stable' }}>
        <div className={cn('flex w-full flex-col gap-5', PAGE_MAX, PAGE_PAD_X, PAGE_PAD_Y)}>
          <h2 className="mx-1 text-18 font-medium">{t('sec.heading')}</h2>

          {detail && scanId ? (
            <ScanDetail scan={detail} onBack={() => nav('/admin/security')} onPatch={patchFinding} />
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                {/* official segmented tabs */}
                <div className="flex rounded-[7px] border border-border-secondary p-0.5">
                  {tabBtn('scans', t('sec.tabScans'), scans.length)}
                  {tabBtn('profiles', t('sec.tabProfiles'), profiles.length)}
                  {tabBtn('automations', t('sec.tabAutomations'), automations.length)}
                </div>
                <div className="flex items-center gap-2">
                  {tab === 'scans' && (
                    <div className="flex h-7 items-center gap-1.5 rounded-[6px] border border-border-secondary bg-bg-elevated px-2">
                      <Search size={13} className="text-muted-foreground" />
                      <input value={search} onChange={(e) => setSearch(e.target.value.toLowerCase())} placeholder={t('sec.search')} aria-label={t('sec.search')} className="h-full w-36 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground" />
                    </div>
                  )}
                  {tab === 'scans' && (
                    <div className="relative">
                      <button onClick={() => setCreateMenu((m) => !m)} className="flex h-7 items-center gap-1 rounded-[6px] bg-accent-primary px-2.5 text-[13px] font-medium text-white hover:opacity-90">
                        {t('sec.createScan')}<ChevronDown size={13} />
                      </button>
                      {createMenu && (
                        <div className="absolute right-0 top-8 z-20 w-52 rounded-[8px] border border-border-secondary bg-background p-1 shadow-lg">
                          <button onClick={() => { setCreateMenu(false); setCreating(true) }} className="flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-left text-[13px] hover:bg-tint-secondary">
                            <Play size={13} />{t('sec.manual')}
                          </button>
                          <button disabled title={t('sec.devinSoon')} className="flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-left text-[13px] text-muted-foreground opacity-50">
                            <AlertTriangle size={13} />{t('sec.withDevin')}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {!loaded ? (
                <div className="flex justify-center py-16"><Loader2 size={18} className="animate-spin text-muted-foreground" /></div>
              ) : tab === 'scans' ? (
                <ScansTab scans={scans} counts={counts} search={search} onOpen={openScan} onArchive={(s) => void archive(s)} onRefresh={load} />
              ) : tab === 'profiles' ? (
                <ProfilesTab profiles={profiles} onCreate={(n, p) => void createProfile(n, p)} onDelete={(p) => void deleteProfile(p)} />
              ) : (
                <AutomationsTab automations={automations} />
              )}
            </>
          )}
        </div>
      </div>
      {creating && <CreateScanDialog profiles={profiles} onClose={() => setCreating(false)} onCreated={load} />}
    </Shell>
  )
}
