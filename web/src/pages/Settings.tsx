import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '@/i18n'
import { Link } from 'react-router-dom'
import { ArrowLeft, PanelLeft, Plus, RefreshCw, RotateCcw, ChevronDown, ChevronRight, FileText, BookOpen } from 'lucide-react'
import { Combo } from '@/components/ui'
import { adminFetch } from '@/lib/api'
import { getTheme, setTheme, type Theme } from '@/lib/theme'
import { CodeEditor } from '@/pages/mirror/WorkspacePanel'
import DoctorDialog from '@/components/DoctorDialog'

/** Preferences — markup replicated from app.devin.ai/settings/preferences
 * (DOM extracted live 2026-10-19): content column `flex flex-col gap-[36px]
 * max-w-[700px]`; page header `text-17` + `text-13 secondary`; each section =
 * `gap-[12px]` → `text-14` heading + double-layer card
 * (`bg-tint-tertiary rounded-[10px]` shell ⊃ `bg-elevated border rounded-[10px]
 * p-[6px]` body); each row `min-h-[60px] px-[12px] py-[10px]` with
 * `text-13` title + `text-13 text-secondary` desc, control right. */
interface AccountInfo {
  email?: string; userName?: string; plan?: string
  dailyQuotaRemainingPercent?: number; weeklyQuotaRemainingPercent?: number
  overageBalanceUsd?: number; planEnd?: string
}
interface Account {
  name: string; current: boolean; picked: boolean
  cooling?: boolean; limitedUntil?: number; info?: AccountInfo
}
const TREE_PREFS_KEY = 'sidebar-sessions-prefs'
const readTreePrefs = () => { try { return JSON.parse(localStorage.getItem(TREE_PREFS_KEY) || '{}') } catch { return {} } }

export default function Settings() {
  const { t } = useTranslation()
  const [autoResume, setAutoResume] = useState<boolean | null>(null)
  const [sendWith, setSendWith] = useState<'enter' | 'ctrlenter'>(() =>
    (localStorage.getItem('dw-send-with') === 'ctrlenter' ? 'ctrlenter' : 'enter'))
  const [theme, setThemeState] = useState<Theme>(getTheme)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [accBusy, setAccBusy] = useState('')
  const [newKey, setNewKey] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [prefsMsg, setPrefsMsg] = useState('')
  const [groupBy, setGroupBy] = useState<string>(() => readTreePrefs().groupBy ?? 'folders')
  const [compact, setCompact] = useState<boolean>(() => !!readTreePrefs().compact)
  const [showArchived, setShowArchived] = useState<boolean>(() => !!readTreePrefs().showArchived)
  const [doctor, setDoctor] = useState(false)

  const loadAccounts = () => {
    void adminFetch<{ accounts: Account[] }>('/api/accounts')
      .then((r) => setAccounts(r.accounts ?? []))
      .catch(() => {})
  }

  useEffect(() => {
    adminFetch<{ prefs: { autoResume?: boolean } }>('/api/admin/prefs')
      .then((r) => setAutoResume(!!r.prefs?.autoResume))
      .catch(() => setAutoResume(false))
    loadAccounts()
  }, [])

  const accAction = async (key: string, path: string, body: Record<string, unknown> = {}) => {
    if (accBusy) return
    setAccBusy(key)
    try {
      await adminFetch(path, { method: 'POST', body: JSON.stringify(body) })
      loadAccounts()
    } finally { setAccBusy('') }
  }
  const addAccount = async () => {
    const key = newKey.trim()
    if (!key || accBusy) return
    setAccBusy('add')
    try {
      await adminFetch('/api/accounts', { method: 'POST', body: JSON.stringify({ key }) })
      setNewKey(''); setAddOpen(false); loadAccounts()
    } catch { setPrefsMsg(t('set.addFail')) }
    finally { setAccBusy('') }
  }
  const writeTreePrefs = (patch: Record<string, unknown>) => {
    const cur = readTreePrefs()
    localStorage.setItem(TREE_PREFS_KEY, JSON.stringify({ ...cur, ...patch }))
  }
  const pickGroupBy = (v: string) => { setGroupBy(v); writeTreePrefs({ groupBy: v }) }
  const toggleCompact = () => { const v = !compact; setCompact(v); writeTreePrefs({ compact: v }) }
  const toggleArchived = () => { const v = !showArchived; setShowArchived(v); writeTreePrefs({ showArchived: v }) }

  const toggleAutoResume = () => {
    if (autoResume == null) return
    const next = !autoResume
    setAutoResume(next)
    void adminFetch('/api/admin/prefs', { method: 'POST', body: JSON.stringify({ autoResume: next }) })
      .catch(() => setAutoResume(!next))
  }
  const pickSend = (v: 'enter' | 'ctrlenter') => { setSendWith(v); localStorage.setItem('dw-send-with', v) }
  const pickTheme = (v: Theme) => { setThemeState(v); setTheme(v) }

  // Official row: [icon?] title+desc column | control — min-h-60px, 13px both lines.
  const Row = ({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) => (
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
  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="flex flex-col gap-[12px]">
      <div className="flex flex-col gap-[2px]"><h3 className="text-[14px] font-medium text-foreground">{title}</h3></div>
      <div className="overflow-hidden rounded-[10px] bg-tint-tertiary">
        <div className="flex flex-col gap-[2px] rounded-[10px] border border-border bg-card p-[6px]">{children}</div>
      </div>
    </div>
  )
  // Shared official combobox lives in components/ui.tsx (Combo) — trigger
  // content-sized, popup listbox. `width` lets a row pin a fixed trigger size.
  const Sel = ({ value, options, onPick, width = 'w-fit' }: { value: string; options: { v: string; l: string }[]; onPick: (v: string) => void; width?: string }) => (
    <Combo className={width} value={value} options={options} onPick={onPick} />
  )

  // Official switch: 36×20 p-2; unchecked tint-secondary, checked accent
  // blue #317CFF; 16px white thumb w/ border.
  const Sw = ({ on, onToggle, busy }: { on: boolean; onToggle: () => void; busy?: boolean }) => (
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
  const Btn2 = ({ children, onClick, disabled, title }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; title?: string }) => (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex h-[28px] cursor-pointer items-center gap-1 rounded-[6px] border border-border bg-card px-2 text-[13px] font-medium text-foreground outline-none hover:bg-tint-tertiary disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  )

  return (
    <div className="flex h-screen bg-background text-foreground">
      {/* Official left rail: 300px full-height settings nav (md+) */}
      <aside className="hidden w-[300px] shrink-0 flex-col border-r border-border bg-background md:flex">
        <div className="flex h-11 items-center border-b border-border px-3">
          <Link to="/admin/new" className="flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
            <ArrowLeft size={14} /> Back to app
          </Link>
        </div>
        <nav className="flex flex-col gap-0.5 p-2 text-[13px]">
          <p className="px-2 pb-1 pt-2 text-[11px] text-muted-foreground">{t('set.personal')}</p>
          <span className="flex h-[30px] items-center rounded-[6px] bg-tint-secondary px-2 font-medium text-foreground">{t('set.prefs')}</span>
          <p className="px-2 pb-1 pt-3 text-[11px] text-muted-foreground">{t('set.org')}</p>
          <span className="flex h-[30px] items-center rounded-[6px] px-2 text-muted-foreground">{t('set.localInstance')}</span>
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
      {/* Official 44px top bar (all widths): breadcrumb "Settings / Preferences" */}
      <header className="flex h-11 flex-shrink-0 select-none items-center gap-1 border-b border-border px-3">
        <Link to="/admin/new" aria-label={t('set.back')} className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent md:hidden">
          <PanelLeft size={15} />
        </Link>
        <span className="text-[13px] text-muted-foreground">{t('set.settings')}</span>
        <span className="text-[13px] text-muted-foreground">/</span>
        <span className="text-[13px] font-medium text-foreground">{t('set.prefs')}</span>
      </header>
      {/* Official main: scrollable body, content col max-w-700 gap-36 */}
      <main className="relative h-full min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="w-full px-4 pb-4 pt-4 sm:px-12 sm:pb-12 sm:pt-12">
          <div className="mx-auto flex h-fit w-full max-w-[700px] flex-col gap-[36px]">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex min-w-0 flex-1 basis-80 flex-col gap-1">
                <h2 className="text-[17px] font-medium text-foreground">{t('set.prefs')}</h2>
                <p className="text-[13px] text-muted-foreground">{t('set.prefsDesc')}</p>
              </div>
            </div>

            <Section title={t('set.general')}>
              <Row title={t('set.sendShortcut')} desc={t('set.sendShortcutDesc')}>
                <Sel value={sendWith} onPick={(v) => pickSend(v as 'enter' | 'ctrlenter')}
                  options={[{ v: 'enter', l: 'Enter' }, { v: 'ctrlenter', l: 'Ctrl+Enter' }]} />
              </Row>
              <Row title={t('set.theme')} desc={t('set.themeDesc')}>
                <Sel value={theme} onPick={(v) => pickTheme(v as Theme)}
                  options={[{ v: 'system', l: t('set.thSystem') }, { v: 'light', l: t('set.thLight') }, { v: 'dark', l: t('set.thDark') }]} />
              </Row>
              <Row title={t('set.language')} desc={t('set.languageDesc')}>
                <Sel value={i18n.language.startsWith('zh') ? 'zh' : 'en'} onPick={(v) => void i18n.changeLanguage(v)}
                  options={[{ v: 'zh', l: '中文' }, { v: 'en', l: 'English' }]} />
              </Row>
            </Section>

            <Section title={t('set.devinSession')}>
              <Row title={t('set.autoResume')} desc={t('set.autoResumeDesc')}>
                <Sw on={!!autoResume} onToggle={toggleAutoResume} busy={autoResume == null} />
              </Row>
            </Section>

            <Section title={t('set.accounts')}>
              {accounts.length === 0 && (
                <div className="px-[12px] py-[10px] text-[13px] text-muted-foreground">{t('set.noAccounts')}</div>
              )}
              {accounts.map((a) => {
                const info = a.info ?? {}
                const quota = [info.dailyQuotaRemainingPercent != null && `${t('set.daily')}${Math.round(info.dailyQuotaRemainingPercent)}%`,
                  info.weeklyQuotaRemainingPercent != null && `${t('set.weekly')}${Math.round(info.weeklyQuotaRemainingPercent)}%`].filter(Boolean).join(' · ')
                return (
                  <div key={a.name} className="flex min-h-[60px] flex-col justify-center gap-[14px] rounded-[6px] px-[12px] py-[10px]">
                    <div className="flex flex-row flex-wrap items-center justify-between gap-2 md:flex-nowrap">
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-tint-secondary text-[12px] font-medium text-foreground">
                          {(info.userName ?? a.name).slice(0, 1).toUpperCase()}
                        </div>
                        <div className="flex min-w-0 flex-col gap-[2px]">
                          <h4 className="flex items-center gap-2 text-[13px] font-normal text-foreground">
                            <span className="truncate">{info.email ?? a.name}</span>
                            {a.current && <span className="shrink-0 rounded-full bg-[#317CFF]/10 px-1.5 py-px text-[11px] font-medium text-[#317CFF]">{t('set.currentBadge')}</span>}
                            {a.cooling && <span className="shrink-0 rounded-full bg-amber-500/10 px-1.5 py-px text-[11px] font-medium text-amber-600">{t('set.coolingBadge')}</span>}
                          </h4>
                          <div className="text-[13px] text-muted-foreground">
                            {[info.plan, quota, info.planEnd && `${t('set.expiry')}${info.planEnd.slice(0, 10)}`].filter(Boolean).join(' · ')}
                          </div>
                        </div>
                      </div>
                      <div className="relative flex items-center gap-1.5">
                        {a.cooling && <Btn2 title={t('set.clearCooling')} disabled={!!accBusy} onClick={() => void accAction(`u:${a.name}`, '/api/accounts/unlimited', { name: a.name })}>{t('set.uncool')}</Btn2>}
                        {!a.current && !a.cooling && <Btn2 title={t('set.rotateTo')} disabled={!!accBusy} onClick={() => void accAction(`r:${a.name}`, '/api/accounts/rotate', { target: a.name })}>{t('set.switch')}</Btn2>}
                        <Btn2 title={t('set.refreshQuota')} disabled={!!accBusy} onClick={() => void accAction(`f:${a.name}`, '/api/accounts/refresh', { name: a.name })}><RefreshCw size={13} /></Btn2>
                      </div>
                    </div>
                  </div>
                )
              })}
              <div className="flex min-h-[44px] items-center justify-between gap-2 rounded-[6px] px-[12px] py-[8px]">
                <span className="text-[13px] text-muted-foreground">{addOpen ? t('set.pasteToken') : t('set.addToken')}</span>
                {addOpen ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      value={newKey}
                      onChange={(e) => setNewKey(e.target.value)}
                      placeholder="devin-session-token..."
                      className="h-[28px] w-[220px] rounded-[6px] border border-border bg-transparent px-2 text-[13px] outline-none focus:border-foreground/30"
                    />
                    <Btn2 disabled={!!accBusy || !newKey.trim()} onClick={() => void addAccount()}>{t('set.add')}</Btn2>
                    <Btn2 onClick={() => { setAddOpen(false); setNewKey('') }}>{t('common.cancel')}</Btn2>
                  </div>
                ) : (
                  <Btn2 onClick={() => setAddOpen(true)}><Plus size={13} /> {t('set.addAccount')}</Btn2>
                )}
              </div>
              {prefsMsg && <div className="px-[12px] pb-2 text-[12px] text-amber-600">{prefsMsg}</div>}
            </Section>

            <Section title={t('set.sidebar')}>
              <Row title={t('set.groupBy')} desc={t('set.groupByDesc')}>
                <Sel value={groupBy} onPick={pickGroupBy}
                  options={[{ v: 'folders', l: t('set.foldersOpt') }, { v: 'project', l: t('set.projectOpt') }]} />
              </Row>
              <Row title={t('set.compact')} desc={t('set.compactDesc')}>
                <Sw on={compact} onToggle={toggleCompact} />
              </Row>
              <Row title={t('set.showArchived')} desc={t('set.showArchivedDesc')}>
                <Sw on={showArchived} onToggle={toggleArchived} />
              </Row>
            </Section>

            <Section title={t('set.agentRes')}>
              <AgentResources />
            </Section>

            <Section title={t('set.service')}>
              <ServiceStatus />
              <Row title={t('set.restart')} desc={t('set.restartDesc')}>
                <Btn2 onClick={() => {
                  if (!confirm(t('set.restartConfirm'))) return
                  void adminFetch('/api/admin/restart', { method: 'POST', body: JSON.stringify({}) })
                    .then(() => { setPrefsMsg(t('set.restarting')); setTimeout(() => location.reload(), 15000) })
                    .catch(() => setPrefsMsg(t('set.restartFail')))
                }}><RotateCcw size={13} /> {t('set.restartBtn')}</Btn2>
              </Row>
              <Row title={t('set.rebuild')} desc={t('set.rebuildDesc')}>
                <Btn2 onClick={() => {
                  if (!confirm(t('set.redeployConfirm'))) return
                  void adminFetch('/api/admin/redeploy', { method: 'POST', body: JSON.stringify({}) })
                    .then(() => setPrefsMsg(t('set.building')))
                    .catch(() => setPrefsMsg(t('set.buildFail')))
                }}><RefreshCw size={13} /> {t('set.rebuildBtn')}</Btn2>
              </Row>
              <Row title={t('set.svcHardRestart')} desc={t('set.svcHardRestartDesc')}>
                <Btn2 onClick={() => {
                  if (!confirm(t('set.svcHardConfirm'))) return
                  void fetch('/api/_super/restart', { method: 'POST' })
                    .then(() => setPrefsMsg(t('set.svcHardSent')))
                    .catch(() => setPrefsMsg(t('set.restartFail')))
                }}><RotateCcw size={13} /> {t('set.svcHardBtn')}</Btn2>
              </Row>
              <Row title={t('set.svcStop')} desc={t('set.svcStopDesc')}>
                <Btn2 onClick={() => {
                  if (!confirm(t('set.svcStopConfirm'))) return
                  void fetch('/api/_super/stop', { method: 'POST' })
                    .then(() => setPrefsMsg(t('set.svcStopSent')))
                    .catch(() => setPrefsMsg(t('set.restartFail')))
                }}>{t('set.svcStopBtn')}</Btn2>
              </Row>
            </Section>

            <Section title={t('set.diag')}>
              <Row title={t('doc.entry')} desc={t('doc.rowDesc')}>
                <Btn2 onClick={() => setDoctor(true)}>{t('doc.runBtn')}</Btn2>
              </Row>
              <ModulesPanel />
              <SendCheck />
            </Section>

            <Section title={t('set.logs')}>
              <LogsPanel />
            </Section>

            <Section title={t('set.about')}>
              <AboutPanel />
            </Section>
          </div>
        </div>
      </main>
      </div>
      {doctor && <DoctorDialog onClose={() => setDoctor(false)} />}
    </div>
  )
}

/* Agent resources — multi-level (project/global) rules + skills browser.
 * Entries open inline into the shared CodeEditor; save rides
 * /api/admin/resource-file (server confines writes to resource roots). */
interface ResEntry { scope: string; name: string; path: string; description?: string }

function AgentResources() {
  const { t } = useTranslation()
  const [data, setData] = useState<{ cwd: string; rules: ResEntry[]; skills: ResEntry[] } | null>(null)
  const [openPath, setOpenPath] = useState<string | null>(null)
  useEffect(() => {
    void adminFetch<{ cwd: string; rules: ResEntry[]; skills: ResEntry[] }>('/api/admin/resources')
      .then(setData).catch(() => setData({ cwd: '', rules: [], skills: [] }))
  }, [])
  if (!data) return <p className="px-[12px] py-[10px] text-13 text-secondary">{t('common.loading')}</p>
  const groups: { scope: 'project' | 'global'; label: string }[] = [
    { scope: 'project', label: t('set.resProject') },
    { scope: 'global', label: t('set.resGlobal') },
  ]
  const entry = (e: ResEntry, kind: 'rule' | 'skill') => {
    const open = openPath === e.path
    return (
      <div key={e.path}>
        <button onClick={() => setOpenPath(open ? null : e.path)}
          className="flex w-full cursor-pointer items-center gap-2 px-[12px] py-[8px] text-left hover:bg-tint-secondary">
          {open ? <ChevronDown size={13} className="shrink-0 text-muted-foreground" /> : <ChevronRight size={13} className="shrink-0 text-muted-foreground" />}
          {kind === 'skill' ? <BookOpen size={13} className="shrink-0 text-accent-primary" /> : <FileText size={13} className="shrink-0 text-muted-foreground" />}
          <span className="min-w-0 flex-1 truncate text-13">{e.name}</span>
          {e.description && <span className="hidden max-w-[40%] truncate text-12 text-secondary sm:block">{e.description}</span>}
          <span className="shrink-0 truncate text-11 text-muted-foreground">{e.path}</span>
        </button>
        {open && (
          <div className="mx-3 mb-2 h-[320px] overflow-hidden rounded-[8px] border border-border">
            <ResFileEditor filePath={e.path} name={e.name} />
          </div>
        )}
      </div>
    )
  }
  return (
    <div className="px-[6px] py-[6px]">
      {groups.map((g) => {
        const rules = data.rules.filter((r) => r.scope === g.scope)
        const skills = data.skills.filter((s) => s.scope === g.scope)
        return (
          <div key={g.scope} className="mb-2 last:mb-0">
            <div className="px-[12px] pb-1 pt-2 text-11 font-medium uppercase tracking-wide text-muted-foreground">
              {g.label}{g.scope === 'project' && data.cwd ? ` — ${data.cwd}` : ''}
            </div>
            {!rules.length && !skills.length
              ? <p className="px-[12px] pb-2 text-12 text-secondary">{t('set.resEmpty')}</p>
              : <>{rules.map((r) => entry(r, 'rule'))}{skills.map((s) => entry(s, 'skill'))}</>}
          </div>
        )
      })}
    </div>
  )
}

function ResFileEditor({ filePath, name }: { filePath: string; name: string }) {
  const [saved, setSaved] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    setSaved(null); setErr(null)
    void adminFetch<{ text: string }>('/api/admin/resource-file?path=' + encodeURIComponent(filePath))
      .then((d) => { if (alive) { setSaved(d.text); setText(d.text) } })
      .catch((e) => { if (alive) setErr((e as Error).message) })
    return () => { alive = false }
  }, [filePath])
  if (err) return <p className="p-3 text-12 text-red-500">{err}</p>
  if (saved === null) return <p className="p-3 text-12 text-secondary">…</p>
  return (
    <CodeEditor text={text} savedText={saved} name={name}
      onChange={setText}
      onSave={() => void adminFetch('/api/admin/resource-file', { method: 'POST', body: JSON.stringify({ path: filePath, text }) }).then(() => setSaved(text))}
      onDiscard={() => setText(saved)} />
  )
}

/* ---- service status / logs / about panels -------------------------------
 * These ride the SUPERVISOR's own /api/_super/* endpoints (served even while
 * the backend is dead). In unmanaged dev mode they degrade to a note row. */
interface SuperStatus {
  ok: boolean; state: string; pid: number | null; backendPort: number
  uptime: number; recentExits: number; supervisorPid: number
  publicPort?: number; version?: string; node?: string
  platform?: string; repoRoot?: string; dataDir?: string
}
const useSuperStatus = () => {
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
const fmtUptime = (s: number) =>
  s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`

function ServiceStatus() {
  const { t } = useTranslation()
  const st = useSuperStatus()
  if (st === 'down') return <div className="px-[12px] py-[10px] text-[13px] text-muted-foreground">{t('set.svcUnmanaged')}</div>
  if (!st) return <div className="px-[12px] py-[10px] text-[13px] text-muted-foreground">…</div>
  const stateLabel = st.state === 'up' ? t('set.svcStateUp') : st.state === 'down' ? t('set.svcStateDown')
    : st.state === 'starting' ? t('set.svcStateStarting') : t('set.svcStateRestarting')
  const dot = st.state === 'up' ? 'bg-emerald-500' : 'bg-amber-500'
  const Item = ({ k, v }: { k: string; v: React.ReactNode }) => (
    <div className="flex items-center justify-between gap-2 px-[12px] py-[6px]">
      <span className="text-[12px] text-muted-foreground">{k}</span>
      <span className="font-mono text-[12px] text-foreground">{v}</span>
    </div>
  )
  return (
    <div className="rounded-[6px] px-0 py-[4px]">
      <div className="flex items-center gap-2 px-[12px] py-[6px]">
        <span className={`size-2 rounded-full ${dot}`} />
        <span className="text-[13px] font-medium text-foreground">{t('set.svcStatus')}</span>
        <span className="text-[12px] text-muted-foreground">{stateLabel}</span>
      </div>
      <Item k={t('set.svcSupervisor')} v={`pid ${st.supervisorPid}`} />
      <Item k={t('set.svcBackend')} v={st.pid ? `pid ${st.pid} :${st.backendPort}` : '—'} />
      <Item k={t('set.svcPorts')} v={st.publicPort ? `:${st.publicPort} → :${st.backendPort}` : `:${st.backendPort}`} />
      <Item k={t('set.svcUptime')} v={fmtUptime(st.uptime)} />
      <Item k={t('set.svcExits')} v={st.recentExits} />
    </div>
  )
}

/* Per-module health — every subsystem reports independently so a broken hop
 * is visible at a glance instead of one global up/down. Levels:
 * ok=emerald, warn=amber, fail=red. */
interface ModRow {
  id: string; level: 'ok' | 'warn' | 'fail'; detail: string; ms: number
  lane?: 'trunk' | 'branch'
  rows?: { name: string; value: string; level?: 'ok' | 'warn' | 'fail' }[]
}
interface SendErr { sessionId: string; ts: number; stage: string; message: string }

const LEVEL_DOT: Record<ModRow['level'], string> = {
  ok: 'bg-emerald-500', warn: 'bg-amber-500', fail: 'bg-red-500',
}

function ModulesPanel() {
  const { t } = useTranslation()
  const [mods, setMods] = useState<ModRow[] | 'down' | null>(null)
  const [errs, setErrs] = useState<SendErr[]>([])
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    const tick = () => void fetch('/api/admin/modules')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j: { modules: ModRow[]; recentSendErrors: SendErr[] }) => {
        if (!alive) return
        setMods(j.modules); setErrs(j.recentSendErrors ?? [])
      })
      .catch(() => alive && setMods('down'))
    tick()
    const iv = setInterval(tick, 10000)
    return () => { alive = false; clearInterval(iv) }
  }, [])
  if (mods === 'down') return <div className="px-[12px] py-[10px] text-[13px] text-red-500">/api/admin/modules — backend unreachable</div>
  if (!mods) return <div className="px-[12px] py-[10px] text-[13px] text-muted-foreground">…</div>
  const label = (id: string) => {
    if (id.startsWith('agent-')) return id.slice(6)
    const k = `set.mod${id[0].toUpperCase()}${id.slice(1)}`
    const v = t(k)
    return v === k ? id : v
  }
  return (
    <div className="rounded-[6px] py-[4px]">
      <div className="px-[12px] pb-1 pt-1 text-[11px] text-muted-foreground">{t('set.diagFlow')}</div>
      {mods.map((m, i) => {
        const branch = m.lane === 'branch'
        const lastBranch = branch && mods[i + 1]?.lane !== 'branch'
        const isOpen = open === m.id
        const canExpand = !!m.rows?.length
        return (
          <div key={m.id} className="flex">
            {/* continuous trunk rail; trunk rows overlay a node dot, branch
                rows get a tree elbow (├ / └) out to their indented dot */}
            <div className="relative w-[30px] shrink-0">
              <span className={`absolute left-[16px] w-px bg-border ${i === mods.length - 1 ? 'top-0 h-[11px]' : 'top-0 bottom-0'}`} />
              {!branch && <span className={`absolute left-[12px] top-[7px] size-2 rounded-full ${LEVEL_DOT[m.level]}`} />}
              {branch && (
                <span className="absolute left-[17px] top-[-2px] font-mono text-[12px] leading-none text-muted-foreground">
                  {lastBranch ? '└' : '├'}
                </span>
              )}
            </div>
            <div className={`min-w-0 flex-1 pb-[6px] pr-[12px] ${branch ? 'pl-[10px]' : ''}`}>
              <button
                onClick={() => canExpand && setOpen(isOpen ? null : m.id)}
                className={`flex w-full min-w-0 items-center gap-2 rounded-[4px] py-[4px] text-left ${canExpand ? 'cursor-pointer hover:bg-tint-secondary' : 'cursor-default'}`}>
                {branch && <span className={`size-2 shrink-0 rounded-full ${LEVEL_DOT[m.level]}`} />}
                {canExpand
                  ? (isOpen ? <ChevronDown size={13} className="shrink-0 text-muted-foreground" /> : <ChevronRight size={13} className="shrink-0 text-muted-foreground" />)
                  : <span className="w-[13px] shrink-0" />}
                <span className="w-[110px] shrink-0 truncate text-[12px] font-medium text-foreground">{label(m.id)}</span>
                <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
                  {m.detail.split(' · ').map((seg, si) => (
                    <span key={si} className="shrink-0 max-w-[180px] truncate rounded-[4px] bg-tint-secondary px-[5px] py-px font-mono text-[10px] text-secondary" title={seg}>{seg}</span>
                  ))}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground/60">{m.ms}ms</span>
              </button>
              {isOpen && canExpand && (
                <div className="mb-1 ml-[17px] rounded-[6px] border border-border bg-background px-[8px] py-[4px]">
                  {m.rows!.map((r, ri) => (
                    <div key={ri} className="flex items-center gap-2 py-[3px]">
                      {r.level && <span className={`size-[6px] shrink-0 rounded-full ${LEVEL_DOT[r.level]}`} />}
                      <span className="w-[110px] shrink-0 truncate text-[11px] text-muted-foreground">{r.name}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground" title={r.value}>{r.value}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )
      })}
      {errs.length > 0 && (
        <div className="mt-1 border-t border-border px-[12px] pt-2 pb-1">
          <div className="pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('set.lastErrRecent')}</div>
          {errs.slice(-6).reverse().map((e, i) => (
            <div key={i} className="truncate py-[3px] font-mono text-[11px] text-secondary" title={e.message}>
              {new Date(e.ts).toLocaleTimeString()} · <span className="text-red-500">[{e.stage}]</span> {e.sessionId.slice(0, 18)} — {e.message}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* Send-path preflight — runs the modular pipeline check for one session so a
 * send failure can be localized to a stage BEFORE the next attempt. */
interface SendStep { id: string; level: 'ok' | 'warn' | 'fail'; detail: string }
interface TreeSession { id?: string; session_id?: string; devin_id?: string; title?: string | null }

function SendCheck() {
  const { t } = useTranslation()
  const [sessions, setSessions] = useState<{ id: string; label: string }[]>([])
  const [sid, setSid] = useState('')
  const [steps, setSteps] = useState<SendStep[] | null>(null)
  const [verdict, setVerdict] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void adminFetch<{ sessions: TreeSession[] }>('/api/admin/mirror/sessions')
      .then((r) => setSessions((r.sessions ?? [])
        .map((s) => { const id = String(s.id ?? s.session_id ?? s.devin_id ?? ''); return { id, label: s.title || id } })
        .filter((s) => s.id).slice(0, 100)))
      .catch(() => {})
  }, [])
  const run = () => {
    if (!sid || busy) return
    setBusy(true)
    void fetch(`/api/admin/send-check?session=${encodeURIComponent(sid)}`)
      .then((r) => r.json())
      .then((j: { steps: SendStep[]; verdict: string }) => { setSteps(j.steps); setVerdict(j.verdict) })
      .catch(() => setSteps([{ id: 'fetch', level: 'fail', detail: 'request failed' }]))
      .finally(() => setBusy(false))
  }
  const verdictText = verdict === 'ok' ? t('set.verdictOk') : verdict === 'degraded' ? t('set.verdictDegraded') : verdict === 'blocked' ? t('set.verdictBlocked') : ''
  return (
    <div className="border-t border-border px-[12px] py-[10px]">
      <div className="pb-1 text-[13px] font-medium text-foreground">{t('set.sendCheck')}</div>
      <div className="pb-2 text-[12px] text-secondary">{t('set.sendCheckDesc')}</div>
      <div className="flex items-center gap-2">
        <Combo className="w-[240px]" value={sid} onPick={setSid}
          options={[{ v: '', l: t('set.sendCheckPick') }, ...sessions.map((s) => ({ v: s.id, l: s.label }))]} />
        <button onClick={run} disabled={busy || !sid}
          className="flex h-[28px] cursor-pointer items-center gap-1 rounded-[6px] border border-border bg-card px-2 text-[13px] font-medium text-foreground outline-none hover:bg-tint-tertiary disabled:cursor-not-allowed disabled:opacity-50">
          <RefreshCw size={12} className={busy ? 'animate-spin' : ''} /> {t('set.sendCheckRun')}
        </button>
        {verdictText && <span className={`text-[12px] font-medium ${verdict === 'ok' ? 'text-emerald-500' : verdict === 'blocked' ? 'text-red-500' : 'text-amber-500'}`}>{verdictText}</span>}
      </div>
      {steps && (
        <div className="mt-2 rounded-[8px] border border-border bg-background py-[4px]">
          {steps.map((s, i) => (
            <div key={s.id} className="flex">
              <div className="flex w-[26px] shrink-0 flex-col items-center pl-[10px]">
                <span className={`mt-[8px] size-2 shrink-0 rounded-full ${LEVEL_DOT[s.level]}`} />
                {i < steps.length - 1 && <span className="w-px flex-1 bg-border" />}
              </div>
              <div className="flex min-w-0 flex-1 items-center gap-2 px-[6px] pb-[5px] pt-[1px]">
                <span className="w-[80px] shrink-0 font-mono text-[11px] text-muted-foreground">{s.id}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-foreground" title={s.detail}>{s.detail}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function LogsPanel() {
  const { t } = useTranslation()
  const [file, setFile] = useState('supervisor')
  const [tail, setTail] = useState('300')
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const load = () => {
    setLoading(true)
    void fetch(`/api/_super/log?file=${file}&tail=${tail}`)
      .then((r) => r.text()).then(setText)
      .catch(() => setText(t('set.logMissing')))
      .finally(() => setLoading(false))
  }
  useEffect(load, [file, tail]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="px-[6px] py-[6px]">
      <div className="flex items-center gap-2 px-[6px] pb-2">
        <Combo className="w-fit" value={file} onPick={setFile}
          options={[{ v: 'supervisor', l: 'supervisor.log' }, { v: 'server', l: 'server.log' }, { v: 'respawn', l: 'respawn.log' }]} />
        <Combo className="w-fit" value={tail} onPick={setTail}
          options={[{ v: '100', l: '100' }, { v: '300', l: '300' }, { v: '1000', l: '1000' }]} />
        <button onClick={load} disabled={loading}
          className="flex h-[28px] cursor-pointer items-center gap-1 rounded-[6px] border border-border bg-card px-2 text-[13px] font-medium text-foreground hover:bg-tint-tertiary disabled:opacity-50">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> {t('set.logRefresh')}
        </button>
      </div>
      <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap break-all rounded-[8px] border border-border bg-background p-3 font-mono text-[11px] leading-[1.5] text-foreground">
        {text || '…'}
      </pre>
    </div>
  )
}

function AboutPanel() {
  const { t } = useTranslation()
  const st = useSuperStatus()
  const Item = ({ k, v }: { k: string; v: React.ReactNode }) => (
    <div className="flex items-center justify-between gap-4 px-[12px] py-[8px]">
      <span className="shrink-0 text-[13px] text-muted-foreground">{k}</span>
      <span className="min-w-0 truncate text-right font-mono text-[12px] text-foreground">{v}</span>
    </div>
  )
  const down = st === 'down' || !st
  return (
    <div className="py-[4px]">
      <Item k="devin-web" v={down ? '—' : `v${st.version}`} />
      <Item k={t('set.aboutRuntime')} v={down ? '—' : `Node ${st.node} · ${st.platform}`} />
      {!down && <Item k={t('set.aboutRepo')} v={st.repoRoot} />}
      {!down && <Item k={t('set.aboutData')} v={st.dataDir} />}
      <Item k={t('set.aboutDev')} v={t('set.aboutDevDesc')} />
    </div>
  )
}
