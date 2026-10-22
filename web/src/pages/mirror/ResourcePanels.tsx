import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Loader2, ChevronRight, ChevronDown, Bot, Search, Plus, Square, Laptop } from 'lucide-react'
import { adminFetch } from '@/lib/api'
import { visibleInterval } from '@/lib/poll'
import { cn, subProfileLabel } from '@/lib/utils'
import { Combo } from '@/components/ui'

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
type McpServer = { name?: string; command?: string; url?: string; status?: string; tools?: { name?: string }[] | number; source?: string }
type RuleEntry = { name?: string; source?: string; content?: string; path?: string; providerLabel?: string; trigger?: string; scope?: string }
type PlanEntry = { name?: string; title?: string; status?: string; summary?: string; description?: string; path?: string; updatedAt?: string }
type SessionResources = {
  rules?: RuleEntry[] | null
  skills?: { name?: string; displayName?: string; description?: string; path?: string; providerLabel?: string; scope?: string; isBuiltin?: boolean }[] | null
  subagentProfiles?: { name?: string; description?: string; model?: string; allowedTools?: string[] }[] | null
  hooks?: { event?: string; command?: string; source?: string }[] | null
  mcpServers?: McpServer[] | null
  plans?: PlanEntry[] | null
  config?: Record<string, unknown> | null
  configPath?: string | null
  /** Runtime registry — subagents this session actually spawned. */
  subagents?: LocalSubagent[]
  errors?: Record<string, string>
}

/** Editable agent config — `_cognition.ai/config/write` via the ext
 *  passthrough. Hooks live in this object, so this is the configure entry
 *  the hooks list points at. Parse/save errors surface verbatim. */
function ConfigEditor({ id, config }: { id: string; config: Record<string, unknown> }) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(() => JSON.stringify(config, null, 2))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const save = async () => {
    let parsed: unknown
    try { parsed = JSON.parse(draft) } catch (e) { setMsg({ ok: false, text: `${t('res.cfgBadJson')}: ${(e as Error).message}` }); return }
    setBusy(true); setMsg(null)
    try {
      const r = await adminFetch<{ ok: boolean; error?: string }>(`/api/admin/session/${id}/ext`, {
        method: 'POST',
        body: JSON.stringify({ method: '_cognition.ai/config/write', params: { config: parsed } }),
      })
      setMsg(r.ok ? { ok: true, text: t('res.cfgSaved') } : { ok: false, text: r.error || t('res.cfgSaveFail') })
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    } finally { setBusy(false) }
  }
  const dirty = draft !== JSON.stringify(config, null, 2)
  return (
    <div>
      <textarea
        value={draft}
        onChange={(e) => { setDraft(e.target.value); setMsg(null) }}
        spellCheck={false}
        className="max-h-48 min-h-24 w-full resize-y overflow-auto rounded-md border border-border bg-muted/60 p-2 font-mono text-[11px] leading-[15px] text-foreground outline-none focus:border-accent-primary"
      />
      <div className="mt-1.5 flex items-center gap-2">
        <button
          onClick={() => void save()}
          disabled={busy || !dirty}
          className="h-6 cursor-pointer rounded-md bg-primary px-2.5 text-[11px] text-primary-foreground disabled:cursor-default disabled:opacity-50"
        >{busy ? t('common.saving') : t('common.save')}</button>
        <button
          onClick={() => { setDraft(JSON.stringify(config, null, 2)); setMsg(null) }}
          disabled={busy || !dirty}
          className="h-6 cursor-pointer rounded-md px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
        >{t('common.reset')}</button>
        {msg && <span className={cn('truncate text-[11px]', msg.ok ? 'text-emerald-600' : 'text-red-500')} title={msg.text}>{msg.text}</span>}
      </div>
    </div>
  )
}

/** camelCase / snake_case key → readable label ("subagent_model" → "Subagent
 *  model", "themeMode" → "Theme mode"). The value stays untranslated — config
 *  keys are a contract, not prose. */
function humanizeKey(k: string): string {
  const s = k.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Visual render for one config value — leaf rows only; objects recurse in
 *  ConfigRows. Booleans pill, null → em dash, arrays inline-join. */
function CfgValue({ v }: { v: unknown }) {
  const { t } = useTranslation()
  if (v === null || v === undefined) return <span className="text-muted-foreground/60">—</span>
  if (typeof v === 'boolean') return <span className={cn('rounded px-1 text-[10px] leading-[15px]', v ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-muted text-muted-foreground')}>{v ? t('res.cfgOn') : t('res.cfgOff')}</span>
  if (typeof v === 'number' || typeof v === 'string') return <span className="break-words font-mono">{String(v) || '""'}</span>
  if (Array.isArray(v)) {
    if (!v.length) return <span className="text-muted-foreground/60">[]</span>
    if (v.every((x) => x === null || ['string', 'number', 'boolean'].includes(typeof x))) return <span className="break-words font-mono">{v.map((x) => String(x)).join(', ')}</span>
    return <span className="text-muted-foreground">{t('res.cfgItems', { n: v.length })}</span>
  }
  const n = Object.keys(v as object).length
  return <span className="text-muted-foreground">{n ? t('res.cfgKeys', { n }) : '{}'}</span>
}

/** key→value rows for a config object; nested objects get their own block. */
function ConfigRows({ obj }: { obj: Record<string, unknown> }) {
  const entries = Object.entries(obj)
  const leaves = entries.filter(([, v]) => v === null || v === undefined || typeof v !== 'object' || (Array.isArray(v) && v.every((x) => x === null || ['string', 'number', 'boolean'].includes(typeof x))))
  const nested = entries.filter(([k, v]) => v !== null && typeof v === 'object' && !leaves.some(([lk]) => lk === k))
  return (
    <>
      {leaves.length > 0 && (
        <div className="grid grid-cols-[minmax(0,45%)_1fr] gap-x-2 gap-y-1 text-[11px] leading-[16px]">
          {leaves.map(([k, v]) => (
            <div key={k} className="contents">
              <span className="truncate text-muted-foreground" title={k}>{humanizeKey(k)}</span>
              <span className="min-w-0 truncate text-foreground" title={typeof v === 'string' ? v : JSON.stringify(v)}><CfgValue v={v} /></span>
            </div>
          ))}
        </div>
      )}
      {nested.map(([k, v]) => {
        const inner = Array.isArray(v)
          ? null
          : (v as Record<string, unknown>)
        return (
          <div key={k} className="mt-1.5">
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">{humanizeKey(k)}</div>
            {inner ? (
              <div className="mt-0.5 rounded-md border border-border/60 bg-muted/30 px-2 py-1"><ConfigRows obj={inner} /></div>
            ) : (
              <pre className="mt-0.5 max-h-32 overflow-auto rounded-md border border-border/60 bg-muted/30 p-1.5 font-mono text-[10px] leading-snug text-muted-foreground">{JSON.stringify(v, null, 2)}</pre>
            )}
          </div>
        )
      })}
    </>
  )
}

/** Agent config — visual key→value render by default (the raw JSON editor is
 *  still one toggle away for real edits via config/write). */
function ConfigView({ id, config, path }: { id: string; config: Record<string, unknown>; path?: string | null }) {
  const { t } = useTranslation()
  const [edit, setEdit] = useState(false)
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="flex gap-0.5 rounded-md bg-muted p-0.5">
          <button onClick={() => setEdit(false)} className={cn('h-5 cursor-pointer rounded-[5px] px-2 text-[10px]', !edit ? 'bg-card font-medium text-foreground shadow-sm' : 'text-muted-foreground')}>{t('res.cfgView')}</button>
          <button onClick={() => setEdit(true)} className={cn('h-5 cursor-pointer rounded-[5px] px-2 text-[10px]', edit ? 'bg-card font-medium text-foreground shadow-sm' : 'text-muted-foreground')}>{t('res.cfgJson')}</button>
        </span>
        {path && <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground/70" title={path}>{path}</span>}
      </div>
      {edit ? <ConfigEditor id={id} config={config} /> : <ConfigRows obj={config} />}
    </div>
  )
}

/** Expandable view/edit for a rule or plan file — reads/saves through the
 *  session-scoped rule-file route (confined to resource roots ∪ paths the
 *  agent itself lists as rules/plans). */
function RuleFileEditor({ id, path, name }: { id: string; path: string; name: string }) {
  const { t } = useTranslation()
  const [saved, setSaved] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => {
    let alive = true
    setSaved(null); setErr(null); setMsg(null)
    void adminFetch<{ text: string | null }>(`/api/admin/session/${id}/rule-file?path=${encodeURIComponent(path)}`)
      .then((d) => { if (alive) { setSaved(d.text ?? ''); setText(d.text ?? '') } })
      .catch((e) => { if (alive) setErr((e as Error).message) })
    return () => { alive = false }
  }, [id, path])
  if (err) return <p className="py-1.5 text-[11px] text-red-500">{err}</p>
  if (saved === null) return <p className="flex items-center gap-1.5 py-1.5 text-[11px] text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />{t('common.loading')}</p>
  const dirty = text !== saved
  const save = async () => {
    setBusy(true); setMsg(null)
    try {
      await adminFetch(`/api/admin/session/${id}/rule-file`, { method: 'POST', body: JSON.stringify({ path, text }) })
      setSaved(text); setMsg({ ok: true, text: t('res.cfgSaved') })
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }) } finally { setBusy(false) }
  }
  return (
    <div className="mt-1">
      <textarea
        value={text}
        onChange={(e) => { setText(e.target.value); setMsg(null) }}
        spellCheck={false}
        aria-label={name}
        className="max-h-56 min-h-28 w-full resize-y overflow-auto rounded-md border border-border bg-muted/60 p-2 font-mono text-[11px] leading-[15px] text-foreground outline-none focus:border-accent-primary"
      />
      <div className="mt-1 flex items-center gap-2">
        <button onClick={() => void save()} disabled={busy || !dirty}
          className="h-6 cursor-pointer rounded-md bg-primary px-2.5 text-[11px] text-primary-foreground disabled:cursor-default disabled:opacity-50">{busy ? t('common.saving') : t('common.save')}</button>
        <button onClick={() => { setText(saved); setMsg(null) }} disabled={busy || !dirty}
          className="h-6 cursor-pointer rounded-md px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50">{t('common.reset')}</button>
        {msg && <span className={cn('truncate text-[11px]', msg.ok ? 'text-emerald-600' : 'text-red-500')} title={msg.text}>{msg.text}</span>}
      </div>
    </div>
  )
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

/** A rule/plan row that expands to reveal (and edit, when the route allows)
 *  the file's actual content. Entries the agent reports without a path but
 *  WITH inline `content` render that instead. */
function ExpandableFile({ id, path, content, label, children }: { id: string; path?: string; content?: string; label: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false)
  const expandable = !!path || !!content
  return (
    <div className="rounded-md border border-border bg-card">
      <button
        onClick={expandable ? () => setOpen(!open) : undefined}
        className={cn('flex w-full items-center gap-1.5 px-2 py-1.5 text-left', expandable ? 'cursor-pointer' : 'cursor-default')}
      >
        {expandable && (open ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />)}
        <div className="min-w-0 flex-1">{children}</div>
      </button>
      {open && path && <div className="border-t border-border/60 px-2 pb-2"><RuleFileEditor id={id} path={path} name={label} /></div>}
      {open && !path && content && <pre className="max-h-56 overflow-auto border-t border-border/60 p-2 font-mono text-[10px] leading-snug whitespace-pre-wrap text-muted-foreground">{content}</pre>}
    </div>
  )
}

/** Skills list with a search filter + an honest install path: no marketplace
 *  ext method exists on the local agent, so "install" writes a SKILL.md into
 *  ~/.agents/skills/<name>/ — the same dir the agent's skills probe scans. */
function SkillList({ id, skills, installed, onChanged }: { id: string; skills: NonNullable<SessionResources['skills']>; installed: boolean; onChanged: () => void }) {
  const { t } = useTranslation()
  const [q, setQ] = useState('')
  const [installing, setInstalling] = useState(false)
  const [name, setName] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const needle = q.trim().toLowerCase()
  const shown = needle
    ? skills.filter((s) => [s.name, s.displayName, s.description].some((f) => f?.toLowerCase().includes(needle)))
    : skills
  const install = async () => {
    const n = name.trim()
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(n)) { setMsg({ ok: false, text: t('res.skillInstallBadName') }); return }
    setBusy(true); setMsg(null)
    try {
      await adminFetch('/api/admin/skill-install', { method: 'POST', body: JSON.stringify({ name: n, content: body }) })
      setMsg({ ok: true, text: t('res.skillInstalled', { name: n }) })
      setInstalling(false); setName(''); setBody('')
      onChanged()
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }) } finally { setBusy(false) }
  }
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('res.skillSearch')}
            className="h-6 w-full rounded-md border border-border bg-background pl-5 pr-1.5 text-[11px] outline-none focus:border-accent-primary"
          />
        </div>
        <button
          onClick={() => { setInstalling(!installing); setMsg(null) }}
          title={t('res.skillInstallTitle')}
          className="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        ><Plus className="h-3 w-3" />{t('res.skillInstall')}</button>
      </div>
      {installing && (
        <div className="mb-1.5 rounded-md border border-border bg-muted/40 p-2">
          <input
            value={name}
            onChange={(e) => { setName(e.target.value); setMsg(null) }}
            placeholder={t('res.skillInstallNamePh')}
            className="mb-1 h-6 w-full rounded-md border border-border bg-background px-1.5 font-mono text-[11px] outline-none focus:border-accent-primary"
          />
          <textarea
            value={body}
            onChange={(e) => { setBody(e.target.value); setMsg(null) }}
            placeholder={'---\nname: my-skill\ndescription: …\n---\n# SKILL.md'}
            spellCheck={false}
            className="h-28 w-full resize-y rounded-md border border-border bg-background p-1.5 font-mono text-[10px] leading-[14px] outline-none focus:border-accent-primary"
          />
          <div className="mt-1 flex items-center gap-2">
            <button onClick={() => void install()} disabled={busy || !name.trim() || !body.trim()}
              className="h-6 cursor-pointer rounded-md bg-primary px-2.5 text-[11px] text-primary-foreground disabled:cursor-default disabled:opacity-50">{busy ? t('common.saving') : t('res.skillInstall')}</button>
            <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground/80" title={t('res.skillInstallHint')}>{t('res.skillInstallHint')}</span>
          </div>
        </div>
      )}
      {msg && <p className={cn('mb-1.5 text-[11px]', msg.ok ? 'text-emerald-600' : 'text-red-500')}>{msg.text}</p>}
      {!shown.length ? (
        <p className="text-[12px] text-muted-foreground">{installed ? t('res.noSkillMatch') : t('res.noSkills')}</p>
      ) : shown.map((x, i) => (
        <div key={x.name || i} className="mb-1.5 rounded-md border border-border bg-card px-2 py-1.5">
          <div className="flex items-center gap-1.5 text-[12px] font-medium">
            <span className="min-w-0 flex-1 truncate">{x.displayName || x.name}</span>
            {x.isBuiltin && <span className="shrink-0 rounded bg-tint px-1 py-px text-[9px] text-muted-foreground">{t('res.builtin')}</span>}
            {(x.providerLabel || x.scope) && <span className="shrink-0 rounded bg-tint px-1 py-px text-[9px] text-muted-foreground" title={x.path}>{x.providerLabel || x.scope}</span>}
          </div>
          {x.description && <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{x.description}</div>}
          {x.path && <div className="mt-0.5 truncate font-mono text-[9px] text-muted-foreground/60" title={x.path}>{x.path}</div>}
        </div>
      ))}
    </div>
  )
}

/** Runtime subagent roster inside the resources panel — the rows the agent
 *  actually spawned (status dot + profile/model + task), each a deep-link to
 *  its sub:* session page. `live`/`resumable` gate nothing here — this list
 *  is information, not control. */
function RuntimeSubRow({ id, a }: { id: string; a: LocalSubagent }) {
  const nav = useNavigate()
  const { t } = useTranslation()
  // `sub:` ids key off the ROOT session — a nested child's rows keep the root.
  const root = id.startsWith('sub:') ? id.split(':')[1] : id
  return (
    <button
      onClick={() => nav(`/admin/sub:${root}:${a.agentId}`)}
      className="mb-1.5 flex w-full items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5 text-left hover:bg-tint-secondary"
    >
      <span className={cn('size-1.5 shrink-0 rounded-full', a.status === 'running' ? 'bg-emerald-500' : a.status === 'failed' ? 'bg-red-500' : 'bg-muted-foreground/40')} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-medium">{a.title || a.agentId}</span>
        <span className="block truncate text-[10px] text-muted-foreground">
          {[a.profile ? subProfileLabel(a.profile) : null, a.model, a.isBackground ? t('res.background') : null].filter(Boolean).join(' · ')}
        </span>
      </span>
      {a.resumable === false && <span className="shrink-0 rounded bg-tint px-1 py-px text-[9px] text-muted-foreground" title={t('res.handleGone')}>{t('res.handleGoneBadge')}</span>}
      <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
    </button>
  )
}

function ResourcesPanel({ id }: { id: string }) {
  const { t } = useTranslation()
  const [r, setR] = useState<SessionResources | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    setR(null); setErr(null)
    adminFetch<SessionResources>(`/api/admin/session/${id}/resources`)
      .then((x) => { if (alive) setR(x) })
      .catch((e) => { if (alive) setErr((e as Error).message) })
    return () => { alive = false }
  }, [id, tick])
  if (err) return <p className="p-4 text-[12px] text-muted-foreground">{err}</p>
  if (!r) return <div className="flex items-center gap-2 p-4 text-[12px] text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t('res.loading')}</div>
  const empty = 'text-[12px] text-muted-foreground'
  // Per-probe failures surface in their own section instead of collapsing the panel.
  const probeErr = (key: string, fb: string) => r.errors?.[key] ? <p className="text-[11px] text-amber-600 dark:text-amber-400" title={r.errors[key]}>{fb}: {r.errors[key]}</p> : null
  const runtimeSubs = r.subagents ?? []
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <ResSection title={t('res.subProfiles')} count={(r.subagentProfiles?.length ?? 0) + runtimeSubs.length}>
        {probeErr('subagentProfiles', t('res.probeFail'))}
        {runtimeSubs.map((a) => <RuntimeSubRow key={a.agentId} id={id} a={a} />)}
        {r.subagentProfiles?.map((x, i) => (
          <div key={i} className="mb-1.5 rounded-md border border-border bg-card px-2 py-1.5">
            <div className="flex items-center gap-2 text-[12px] font-medium"><Bot className="h-3.5 w-3.5 text-muted-foreground" /><span className="min-w-0 flex-1 truncate">{x.name}</span></div>
            {x.description && <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{x.description}</div>}
            {x.model && <div className="mt-1 text-[10px] text-muted-foreground">{x.model}</div>}
          </div>
        ))}
        {!runtimeSubs.length && !r.subagentProfiles?.length && <p className={empty}>{t('res.noSub')}</p>}
      </ResSection>
      <ResSection title={t('res.mcp')} count={r.mcpServers?.length ?? 0}>
        {probeErr('mcp', t('res.probeFail'))}
        {!r.mcpServers?.length ? <p className={empty}>{t('res.noMcp')}</p> : r.mcpServers.map((x, i) => (
          <div key={i} className="mb-1.5 rounded-md border border-border bg-card px-2 py-1.5">
            <div className="flex items-center gap-2 text-[12px] font-medium">
              {x.source !== 'config' && <span className={cn('size-1.5 shrink-0 rounded-full', x.status === 'connected' || x.status === 'running' ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />}
              <span className="truncate">{x.name || x.command || x.url}</span>
              {x.source === 'config' && <span className="shrink-0 rounded bg-tint px-1 py-px text-[9px] text-muted-foreground" title={t('res.fromConfigTitle')}>{t('res.fromConfig')}</span>}
              {typeof x.tools === 'number' && <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{t('res.toolCount', { n: x.tools })}</span>}
              {Array.isArray(x.tools) && <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{t('res.toolCount', { n: x.tools.length })}</span>}
            </div>
            {(x.command || x.url) && <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{x.command || x.url}</div>}
          </div>
        ))}
        {!!r.mcpServers?.length && r.mcpServers.some((x) => x.source === 'config') && <p className="mt-1 text-[10px] text-muted-foreground/80">{t('res.mcpFromConfig')}</p>}
      </ResSection>
      <ResSection title={t('res.hooks')} count={r.hooks?.length ?? 0}>
        {probeErr('hooks', t('res.probeFail'))}
        {!r.hooks?.length ? <p className={empty}>{t('res.noHooks')}</p> : r.hooks.map((x, i) => (
          <div key={i} className="mb-1.5 rounded-md border border-border bg-card px-2 py-1.5 text-[11px]">
            <div className="flex items-center gap-2 font-medium"><span className="min-w-0 flex-1 truncate">{x.event}</span>{x.source && <span className="shrink-0 rounded bg-tint px-1 py-px text-[9px] text-muted-foreground" title={x.source}>{x.source}</span>}</div>
            {x.command && <div className="mt-0.5 truncate font-mono text-muted-foreground">{x.command}</div>}
          </div>
        ))}
        {!!r.hooks?.length && <p className="mt-1 text-[10px] text-muted-foreground/80">{t('res.hooksInConfig')}</p>}
      </ResSection>
      <ResSection title={t('res.plans')} count={r.plans?.length ?? 0}>
        {probeErr('plans', t('res.probeFail'))}
        {!r.plans?.length ? <p className={empty}>{t('res.noPlans')}</p> : r.plans.map((x, i) => (
          <div key={i} className="mb-1.5">
            <ExpandableFile id={id} path={x.path} label={x.title || x.name || `#${i + 1}`}>
              <div className="flex items-center gap-2 text-[11px] font-medium"><span className="min-w-0 flex-1 truncate">{x.title || x.name || `#${i + 1}`}</span>{x.status && <span className="shrink-0 rounded bg-tint px-1 py-px text-[9px] text-muted-foreground">{x.status}</span>}</div>
              {(x.description || x.summary) && <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{x.description || x.summary}</div>}
              {x.path && <div className="mt-0.5 truncate font-mono text-[9px] text-muted-foreground/60" title={x.path}>{x.path}</div>}
            </ExpandableFile>
          </div>
        ))}
      </ResSection>
      <ResSection title={t('res.config')} count={r.config ? Object.keys(r.config).length : 0}>
        {probeErr('config', t('res.probeFail'))}
        {!r.config ? <p className={empty}>{t('res.noConfig')}</p> : <ConfigView id={id} config={r.config} path={r.configPath} />}
      </ResSection>
      <ResSection title={t('res.rules')} count={r.rules?.length ?? 0}>
        {probeErr('rules', t('res.probeFail'))}
        {!r.rules?.length ? <p className={empty}>{t('res.noRules')}</p> : r.rules.map((x, i) => (
          <div key={i} className="mb-1.5">
            <ExpandableFile id={id} path={x.path} content={x.content} label={x.name || x.path || x.source || `#${i + 1}`}>
              <div className="flex items-center gap-2 text-[12px]">
                <span className="min-w-0 flex-1 truncate font-medium">{x.name || x.path?.split(/[\\/]/).pop() || x.source}</span>
                {(x.providerLabel || x.scope || x.source) && <span className="shrink-0 rounded bg-tint px-1 py-px text-[9px] text-muted-foreground">{x.providerLabel || x.scope || x.source}</span>}
              </div>
              {x.path && <div className="mt-0.5 truncate font-mono text-[9px] text-muted-foreground/60" title={x.path}>{x.path}</div>}
            </ExpandableFile>
          </div>
        ))}
      </ResSection>
      <ResSection title={t('res.skills')} count={r.skills?.length ?? 0}>
        {probeErr('skills', t('res.probeFail'))}
        <SkillList id={id} skills={r.skills ?? []} installed={!!r.skills?.length} onChanged={() => setTick((n) => n + 1)} />
      </ResSection>
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
  const [sid, setSid] = useState(id)
  const [method, setMethod] = useState('_cognition.ai/')
  const [params, setParams] = useState('')
  const [load, setLoad] = useState(false)
  const [busy, setBusy] = useState(false)
  const [out, setOut] = useState<string | null>(null)
  const send = async () => {
    const m = method.trim()
    const target = sid.trim()
    if (!m || !target || busy) return
    let p: Record<string, unknown> = {}
    try { p = params.trim() ? JSON.parse(params) : {} } catch { setOut(t('res.badParams')); return }
    if (!('sessionId' in p)) p = { sessionId: target, ...p }
    setBusy(true); setOut(null)
    try {
      const r = await adminFetch<{ ok: boolean; result?: unknown; error?: string }>(`/api/admin/session/${target}/ext`, {
        method: 'POST', body: JSON.stringify({ method: m, params: p, load: load ? 1 : undefined }),
      })
      setOut(r.ok ? JSON.stringify(r.result ?? {}, null, 2) : `${t('res.errPrefix')}${r.error}`)
    } catch (e) { setOut(`${t('res.reqFail')}${(e as Error).message}`) } finally { setBusy(false) }
  }
  return (
    <div className="px-3 py-2">
      <div className="mb-2 text-[12px] font-medium text-muted-foreground">{t('res.consoleDesc')}</div>
      {!id && (
        <input value={sid} onChange={(e) => setSid(e.target.value)}
          placeholder={t('res.sessionIdPh')}
          className="mb-1.5 w-full rounded-md border border-border bg-card px-2 py-1.5 font-mono text-[11px] outline-none focus:border-foreground/30" />
      )}
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

/** ms an agent has been (or was) running — the 'runtime' sort dimension. */
function subRuntime(a: LocalSubagent, now: number): number {
  const start = a.startedAt ? Date.parse(a.startedAt) : NaN
  if (Number.isNaN(start)) return -1
  const end = a.finishedAt ? Date.parse(a.finishedAt) : now
  return Math.max(0, (Number.isNaN(end) ? now : end) - start)
}

type SubSort = 'status' | 'name' | 'runtime'
const SUB_SORTS: SubSort[] = ['status', 'name', 'runtime']

function sortSubs(agents: LocalSubagent[], sort: SubSort, now: number): LocalSubagent[] {
  const statusRank = (a: LocalSubagent) => (a.status === 'running' ? 0 : a.status === 'failed' ? 1 : 2)
  const newest = (a: LocalSubagent, b: LocalSubagent) => Date.parse(b.startedAt ?? '') - Date.parse(a.startedAt ?? '')
  const rows = [...agents]
  if (sort === 'name') rows.sort((a, b) => (a.title || a.agentId).localeCompare(b.title || b.agentId))
  else if (sort === 'runtime') rows.sort((a, b) => subRuntime(b, now) - subRuntime(a, now) || newest(a, b))
  else rows.sort((a, b) => statusRank(a) - statusRank(b) || newest(a, b)) // default: running first, newest next
  return rows
}

/**
 * Subagents list — cloud parity: a subagent IS a child session, so a row
 * navigates to its full session page (`/admin/sub:<root>:<agentId>`) instead
 * of an inline transcript. `id` may itself be a sub id — rows then list that
 * agent's nested children (spawned inside its stream). Rows also carry the
 * live controls the registry allows: stop (cancel) + foreground/background —
 * only while the agent's handle is live (replayed `spawn:*` rows and
 * `resumable:false` handles get no buttons, matching SubagentCard).
 */
function SubagentsPanel({ id }: { id: string }) {
  const { t } = useTranslation()
  const nav = useNavigate()
  const [agents, setAgents] = useState<LocalSubagent[]>([])
  const [sort, setSort] = useState<SubSort>('status')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [ctlErr, setCtlErr] = useState<string | null>(null)
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
  const control = async (a: LocalSubagent, action: 'cancel' | 'foreground' | 'background') => {
    setBusyId(a.agentId); setCtlErr(null)
    try {
      const r = await adminFetch<{ ok: boolean; error?: string }>(`/api/admin/session/${root}/subagent/${encodeURIComponent(a.agentId)}/control`, {
        method: 'POST', body: JSON.stringify({ action }),
      })
      if (!r.ok) setCtlErr(r.error || t('res.reqFail'))
      const reload = await adminFetch<{ subagents: LocalSubagent[] }>(`/api/admin/session/${id}/subagents`).catch(() => null)
      if (reload) setAgents(reload.subagents ?? [])
    } catch (e) { setCtlErr((e as Error).message) } finally { setBusyId(null) }
  }
  const sorted = sortSubs(agents, sort, Date.now())
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-[12px] font-medium text-muted-foreground">{t('res.subagents')}{agents.length ? ` · ${agents.length}` : ''}</span>
        {agents.length > 1 && (
          <span className="ml-auto">
            <Combo
              value={sort}
              options={SUB_SORTS.map((v) => ({ v, l: t(`res.sort.${v}`) }))}
              onPick={(v) => setSort(v as SubSort)}
              className="h-6 text-[11px]"
            />
          </span>
        )}
      </div>
      {ctlErr && <p className="border-b border-border px-3 py-1.5 text-[11px] text-red-500">{ctlErr}</p>}
      <div className="flex-1 overflow-y-auto p-2">
        {!agents.length && <p className="px-2 py-6 text-center text-[12px] text-muted-foreground">{t('res.noSubs')}</p>}
        {sorted.map((a) => {
          const controllable = a.live && a.resumable !== false && !a.agentId.startsWith('spawn:')
          return (
            <div key={a.agentId} role="button" tabIndex={0}
              onClick={() => nav(`/admin/sub:${root}:${a.agentId}`)}
              onKeyDown={(e) => { if (e.key === 'Enter') nav(`/admin/sub:${root}:${a.agentId}`) }}
              className="mb-1 flex w-full cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 text-left hover:bg-tint-secondary">
              <span className={cn('size-2 shrink-0 rounded-full', a.resumable === false ? 'bg-muted-foreground/40' : a.status === 'running' ? 'bg-amber-500 animate-pulse' : a.status === 'failed' ? 'bg-red-500' : 'bg-emerald-500')} />
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-1.5 truncate text-[13px] font-medium leading-[18px]">
                  <span className={cn('truncate', a.resumable === false && 'text-muted-foreground')}>{a.title || a.agentId}</span>
                  {a.resumable === false && <span className="shrink-0 rounded bg-muted px-1 text-[10px] leading-[15px] text-muted-foreground" title={t('res.handleGone')}>{t('res.handleGoneBadge')}</span>}
                </span>
                <span className="block truncate text-[11px] leading-[15px] text-muted-foreground">{[subProfileLabel(a.profile ?? ''), a.model].filter(Boolean).join(' · ')}{a.isBackground ? ` · ${t('lib.prof.bg')}` : ''}{a.lastText ? ` — ${a.lastText}` : a.summary ? ` — ${a.summary}` : ''}</span>
              </span>
              {controllable && (
                <span className="flex shrink-0 items-center gap-1">
                  {a.status === 'running' && (
                    <button
                      onClick={(e) => { e.stopPropagation(); void control(a, 'cancel') }}
                      disabled={busyId === a.agentId}
                      title={t('res.subStop')}
                      className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50"
                    >{busyId === a.agentId ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />}</button>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); void control(a, a.isBackground ? 'foreground' : 'background') }}
                    disabled={busyId === a.agentId}
                    title={a.isBackground ? t('menu.bringFg') : t('menu.sendBg')}
                    className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                  ><Laptop className="h-3 w-3" /></button>
                </span>
              )}
              <ChevronRight size={14} className="shrink-0 text-muted-foreground" />
            </div>
          )
        })}
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
