import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { MoreHorizontal, ExternalLink, Copy, Archive, ArchiveRestore } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CountCell, EmptyPanel, ScanListSkeleton, StatusDot, rel } from './atoms'
import type { Scan } from './atoms'

/* ---------- scans tab — official group sections, not a card table ---------- */

function ScanRowMenu({ scan, archived, onArchive }: {
  scan: Scan; archived: boolean; onArchive: (s: Scan, unarchive: boolean) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  return (
    <div className="relative z-10" ref={ref}>
      <button
        aria-label={t('sec.scanActions')}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((o) => !o) }}
        className="flex size-7 items-center justify-center rounded-[6px] text-muted-foreground opacity-0 hover:bg-background hover:text-foreground group-hover/row:opacity-100"
      >
        <MoreHorizontal size={15} />
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-30 w-48 rounded-[8px] border border-border-secondary bg-background p-1 shadow-lg" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => { setOpen(false); void navigator.clipboard.writeText(`${location.origin}/admin/security/${scan.id}`).catch(() => {}) }}
            className="flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-left text-[13px] hover:bg-tint-secondary">
            <Copy size={13} />{t('sec.copyScanLink')}
          </button>
          {scan.session_id && (
            <Link to={`/admin/${scan.session_id}`} className="flex items-center gap-2 rounded-[5px] px-2 py-1.5 text-[13px] hover:bg-tint-secondary">
              <ExternalLink size={13} />{t('sec.viewSession')}
            </Link>
          )}
          {archived ? (
            <button onClick={() => { setOpen(false); onArchive(scan, true) }} className="flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-left text-[13px] hover:bg-tint-secondary">
              <ArchiveRestore size={13} />{t('sec.unarchive')}
            </button>
          ) : (
            <button onClick={() => { setOpen(false); onArchive(scan, false) }} className="flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-left text-[13px] hover:bg-tint-secondary">
              <Archive size={13} />{t('sec.archive')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function ScanRow({ scan, profileName, archived, onOpen, onArchive }: {
  scan: Scan; profileName: string | null; archived: boolean
  onOpen: (s: Scan) => void; onArchive: (s: Scan, unarchive: boolean) => void
}) {
  const { t } = useTranslation()
  const sc = scan.severity_counts ?? {}
  const last =
    scan.status === 'done' || scan.status === 'failed' || scan.status === 'cancelled'
      ? rel(scan.finished_at ?? scan.created_at)
      : scan.status === 'pending' || scan.status === 'running'
        ? t('sec.scanning')
        : rel(scan.created_at)
  return (
    <div
      className="group/row relative flex cursor-pointer items-center gap-6 rounded-md py-2 pl-3.5 pr-2.5 hover:bg-tint-secondary"
      onClick={() => onOpen(scan)}
      role="link" aria-label={scan.repo_name} tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(scan) }}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <StatusDot s={scan.status} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5 text-13 leading-[18px] text-text-primary">
            <span className="truncate">{scan.repo_name}</span>
            <span className="relative z-10 flex" title={t(`sec.effortTip.${scan.effort}`)}>
              <span className={cn('flex gap-[3px]', scan.effort === 'standard' ? 'text-text-secondary' : 'text-text-disabled')}>
                <span className="size-1 rounded-full bg-current" /><span className="size-1 rounded-full bg-current" /><span className={cn('size-1 rounded-full', scan.effort === 'standard' ? 'bg-current' : 'bg-border-secondary')} />
              </span>
            </span>
          </span>
          <span className="flex min-w-0 items-center gap-1 text-12 leading-4 text-text-secondary">
            {profileName ?? t('sec.noProfile')}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="hidden items-center gap-2 text-13 leading-[18px] sm:flex">
          <span className="w-16 shrink-0 truncate text-right text-text-secondary">{t('sec.typeSecurity')}</span>
          <CountCell value={scan.finding_count ?? 0} colorClass="text-text-secondary" />
          <CountCell value={sc.critical ?? 0} colorClass="text-red-500" />
          <CountCell value={sc.high ?? 0} colorClass="text-orange" />
          <CountCell value={sc.medium ?? 0} colorClass="text-text-secondary" />
        </div>
        <div className="flex w-[88px] shrink-0 items-center justify-end gap-1 whitespace-nowrap text-right text-13 leading-[18px]">
          <span className="min-w-0 flex-1 truncate text-text-secondary">{last}</span>
          <ScanRowMenu scan={scan} archived={archived} onArchive={onArchive} />
        </div>
      </div>
    </div>
  )
}

const COLLAPSE_AT = 5
function ScanGroup({ label, items, profiles, archived, onOpen, onArchive }: {
  label: string; items: Scan[]; profiles: Map<string, string>; archived: boolean
  onOpen: (s: Scan) => void; onArchive: (s: Scan, unarchive: boolean) => void
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  if (items.length === 0) return null
  const shown = !expanded && items.length > COLLAPSE_AT ? items.slice(0, COLLAPSE_AT) : items
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 pl-3.5 pr-2.5 text-12 font-medium leading-4 text-text-secondary">
        <span className="truncate">{label}</span>
        <div className="flex items-center gap-2">
          <div className="hidden items-center gap-2 sm:flex">
            <span className="w-16 text-right">{t('sec.type')}</span>
            <span className="w-12 text-right">{t('sec.total')}</span>
            <span className="w-12 text-right">{t('sec.critical')}</span>
            <span className="w-12 text-right">{t('sec.high')}</span>
            <span className="w-12 text-right">{t('sec.med')}</span>
          </div>
          <span className="w-[88px] text-right">{t('sec.lastScan')}</span>
        </div>
      </div>
      <div className="flex flex-col gap-0.5">
        {shown.map((s) => (
          <ScanRow key={s.id} scan={s} profileName={s.profile_id ? profiles.get(s.profile_id) ?? null : null} archived={archived} onOpen={onOpen} onArchive={onArchive} />
        ))}
      </div>
      {!expanded && items.length > COLLAPSE_AT && (
        <button type="button" onClick={() => setExpanded(true)}
          className="px-3 py-1 text-left text-12 font-medium leading-4 text-text-secondary hover:text-text-primary">
          {t('sec.showMore')}
        </button>
      )}
    </div>
  )
}

export function ScansTab({ scans, loading, error, searching, archived, profiles, onOpen, onArchive }: {
  scans: Scan[]; loading: boolean; error: boolean; searching: boolean; archived: boolean
  profiles: Map<string, string>
  onOpen: (s: Scan) => void; onArchive: (s: Scan, unarchive: boolean) => void
}) {
  const { t } = useTranslation()
  if (loading) return <ScanListSkeleton />
  if (error) return <EmptyPanel title={t('sec.failedToLoad')} hint={t('sec.tryRefreshing')} />
  if (scans.length === 0) {
    return <EmptyPanel
      title={searching ? t('sec.noMatchingScans') : t('sec.noScansYet')}
      hint={searching ? t('sec.tryDifferentSearch') : t('sec.startScanDescription')}
    />
  }
  return (
    <div className="flex flex-col gap-6">
      <ScanGroup label={t('sec.createdByYou')} items={scans} profiles={profiles} archived={archived} onOpen={onOpen} onArchive={onArchive} />
    </div>
  )
}
