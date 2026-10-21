import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Zap, Play, Trash2, Plus, Loader2, ChevronDown } from 'lucide-react'
import { OExpand } from '@/components/officialIcons'
import { adminFetch } from '@/lib/api'
import AppSidebar from '@/components/AppSidebar'
import type { MirrorTreeSession } from './mirror/treeCache'

/** Local scheduled sessions — official "Automations" parity backed by the
 *  backend 30s cron tick. Each fire spawns a real session on the automation's
 *  cwd and dispatches its prompt (shows in the tree as ⚙ <name>). */
interface Automation {
  id: string; name: string; prompt: string; schedule: string; cwd: string
  enabled: boolean; createdAt: number; lastRun?: number; lastSession?: string; nextRun?: number
}

const PRESETS: { key: string; cron: string }[] = [
  { key: 'au.p5', cron: '*/5 * * * *' },
  { key: 'au.hourly', cron: '0 * * * *' },
  { key: 'au.daily9', cron: '0 9 * * *' },
  { key: 'au.mon9', cron: '0 9 * * 1' },
  { key: 'au.custom', cron: '' },
]

const fmtTs = (ts?: number) => ts ? new Date(ts).toLocaleString() : '—'

export default function AutomationsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [sideOpen, setSideOpen] = useState(window.innerWidth >= 1024)
  const [tree, setTree] = useState<MirrorTreeSession[]>([])
  const [items, setItems] = useState<Automation[]>([])
  const [busy, setBusy] = useState('')
  const [form, setForm] = useState<{ open: boolean; name: string; prompt: string; preset: string; cron: string; cwd: string }>({ open: false, name: '', prompt: '', preset: '0', cron: '', cwd: '' })
  const [err, setErr] = useState('')

  const load = () => {
    adminFetch<{ sessions: MirrorTreeSession[] }>('/api/admin/mirror/sessions').then((r) => setTree(r.sessions ?? [])).catch(() => {})
    adminFetch<{ automations: Automation[] }>('/api/admin/automations').then((r) => setItems(r.automations ?? [])).catch(() => {})
  }
  useEffect(load, [])

  const schedule = form.preset === String(PRESETS.length - 1) ? form.cron : PRESETS[+form.preset].cron
  const create = async () => {
    setErr('')
    try {
      await adminFetch('/api/admin/automations', { method: 'POST', body: JSON.stringify({ name: form.name.trim(), prompt: form.prompt.trim(), schedule, cwd: form.cwd.trim() || undefined }) })
      setForm({ open: false, name: '', prompt: '', preset: '0', cron: '', cwd: '' })
      load()
    } catch (e) { setErr((e as Error).message) }
  }
  const act = async (id: string, path = '', body?: unknown) => {
    setBusy(id + path)
    try { await adminFetch(`/api/admin/automations/${id}${path}`, { method: path === '' && body === undefined ? 'DELETE' : 'POST', body: JSON.stringify(body ?? {}) }); load() }
    catch { /* toast-less */ }
    finally { setBusy('') }
  }

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
          <Zap size={14} className="text-muted-foreground" />
          <span className="text-[13px] font-medium">{t('au.title')}</span>
          <div className="flex-1" />
          <button onClick={() => setForm((f) => ({ ...f, open: !f.open }))} className="flex h-7 items-center gap-1 rounded-[6px] bg-accent-fill px-2.5 text-[12px] font-medium text-accent-foreground hover:opacity-90">
            <Plus size={13} /> {t('au.new')}
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto max-w-[820px] px-6 py-5">
            {form.open && (
              <div className="mb-5 flex flex-col gap-3 rounded-[10px] border border-border bg-card p-4">
                <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder={t('au.namePh')} className="rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none placeholder:text-muted-foreground focus:border-ring" />
                <textarea value={form.prompt} onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))} placeholder={t('au.promptPh')} rows={3} className="resize-y rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none placeholder:text-muted-foreground focus:border-ring" />
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
                  <button onClick={create} disabled={!form.name.trim() || !form.prompt.trim() || !schedule.trim()} className="rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">{t('au.create')}</button>
                  <button onClick={() => setForm((f) => ({ ...f, open: false }))} className="rounded-md px-3 py-1.5 text-[13px] text-muted-foreground hover:bg-tint-secondary">{t('au.cancel')}</button>
                  {err && <span className="text-[12px] text-red-500">{err}</span>}
                </div>
              </div>
            )}
            {!items.length && <p className="py-10 text-center text-[13px] text-muted-foreground">{t('au.empty')}</p>}
            <div className="flex flex-col gap-2">
              {items.map((a) => (
                <div key={a.id} className="rounded-[10px] border border-border bg-card p-4">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{a.name}</span>
                    <code className="rounded bg-tint-secondary px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{a.schedule}</code>
                    <button
                      role="switch" aria-checked={a.enabled}
                      onClick={() => act(a.id, '', { enabled: !a.enabled })}
                      className={`relative h-[18px] w-[32px] shrink-0 rounded-full transition-colors ${a.enabled ? 'bg-accent-fill' : 'bg-tint-tertiary'}`}
                    >
                      <span className={`absolute top-[2px] size-[14px] rounded-full bg-white transition-transform ${a.enabled ? 'left-[16px]' : 'left-[2px]'}`} />
                    </button>
                  </div>
                  <p className="mt-1.5 line-clamp-2 whitespace-pre-wrap text-[12px] text-muted-foreground">{a.prompt}</p>
                  <div className="mt-2.5 flex items-center gap-3 text-[11px] text-muted-foreground">
                    <span>{t('au.next')}: {a.enabled ? fmtTs(a.nextRun) : t('au.off')}</span>
                    <span>{t('au.last')}: {fmtTs(a.lastRun)}</span>
                    {a.lastSession && <button onClick={() => navigate(`/admin/${a.lastSession}`)} className="text-accent-primary hover:underline">{t('au.openLast')}</button>}
                    <div className="flex-1" />
                    <button onClick={() => act(a.id, '/run')} disabled={busy === a.id + '/run'} className="flex items-center gap-1 rounded-[5px] px-2 py-1 text-[11px] font-medium text-foreground hover:bg-tint-secondary disabled:opacity-50">
                      {busy === a.id + '/run' ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />} {t('au.run')}
                    </button>
                    <button onClick={() => act(a.id)} disabled={busy === a.id} className="flex items-center gap-1 rounded-[5px] px-2 py-1 text-[11px] text-muted-foreground hover:bg-tint-secondary hover:text-red-500">
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
