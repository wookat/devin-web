import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Clock, Plus, Loader2, MoreHorizontal, Play, Search, ArrowUp, ArrowDown, ChevronDown, X } from 'lucide-react'
import { OExpand } from '@/components/officialIcons'
import { adminFetch } from '@/lib/api'
import AppSidebar from '@/components/AppSidebar'
import { cn } from '@/lib/utils'
import type { MirrorTreeSession } from './mirror/treeCache'
import { dateLoc, relAgo } from '@/lib/datetime'

/** Local scheduled sessions — official "Automations" page parity (structure
 *  ported from _deob/src/routes/AutomationsPage.js + components/
 *  AutomationListTable.js + AutomationListItem.js). Each fire spawns a real
 *  session on the automation's cwd via the backend 30s cron tick. */
interface Automation {
  id: string; name: string; prompt: string; schedule: string; cwd: string
  enabled: boolean; createdAt: number; lastRun?: number; lastSession?: string; nextRun?: number
  steps?: { name: string; prompt: string }[]
  runs?: { at: number; sessionId: string | null }[]
  running?: Record<string, { step: number; sentAt: number; prompts: string[] }>
}
interface Playbook { id: string; name: string; prompt: string }

const PAGE_MAX = 'max-w-[min(1200px,max(50vw,800px))]'
const PAGE_PAD_X = 'px-4 sm:px-6'
const PAGE_PAD_Y = 'py-4 sm:py-8'
const PAGE_SIZE = 20

const PRESETS: { key: string; cron: string }[] = [
  { key: 'au.p5', cron: '*/5 * * * *' },
  { key: 'au.hourly', cron: '0 * * * *' },
  { key: 'au.daily9', cron: '0 9 * * *' },
  { key: 'au.mon9', cron: '0 9 * * 1' },
  { key: 'au.custom', cron: '' },
]

const rel = (ts?: number): string => {
  if (!ts) return '—'
  const d = Date.now() - ts
  if (d < 86400e3) return relAgo(ts)
  return new Date(ts).toLocaleDateString(dateLoc())
}

/** Humanize the common cron shapes we preset; anything else shows raw. */
const humanCron = (cron: string, t: (k: string, o?: Record<string, unknown>) => string): string => {
  const f = cron.trim().split(/\s+/)
  if (f.length !== 5) return cron
  const [mi, h, dom, mo, dow] = f
  if (/^\*\/(\d+)$/.test(mi) && h === '*' && dom === '*' && mo === '*' && dow === '*')
    return t('au.everyMin', { n: mi.slice(2) })
  if (mi === '0' && h === '*' && dom === '*' && mo === '*' && dow === '*') return t('au.hourly')
  if (/^\d+$/.test(mi) && /^\d+$/.test(h) && dom === '*' && mo === '*' && dow === '*')
    return t('au.dailyAt', { time: `${h.padStart(2, '0')}:${mi.padStart(2, '0')}` })
  if (/^\d+$/.test(mi) && /^\d+$/.test(h) && dom === '*' && mo === '*' && /^\d$/.test(dow))
    return t('au.weeklyAt', { dow: t(`au.dow${dow}`), time: `${h.padStart(2, '0')}:${mi.padStart(2, '0')}` })
  if (/^\d+$/.test(mi) && /^\d+$/.test(h) && dom === '*' && mo === '*' && dow === '*') return cron
  return cron
}

/** Official intro-diagram atoms: label pill + down-arrow + branch-arrow SVGs
 *  (paths copied verbatim from the deob'd page). */
function IntroPill({ icon, title, subtitle, wide }: { icon: React.ReactNode; title: string; subtitle?: string; wide?: boolean }) {
  return (
    <div className={cn('shadow-sm flex items-center gap-2.5 rounded-[10px] border border-border-secondary bg-card px-4 py-2.5', wide && 'w-[280px]')}>
      <span className="flex shrink-0 items-center gap-1">{icon}</span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-[13px] font-medium">{title}</span>
        {subtitle && <span className="truncate text-[12px] text-muted-foreground">{subtitle}</span>}
      </span>
    </div>
  )
}
const ArrowDown1 = () => (
  <svg width="12" height="42" viewBox="0 0 12 42" fill="none" className="my-1.5 opacity-10" aria-hidden>
    <path d="M6 1v31" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <path d="M6 41L1.5 31.5h9L6 41Z" fill="currentColor" />
  </svg>
)
const ArrowBranch = () => (
  <svg width="380" height="56" viewBox="0 0 380 56" fill="none" className="my-1.5 opacity-10" aria-hidden>
    <g stroke="currentColor" strokeWidth="2">
      <path d="M190 15c0 5-4 9-9 9H47c-5 0-9 4-9 9v9" />
      <path d="M190 1v41" strokeLinecap="round" />
      <path d="M190 15c0 5 4 9 9 9h134c5 0 9 4 9 9v9" />
    </g>
    <g fill="currentColor">
      <path d="M38 51l-4.5-9.5h9L38 51Z" />
      <path d="M190 51l-4.5-9.5h9L190 51Z" />
      <path d="M342 51l-4.5-9.5h9L342 51Z" />
    </g>
  </svg>
)

export default function AutomationsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [sideOpen, setSideOpen] = useState(window.innerWidth >= 1024)
  const [tree, setTree] = useState<MirrorTreeSession[]>([])
  const [items, setItems] = useState<Automation[]>([])
  const [busy, setBusy] = useState('')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'all' | 'mine'>('all')
  const [page, setPage] = useState(0)
  const [sort, setSort] = useState<{ col: 'name' | 'last'; dir: 1 | -1 }>({ col: 'name', dir: 1 })
  const [menuFor, setMenuFor] = useState('')
  const [delFor, setDelFor] = useState<Automation | null>(null)
  const [batchFor, setBatchFor] = useState<Automation | null>(null)
  const [batchText, setBatchText] = useState('')
  const [form, setForm] = useState<{ open: boolean; name: string; prompt: string; preset: string; cron: string; cwd: string; steps: { name: string; prompt: string }[] }>({ open: false, name: '', prompt: '', preset: '0', cron: '', cwd: '', steps: [] })
  const [createMenu, setCreateMenu] = useState(false)
  const [playbooks, setPlaybooks] = useState<Playbook[]>([])
  const [tplPanel, setTplPanel] = useState(false)
  const [err, setErr] = useState('')

  const load = () => {
    adminFetch<{ sessions: MirrorTreeSession[] }>('/api/admin/mirror/sessions').then((r) => setTree(r.sessions ?? [])).catch(() => {})
    adminFetch<{ automations: Automation[] }>('/api/admin/automations').then((r) => setItems(r.automations ?? [])).catch(() => {})
    adminFetch<{ playbooks: Playbook[] }>('/api/admin/playbooks').then((r) => setPlaybooks(r.playbooks ?? [])).catch(() => {})
  }
  useEffect(load, [])

  const schedule = form.preset === String(PRESETS.length - 1) ? form.cron : PRESETS[+form.preset].cron
  const openForm = (a?: Automation) => {
    setCreateMenu(false)
    setTplPanel(false)
    setForm(a
      ? { open: true, name: t('au.copyOf', { name: a.name }), prompt: a.prompt, preset: String(PRESETS.length - 1), cron: a.schedule, cwd: a.cwd, steps: (a.steps ?? []).slice(1).map((s) => ({ ...s })) }
      : { open: true, name: '', prompt: '', preset: '0', cron: '', cwd: '', steps: [] })
  }
  const create = async () => {
    setErr('')
    const steps = [{ name: '', prompt: form.prompt.trim() }, ...form.steps.map((s) => ({ name: s.name.trim(), prompt: s.prompt.trim() }))]
    try {
      await adminFetch('/api/admin/automations', { method: 'POST', body: JSON.stringify({ name: form.name.trim(), prompt: form.prompt.trim(), ...(steps.length > 1 ? { steps } : {}), schedule, cwd: form.cwd.trim() || undefined }) })
      setForm((f) => ({ ...f, open: false, name: '', prompt: '', steps: [] }))
      load()
    } catch (e) { setErr((e as Error).message) }
  }
  const saveTpl = async () => {
    if (!form.name.trim() || !form.prompt.trim()) return
    try { await adminFetch('/api/admin/playbooks', { method: 'POST', body: JSON.stringify({ name: form.name.trim(), prompt: form.prompt.trim() }) }); load() } catch { /* toast-less */ }
  }
  const useTpl = (pb: Playbook) => { setTplPanel(false); setForm((f) => ({ ...f, open: true, name: f.name || pb.name, prompt: pb.prompt })) }
  const delTpl = async (id: string) => { try { await adminFetch(`/api/admin/playbooks/${id}`, { method: 'DELETE' }); load() } catch { /* toast-less */ } }
  const act = async (id: string, path = '', body?: unknown, del = false) => {
    setBusy(id + path)
    try { await adminFetch(`/api/admin/automations/${id}${path}`, { method: del ? 'DELETE' : 'POST', body: JSON.stringify(body ?? {}) }); load() }
    catch { /* toast-less */ }
    finally { setBusy('') }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = items.filter((a) => !q || a.name.toLowerCase().includes(q) || a.prompt.toLowerCase().includes(q) || a.schedule.includes(q))
    return [...list].sort((a, b) => sort.col === 'name'
      ? sort.dir * a.name.localeCompare(b.name)
      : sort.dir * ((a.lastRun ?? 0) - (b.lastRun ?? 0)))
  }, [items, search, sort])
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const toggleSort = (col: 'name' | 'last') => setSort((s) => s.col === col ? { col, dir: (s.dir * -1) as 1 | -1 } : { col, dir: 1 })

  const sortIcon = (col: 'name' | 'last') => sort.col === col ? (sort.dir === 1 ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : null
  const thBtn = (col: 'name' | 'last', cls?: string) => (
    <button type="button" onClick={() => toggleSort(col)} className={cn('flex cursor-pointer items-center gap-1 hover:text-foreground', cls)}>{sortIcon(col)}{col === 'name' ? t('au.nameCol') : t('au.lastTrig')}</button>
  )

  const rowMenu = (a: Automation) => menuFor === a.id && (
    <>
      <div className="fixed inset-0 z-30" onClick={() => setMenuFor('')} />
      <div className="absolute right-0 top-full z-40 mt-1 min-w-[160px] rounded-lg border border-border bg-popover p-1 shadow-lg">
        <button disabled={busy === a.id} onClick={() => { setMenuFor(''); void act(a.id, '', { enabled: !a.enabled }) }} className="flex h-8 w-full cursor-pointer items-center rounded-md px-2.5 text-[13px] hover:bg-accent disabled:opacity-50">{a.enabled ? t('au.disable') : t('au.enable')}</button>
        <button disabled={busy === a.id + '/run'} onClick={() => { setMenuFor(''); void act(a.id, '/run') }} className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-[13px] hover:bg-accent disabled:opacity-50"><Play size={12} />{t('au.runNow')}</button>
        <button onClick={() => { setMenuFor(''); setBatchFor(a); setBatchText('') }} className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-[13px] hover:bg-accent"><Plus size={12} />{t('au.runBatch')}</button>
        {a.lastSession && <button onClick={() => navigate(`/admin/${a.lastSession}`)} className="flex h-8 w-full cursor-pointer items-center rounded-md px-2.5 text-[13px] hover:bg-accent">{t('au.viewSessions')}</button>}
        {(a.runs?.length ?? 0) > 0 && (
          <>
            <div className="px-2.5 pb-0.5 pt-1.5 text-[11px] font-medium text-muted-foreground">{t('au.runs')}</div>
            {a.runs!.slice(-5).reverse().map((r, i) => (
              <button key={i} disabled={!r.sessionId} onClick={() => { setMenuFor(''); if (r.sessionId) navigate(`/admin/${r.sessionId}`) }} className="flex h-7 w-full cursor-pointer items-center rounded-md px-2.5 text-[12px] tabular-nums text-muted-foreground hover:bg-accent disabled:cursor-default disabled:opacity-50">
                {rel(r.at)}{!r.sessionId && ` · ${t('au.runFailed')}`}
              </button>
            ))}
          </>
        )}
        <button onClick={() => { setMenuFor(''); openForm(a) }} className="flex h-8 w-full cursor-pointer items-center rounded-md px-2.5 text-[13px] hover:bg-accent">{t('au.duplicate')}</button>
        <div className="my-1 h-px bg-border" />
        <button onClick={() => { setMenuFor(''); setDelFor(a) }} className="flex h-8 w-full cursor-pointer items-center rounded-md px-2.5 text-[13px] text-red-500 hover:bg-red-500/10">{t('au.delete')}</button>
      </div>
    </>
  )

  return (
    <div className="flex h-screen bg-background text-foreground">
      <AppSidebar
        open={sideOpen} onToggle={setSideOpen} active="automations"
        tree={tree.filter((s) => s.status_enum !== 'archived')}
        archivedTree={tree.filter((s) => s.status_enum === 'archived')}
        onOpen={(s) => navigate(`/admin/${s.devin_id}`)}
        onRefresh={() => void adminFetch<{ sessions: MirrorTreeSession[] }>('/api/admin/mirror/sessions').then((r) => setTree(r.sessions ?? [])).catch(() => {})}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border-secondary px-2 pr-[7px]">
          {!sideOpen && (
            <button onClick={() => setSideOpen(true)} className="flex size-7 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground" aria-label={t('sp.expandSb')} title={t('sp.expandSb')}>
              <OExpand size={16} />
            </button>
          )}
        </header>
        {/* Official page shell: centered md column inside a scroll container */}
        <div className={cn('min-h-0 flex-1 overflow-y-auto', 'flex flex-col items-center')} style={{ scrollbarGutter: 'stable' }}>
          <div className={cn('flex w-full flex-col gap-4', PAGE_PAD_X, PAGE_PAD_Y, PAGE_MAX)}>
            <div className="mx-1 flex flex-col gap-1">
              <h2 className="text-[18px] font-medium">{t('au.title')}</h2>
              <p className="text-[13px] text-muted-foreground">{t('au.subtitle')}</p>
            </div>

            {/* Toolbar: segmented tabs + search + create split */}
            <div className="mx-1 my-1.5 flex items-center justify-between gap-2">
              <div className="flex items-center rounded-lg bg-tint-secondary/60 p-0.5">
                {(['mine', 'all'] as const).map((k) => (
                  <button key={k} onClick={() => { setTab(k); setPage(0) }} className={cn('flex h-7 cursor-pointer items-center gap-1 rounded-[6px] px-2.5 text-[13px]', tab === k ? 'bg-card font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                    {t(`au.${k}`)}<span className="rounded bg-tint-tertiary px-1 text-[11px] tabular-nums text-muted-foreground">{items.length}</span>
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <div className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5">
                  <Search size={13} className="shrink-0 text-muted-foreground" />
                  <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(0) }} placeholder={t('au.searchPh')} className="w-40 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground" />
                  {search && <button onClick={() => setSearch('')} className="cursor-pointer text-muted-foreground hover:text-foreground"><X size={12} /></button>}
                </div>
                <div className="relative">
                  <button onClick={() => setCreateMenu((o) => !o)} className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:opacity-90">
                    {t('au.create')}<ChevronDown size={13} />
                  </button>
                  {createMenu && (
                    <>
                      <div className="fixed inset-0 z-30" onClick={() => setCreateMenu(false)} />
                      <div className="absolute right-0 top-full z-40 mt-1 min-w-[190px] rounded-lg border border-border bg-popover p-1 shadow-lg">
                        <button onClick={() => openForm()} className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-[13px] hover:bg-accent"><Plus size={13} />{t('au.createManual')}</button>
                        <button onClick={() => { setCreateMenu(false); setTplPanel((o) => !o) }} className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-[13px] hover:bg-accent"><Clock size={13} />{t('au.fromTpl')}</button>
                        <button disabled title={t('au.comingSoon')} className="flex h-8 w-full cursor-not-allowed items-center gap-2 rounded-md px-2.5 text-[13px] text-muted-foreground opacity-50">{t('au.genDevin')}</button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Playbook picker — "create from template" target */}
            {tplPanel && (
              <div className="mx-1 flex flex-col gap-1 rounded-lg border border-border-secondary bg-card p-2">
                <div className="flex items-center justify-between px-1.5 py-1">
                  <span className="text-[12px] font-medium text-muted-foreground">{t('au.tplLib')}</span>
                  <button onClick={() => setTplPanel(false)} className="cursor-pointer text-muted-foreground hover:text-foreground"><X size={13} /></button>
                </div>
                {playbooks.length === 0 && <div className="px-1.5 py-3 text-center text-[12px] text-muted-foreground">{t('au.tplEmpty')}</div>}
                {playbooks.map((pb) => (
                  <div key={pb.id} className="flex items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-tint-secondary">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px]">{pb.name}</div>
                      <div className="truncate text-[12px] text-muted-foreground">{pb.prompt}</div>
                    </div>
                    <button onClick={() => useTpl(pb)} className="shrink-0 cursor-pointer rounded-md px-2 py-1 text-[12px] hover:bg-accent">{t('au.useTpl')}</button>
                    <button onClick={() => delTpl(pb.id)} aria-label={t('au.delete')} className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-red-500"><X size={12} /></button>
                  </div>
                ))}
              </div>
            )}

            {/* Create form (official links to /automations/create; ours is inline) */}
            {form.open && (
              <div className="mx-1 flex flex-col gap-3 rounded-lg border border-border-secondary bg-card p-4">
                <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder={t('au.namePh')} className="rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none placeholder:text-muted-foreground focus:border-ring" />
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <span className="w-14 shrink-0 text-[12px] text-muted-foreground">{t('au.stepN', { n: 1 })}</span>
                    <textarea value={form.prompt} onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))} placeholder={t('au.promptPh')} rows={3} className="min-w-0 flex-1 resize-y rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none placeholder:text-muted-foreground focus:border-ring" />
                  </div>
                  {form.steps.map((s, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <input value={s.name} onChange={(e) => setForm((f) => ({ ...f, steps: f.steps.map((x, j) => j === i ? { ...x, name: e.target.value } : x) }))} placeholder={t('au.stepN', { n: i + 2 })} className="w-14 shrink-0 rounded-md border border-border bg-background px-1.5 py-2 text-[12px] outline-none placeholder:text-muted-foreground focus:border-ring" />
                      <textarea value={s.prompt} onChange={(e) => setForm((f) => ({ ...f, steps: f.steps.map((x, j) => j === i ? { ...x, prompt: e.target.value } : x) }))} placeholder={t('au.stepPh')} rows={2} className="min-w-0 flex-1 resize-y rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none placeholder:text-muted-foreground focus:border-ring" />
                      <button onClick={() => setForm((f) => ({ ...f, steps: f.steps.filter((_, j) => j !== i) }))} aria-label={t('au.delStep')} className="mt-1.5 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"><X size={13} /></button>
                    </div>
                  ))}
                  {form.steps.length < 19 && (
                    <button onClick={() => setForm((f) => ({ ...f, steps: [...f.steps, { name: '', prompt: '' }] }))} className="flex h-7 w-fit cursor-pointer items-center gap-1 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground"><Plus size={12} />{t('au.addStep')}</button>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative">
                    <select value={form.preset} onChange={(e) => setForm((f) => ({ ...f, preset: e.target.value }))} className="appearance-none rounded-md border border-border bg-background py-2 pl-3 pr-8 text-[13px] outline-none focus:border-ring">
                      {PRESETS.map((p, i) => <option key={p.key} value={i}>{t(p.key)}</option>)}
                    </select>
                    <ChevronDown size={13} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  </div>
                  {form.preset === String(PRESETS.length - 1) && (
                    <input value={form.cron} onChange={(e) => setForm((f) => ({ ...f, cron: e.target.value }))} placeholder="* * * * *" className="w-36 rounded-md border border-border bg-background px-3 py-2 font-mono text-[12px] outline-none placeholder:text-muted-foreground focus:border-ring" />
                  )}
                  <input value={form.cwd} onChange={(e) => setForm((f) => ({ ...f, cwd: e.target.value }))} placeholder={t('au.cwdPh')} className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none placeholder:text-muted-foreground focus:border-ring" />
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={create} disabled={!form.name.trim() || !form.prompt.trim() || !schedule.trim() || form.steps.some((s) => !s.prompt.trim())} className="rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">{t('au.create')}</button>
                  <button onClick={() => setForm((f) => ({ ...f, open: false }))} className="rounded-md px-3 py-1.5 text-[13px] text-muted-foreground hover:bg-tint-secondary">{t('au.cancel')}</button>
                  <button onClick={saveTpl} disabled={!form.name.trim() || !form.prompt.trim()} className="rounded-md px-3 py-1.5 text-[13px] text-muted-foreground hover:bg-tint-secondary disabled:opacity-50">{t('au.saveTpl')}</button>
                  {err && <span className="text-[12px] text-red-500">{err}</span>}
                </div>
              </div>
            )}

            {/* List card — official AutomationListTable structure */}
            {filtered.length > 0 && (
              <div className="mx-1 rounded-lg border border-border-secondary bg-card">
                <div className="flex items-center gap-5 border-b border-border-secondary px-4 py-2 text-[12px] font-medium leading-4 text-muted-foreground">
                  {thBtn('name', 'min-w-0 flex-1')}
                  {thBtn('last', 'w-[100px] justify-end whitespace-nowrap')}
                </div>
                <div className="flex flex-col gap-0.5 p-1">
                  {paged.map((a) => (
                    <div key={a.id} className="group/row relative flex items-center gap-5 overflow-clip rounded-md px-3 py-2 hover:bg-tint-secondary">
                      <Clock size={16} className="flex h-[18px] shrink-0 items-center justify-center text-foreground" />
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <div className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium leading-[18px] first-letter:uppercase">
                          <span className="min-w-0 truncate">{a.name}</span>
                          {!a.enabled && <span className="shrink-0 rounded border border-border px-1 text-[11px] text-muted-foreground">{t('au.disabled')}</span>}
                          {(a.steps?.length ?? 0) > 1 && <span className="shrink-0 rounded border border-border px-1 text-[11px] text-muted-foreground">{t('au.stepsN', { n: a.steps!.length })}</span>}
                          {a.running && <span className="flex shrink-0 items-center gap-1 rounded border border-blue-500/40 px-1 text-[11px] text-blue-500"><Loader2 size={10} className="animate-spin" />{(() => { const rs = Object.values(a.running); const i = Math.max(...rs.map((r) => r.step)) + 1; const n = rs[0]?.prompts.length ?? 1; return rs.length > 1 ? t('au.runningK', { k: rs.length, i, n }) : t('au.runningN', { i, n }) })()}</span>}
                        </div>
                        <div className="truncate text-[13px] leading-[18px] text-muted-foreground">
                          {humanCron(a.schedule, t)}<span className="text-muted-foreground/60"> · {a.cwd}</span>
                        </div>
                      </div>
                      <div className="relative w-[100px] shrink-0 text-right">
                        <span className="block text-[12px] leading-4 tabular-nums text-muted-foreground group-hover/row:invisible">{rel(a.lastRun)}</span>
                        <div className="absolute inset-0 flex items-center justify-end opacity-0 group-hover/row:opacity-100">
                          <button onClick={() => setMenuFor(menuFor === a.id ? '' : a.id)} aria-label={t('au.moreActions')} className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
                            {busy === a.id || busy === a.id + '/run' ? <Loader2 size={14} className="animate-spin" /> : <MoreHorizontal size={14} />}
                          </button>
                          {rowMenu(a)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {filtered.length > 0 && pages > 1 && (
              <div className="flex items-center justify-between px-3 text-[12px] text-muted-foreground">
                <span className="tabular-nums">{t('au.showing', { from: page * PAGE_SIZE + 1, to: Math.min((page + 1) * PAGE_SIZE, filtered.length), total: filtered.length })}</span>
                <div className="flex items-center gap-1">
                  <button disabled={page === 0} onClick={() => setPage((p) => p - 1)} className="cursor-pointer rounded-md px-2 py-1 hover:bg-accent disabled:opacity-40">{t('au.prev')}</button>
                  <button disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)} className="cursor-pointer rounded-md px-2 py-1 hover:bg-accent disabled:opacity-40">{t('au.next')}</button>
                </div>
              </div>
            )}

            {/* Empty state — official intro diagram + 3-card grid */}
            {!items.length && (
              <div className="mx-1 flex flex-col gap-12 pt-6">
                <div className="grid gap-3 sm:grid-cols-3">
                  <button onClick={() => openForm()} className="group relative flex flex-col gap-3 overflow-clip rounded-lg border border-border bg-blue-500/10 p-4 text-left hover:brightness-[0.98]">
                    <span className="flex size-7 items-center justify-center rounded-md bg-blue-500/15 text-blue-600 dark:text-blue-400"><Play size={14} /></span>
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="text-[13px] font-medium">{t('au.genDevin')}</span>
                      <span className="text-pretty text-[12px] leading-4 text-muted-foreground">{t('au.genDevinDesc')}</span>
                    </span>
                  </button>
                  <button onClick={() => openForm()} className="group relative flex flex-col gap-3 overflow-clip rounded-lg border border-border p-4 text-left hover:bg-tint-tertiary">
                    <span className="flex size-7 items-center justify-center rounded-md bg-tint-secondary"><Plus size={14} /></span>
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="text-[13px] font-medium">{t('au.createManual')}</span>
                      <span className="text-pretty text-[12px] leading-4 text-muted-foreground">{t('au.createManualDesc')}</span>
                    </span>
                  </button>
                  <div className="relative flex flex-col gap-3 overflow-clip rounded-lg border border-border p-4 opacity-60">
                    <span className="flex size-7 items-center justify-center rounded-md bg-tint-secondary"><Clock size={14} /></span>
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="text-[13px] font-medium">{t('au.fromTpl')}</span>
                      <span className="text-pretty text-[12px] leading-4 text-muted-foreground">{t('au.fromTplDesc')}</span>
                    </span>
                  </div>
                </div>
                <div className="flex flex-col items-center">
                  <IntroPill icon={<Clock size={16} />} title={t('au.introTrig')} />
                  <ArrowDown1 />
                  <IntroPill icon={<Play size={16} />} title={t('au.introDevin')} />
                  <ArrowBranch />
                  <div className="flex items-start justify-center gap-3">
                    <IntroPill wide icon={<Search size={16} className="text-emerald-500" />} title={t('au.introPr')} />
                    <IntroPill wide icon={<Search size={16} />} title={t('au.introReport')} />
                    <IntroPill wide icon={<Search size={16} />} title={t('au.introNotify')} />
                  </div>
                </div>
              </div>
            )}
            {!!items.length && !filtered.length && (
              <p className="px-3 py-12 text-center text-[13px] leading-[18px] text-muted-foreground">{t('au.noMatch')}</p>
            )}
          </div>
        </div>
      </div>

      {/* Delete confirm — official destructive ConfirmDialog */}
      {delFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setDelFor(null)}>
          <div className="w-[400px] rounded-xl border border-border bg-popover p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-[15px] font-medium">{t('au.delTitle')}</h3>
            <p className="mt-1.5 text-[13px] text-muted-foreground">{t('au.delDesc', { name: delFor.name })}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setDelFor(null)} className="cursor-pointer rounded-md px-3 py-1.5 text-[13px] hover:bg-accent">{t('au.cancel')}</button>
              <button disabled={busy === delFor.id} onClick={() => { const id = delFor.id; setDelFor(null); void act(id, '', undefined, true) }} className="cursor-pointer rounded-md bg-red-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-red-700 disabled:opacity-50">{busy === delFor.id ? '…' : t('au.delete')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Batch run — one session per input line, {{input}} substituted */}
      {batchFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setBatchFor(null)}>
          <div className="w-[440px] rounded-xl border border-border bg-popover p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-[15px] font-medium">{t('au.batchTitle', { name: batchFor.name })}</h3>
            <p className="mt-1.5 text-[13px] text-muted-foreground">{t('au.batchDesc')}</p>
            <textarea
              autoFocus
              value={batchText}
              onChange={(e) => setBatchText(e.target.value)}
              placeholder={t('au.batchPh')}
              rows={5}
              className="mt-3 w-full resize-y rounded-md border border-border bg-background px-3 py-2 font-mono text-[12px] outline-none placeholder:text-muted-foreground focus:border-ring"
            />
            <div className="mt-4 flex items-center justify-end gap-2">
              <span className="mr-auto text-[12px] tabular-nums text-muted-foreground">{t('au.batchN', { n: batchText.split('\n').filter((x) => x.trim()).length })}</span>
              <button onClick={() => setBatchFor(null)} className="cursor-pointer rounded-md px-3 py-1.5 text-[13px] hover:bg-accent">{t('au.cancel')}</button>
              <button
                disabled={!batchText.trim() || busy === batchFor.id + '/run'}
                onClick={() => {
                  const inputs = batchText.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 20)
                  const id = batchFor.id
                  setBatchFor(null)
                  void act(id, '/run', { inputs })
                }}
                className="cursor-pointer rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >{busy === batchFor.id + '/run' ? '…' : t('au.runNow')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
