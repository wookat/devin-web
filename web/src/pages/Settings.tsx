import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '@/i18n'
import { Link } from 'react-router-dom'
import { ArrowLeft, PanelLeft, Plus, RefreshCw, RotateCcw } from 'lucide-react'
import { Combo } from '@/components/ui'
import { adminFetch } from '@/lib/api'
import { getTheme, setTheme, type Theme } from '@/lib/theme'

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
    (localStorage.getItem('wb-send-with') === 'ctrlenter' ? 'ctrlenter' : 'enter'))
  const [theme, setThemeState] = useState<Theme>(getTheme)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [accBusy, setAccBusy] = useState('')
  const [newKey, setNewKey] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [prefsMsg, setPrefsMsg] = useState('')
  const [groupBy, setGroupBy] = useState<string>(() => readTreePrefs().groupBy ?? 'folders')
  const [compact, setCompact] = useState<boolean>(() => !!readTreePrefs().compact)
  const [showArchived, setShowArchived] = useState<boolean>(() => !!readTreePrefs().showArchived)

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
  const pickSend = (v: 'enter' | 'ctrlenter') => { setSendWith(v); localStorage.setItem('wb-send-with', v) }
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

            <Section title={t('set.service')}>
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
            </Section>

            <Section title={t('set.send')}>
              <Row title={t('set.sendShortcut')} desc={t('set.sendShortcutDesc')}>
                <Sel value={sendWith} onPick={(v) => pickSend(v as 'enter' | 'ctrlenter')}
                  options={[{ v: 'enter', l: 'Enter' }, { v: 'ctrlenter', l: 'Ctrl+Enter' }]} />
              </Row>
            </Section>

            <Section title={t('set.appearance')}>
              <Row title={t('set.theme')} desc={t('set.themeDesc')}>
                <Sel value={theme} onPick={(v) => pickTheme(v as Theme)}
                  options={[{ v: 'system', l: t('set.thSystem') }, { v: 'light', l: t('set.thLight') }, { v: 'dark', l: t('set.thDark') }]} />
              </Row>
              <Row title={t('set.language')} desc={t('set.languageDesc')}>
                <Sel value={i18n.language.startsWith('zh') ? 'zh' : 'en'} onPick={(v) => void i18n.changeLanguage(v)}
                  options={[{ v: 'zh', l: '中文' }, { v: 'en', l: 'English' }]} />
              </Row>
            </Section>
          </div>
        </div>
      </main>
      </div>
    </div>
  )
}
