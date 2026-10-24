import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, BookOpen, ChevronDown, ChevronRight, FileText } from 'lucide-react'
import { adminFetch } from '@/lib/api'
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
  acps: { acpId: string; pid: number; mb: number | null; cwd: string; key: string | null; account: string | null; exited: boolean; sessions: number }[]
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
                <span className="shrink-0 text-13 tabular-nums text-foreground">{fmtMb(a.mb)}</span>
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

/** Resources tab — system resource monitor + agent rules/skills browser. */
export function ResourcesTab() {
  const { t } = useTranslation()
  return (
    <>
      <Section title={t('set.sysRes')}>
        <SystemResources />
      </Section>
      <Section title={t('set.agentRes')}>
        <AgentResources />
      </Section>
    </>
  )
}
