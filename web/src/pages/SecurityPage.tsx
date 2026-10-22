import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ChevronDown } from 'lucide-react'
import { adminFetch } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { MirrorTreeSession } from './mirror/treeCache'
import {
  CreateScanButton, FilterPopover, PAGE_MAX, SearchToggle, Shell,
} from './security/atoms'
import type { Automation, Finding, Profile, SStatus, Scan } from './security/atoms'
import { ScansTab } from './security/ScansTab'
import { ScanDetail } from './security/ScanDetail'
import { ProfilesTab } from './security/ProfilesTab'
import { AutomationsTab } from './security/AutomationsTab'
import { CreateScanDialog } from './security/CreateScanDialog'

/* Local code scans — official "Security" surface parity, ported from the
 * deobfuscated official bundles (_deob/src/security/security-uJj1dvj4.js +
 * CodeScanDetailPage-Bx9eZ-s0.js). Each scan is a real acp session rooted at
 * the scanned directory; findings are agent-emitted JSON parsed server-side
 * into the official field shape (severity/status/finding_id).
 * Section components live in pages/security/*; this file is the page —
 * data loading, actions, tab bar and dispatch. */

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
