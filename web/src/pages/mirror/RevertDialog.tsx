import { useTranslation } from 'react-i18next'
import { History, GitBranch, Loader2 } from 'lucide-react'
import { Dialog } from '@/components/ui'

/** ACP `revert/preview` result — all three arrays empty means the official
 *  client executes without ever opening this dialog. */
export type RevertPreview = {
  fileActions?: { path?: string; action?: string }[] | unknown[]
  irreversibleWarnings?: (string | { message?: string })[]
  conflicts?: (string | { message?: string; path?: string })[]
}

const text = (x: unknown): string =>
  typeof x === 'string' ? x : String((x as { message?: string; path?: string })?.message ?? (x as { path?: string })?.path ?? JSON.stringify(x))

export function RevertDialog({ userMessageId, preview, busy, onExecute, onFork, onClose }: {
  userMessageId: string
  preview: RevertPreview | null
  busy: boolean
  onExecute: () => void
  onFork: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const files = preview?.fileActions?.length ?? 0
  const warnings = preview?.irreversibleWarnings ?? []
  const conflicts = preview?.conflicts ?? []
  const btn = 'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[8px] px-3 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50'
  return (
    <Dialog open onClose={busy ? () => {} : onClose} title={t('rv.title')}>
      <div className="flex flex-col gap-3 text-[13px] leading-[19px] text-foreground">
        <p className="text-muted-foreground">{t('rv.desc')}</p>
        {files > 0 && (
          <p><span className="font-medium">{files}</span> {t('rv.fileActions')}</p>
        )}
        {warnings.length > 0 && (
          <div className="rounded-[8px] border border-amber-500/40 bg-amber-500/10 px-3 py-2">
            <p className="mb-1 font-medium text-amber-600 dark:text-amber-400">{t('rv.warnings')}</p>
            <ul className="list-disc pl-4 text-muted-foreground">
              {warnings.map((w, i) => <li key={i}>{text(w)}</li>)}
            </ul>
          </div>
        )}
        {conflicts.length > 0 && (
          <div className="rounded-[8px] border border-red-500/40 bg-red-500/10 px-3 py-2">
            <p className="mb-1 font-medium text-red-600 dark:text-red-400">{t('rv.conflicts')}</p>
            <ul className="list-disc pl-4 text-muted-foreground">
              {conflicts.map((c, i) => <li key={i}>{text(c)}</li>)}
            </ul>
          </div>
        )}
        <div className="mt-1 flex items-center justify-end gap-2">
          <button className={`${btn} text-muted-foreground hover:bg-accent`} onClick={onClose} disabled={busy}>
            {t('rv.cancel')}
          </button>
          <button className={`${btn} border border-border hover:bg-accent`} onClick={onFork} disabled={busy}>
            <GitBranch size={14} /> {t('rv.fork')}
          </button>
          <button
            className={`${btn} bg-primary text-primary-foreground hover:bg-primary/90`}
            onClick={onExecute}
            disabled={busy}
            data-umsg={userMessageId}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <History size={14} />}
            {busy ? t('rv.busy') : t('rv.execute')}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
