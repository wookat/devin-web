import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { Combo } from '@/components/ui'
import { adminFetch } from '@/lib/api'
import DoctorDialog from '@/components/DoctorDialog'
import { Btn2, Row, Section } from './atoms'

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

/** Diagnostics tab — doctor entry + module-health flow + send-path preflight. */
export function DiagTab() {
  const { t } = useTranslation()
  const [doctor, setDoctor] = useState(false)
  return (
    <>
      <Section title={t('set.diag')}>
        <Row title={t('doc.entry')} desc={t('doc.rowDesc')}>
          <Btn2 onClick={() => setDoctor(true)}>{t('doc.runBtn')}</Btn2>
        </Row>
        <ModulesPanel />
        <SendCheck />
      </Section>
      {doctor && <DoctorDialog onClose={() => setDoctor(false)} />}
    </>
  )
}
