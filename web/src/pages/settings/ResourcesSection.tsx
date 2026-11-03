import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, BookOpen, ChevronDown, ChevronRight, FileText, KeyRound, Pencil, Puzzle, Server, Trash2 } from 'lucide-react'
import { adminFetch } from '@/lib/api'
import { cn } from '@/lib/utils'
import { visibleInterval } from '@/lib/poll'
import { CodeEditor } from '@/pages/mirror/WorkspacePanel'
import { Section } from './atoms'

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
          <span className="min-w-0 flex-1 truncate text-13" title={e.name}>{e.name}</span>
          {e.description && <span className="hidden max-w-[40%] shrink truncate text-12 text-secondary sm:block" title={e.description}>{e.description}</span>}
          <span className="w-[34%] shrink-0 truncate text-11 text-muted-foreground" title={e.path}>{e.path}</span>
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

/* ------------------------------------------------------------------ */
/* System resources monitor — polls /api/admin/resources/system every 5s
 * while the tab is open: host totals, process tree RSS, live session
 * occupancy, log/timeline cache footprint, data-dir sizes. */
interface SysRes {
  os: { platform: string; cpus: number; totalMb: number; freeMb: number; usedMb: number; loadAvg: number[]; uptimeSec: number }
  backend: { pid: number; rssMb: number; heapUsedMb: number; heapTotalMb: number; externalMb: number; buffersMb: number; uptimeSec: number }
  procs: { pid: number; name: string; mb: number; role: string }[]
  acps: { acpId: string; pid: number; mb: number | null; commitMb?: number | null; cwd: string; key: string | null; account: string | null; exited: boolean; sessions: number }[]
  sessions: {
    total: number; loadedHere: number; inflight: number; openTurns: number; locked: number
    rings: { sessions: number; entries: number; hydrated: number }
    tl: { sessions: number; items: number }
    topRings: { id: string; entries: number; title: string | null }[]
  }
  dataDir: { sessionlogDbMb: number; walMb: number; dwJsonKb: number }
}

const fmtMb = (n: number | null | undefined) => (n == null ? '—' : n >= 1024 ? `${(n / 1024).toFixed(2)} GB` : `${Math.round(n)} MB`)
const fmtSecs = (s: number) => (s >= 86400 ? `${(s / 86400).toFixed(1)}d` : s >= 3600 ? `${(s / 3600).toFixed(1)}h` : s >= 60 ? `${Math.floor(s / 60)}m${Math.round(s % 60)}s` : `${s}s`)

function Bar({ used, total, warn = 0.85 }: { used: number; total: number; warn?: number }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0
  return (
    <div className="h-[6px] w-full overflow-hidden rounded-full bg-tint-secondary">
      <div className={`h-full rounded-full ${pct / 100 >= warn ? 'bg-amber-500' : 'bg-accent-primary'}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

function Kv({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-[12px] py-[6px]">
      <span className="text-13 text-muted-foreground">{k}</span>
      <span className="min-w-0 truncate text-13 tabular-nums text-foreground">{v}</span>
    </div>
  )
}

function SystemResources() {
  const { t } = useTranslation()
  const [d, setD] = useState<SysRes | null>(null)
  const [err, setErr] = useState(false)
  useEffect(() => visibleInterval(() => {
    void adminFetch<SysRes>('/api/admin/resources/system').then(setD).catch(() => setErr(true))
  }, 5000), [])
  if (!d) return <p className="px-[12px] py-[10px] text-13 text-secondary">{err ? t('set.sysErr') : t('common.loading')}</p>
  const roleLabel = (r: string) => t(`set.sysRole.${r}` as never, r)
  const backend = d.procs.find((p) => p.role === 'backend')
  const dwTotal = d.procs.filter((p) => p.role !== 'other').reduce((a, p) => a + p.mb, 0)
  return (
    <div className="flex flex-col gap-[2px]">
      {/* host totals */}
      <div className="px-[12px] pb-1 pt-2 text-11 font-medium uppercase tracking-wide text-muted-foreground">{t('set.sysHost')}</div>
      <div className="px-[12px] pb-2">
        <div className="mb-1 flex justify-between text-12 text-secondary">
          <span>{d.os.platform} · {d.os.cpus} CPU · up {fmtSecs(d.os.uptimeSec)}</span>
          <span className="tabular-nums">{fmtMb(d.os.usedMb)} / {fmtMb(d.os.totalMb)}</span>
        </div>
        <Bar used={d.os.usedMb} total={d.os.totalMb} />
      </div>
      {/* backend process */}
      <div className="px-[12px] pb-1 pt-2 text-11 font-medium uppercase tracking-wide text-muted-foreground">
        {t('set.sysBackend')} · pid {d.backend.pid} · up {fmtSecs(d.backend.uptimeSec)}
      </div>
      <Kv k="RSS" v={fmtMb(d.backend.rssMb)} />
      <Kv k={t('set.sysHeap')} v={`${fmtMb(d.backend.heapUsedMb)} / ${fmtMb(d.backend.heapTotalMb)}`} />
      <Kv k={t('set.sysExt')} v={`${fmtMb(d.backend.externalMb)} · buffers ${fmtMb(d.backend.buffersMb)}`} />
      {/* process tree */}
      <div className="px-[12px] pb-1 pt-2 text-11 font-medium uppercase tracking-wide text-muted-foreground">
        {t('set.sysProcs')} · devin-web {fmtMb(dwTotal)}
      </div>
      <div className="px-[6px] pb-1">
        {d.procs.map((p) => (
          <div key={p.pid} className="flex items-center gap-2 rounded-[6px] px-[6px] py-[4px] text-13 hover:bg-tint-secondary">
            <span className={`w-[72px] shrink-0 truncate text-12 ${p.role === 'backend' ? 'text-accent-primary' : 'text-muted-foreground'}`}>{roleLabel(p.role)}</span>
            <span className="w-[60px] shrink-0 text-12 tabular-nums text-muted-foreground">{p.pid}</span>
            <span className="min-w-0 flex-1 truncate text-12 text-secondary">{p.name}</span>
            <span className={`shrink-0 text-13 tabular-nums ${p.mb > 500 ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-foreground'}`}>{fmtMb(p.mb)}</span>
          </div>
        ))}
        {!backend && <p className="px-[6px] py-[4px] text-12 text-secondary">{t('set.sysNoWmi')}</p>}
      </div>
      {/* sessions */}
      <div className="px-[12px] pb-1 pt-2 text-11 font-medium uppercase tracking-wide text-muted-foreground">{t('set.sysSessions')}</div>
      <Kv k={t('set.sysSessTotal')} v={d.sessions.total} />
      <Kv k={t('set.sysSessLoaded')} v={`${d.sessions.loadedHere} · ${t('set.sysSessInflight')} ${d.sessions.inflight} · ${t('set.sysSessLocked')} ${d.sessions.locked}`} />
      <Kv k={t('set.sysRings')} v={`${d.sessions.rings.sessions} ${t('set.sysSessUnit')} · ${d.sessions.rings.entries.toLocaleString()} ${t('set.sysEntriesUnit')}`} />
      <Kv k={t('set.sysTl')} v={`${d.sessions.tl.sessions} ${t('set.sysSessUnit')} · ${d.sessions.tl.items.toLocaleString()} items`} />
      {d.sessions.topRings.length > 0 && (
        <div className="px-[6px] pb-1">
          {d.sessions.topRings.slice(0, 6).map((r) => (
            <div key={r.id} className="flex items-center gap-2 px-[6px] py-[3px] text-12">
              <span className="min-w-0 flex-1 truncate text-secondary">{r.title ?? r.id}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{r.entries.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
      {/* acp pool */}
      {d.acps.length > 0 && (
        <>
          <div className="px-[12px] pb-1 pt-2 text-11 font-medium uppercase tracking-wide text-muted-foreground">{t('set.sysAcps')}</div>
          <div className="px-[6px] pb-1">
            {d.acps.map((a) => (
              <div key={a.acpId} className="flex items-center gap-2 rounded-[6px] px-[6px] py-[4px] text-13 hover:bg-tint-secondary">
                <Activity size={12} className={`shrink-0 ${a.exited ? 'text-muted-foreground' : 'text-green-500'}`} />
                <span className="w-[56px] shrink-0 text-12 tabular-nums text-muted-foreground">{a.pid}</span>
                <span className="min-w-0 flex-1 truncate text-12 text-secondary" title={a.cwd}>{a.key ?? a.cwd}</span>
                <span className="shrink-0 text-12 text-muted-foreground">{a.sessions} {t('set.sysSessUnit')}</span>
                <span className="shrink-0 text-13 tabular-nums text-foreground" title={`RSS ${fmtMb(a.mb)} · commit ${fmtMb(a.commitMb ?? null)}`}>{fmtMb(a.commitMb ?? a.mb)}</span>
              </div>
            ))}
          </div>
        </>
      )}
      {/* data dir */}
      <div className="px-[12px] pb-1 pt-2 text-11 font-medium uppercase tracking-wide text-muted-foreground">{t('set.sysDataDir')}</div>
      <Kv k="sessionlog.db" v={fmtMb(d.dataDir.sessionlogDbMb)} />
      <Kv k="sessionlog.db-wal" v={fmtMb(d.dataDir.walMb)} />
      <Kv k="dw.json" v={`${d.dataDir.dwJsonKb} KB`} />
    </div>
  )
}

/* Insights-lite — local usage stats from sessiondb (official Insights
 * parity, local data). 30d activity histogram + kind mix + top sessions. */
interface Insights {
  days: { day: string; events: number; sessions: number; bytes: number }[]
  kinds: { kind: string | null; n: number }[]
  topSessions: { id: string; events: number; bytes: number; firstTs: number; lastTs: number }[]
}
function InsightsLite() {
  const { t } = useTranslation()
  const [d, setD] = useState<Insights | null>(null)
  useEffect(() => {
    void adminFetch<Insights>('/api/admin/insights?days=30').then(setD).catch(() => setD({ days: [], kinds: [], topSessions: [] }))
  }, [])
  if (!d) return <p className="px-[12px] py-[10px] text-13 text-secondary">{t('common.loading')}</p>
  const max = Math.max(1, ...d.days.map((x) => x.events))
  return (
    <div className="flex flex-col gap-3 px-[12px] py-[10px]">
      <div className="flex h-[64px] items-end gap-[2px]" title={t('set.insAct')}>
        {d.days.map((x) => (
          <div key={x.day} title={`${x.day}: ${x.events} ${t('set.insEvents')}, ${x.sessions} ${t('set.insSessions')}`}
            className="min-w-[3px] flex-1 rounded-t-[2px] bg-accent-primary/70 hover:bg-accent-primary"
            style={{ height: `${Math.max(4, (x.events / max) * 100)}%` }} />
        ))}
        {d.days.length === 0 && <span className="text-12 text-secondary">{t('set.insEmpty')}</span>}
      </div>
      {d.kinds.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {d.kinds.filter((k) => k.kind).slice(0, 10).map((k) => (
            <span key={k.kind} className="rounded-[6px] border border-border px-1.5 py-0.5 text-11 text-secondary">{k.kind}: {k.n}</span>
          ))}
        </div>
      )}
      {d.topSessions.length > 0 && (
        <div className="flex flex-col">
          {d.topSessions.slice(0, 8).map((s) => (
            <div key={s.id} className="flex items-center gap-2 border-t border-border-secondary py-[5px] text-12">
              <span className="min-w-0 flex-1 truncate font-mono text-11 text-muted-foreground">{s.id}</span>
              <span className="shrink-0 text-secondary">{s.events} {t('set.insEvents')}</span>
              <span className="w-[90px] shrink-0 text-right text-muted-foreground">{(s.bytes / 1048576).toFixed(1)}MB</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* Installed plugins — `_cognition.ai/plugins/list` passthrough; each row
 * expands to its skills + MCP servers. */
interface Plugin {
  pluginKey: string; name: string; state: string; metadataStatus?: string
  origins?: { tier?: string; required?: boolean; source?: string }[]
  assets?: {
    skills?: { name: string; namespacedName?: string; description?: string; userInvocable?: boolean; skillPath?: string }[]
    skillsTotal?: number
    mcpServers?: { name: string; transport?: string; sourcePath?: string }[]
  }
}
function PluginsPanel() {
  const { t } = useTranslation()
  const [data, setData] = useState<Plugin[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => {
    void adminFetch<{ plugins: Plugin[] }>('/api/admin/plugins').then((r) => setData(r.plugins ?? [])).catch(() => setData([]))
  }, [])
  if (!data) return <p className="px-[12px] py-[10px] text-13 text-secondary">{t('common.loading')}</p>
  return (
    <div className="px-[6px] py-[6px]">
      {data.length === 0 && <p className="px-[6px] py-[8px] text-13 text-secondary">{t('set.plgEmpty')}</p>}
      {data.map((p) => {
        const o = open === p.pluginKey
        const skills = p.assets?.skills ?? []
        const mcps = p.assets?.mcpServers ?? []
        const tier = p.origins?.[0]?.tier
        return (
          <div key={p.pluginKey}>
            <button onClick={() => setOpen(o ? null : p.pluginKey)}
              className="flex w-full cursor-pointer items-center gap-2 px-[12px] py-[8px] text-left hover:bg-tint-secondary">
              {o ? <ChevronDown size={13} className="shrink-0 text-muted-foreground" /> : <ChevronRight size={13} className="shrink-0 text-muted-foreground" />}
              <Puzzle size={13} className="shrink-0 text-accent-primary" />
              <span className="min-w-0 flex-1 truncate text-13">{p.name}</span>
              {tier && <span className="shrink-0 rounded-[5px] border border-border px-1 py-px text-10 text-muted-foreground">{tier}</span>}
              <span className="shrink-0 text-11 text-muted-foreground">
                {skills.length > 0 && `${skills.length}${p.assets?.skillsTotal ? `/${p.assets.skillsTotal}` : ''} ${t('set.plgSkills')}`}
                {skills.length > 0 && mcps.length > 0 && ' · '}
                {mcps.length > 0 && `${mcps.length} MCP`}
              </span>
              <span className={`size-1.5 shrink-0 rounded-full ${p.state === 'installed' ? 'bg-green-500' : 'bg-border'}`} title={p.state} />
            </button>
            {o && (
              <div className="mx-3 mb-2 rounded-[8px] border border-border px-3 py-2">
                {skills.map((s) => (
                  <div key={s.name} className="border-t border-border-secondary py-[6px] first:border-0" title={s.skillPath || s.namespacedName}>
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-12 font-medium text-foreground">{s.name}</span>
                      {s.userInvocable && <span className="shrink-0 rounded-[5px] border border-border px-1 py-px text-10 text-muted-foreground" title={s.namespacedName}>/{s.name}</span>}
                    </div>
                    {s.description && <div className="mt-0.5 text-11 text-muted-foreground line-clamp-2" title={s.description}>{s.description}</div>}
                  </div>
                ))}
                {skills.length === 0 && mcps.length === 0 && <div className="py-1 text-12 text-muted-foreground">{t('set.plgNoSkills')}</div>}
                {mcps.length > 0 && (
                  <div className="mt-1 border-t border-border pt-2">
                    <div className="pb-1 text-11 font-medium text-muted-foreground">MCP</div>
                    {mcps.map((m) => (
                      <div key={m.name} className="flex items-center gap-1.5 py-[4px]" title={m.sourcePath}>
                        <Server size={12} className="shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-12 text-foreground">{m.name}</span>
                        {m.transport && <span className="shrink-0 rounded-[5px] border border-border px-1 py-px text-10 text-muted-foreground">{m.transport}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/* Agent rules — `_cognition.ai/rules/list`: the resolved rule set the
 * agent actually loads for the workspace (global + workspace scope). */
interface AgentRule { name: string; path: string; provider: string; providerLabel?: string; trigger?: string; userInvocable?: boolean; scope?: string }
function RulesPanel() {
  const { t } = useTranslation()
  const [data, setData] = useState<AgentRule[] | null>(null)
  useEffect(() => {
    void adminFetch<{ rules: AgentRule[] }>('/api/admin/rules').then((r) => setData(r.rules ?? [])).catch(() => setData([]))
  }, [])
  if (!data) return <p className="px-[12px] py-[10px] text-13 text-secondary">{t('common.loading')}</p>
  return (
    <div className="px-[6px] py-[6px]">
      {data.length === 0 && <p className="px-[6px] py-[8px] text-13 text-secondary">{t('set.rulesEmpty')}</p>}
      {data.map((r) => (
        <div key={r.path} className="flex items-center gap-2 px-[12px] py-[7px] hover:bg-tint-secondary">
          <FileText size={13} className="shrink-0 text-accent-primary" />
          <span className="min-w-0 flex-1 truncate text-13" title={r.path}>{r.name}</span>
          {r.scope && <span className="shrink-0 rounded-[5px] border border-border px-1 py-px text-10 text-muted-foreground">{r.scope}</span>}
          {r.trigger && <span className="shrink-0 rounded-[5px] border border-border px-1 py-px text-10 text-muted-foreground">{r.trigger}</span>}
          {r.providerLabel && <span className="shrink-0 text-11 text-muted-foreground">{r.providerLabel}</span>}
        </div>
      ))}
    </div>
  )
}

/* Plans — `_cognition.ai/plans/list`: the user's plan library
 * (~/.devin/plans/*.md), no params. Read-only listing. */
interface PlanFile { path: string; title?: string; description?: string }
function PlansPanel() {
  const { t } = useTranslation()
  const [data, setData] = useState<PlanFile[] | null>(null)
  useEffect(() => {
    void adminFetch<{ plans: PlanFile[] }>('/api/admin/plans').then((r) => setData(r.plans ?? [])).catch(() => setData([]))
  }, [])
  if (!data) return <p className="px-[12px] py-[10px] text-13 text-secondary">{t('common.loading')}</p>
  return (
    <div className="px-[6px] py-[6px]">
      {data.length === 0 && <p className="px-[6px] py-[8px] text-13 text-secondary">{t('set.plansEmpty')}</p>}
      {data.map((pl) => (
        <div key={pl.path} className="px-[12px] py-[7px] hover:bg-tint-secondary" title={pl.path}>
          <div className="flex items-center gap-2">
            <BookOpen size={13} className="shrink-0 text-accent-primary" />
            <span className="min-w-0 flex-1 truncate text-13">{pl.title || pl.path.split(/[\\/]/).pop()}</span>
          </div>
          {pl.description && <div className="ml-5 mt-0.5 text-11 text-muted-foreground line-clamp-2" title={pl.description}>{pl.description}</div>}
        </div>
      ))}
    </div>
  )
}

/* Cloud account — app.devin.ai/api/* reads (auth1 token + x-cog-org-id):
 * org/members/settings/billing/notification prefs. What only the cloud can
 * answer; each sub-read degrades independently. */
interface CloudMember {
  user_id?: string; name?: string; email?: string; preferred_name?: string
  roles?: { id?: string; label?: string }[]; seat_type?: string
}
interface CloudAccount {
  ok?: boolean; error?: string
  org?: { org_id?: string; display_name?: string } | { error: string }
  members?: CloudMember[] | { error: string }
  settings?: Record<string, unknown> | { error: string }
  subscription?: { slug?: string; status?: string; planId?: string } | { error: string }
  invoices?: { invoices?: { id?: string; status?: string; amount?: number; date?: number }[] } | { error: string }
  notificationPrefs?: { groups?: { group?: string; name?: string }[] } | { error: string }
  sessionTags?: { tags?: unknown[]; default_tag?: unknown } | { error: string }
  slashCommands?: { commands?: { name?: string }[] } | { error: string }
  automationSchemas?: Record<string, Record<string, { event_type?: string }>> | { error: string }
}
function CloudPanel() {
  const { t } = useTranslation()
  const [d, setD] = useState<CloudAccount | null>(null)
  useEffect(() => {
    void adminFetch<CloudAccount>('/api/admin/cloud/account').then(setD).catch(() => setD({ ok: false, error: 'fetch failed' }))
  }, [])
  if (!d) return <p className="px-[12px] py-[10px] text-13 text-secondary">{t('common.loading')}</p>
  if (!d.ok) return <p className="px-[12px] py-[10px] text-13 text-amber-600">{t('set.cloudNoCreds')}{d.error ? ` — ${d.error}` : ''}</p>
  const org = d.org && !('error' in d.org) ? d.org : null
  const sub = d.subscription && !('error' in d.subscription) ? d.subscription : null
  const members = Array.isArray(d.members) ? d.members : []
  const settings = d.settings && !('error' in d.settings) ? d.settings : null
  const inv = d.invoices && !('error' in d.invoices) ? (d.invoices.invoices ?? []) : []
  const groups = d.notificationPrefs && !('error' in d.notificationPrefs) ? (d.notificationPrefs.groups ?? []) : []
  const schemas = d.automationSchemas && !('error' in d.automationSchemas) ? d.automationSchemas : null
  const schemaBySrc = schemas
    ? Object.entries(schemas).map(([src, evts]) => ({
        src,
        events: Object.values(evts ?? {}).map((s) => s.event_type).filter(Boolean) as string[],
      }))
    : []
  const schemaEventCount = schemaBySrc.reduce((n, s) => n + s.events.length, 0)
  const tagCount = d.sessionTags && !('error' in d.sessionTags) ? (d.sessionTags.tags?.length ?? 0) : null
  const cmdCount = d.slashCommands && !('error' in d.slashCommands) ? (d.slashCommands.commands?.length ?? 0) : null
  const flags = settings ? Object.entries(settings).filter(([, v]) => typeof v === 'boolean') : []
  return (
    <div className="px-[6px] py-[6px]">
      <div className="px-[6px] py-[4px]">
        {org && <Kv k={t('set.cloudOrg')} v={`${org.display_name ?? org.org_id} ${org.org_id ? `(${org.org_id.slice(0, 18)}…)` : ''}`} />}
        {sub && <Kv k={t('set.cloudPlan')} v={
          <span className="flex items-center gap-2">
            <span className={cn('text-13 font-medium', sub.status === 'past_due' || sub.status === 'unpaid' ? 'text-amber-600' : 'text-foreground')}>{sub.slug ?? sub.planId ?? '—'}</span>
            {sub.status && <span className={cn('rounded-[5px] border px-1 py-px text-10', sub.status === 'active' ? 'border-emerald-500/40 text-emerald-600' : 'border-amber-500/40 text-amber-600')}>{sub.status}</span>}
          </span>
        } />}
        {inv.length > 0 && <Kv k={t('set.cloudInvoices')} v={`${inv.length} · ${t('set.cloudLatest')}: ${inv[0].status ?? '?'} ${typeof inv[0].amount === 'number' ? `$${(inv[0].amount / 100).toFixed(2)}` : ''}`} />}
        {groups.length > 0 && <Kv k={t('set.cloudNotifGroups')} v={groups.length} />}
        {tagCount !== null && <Kv k={t('set.cloudSessionTags')} v={tagCount} />}
        {cmdCount !== null && <Kv k={t('set.cloudSlashCommands')} v={cmdCount} />}
        {schemaEventCount > 0 && <Kv k={t('set.cloudAutomationEvents')} v={schemaEventCount} />}
        {!!flags.length && <Kv k={t('set.cloudFlags')} v={flags.filter(([, v]) => v).map(([k]) => k).join(', ') || '—'} />}
      </div>
      {schemaBySrc.length > 0 && (
        <div className="mt-[4px] border-t border-border-secondary pt-[4px]">
          {schemaBySrc.map(({ src, events }) => (
            <div key={src} className="px-[12px] py-[5px]" title={events.join(', ')}>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-13">{src}</span>
                <span className="shrink-0 rounded-[5px] border border-border px-1 py-px text-10 text-muted-foreground">{events.length}</span>
              </div>
              <div className="mt-0.5 text-11 text-muted-foreground truncate">{events.map((e) => e.split(':').pop()).join(', ')}</div>
            </div>
          ))}
        </div>
      )}
      {members.length > 0 && (
        <div className="mt-[4px] border-t border-border-secondary pt-[4px]">
          {members.map((m, i) => (
            <div key={m.user_id ?? i} className="flex items-center gap-2 px-[12px] py-[5px] text-13">
              <span className="min-w-0 flex-1 truncate">{m.preferred_name || m.name || m.email}</span>
              {m.email && <span className="shrink-0 truncate text-11 text-muted-foreground">{m.email}</span>}
              {m.seat_type && <span className="shrink-0 text-11 text-muted-foreground">{m.seat_type}</span>}
              {m.roles?.[0]?.label && <span className="shrink-0 rounded-[5px] border border-border px-1 py-px text-10 text-muted-foreground">{m.roles[0].label}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* Secrets — local equivalent of cloud org secrets. Values are write-only:
 * the list carries name+description; the agent receives values as terminal
 * env vars bound per session via @secrets:NAME mentions. */
interface SecretRow { name: string; description: string; createdAt: number; updatedAt: number; type?: 'totp'; sessions?: string[] }
function SecretsPanel() {
  const { t } = useTranslation()
  const [rows, setRows] = useState<SecretRow[] | null>(null)
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [desc, setDesc] = useState('')
  const [totp, setTotp] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const refresh = () => {
    void adminFetch<{ secrets: SecretRow[] }>('/api/admin/secrets').then((r) => setRows(r.secrets ?? [])).catch(() => setRows([]))
  }
  useEffect(refresh, [])
  const submit = async () => {
    if (!name.trim() || !value) return
    setBusy(true); setErr('')
    const r = await adminFetch<{ ok: boolean; error?: string }>('/api/admin/secrets', {
      method: 'POST',
      body: JSON.stringify({ name: name.trim(), value, description: desc.trim(), ...(totp ? { type: 'totp' } : {}) }),
      headers: { 'content-type': 'application/json' },
    }).catch(() => null)
    setBusy(false)
    if (!r?.ok) {
      setErr(r?.error === 'invalid_name' ? t('set.secretBadName') : r?.error === 'invalid_totp_seed' ? t('set.secretBadTotp') : t('common.failed'))
      return
    }
    setName(''); setValue(''); setDesc(''); setTotp(false)
    refresh()
  }
  const del = async (n: string) => {
    await adminFetch('/api/admin/secrets/delete', {
      method: 'POST',
      body: JSON.stringify({ name: n }),
      headers: { 'content-type': 'application/json' },
    }).catch(() => null)
    refresh()
  }
  const unbind = async (n: string, sid: string) => {
    await adminFetch('/api/admin/secrets/unbind', {
      method: 'POST',
      body: JSON.stringify({ name: n, sessionId: sid }),
      headers: { 'content-type': 'application/json' },
    }).catch(() => null)
    refresh()
  }
  const edit = (s: SecretRow) => {
    setName(s.name); setDesc(s.description); setTotp(s.type === 'totp'); setValue('')
  }
  if (!rows) return <p className="px-[12px] py-[10px] text-13 text-secondary">{t('common.loading')}</p>
  return (
    <div className="px-[6px] py-[6px]">
      <p className="px-[12px] pb-[6px] text-11 text-muted-foreground">{t('set.secretsHint')}</p>
      {rows.length === 0 && <p className="px-[12px] py-[8px] text-13 text-secondary">{t('set.secretsEmpty')}</p>}
      {rows.map((s) => (
        <div key={s.name}>
          <div className="flex items-center gap-2 px-[12px] py-[7px] hover:bg-tint-secondary">
            <KeyRound size={13} className="shrink-0 text-accent-primary" />
            <span className="min-w-0 flex-1 truncate text-13 font-mono">{s.name}</span>
            {s.type === 'totp' && <span className="shrink-0 rounded-[5px] border border-border px-1 py-px text-10 text-muted-foreground">TOTP</span>}
            {!!s.sessions?.length && (
              <button
                className="shrink-0 cursor-pointer rounded-[5px] border border-border px-1 py-px text-10 text-muted-foreground hover:bg-tint-secondary"
                title={t('set.secretBoundHint')}
                onClick={() => setOpen(open === s.name ? null : s.name)}
              >
                {t('set.secretBound', { n: s.sessions.length })}
              </button>
            )}
            {s.description && <span className="shrink-0 max-w-[140px] truncate text-11 text-muted-foreground" title={s.description}>{s.description}</span>}
            <button
              className="shrink-0 rounded-[5px] p-1 text-muted-foreground hover:bg-tint-secondary"
              title={t('set.secretRotate')}
              onClick={() => edit(s)}
            >
              <Pencil size={13} />
            </button>
            <button
              className="shrink-0 rounded-[5px] p-1 text-muted-foreground hover:bg-tint-secondary hover:text-red-500"
              title={t('common.delete')}
              onClick={() => void del(s.name)}
            >
              <Trash2 size={13} />
            </button>
          </div>
          {open === s.name && !!s.sessions?.length && (
            <div className="mx-[12px] mb-[4px] rounded-[6px] border border-border-secondary px-2 py-1">
              {s.sessions.map((sid) => (
                <div key={sid} className="flex items-center gap-2 py-[2px]">
                  <span className="min-w-0 flex-1 truncate font-mono text-11 text-muted-foreground">{sid}</span>
                  <button
                    className="shrink-0 rounded-[4px] px-1.5 text-11 text-muted-foreground hover:bg-tint-secondary hover:text-red-500"
                    onClick={() => void unbind(s.name, sid)}
                  >
                    {t('set.secretUnbind')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
      <div className="mt-[6px] border-t border-border-secondary px-[12px] pt-[8px]">
        <div className="flex items-center gap-2">
          <input
            className="h-[28px] w-[200px] rounded-[6px] border border-border bg-transparent px-2 font-mono text-12 outline-none focus:border-accent-primary"
            placeholder="SECRET_NAME"
            value={name}
            onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
          />
          <input
            className="h-[28px] min-w-0 flex-1 rounded-[6px] border border-border bg-transparent px-2 text-12 outline-none focus:border-accent-primary"
            placeholder={t('set.secretDescPh')}
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
          <label className="flex shrink-0 cursor-pointer items-center gap-1 text-11 text-muted-foreground" title={t('set.secretTotpHint')}>
            <input type="checkbox" checked={totp} onChange={(e) => setTotp(e.target.checked)} />
            TOTP
          </label>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <input
            className="h-[28px] min-w-0 flex-1 rounded-[6px] border border-border bg-transparent px-2 font-mono text-12 outline-none focus:border-accent-primary"
            type="password"
            autoComplete="new-password"
            placeholder={totp ? t('set.secretSeedPh') : t('set.secretValuePh')}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button
            className="h-[28px] shrink-0 rounded-[6px] bg-accent-primary px-3 text-12 font-medium text-white disabled:opacity-40"
            disabled={busy || !name.trim() || !value}
            onClick={() => void submit()}
          >
            {t('set.secretAdd')}
          </button>
        </div>
        {err && <p className="mt-1 text-11 text-red-500">{err}</p>}
      </div>
    </div>
  )
}

/** Resources tab — system resource monitor + agent rules/skills browser. */
export function ResourcesTab() {
  const { t } = useTranslation()
  return (
    <>
      <Section title={t('set.secrets')}>
        <SecretsPanel />
      </Section>
      <Section title={t('set.cloudAccount')}>
        <CloudPanel />
      </Section>
      <Section title={t('set.sysRes')}>
        <SystemResources />
      </Section>
      <Section title={t('set.insights')}>
        <InsightsLite />
      </Section>
      <Section title={t('set.plugins')}>
        <PluginsPanel />
      </Section>
      <Section title={t('set.agentRules')}>
        <RulesPanel />
      </Section>
      <Section title={t('set.plans')}>
        <PlansPanel />
      </Section>
      <Section title={t('set.agentRes')}>
        <AgentResources />
      </Section>
    </>
  )
}
