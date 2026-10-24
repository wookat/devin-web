import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, ChevronRight, ChevronDown, Copy, Check, XCircle, CircleCheck, Circle, Code2, Bot, BookOpen, CircleDashed, ChevronsUpDown } from 'lucide-react'
import { adminFetch } from '@/lib/api'
import { Combo } from '@/components/ui'
import { cn } from '@/lib/utils'
import { sessionMirrorPath } from '@/lib/mirrorLinks'
import { fmtDur } from './timelineUtil'
import { dateLoc } from '@/lib/datetime'

interface WfRunDetail {
  run?: {
    run_id: string
    devin_id?: string
    status?: string
    metadata?: { workflow_name?: string; title?: string }
    created_at?: string
  }
  contents?: {
    description?: string
    product?: string | null
    phases?: { title?: string; detail?: string; count?: number; labels?: string[] }[]
    script?: string
  }
  agent_results?: {
    result_id: string
    status: string
    session_id?: string | null
    metadata?: { phase?: string; label?: string; mode?: string; vm_mode?: string }
    error?: string | null
    output?: string | null
    acus?: number | null
    started_at?: string | null
    updated_at?: string
  }[]
}

/** Official agent status pill wording (workflowRuns.* string catalog). */
const AGENT_STATUS: Record<string, { label: string; cls: string }> = {
  queued: { label: 'Queued', cls: 'bg-muted text-muted-foreground' },
  starting: { label: 'Starting', cls: 'bg-muted text-muted-foreground' },
  running: { label: 'Working', cls: 'bg-blue-500/10 text-blue-600 dark:text-blue-400' },
  completed: { label: 'Finished', cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
  failed: { label: 'Failed', cls: 'bg-red-500/10 text-red-600 dark:text-red-400' },
  replayed: { label: 'Replayed', cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
}

/** Latest per-result state from workflow_agent_update events; a `replayed` event
 * re-places a result into a later phase slot, which the detail API metadata
 * doesn't reflect. */
type WfAgentEventState = { status: string; phase?: string; label?: string }

/** Official agent row status icon: filled green check when settled OK, red X on
 * failure, spinner while working, dashed circle for queued/unstarted slots. */
function AgentStatusIcon({ status }: { status: string }) {
  if (status === 'completed' || status === 'replayed') {
    return (
      <svg className="shrink-0 text-green-600" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none">
        <path fillRule="evenodd" clipRule="evenodd" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm3.58 7.975a.75.75 0 1 0-1.16-.95l-3.976 4.859-1.414-1.414a.75.75 0 1 0-1.06 1.06l2 2a.75.75 0 0 0 1.11-.055l4.5-5.5Z" fill="currentColor" />
      </svg>
    )
  }
  if (status === 'failed') return <XCircle size={14} className="shrink-0 text-red-600" />
  if (status === 'running' || status === 'starting') return <Loader2 size={14} className="shrink-0 animate-spin text-muted-foreground" />
  return <CircleDashed size={14} className="shrink-0 text-muted-foreground/60" />
}

function fmtAgentDur(start?: string | null, end?: string): string {
  if (!start || !end) return ''
  const s = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000)
  if (!Number.isFinite(s) || s < 0) return ''
  return fmtDur(s)
}

interface ParentInfo {
  devin_id: string
  title: string
  status_enum: string
  activity_status: string
  tasks: { title: string; status: string }[]
}

/** Official Agents panel "Parent" card: parent session + its task list. */
function ParentCard({ devinId, onOpen }: { devinId: string; onOpen?: (devinId: string, title: string) => void }) {
  const { t } = useTranslation()
  const [parent, setParent] = useState<ParentInfo | null>(null)
  const [open, setOpen] = useState(true)
  useEffect(() => {
    let cancel = false
    adminFetch<{ parent: ParentInfo | null }>(`/api/admin/mirror/parent?session=${devinId}`)
      .then((r) => { if (!cancel) setParent(r.parent) })
      .catch(() => null)
    return () => { cancel = true }
  }, [devinId])
  if (!parent) return null
  const done = parent.tasks.filter((t) => t.status === 'completed').length
  const working = parent.activity_status === 'working' || parent.status_enum === 'working'
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-card px-3.5 py-3">
      <div className="flex items-center gap-2">
        <span className="text-[12px] leading-[16px] font-medium text-muted-foreground">{t('ag.parent')}</span>
        {working && <span className="rounded-md bg-blue-500/10 px-1.5 py-0.5 text-[11px] font-medium text-blue-600 dark:text-blue-400">{t('ag.working')}</span>}
        <button
          onClick={() => onOpen?.(parent.devin_id, parent.title)}
          className="ml-auto shrink-0 cursor-pointer rounded-md px-1.5 py-0.5 text-[12px] leading-[16px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          View session
        </button>
      </div>
      <p className="truncate text-[13px] leading-[18px] font-medium">{parent.title || parent.devin_id}</p>
      {parent.tasks.length > 0 && (
        <div className="flex flex-col gap-1">
          <button
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="flex cursor-pointer items-center gap-1 text-[12px] leading-[16px] text-muted-foreground hover:text-foreground"
          >
            <ChevronRight size={12} className={cn('transition-transform', open && 'rotate-90')} />
            <span className="tabular-nums">{done} / {parent.tasks.length} tasks</span>
          </button>
          {open && (
            <ul className="flex flex-col gap-0.5 pl-4">
              {parent.tasks.map((t, i) => (
                <li key={i} className="flex items-start gap-1.5 text-[12px] leading-[17px]">
                  {t.status === 'completed'
                    ? <CircleCheck size={13} className="mt-0.5 shrink-0 text-green-600" />
                    : t.status === 'in_progress'
                      ? <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin text-blue-500" />
                      : <Circle size={13} className="mt-0.5 shrink-0 text-muted-foreground" />}
                  <span className={cn('min-w-0', t.status === 'completed' && 'text-muted-foreground line-through')}>{t.title}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

/** Official Agents panel: workflow run detail (run + phases + agent results + script). */
function AgentsPanel({ runs, selected, onSelect, agentEvents, devinId, onOpenSession }: {
  runs: { runId: string; name?: string }[]
  selected: string | null
  onSelect: (runId: string) => void
  agentEvents: Map<string, Map<string, WfAgentEventState>>
  devinId: string
  onOpenSession?: (devinId: string, title: string) => void
}) {
  const { t } = useTranslation()
  const runId = selected ?? runs[runs.length - 1]?.runId ?? null
  const [detail, setDetail] = useState<WfRunDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!runId) return
    let cancel = false
    setLoading(true)
    setErr(null)
    adminFetch<{ data: WfRunDetail | null; error: string | null }>(`/api/admin/mirror/workflow-runs/${runId}`)
      .then((r) => { if (!cancel) { setDetail(r.data); setErr(r.error) } })
      .catch((e: Error) => { if (!cancel) setErr(e.message) })
      .finally(() => { if (!cancel) setLoading(false) })
    return () => { cancel = true }
  }, [runId])
  if (!runs.length) {
    return (
      <div className="flex h-full flex-col gap-3 p-3">
        {devinId && <ParentCard devinId={devinId} onOpen={onOpenSession} />}
        <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
          <Bot size={18} className="text-muted-foreground" />
          <p className="text-[13px] leading-[18px] font-medium">{t('ag.none')}</p>
          <p className="text-[12px] leading-[16px] text-muted-foreground">{t('ag.noneDesc')}</p>
        </div>
      </div>
    )
  }
  const run = detail?.run
  const contents = detail?.contents
  const events = (runId && agentEvents.get(runId)) || undefined
  const agents = (detail?.agent_results || []).map((a) => {
    const ev = events?.get(a.result_id)
    if (!ev) return a
    return {
      ...a,
      status: ev.status,
      metadata: { ...a.metadata, phase: ev.phase ?? a.metadata?.phase, label: ev.label ?? a.metadata?.label },
    }
  })
  const title = run?.metadata?.title ?? run?.metadata?.workflow_name ?? runs.find((r) => r.runId === runId)?.name
  const failed = run?.status === 'failed'
  const settled = agents.filter((a) => a.status !== 'running' && a.status !== 'queued').length
  const byPhase = new Map<string, typeof agents>()
  for (const a of agents) {
    const p = a.metadata?.phase || ''
    const arr = byPhase.get(p)
    if (arr) arr.push(a)
    else byPhase.set(p, [a])
  }
  const phases = contents?.phases?.length
    ? contents.phases.map((p) => p.title || '')
    : [...byPhase.keys()]
  const totalSlots = contents?.phases?.length
    ? contents.phases.reduce((n, p) => n + (p.count ?? p.labels?.length ?? 0), 0) || agents.length
    : agents.length
  const completed = agents.filter((a) => a.status === 'completed' || a.status === 'replayed').length
  const failedCount = agents.filter((a) => a.status === 'failed').length
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-3">
      {devinId && <ParentCard devinId={devinId} onOpen={onOpenSession} />}
      {runs.length > 1 && (
        <Combo value={runId ?? ''} onPick={onSelect} options={runs.map((r) => ({ v: r.runId, l: r.name || r.runId }))} />
      )}
      {loading && !detail && <p className="text-[13px] text-muted-foreground">{t('common.loading')}</p>}
      {err && <p className="text-[12px] text-red-600">{t('ag.readFail')}{err}</p>}
      {(detail || title) && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-3">
            <h1 className="min-w-0 truncate text-lg font-semibold">
              {title ? t('ag.wfTitle', { title }) : t('ag.wfRun')}
            </h1>
            <div className="ml-auto flex items-center gap-1">
              {failed && <span className="shrink-0 rounded-md bg-red-500/10 px-1.5 py-0.5 text-[12px] font-medium text-red-600">{t('ag.failed')}</span>}
              <a
                href="https://docs.devin.ai/work-with-devin/dynamic-workflows"
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t('ag.wfDoc')}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-[6px] bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <BookOpen size={16} />
              </a>
            </div>
          </div>
          {run?.created_at && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] leading-[16px] text-muted-foreground/70">
              <span>{t('ag.started', { date: new Date(run.created_at).toLocaleDateString(dateLoc(), { year: 'numeric', month: 'short', day: 'numeric' }) })}</span>
            </div>
          )}
        </div>
      )}
      {(detail || title) && <hr className="border-border" />}
      {agents.length > 0 && (
        <div className="flex flex-col gap-2 rounded-xl border border-border bg-card px-3.5 py-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 tabular-nums">
            <span className="text-[15px] font-semibold leading-[20px]">{settled} / {totalSlots} settled</span>
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] leading-[16px] text-muted-foreground">
              {completed > 0 && <span className="text-green-600">{completed} completed</span>}
              {failedCount > 0 && <span className="text-red-600">{failedCount} failed</span>}
            </span>
          </div>
          <div
            role="progressbar"
            aria-label={t('ag.runProg')}
            aria-valuemin={0}
            aria-valuemax={totalSlots}
            aria-valuenow={settled}
            aria-valuetext={t('ag.agentsSettled', { settled, total: totalSlots })}
            className="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-muted"
          >
            {completed > 0 && <div className="bg-green-600" style={{ width: `${(completed / totalSlots) * 100}%` }} />}
            {failedCount > 0 && <div className="bg-red-600" style={{ width: `${(failedCount / totalSlots) * 100}%` }} />}
          </div>
        </div>
      )}
      {contents?.description && (
        <div className="flex flex-col gap-1">
          <h2 className="text-[15px] font-medium leading-[20px]">{t('ag.overview')}</h2>
          <p className="text-[13px] leading-[18px] text-muted-foreground">{contents.description}</p>
        </div>
      )}
      {contents?.script && (
        <details className="flex flex-col overflow-hidden rounded-xl border border-border">
          <summary className="flex w-full cursor-pointer items-center gap-2 bg-card p-3 text-[13px] leading-[18px]">
            <Code2 size={13} className="text-muted-foreground" />
            <span className="text-[13px] font-medium">{t('ag.script')}</span>
            <button
              onClick={(e) => {
                e.preventDefault()
                void navigator.clipboard.writeText(contents.script || '').then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                })
              }}
              className="ml-auto flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {copied ? <Check size={11} /> : <Copy size={11} />} Copy script
            </button>
          </summary>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words border-t border-border px-2.5 py-1.5 font-mono text-[11px] leading-relaxed">{contents.script}</pre>
        </details>
      )}
      {detail && agents.length === 0 && (
        <div className="flex flex-col items-center rounded-xl border border-border px-3 py-6 text-center">
          <p className="text-[13px] leading-[18px] font-medium">{t('ag.noResults')}</p>
          <p className="text-[12px] leading-[16px] text-muted-foreground">{t('ag.noneDesc')}</p>
        </div>
      )}
      {agents.length > 0 && (
        <div className="mt-2 flex flex-col gap-4">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-[15px] font-medium leading-[20px]">{t('ag.phases')}</h2>
          </div>
          <div className="flex flex-col gap-4">
            {phases.map((phase) => {
              const list = byPhase.get(phase) || []
              const meta = contents?.phases?.find((p) => (p.title || '') === phase)
              const phaseSlots = meta ? (meta.count ?? meta.labels?.length ?? list.length) : list.length
              const pendingLabels = (meta?.labels || []).filter((l) => !list.some((a) => a.metadata?.label === l))
              const done = list.filter((a) => a.status !== 'running' && a.status !== 'queued').length
              return (
                <section key={phase || '(none)'} className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
                  <div className="flex min-h-[2.625rem] flex-col gap-0 border-b border-border px-3.5 py-3">
                    <span className="flex min-w-0 items-center gap-1">
                      <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
                      <span className="min-w-0 truncate text-[13px] font-medium leading-[18px]">{phase || 'Agents'}</span>
                      <span className="flex flex-shrink-0 items-center gap-2 text-[13px] tabular-nums text-muted-foreground">
                        <span>{done}/{Math.max(phaseSlots, list.length)}</span>
                      </span>
                    </span>
                    {meta?.detail && <span className="max-w-2xl pl-5 text-[13px] leading-[18px] text-muted-foreground">{meta.detail}</span>}
                  </div>
                  <div className="flex flex-col">
                    {list.map((a) => {
                      const st = AGENT_STATUS[a.status] || { label: a.status, cls: 'bg-muted text-muted-foreground' }
                      const dur = fmtAgentDur(a.started_at, a.updated_at)
                      return (
                        <details key={a.result_id} className="group/agent">
                          <summary className="relative flex min-h-[3.75rem] cursor-pointer items-center gap-1 pr-1.5 hover:bg-accent">
                            <span className="flex min-w-0 flex-1 items-center gap-2 py-2 pl-2 pr-2.5">
                              <AgentStatusIcon status={a.status} />
                              <span className="flex min-w-0 flex-col gap-0.5 text-left">
                                <span className="flex min-w-0 items-center gap-1.5">
                                  <span className="truncate text-[13px] leading-[18px]">{a.metadata?.label || a.result_id}</span>
                                  {a.metadata?.mode && (
                                    <span className="flex-shrink-0 rounded bg-muted px-1 text-[11px] leading-[16px] text-muted-foreground">
                                      {a.metadata.mode.charAt(0).toUpperCase() + a.metadata.mode.slice(1)}
                                    </span>
                                  )}
                                  {a.metadata?.vm_mode === 'shared' && (
                                    <span
                                      className="flex-shrink-0 rounded bg-muted px-1 text-[11px] leading-[16px] text-muted-foreground"
                                      title={t('ag.sharedVmTip')}
                                    >
                                      Shared VM
                                    </span>
                                  )}
                                  {a.status !== 'completed' && a.status !== 'replayed' && (
                                    <span className={cn('flex-shrink-0 rounded px-1 text-[11px] leading-[16px] font-medium', st.cls)}>{st.label}</span>
                                  )}
                                </span>
                                <span className="flex min-w-0 items-center gap-1.5 text-[12px] leading-[16px]">
                                  <span className="truncate text-muted-foreground">{dur}</span>
                                </span>
                              </span>
                            </span>
                            {a.session_id && (
                              <a
                                href={sessionMirrorPath(a.session_id)}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="relative z-10 inline-flex h-[24px] flex-shrink-0 select-none items-center justify-center gap-[3px] overflow-hidden whitespace-nowrap rounded-[6px] border border-border bg-card px-[8px] text-[12px] font-medium hover:bg-accent"
                              >
                                <span className="truncate">{t('ag.viewSession')}</span>
                              </a>
                            )}
                            <span className="flex-shrink-0 text-muted-foreground/60">
                              <ChevronsUpDown size={14} />
                            </span>
                          </summary>
                          <div className="px-2 pb-2">
                            {a.error && <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-red-500/5 px-2 py-1.5 text-[11px] leading-relaxed text-red-600">{a.error}</pre>}
                            {a.output && (
                              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted px-2 py-1.5 font-mono text-[11px] leading-relaxed">{a.output}</pre>
                            )}
                            {!a.output && !a.error && <p className="px-1 text-[12px] text-muted-foreground">{t('ag.noOutput')}</p>}
                          </div>
                        </details>
                      )
                    })}
                    {pendingLabels.slice(0, Math.max(0, phaseSlots - list.length)).map((l) => (
                      <div key={`slot-${l}`} className="flex items-center gap-2 py-2.5 pl-2 pr-2.5 hover:bg-accent">
                        <CircleDashed size={14} className="shrink-0 text-muted-foreground/60" />
                        <span className="min-w-0 truncate text-[13px] leading-[18px] text-muted-foreground/60">{l}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}


export { type WfRunDetail, AGENT_STATUS, type WfAgentEventState, AgentStatusIcon, fmtAgentDur, type ParentInfo, ParentCard, AgentsPanel };
