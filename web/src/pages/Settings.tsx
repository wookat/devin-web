import { useEffect, useState } from 'react'
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
    } catch { setPrefsMsg('添加失败：token 需以 devin-session-token 开头') }
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
          <p className="px-2 pb-1 pt-2 text-[11px] text-muted-foreground">Personal</p>
          <span className="flex h-[30px] items-center rounded-[6px] bg-tint-secondary px-2 font-medium text-foreground">首选项</span>
          <p className="px-2 pb-1 pt-3 text-[11px] text-muted-foreground">Organization</p>
          <span className="flex h-[30px] items-center rounded-[6px] px-2 text-muted-foreground">本地实例（local）</span>
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
      {/* Official 44px top bar (all widths): breadcrumb "Settings / Preferences" */}
      <header className="flex h-11 flex-shrink-0 select-none items-center gap-1 border-b border-border px-3">
        <Link to="/admin/new" aria-label="返回" className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent md:hidden">
          <PanelLeft size={15} />
        </Link>
        <span className="text-[13px] text-muted-foreground">Settings</span>
        <span className="text-[13px] text-muted-foreground">/</span>
        <span className="text-[13px] font-medium text-foreground">首选项</span>
      </header>
      {/* Official main: scrollable body, content col max-w-700 gap-36 */}
      <main className="relative h-full min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="w-full px-4 pb-4 pt-4 sm:px-12 sm:pb-12 sm:pt-12">
          <div className="mx-auto flex h-fit w-full max-w-[700px] flex-col gap-[36px]">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex min-w-0 flex-1 basis-80 flex-col gap-1">
                <h2 className="text-[17px] font-medium text-foreground">首选项</h2>
                <p className="text-[13px] text-muted-foreground">管理本地工作台的偏好设置</p>
              </div>
            </div>

            <Section title="Devin 会话">
              <Row title="会话中断后自动继续" desc="服务重启或进程终止导致回复中断时，自动发送「继续」恢复未完成的任务（不需要打开会话页面）。每个中断轮最多自动恢复 2 次。">
                <Sw on={!!autoResume} onToggle={toggleAutoResume} busy={autoResume == null} />
              </Row>
            </Section>

            <Section title="账号">
              {accounts.length === 0 && (
                <div className="px-[12px] py-[10px] text-[13px] text-muted-foreground">暂无账号信息</div>
              )}
              {accounts.map((a) => {
                const info = a.info ?? {}
                const quota = [info.dailyQuotaRemainingPercent != null && `日余 ${Math.round(info.dailyQuotaRemainingPercent)}%`,
                  info.weeklyQuotaRemainingPercent != null && `周余 ${Math.round(info.weeklyQuotaRemainingPercent)}%`].filter(Boolean).join(' · ')
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
                            {a.current && <span className="shrink-0 rounded-full bg-[#317CFF]/10 px-1.5 py-px text-[11px] font-medium text-[#317CFF]">当前</span>}
                            {a.cooling && <span className="shrink-0 rounded-full bg-amber-500/10 px-1.5 py-px text-[11px] font-medium text-amber-600">冷却中</span>}
                          </h4>
                          <div className="text-[13px] text-muted-foreground">
                            {[info.plan, quota, info.planEnd && `到期 ${info.planEnd.slice(0, 10)}`].filter(Boolean).join(' · ')}
                          </div>
                        </div>
                      </div>
                      <div className="relative flex items-center gap-1.5">
                        {a.cooling && <Btn2 title="清除该账号的冷却标记" disabled={!!accBusy} onClick={() => void accAction(`u:${a.name}`, '/api/accounts/unlimited', { name: a.name })}>解除冷却</Btn2>}
                        {!a.current && !a.cooling && <Btn2 title="轮换为该账号" disabled={!!accBusy} onClick={() => void accAction(`r:${a.name}`, '/api/accounts/rotate', { target: a.name })}>切换</Btn2>}
                        <Btn2 title="刷新配额信息" disabled={!!accBusy} onClick={() => void accAction(`f:${a.name}`, '/api/accounts/refresh', { name: a.name })}><RefreshCw size={13} /></Btn2>
                      </div>
                    </div>
                  </div>
                )
              })}
              <div className="flex min-h-[44px] items-center justify-between gap-2 rounded-[6px] px-[12px] py-[8px]">
                <span className="text-[13px] text-muted-foreground">{addOpen ? '粘贴 devin-session-token' : '添加新的会话 token'}</span>
                {addOpen ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      value={newKey}
                      onChange={(e) => setNewKey(e.target.value)}
                      placeholder="devin-session-token..."
                      className="h-[28px] w-[220px] rounded-[6px] border border-border bg-transparent px-2 text-[13px] outline-none focus:border-foreground/30"
                    />
                    <Btn2 disabled={!!accBusy || !newKey.trim()} onClick={() => void addAccount()}>添加</Btn2>
                    <Btn2 onClick={() => { setAddOpen(false); setNewKey('') }}>取消</Btn2>
                  </div>
                ) : (
                  <Btn2 onClick={() => setAddOpen(true)}><Plus size={13} /> 添加账号</Btn2>
                )}
              </div>
              {prefsMsg && <div className="px-[12px] pb-2 text-[12px] text-amber-600">{prefsMsg}</div>}
            </Section>

            <Section title="侧栏">
              <Row title="会话分组" desc="侧边栏会话列表的分组方式（文件夹 / 按工作目录项目）">
                <Sel value={groupBy} onPick={pickGroupBy}
                  options={[{ v: 'folders', l: '文件夹' }, { v: 'project', l: '按项目' }]} />
              </Row>
              <Row title="紧凑模式" desc="会话行只显示标题一行，不显示状态和时间">
                <Sw on={compact} onToggle={toggleCompact} />
              </Row>
              <Row title="显示已归档" desc="在会话列表中显示已归档的会话">
                <Sw on={showArchived} onToggle={toggleArchived} />
              </Row>
            </Section>

            <Section title="服务">
              <Row title="重启服务" desc="优雅排空在途会话后重启本地 server（约几秒）">
                <Btn2 onClick={() => {
                  if (!confirm('重启服务？server 将自动重生，页面稍后自动刷新。')) return
                  void adminFetch('/api/admin/restart', { method: 'POST', body: JSON.stringify({}) })
                    .then(() => { setPrefsMsg('重启中…稍后自动刷新'); setTimeout(() => location.reload(), 15000) })
                    .catch(() => setPrefsMsg('重启请求失败'))
                }}><RotateCcw size={13} /> 重启</Btn2>
              </Row>
              <Row title="重新构建并重启" desc="执行完整构建（约 1-3 分钟）后重启服务">
                <Btn2 onClick={() => {
                  if (!confirm('重新构建并重启？构建约 1-3 分钟，期间页面断开属正常。')) return
                  void adminFetch('/api/admin/redeploy', { method: 'POST', body: JSON.stringify({}) })
                    .then(() => setPrefsMsg('构建中…完成后自动重启'))
                    .catch(() => setPrefsMsg('构建请求失败'))
                }}><RefreshCw size={13} /> 重新构建</Btn2>
              </Row>
            </Section>

            <Section title="发送">
              <Row title="发送快捷键" desc="发送消息使用的按键（等价官方 Send shortcut）">
                <Sel value={sendWith} onPick={(v) => pickSend(v as 'enter' | 'ctrlenter')}
                  options={[{ v: 'enter', l: 'Enter' }, { v: 'ctrlenter', l: 'Ctrl+Enter' }]} />
              </Row>
            </Section>

            <Section title="外观">
              <Row title="主题" desc="选择界面色彩主题">
                <Sel value={theme} onPick={(v) => pickTheme(v as Theme)}
                  options={[{ v: 'system', l: '跟随系统' }, { v: 'light', l: '浅色' }, { v: 'dark', l: '深色' }]} />
              </Row>
            </Section>
          </div>
        </div>
      </main>
      </div>
    </div>
  )
}
