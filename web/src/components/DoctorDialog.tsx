import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { adminFetch } from '@/lib/api'
import { cn } from '@/lib/utils'
import { OCheck, OX } from './officialIcons'

interface Check { id: string; label: string; ok: boolean; detail: string; group?: 'service' | 'session'; fix?: string }

/** "链路体检" — GET /api/admin/diagnose lists every hop (supervisor → drain →
 * inflight → acp pool → orphan lock-holders → session locks → pending replays →
 * disk → public domain). "一键修复" POSTs /api/admin/repair {fixes:'all'}. */
export default function DoctorDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [checks, setChecks] = useState<Check[] | null>(null)
  const [err, setErr] = useState('')
  const [fixing, setFixing] = useState<string | 'all' | null>(null)
  const [results, setResults] = useState<Record<string, string>>({})

  const run = useCallback(async () => {
    try {
      const j = await adminFetch<{ checks?: Check[] }>('/api/admin/diagnose')
      setChecks(j.checks ?? [])
      setErr('')
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }, [])

  useEffect(() => { run() }, [run])

  const repair = async (fixes: string[] | 'all') => {
    setFixing(fixes === 'all' ? 'all' : fixes[0])
    try {
      const j = await adminFetch<{ results?: Record<string, string> }>('/api/admin/repair', {
        method: 'POST', body: JSON.stringify({ fixes }),
      })
      setResults(j.results ?? {})
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    setFixing(null)
    setTimeout(run, 1200) // re-probe after fixes land
  }

  const fixable = checks?.filter(c => c.fix) ?? []
  const bad = checks?.filter(c => !c.ok).length ?? 0

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="w-[min(560px,92vw)] rounded-xl border border-border-secondary bg-bg-elevated p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-foreground">{t('doc.title')}</h2>
          <button onClick={onClose} className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-tint-secondary" aria-label={t('doc.close')}><OX size={14} /></button>
        </div>

        {err && <div className="mb-3 rounded-md border border-border-secondary bg-red-500/10 px-3 py-2 text-[12px] text-text-red">{err}</div>}

        {!checks ? (
          <div className="py-8 text-center text-[13px] text-muted-foreground">{t('doc.running')}</div>
        ) : (
          <>
            <ul className="max-h-[46vh] space-y-1 overflow-y-auto">
              {(['service', 'session'] as const).map(g => {
                const grp = checks.filter(c => c.group === g || (!c.group && g === 'service'))
                if (!grp.length) return null
                return (
                  <li key={g} className="pt-1 first:pt-0">
                    <div className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t(g === 'service' ? 'doc.gService' : 'doc.gSession')}</div>
                    <ul className="space-y-1">{grp.map(c => <CheckRow key={c.id} c={c} fixing={fixing} result={results[c.fix ?? '']} onFix={() => repair([c.fix!])} />)}</ul>
                  </li>
                )
              })}
            </ul>
            <div className="mt-4 flex items-center gap-2">
              <span className={cn('text-[12px]', bad ? 'text-text-orange' : 'text-text-green')}>
                {bad ? t('doc.failing', { n: bad }) : t('doc.allOk')}
              </span>
              <div className="ml-auto flex gap-2">
                <button onClick={run} className="rounded-md border border-border bg-card px-3 py-1.5 text-[13px] font-medium hover:bg-tint-secondary">{t('doc.recheck')}</button>
                <button
                  disabled={!fixable.length || fixing !== null}
                  onClick={() => repair('all')}
                  className="rounded-md bg-accent-primary px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40"
                >{fixing === 'all' ? t('doc.fixing') : t('doc.fixAll')}</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}

function CheckRow({ c, fixing, result, onFix }: { c: Check; fixing: string | 'all' | null; result?: string; onFix: () => void }) {
  const { t } = useTranslation()
  return (
    <li className="flex items-center gap-2.5 rounded-lg border border-border-secondary px-3 py-2">
      <span className={cn('flex size-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white', c.ok ? 'bg-green-600' : 'bg-red-500')}>
        {c.ok ? <OCheck size={11} /> : '!'}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-foreground">{c.label}</div>
        <div className="truncate text-[11px] text-muted-foreground" title={c.detail}>{c.detail}</div>
        {result && <div className="mt-0.5 text-[11px] text-text-blue">→ {result}</div>}
      </div>
      {c.fix && (
        <button
          disabled={fixing !== null}
          onClick={onFix}
          className="shrink-0 rounded-md border border-border bg-card px-2 py-1 text-[12px] font-medium text-foreground hover:bg-tint-secondary disabled:opacity-40"
        >{fixing === c.fix ? '…' : t('doc.fix')}</button>
      )}
    </li>
  )
}
