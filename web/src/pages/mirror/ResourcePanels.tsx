import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Loader2, ChevronRight, ChevronDown, List, Bot } from 'lucide-react'
import { adminFetch } from '@/lib/api'
import { visibleInterval } from '@/lib/poll'
import { cn } from '@/lib/utils'

interface LocalSubagent {
  agentId: string; live: boolean; title: string; task: string; profile: string; model: string
  isBackground: boolean; depth: number
  status: 'running' | 'completed' | 'failed'
  summary: string | null; startedAt: string | null; finishedAt: string | null
  updates: number; lastText: string
  /** false = registry handle gone (restart/replay) — can't be messaged. */
  resumable?: boolean
}

/** Local subagents panel: list → detail (own transcript + direct message + control). */
type SessionResources = {
  rules?: { source?: string; content?: string; path?: string }[] | null
  skills?: { name?: string; description?: string; path?: string }[] | null
  subagentProfiles?: { name?: string; description?: string; model?: string; allowedTools?: string[] }[] | null
  plans?: { title?: string; status?: string; path?: string }[] | null
  hooks?: { event?: string; command?: string; source?: string }[] | null
  config?: Record<string, unknown> | null
}

function ResSection({ title, count, children }: { title: string; count?: number | null; children: ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="border-b border-border">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[12px] font-medium text-muted-foreground hover:bg-tint-secondary">
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {title}
        {typeof count === 'number' && <span className="ml-auto rounded bg-tint px-1.5 py-0.5 text-[10px] tabular-nums">{count}</span>}
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  )
}

function ResourcesPanel({ id }: { id: string }) {
  const { t } = useTranslation()
  const [r, setR] = useState<SessionResources | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    setR(null); setErr(null)
    adminFetch<SessionResources>(`/api/admin/session/${id}/resources`)
      .then((x) => { if (alive) setR(x) })
      .catch((e) => { if (alive) setErr((e as Error).message) })
    return () => { alive = false }
  }, [id])
  if (err) return <p className="p-4 text-[12px] text-muted-foreground">{err}</p>
  if (!r) return <div className="flex items-center gap-2 p-4 text-[12px] text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t('res.loading')}</div>
  const empty = 'text-[12px] text-muted-foreground'
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <ResSection title={t('res.subProfiles')} count={r.subagentProfiles?.length ?? 0}>
        {!r.subagentProfiles?.length ? <p className={empty}>{t('res.noSub')}</p> : r.subagentProfiles.map((x, i) => (
          <div key={i} className="mb-1.5 rounded-md border border-border bg-card px-2 py-1.5">
            <div className="flex items-center gap-2 text-[12px] font-medium"><Bot className="h-3.5 w-3.5 text-muted-foreground" />{x.name}</div>
            {x.description && <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{x.description}</div>}
            {x.model && <div className="mt-1 text-[10px] text-muted-foreground">model: {x.model}</div>}
          </div>
        ))}
      </ResSection>
      <ResSection title={t('res.plans')} count={r.plans?.length ?? 0}>
        {!r.plans?.length ? <p className={empty}>{t('res.noPlans')}</p> : r.plans.map((x, i) => (
          <div key={i} className="mb-1.5 flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5 text-[12px]">
            <List className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{x.title || x.path}</span>
            {x.status && <span className="ml-auto text-[10px] text-muted-foreground">{x.status}</span>}
          </div>
        ))}
      </ResSection>
      <ResSection title={t('res.hooks')} count={r.hooks?.length ?? 0}>
        {!r.hooks?.length ? <p className={empty}>{t('res.noHooks')}</p> : r.hooks.map((x, i) => (
          <div key={i} className="mb-1.5 rounded-md border border-border bg-card px-2 py-1.5 text-[11px]">
            <div className="font-medium">{x.event}</div>
            {x.command && <div className="mt-0.5 truncate font-mono text-muted-foreground">{x.command}</div>}
          </div>
        ))}
      </ResSection>
      {r.config && (
        <ResSection title={t('res.agentCfg')}>
          <pre className="max-h-64 overflow-auto rounded-md border border-border bg-card p-2 text-[10px] leading-snug">{JSON.stringify(r.config, null, 2)}</pre>
        </ResSection>
      )}
      <ExtConsole id={id} />
    </div>
  )
}

/** Raw ACP extension-method console — every `_cognition.ai/*` method the local
 * agent implements is callable from here. Method-not-found answers surface
 * verbatim so unsupported desktop methods are honest failures, not fakes. */
const EXT_METHODS = [
  '_cognition.ai/rules/list', '_cognition.ai/skills/list', '_cognition.ai/subagents/list',
  '_cognition.ai/plans/list', '_cognition.ai/hooks/list', '_cognition.ai/config/read',
  '_cognition.ai/config/write', '_cognition.ai/session/rename', '_cognition.ai/session/end', '_cognition.ai/session/share',
  '_cognition.ai/session/archive', '_cognition.ai/session/pin', '_cognition.ai/session/setTags',
  '_cognition.ai/session/loadPage', '_cognition.ai/session/loadSpine',
  '_cognition.ai/subagent/cancel', '_cognition.ai/subagent/foreground', '_cognition.ai/subagent/background',
  '_cognition.ai/reads/promptHistory', '_cognition.ai/reads/recentModelUids',
  '_cognition.ai/workflows/list', '_cognition.ai/command/revise',
  '_cognition.ai/plan/accept', '_cognition.ai/plan/edit', '_cognition.ai/plan/toggle-confirm-mode',
  '_cognition.ai/revert/listSteps', '_cognition.ai/revert/preview', '_cognition.ai/revert/execute',
  '_cognition.ai/revert/forkFromStep', '_cognition.ai/revert/resume',
  '_cognition.ai/folder/list', '_cognition.ai/repos/list',
  '_cognition.ai/terminal/killBackgroundShell', '_cognition.ai/test-command/run', '_cognition.ai/test-command/cancel',
  '_cognition.ai/messages_in_queued', '_cognition.ai/output', '_cognition.ai/turn_stats',
  '_cognition.ai/request_diagnostics', '_cognition.ai/diagnostics/sessionExport',
  '_cognition.ai/secret/list', '_cognition.ai/scope_search', '_cognition.ai/repo-index/decide',
  '_cognition.ai/mcp/listServers', '_cognition.ai/plugins/list', '_cognition.ai/billingInformation',
]

function ExtConsole({ id }: { id: string }) {
  const { t } = useTranslation()
  const [method, setMethod] = useState('_cognition.ai/')
  const [params, setParams] = useState('')
  const [load, setLoad] = useState(false)
  const [busy, setBusy] = useState(false)
  const [out, setOut] = useState<string | null>(null)
  const send = async () => {
    const m = method.trim()
    if (!m || busy) return
    let p: Record<string, unknown> = {}
    try { p = params.trim() ? JSON.parse(params) : {} } catch { setOut(t('res.badParams')); return }
    if (!('sessionId' in p)) p = { sessionId: id, ...p }
    setBusy(true); setOut(null)
    try {
      const r = await adminFetch<{ ok: boolean; result?: unknown; error?: string }>(`/api/admin/session/${id}/ext`, {
        method: 'POST', body: JSON.stringify({ method: m, params: p, load: load ? 1 : undefined }),
      })
      setOut(r.ok ? JSON.stringify(r.result ?? {}, null, 2) : `${t('res.errPrefix')}${r.error}`)
    } catch (e) { setOut(`${t('res.reqFail')}${(e as Error).message}`) } finally { setBusy(false) }
  }
  return (
    <div className="border-b border-border px-3 py-2">
      <div className="mb-2 text-[12px] font-medium text-muted-foreground">{t('res.consoleDesc')}</div>
      <input list="ext-methods" value={method} onChange={(e) => setMethod(e.target.value)}
        placeholder="_cognition.ai/…"
        className="mb-1.5 w-full rounded-md border border-border bg-card px-2 py-1.5 font-mono text-[11px] outline-none focus:border-foreground/30" />
      <datalist id="ext-methods">{EXT_METHODS.map((m) => <option key={m} value={m} />)}</datalist>
      <textarea value={params} onChange={(e) => setParams(e.target.value)} rows={2}
        placeholder={t('res.paramsPh')}
        className="mb-1.5 w-full resize-y rounded-md border border-border bg-card px-2 py-1.5 font-mono text-[11px] outline-none focus:border-foreground/30" />
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <input type="checkbox" checked={load} onChange={(e) => setLoad(e.target.checked)} />
          {t('res.loadFirst')}
        </label>
        <button onClick={() => void send()} disabled={busy}
          className="ml-auto rounded-md border border-border bg-card px-3 py-1 text-[11px] hover:bg-tint-secondary disabled:opacity-50">
          {busy ? '…' : t('res.call')}
        </button>
      </div>
      {out !== null && <pre className="mt-2 max-h-48 overflow-auto rounded-md border border-border bg-card p-2 text-[10px] leading-snug">{out}</pre>}
    </div>
  )
}

/**
 * Subagents list — cloud parity: a subagent IS a child session, so a row
 * navigates to its full session page (`/admin/sub:<root>:<agentId>`) instead
 * of an inline transcript. `id` may itself be a sub id — rows then list that
 * agent's nested children (spawned inside its stream).
 */
function SubagentsPanel({ id }: { id: string }) {
  const { t } = useTranslation()
  const nav = useNavigate()
  const [agents, setAgents] = useState<LocalSubagent[]>([])
  useEffect(() => {
    let alive = true
    const load = () => adminFetch<{ subagents: LocalSubagent[] }>(`/api/admin/session/${id}/subagents`)
      .then((r) => { if (alive) setAgents(r.subagents ?? []) })
      .catch(() => {})
    load()
    const stop = visibleInterval(load, 4000)
    return () => { alive = false; stop() }
  }, [id])
  // `sub:` ids key off the ROOT session — a nested child keeps the root id.
  const root = id.startsWith('sub:') ? id.split(':')[1] : id
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border px-3 py-2 text-[12px] font-medium text-muted-foreground">Subagents{agents.length ? ` · ${agents.length}` : ''}</div>
      <div className="flex-1 overflow-y-auto p-2">
        {!agents.length && <p className="px-2 py-6 text-center text-[12px] text-muted-foreground">{t('res.noSubs')}</p>}
        {agents.map((a) => (
          <button key={a.agentId} onClick={() => nav(`/admin/sub:${root}:${a.agentId}`)} className="mb-1 flex w-full items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 text-left hover:bg-tint-secondary">
            <span className={cn('size-2 shrink-0 rounded-full', a.resumable === false ? 'bg-muted-foreground/40' : a.status === 'running' ? 'bg-amber-500 animate-pulse' : a.status === 'failed' ? 'bg-red-500' : 'bg-emerald-500')} />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-1.5 truncate text-[13px] font-medium leading-[18px]">
                <span className={cn('truncate', a.resumable === false && 'text-muted-foreground')}>{a.title || a.agentId}</span>
                {a.resumable === false && <span className="shrink-0 rounded bg-muted px-1 text-[10px] leading-[15px] text-muted-foreground" title={t('res.handleGone')}>{t('res.handleGoneBadge')}</span>}
              </span>
              <span className="block truncate text-[11px] leading-[15px] text-muted-foreground">{[a.profile, a.model].filter(Boolean).join(' · ')}{a.isBackground ? ' · bg' : ''}{a.lastText ? ` — ${a.lastText}` : a.summary ? ` — ${a.summary}` : ''}</span>
            </span>
            <ChevronRight size={14} className="shrink-0 text-muted-foreground" />
          </button>
        ))}
      </div>
    </div>
  )
}

/** Inline live-output preview under the latest running command, pinned to the tail. */
function LiveOutputTail({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [text])
  return (
    <pre ref={ref} className="m-0 max-h-[300px] overflow-y-auto whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-[12px] text-muted-foreground">
      {text.length > 8000 ? text.slice(-8000) : text}
    </pre>
  )
}


export { type LocalSubagent, type SessionResources, ResSection, ResourcesPanel, EXT_METHODS, ExtConsole, SubagentsPanel, LiveOutputTail };
