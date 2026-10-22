import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { ArrowLeft, Check, CircleSlash, ExternalLink, Info, Loader2, Wrench } from 'lucide-react'
import { cn } from '@/lib/utils'
import { EmptyPanel, SEVS, StatusDot, rel } from './atoms'
import type { Finding, Scan, Sev } from './atoms'

/* ---------- scan detail — official master-detail ---------- */

const sevRank: Record<Sev, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
const sevColor: Record<Sev, string> = {
  critical: 'text-red-500',
  high: 'text-orange',
  medium: 'text-text-secondary',
  low: 'text-text-secondary',
  info: 'text-text-secondary',
}

function FindingDetailPane({ f, scanId, onPatch, onFix }: {
  f: Finding; scanId: string
  onPatch: (f: Finding, p: Partial<Finding>) => void
  onFix: (f: Finding) => void
}) {
  const { t } = useTranslation()
  const busy = false
  return (
    <div className="flex flex-col gap-4 px-4 py-1">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className={cn('text-12 font-medium capitalize', sevColor[f.severity])}>{t(`sec.sev.${f.severity}`)}</span>
          {f.cwe_id && <span className="rounded-[5px] bg-tint-secondary px-1.5 py-0.5 text-[11px] text-text-secondary">{f.cwe_id}</span>}
        </div>
        <h3 className="text-[15px] font-medium leading-5">{f.title}</h3>
        {f.file_path && (
          <div className="font-mono text-[12px] text-text-secondary">{f.file_path}{f.start_line != null ? `:${f.start_line}` : ''}</div>
        )}
      </div>
      <p className="whitespace-pre-wrap text-[13px] leading-[19px] text-text-secondary">{f.description}</p>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          onClick={() => onFix(f)} disabled={busy}
          className="flex h-8 items-center gap-1.5 rounded-[7px] bg-accent-primary px-3 text-[13px] font-medium text-white hover:opacity-90">
          <Wrench size={13} />{t('sec.fixWithDevin')}
        </button>
        {f.status !== 'resolved' && (
          <button onClick={() => onPatch(f, { status: 'resolved' })}
            className="flex h-8 items-center gap-1.5 rounded-[7px] border border-border-secondary px-3 text-[13px] hover:bg-tint-secondary">
            <Check size={13} />{t('sec.markResolved')}
          </button>
        )}
        {f.status !== 'dismissed' && f.status !== 'resolved' && (
          <button onClick={() => onPatch(f, { status: 'dismissed' })}
            className="flex h-8 items-center gap-1.5 rounded-[7px] border border-border-secondary px-3 text-[13px] text-muted-foreground hover:bg-tint-secondary">
            <CircleSlash size={13} />{t('sec.dismiss')}
          </button>
        )}
        {(f.status === 'resolved' || f.status === 'dismissed') && (
          <button onClick={() => onPatch(f, { status: 'open' })}
            className="flex h-8 items-center gap-1.5 rounded-[7px] border border-border-secondary px-3 text-[13px] text-muted-foreground hover:bg-tint-secondary">
            {t('sec.reopen')}
          </button>
        )}
      </div>
    </div>
  )
}

export function ScanDetail({ scan, profiles, onBack, onPatch, onFix }: {
  scan: Scan; profiles: Map<string, string>
  onBack: () => void
  onPatch: (f: Finding, p: Partial<Finding>) => void
  onFix: (f: Finding) => void
}) {
  const { t } = useTranslation()
  const [statusTab, setStatusTab] = useState<'open' | 'resolved' | 'dismissed'>('open')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const findings = scan.findings ?? []
  const counts = useMemo(() => ({
    open: findings.filter((f) => f.status === 'open').length,
    resolved: findings.filter((f) => f.status === 'resolved').length,
    dismissed: findings.filter((f) => f.status === 'dismissed' || f.status === 'ignored' || f.status === 'false_positive').length,
  }), [findings])
  const filtered = useMemo(() => {
    const list = findings.filter((f) =>
      statusTab === 'open' ? f.status === 'open' :
      statusTab === 'resolved' ? f.status === 'resolved' :
      f.status !== 'open' && f.status !== 'resolved')
    return [...list].sort((a, b) => sevRank[a.severity] - sevRank[b.severity])
  }, [findings, statusTab])
  const groups = useMemo(() => {
    const m = new Map<Sev, Finding[]>()
    for (const f of filtered) { const a = m.get(f.severity) ?? []; a.push(f); m.set(f.severity, a) }
    return SEVS.filter((s) => m.has(s)).map((s) => ({ sev: s, items: m.get(s)! }))
  }, [filtered])
  const selected = findings.find((f) => f.finding_id === selectedId)
    ?? filtered[0] ?? null

  useEffect(() => { setSelectedId(null) }, [scan.id])

  const running = scan.status === 'running' || scan.status === 'pending'
  return (
    <div className="flex w-full flex-1 flex-col overflow-hidden">
      {/* header — official crumb + title + scan actions */}
      <div className="flex items-center gap-2 px-3 pb-1 pt-2">
        <button onClick={onBack} className="flex size-7 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground" aria-label={t('sec.back')}>
          <ArrowLeft size={15} />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <StatusDot s={scan.status} />
          <h3 className="truncate text-[15px] font-medium">{scan.repo_name}</h3>
          <span className="truncate text-[12px] text-text-secondary">
            {scan.profile_id && profiles.get(scan.profile_id) ? profiles.get(scan.profile_id) : t('sec.noProfile')}
            {' · '}{rel(scan.created_at)}
          </span>
        </div>
        {scan.session_id && (
          <Link to={`/admin/${scan.session_id}`} className="flex h-7 items-center gap-1 rounded-[6px] border border-border-secondary px-2 text-[12px] text-text-secondary hover:bg-tint-secondary">
            <ExternalLink size={12} />{t('sec.viewSession')}
          </Link>
        )}
      </div>
      {scan.summary && scan.status === 'done' && (
        <div className="mx-3 mb-2 rounded-[10px] border border-border-secondary bg-bg-elevated px-3 py-2 text-[12px] leading-[17px] text-text-secondary">{scan.summary}</div>
      )}
      {scan.status === 'failed' && (
        <div className="mx-3 mb-2 flex items-center gap-2 rounded-[10px] border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-500">
          <Info size={13} />{t('sec.scanFailedHint')}
        </div>
      )}
      {running ? (
        <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-muted-foreground">
          <Loader2 size={15} className="animate-spin" />{t('sec.scanning')}
        </div>
      ) : findings.length === 0 ? (
        <EmptyPanel title={t('sec.noFindings')} hint={t('sec.noFindingsHint')} />
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* findings list */}
          <div className={cn('flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-2.5', selected ? 'lg:max-w-[50%]' : '')}>
            {/* status tabs — official open/resolved/dismissed w/ counts */}
            <div className="mb-2 flex items-center gap-2">
              <div className="flex rounded-[7px] border border-border-secondary p-0.5">
                {(['open', 'resolved', 'dismissed'] as const).map((k) => (
                  <button key={k} onClick={() => setStatusTab(k)} aria-pressed={statusTab === k}
                    className={cn('flex items-center gap-1.5 rounded-[5px] px-2.5 py-1 text-[13px]', statusTab === k ? 'bg-tint-secondary font-medium' : 'text-muted-foreground hover:text-foreground')}>
                    {t(`sec.ft.${k}`)}<span className="rounded-[4px] bg-tint-secondary px-1 text-[11px] text-muted-foreground">{counts[k]}</span>
                  </button>
                ))}
              </div>
            </div>
            {filtered.length === 0 ? (
              <div className="py-10 text-center text-[13px] text-muted-foreground">{t(`sec.noStatusFindings.${statusTab}`)}</div>
            ) : (
              <div className="flex flex-col gap-3">
                {groups.map((g) => (
                  <div key={g.sev} className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-2 pl-3.5 pr-2.5 text-12 font-medium leading-4 text-text-secondary">
                      <span className={sevColor[g.sev]}>{t(`sec.sev.${g.sev}`)}</span>
                      <span className="tabular-nums">{g.items.length}</span>
                    </div>
                    {g.items.map((f) => (
                      <button key={f.finding_id} onClick={() => setSelectedId(f.finding_id)}
                        className={cn('flex w-full items-center gap-3 rounded-md py-2 pl-3.5 pr-2.5 text-left hover:bg-tint-secondary', selected?.finding_id === f.finding_id && 'bg-tint-secondary')}>
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="truncate text-13 leading-[18px] text-text-primary">{f.title}</span>
                          <span className="flex min-w-0 items-center gap-1 truncate font-mono text-[11px] leading-4 text-text-secondary">
                            {f.file_path ?? t('sec.noFile')}{f.start_line != null ? `:${f.start_line}` : ''}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
          {/* detail pane — official right-hand split */}
          {selected && (
            <div className="hidden min-h-0 w-1/2 flex-col overflow-y-auto border-l border-border-secondary py-2.5 lg:flex">
              <FindingDetailPane f={selected} scanId={scan.id} onPatch={onPatch} onFix={onFix} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
