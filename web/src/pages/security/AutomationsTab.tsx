import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { EmptyPanel, ScanListSkeleton, rel } from './atoms'
import type { Automation } from './atoms'

/* ---------- automations tab ---------- */

export function AutomationsTab({ automations, loading, searching }: { automations: Automation[]; loading: boolean; searching: boolean }) {
  const { t } = useTranslation()
  if (loading) return <ScanListSkeleton />
  if (automations.length === 0) {
    return <EmptyPanel title={searching ? t('sec.noMatchingAutomations') : t('sec.noAutomationsYet')} hint={searching ? t('sec.tryDifferentSearch') : t('sec.findingAutomationsDescription')} />
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-end gap-5 px-3 text-12 font-medium leading-4 text-text-secondary">
        <span className="w-[91px] text-right">{t('sec.last30Days')}</span>
        <span className="w-[70px] text-right">{t('sec.created')}</span>
      </div>
      <div className="flex flex-col gap-0.5">
        {automations.map((a) => (
          <Link key={a.id} to="/admin/automations" className="group/row flex items-center gap-6 rounded-md py-2 pl-3.5 pr-2.5 hover:bg-tint-secondary">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-13 leading-[18px] text-text-primary">{a.name}</span>
                {!a.enabled && <span className="rounded-[5px] bg-tint-secondary px-1.5 py-0.5 text-[11px] text-muted-foreground">{t('sec.disabled')}</span>}
              </span>
              <span className="truncate text-12 leading-4 text-text-secondary">{a.schedule}</span>
            </div>
            <span className="w-[91px] shrink-0 text-right text-13 leading-[18px] text-text-secondary tabular-nums">{a.lastRun ? rel(a.lastRun) : '—'}</span>
            <span className="w-[70px] shrink-0 text-right text-13 leading-[18px] text-text-secondary">{a.created_at ? rel(a.created_at) : '—'}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}
