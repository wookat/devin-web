import { useState, type ReactNode } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { ArrowUpRight, ChevronDown, ChevronRight, CircleCheck, Lightbulb, Loader2 } from 'lucide-react'
import type { TimelineItem } from '@/components/Timeline'
import { cn } from '@/lib/utils'

export type EnvApproveState = 'idle' | 'sending' | 'done' | 'error'

/**
 * Official `environment_config_suggestion` card (transcript renderer `sh`):
 * header wording per resolution, Outdated badge + collapsed body when a newer
 * suggestion supersedes this one, footer variants for accepted / error /
 * saving / superseded / pending. `onApprove` absent ⇒ read-only (visitor).
 */
export default function EnvSuggestionCard({ item, supersededBy, onApprove, approveState = 'idle', settingsBase }: {
  item: TimelineItem
  /** Overrides the server value when the caller can see more of the timeline. */
  supersededBy?: string
  onApprove?: () => void
  approveState?: EnvApproveState
  /** Origin for "View in settings" / "View build" (admin only). */
  settingsBase?: string
}) {
  const { t } = useTranslation()
  const es = item.envSuggestion
  const [open, setOpen] = useState(false)
  const [yamlOpen, setYamlOpen] = useState(false)

  const res = es?.resolution
  const accepted = res?.state === 'accepted' || approveState === 'done'
  const err = res?.state === 'error' ? res : undefined
  const saving = approveState === 'sending'
  const superseded = supersededBy ?? es?.supersededBy
  const outdated = !!superseded && !accepted && !saving
  const collapsed = outdated && !open
  const git = es?.sink === 'git'
  const enterprise = es?.repo === '__enterprise__'
  const org = !enterprise && es?.target === 'org'
  const repoShort = es?.repo?.split('/').pop() ?? es?.blueprintId ?? ''
  const scope = es?.repo && !org && !enterprise ? es.scope ?? '' : ''
  const name = es?.repo
    ? enterprise ? 'Enterprise' : org ? 'Organization' : scope ? `${repoShort}/${scope}` : repoShort
    : org ? 'Organization' : es?.scope ?? repoShort
  const prUrl = res?.state === 'accepted' ? res.prUrl : undefined
  const pullNumber = res?.state === 'accepted' ? res.pullNumber : undefined
  const buildUrl = res?.state === 'accepted' && res.buildJobId && settingsBase ? `${settingsBase}/settings/environment/builds/${res.buildJobId}` : undefined
  const settingsUrl = settingsBase
    ? enterprise
      ? `${settingsBase}/settings/enterprise-environment?tab=blueprint`
      : org
      ? `${settingsBase}/settings/environment/blueprints/organization`
      : `${settingsBase}/settings/environment/blueprints/${es?.repo?.split('/').slice(-2).join('/') ?? ''}${es?.scope ? `?scope=${encodeURIComponent(es.scope)}` : ''}`
    : undefined

  const lines = es?.yaml ? es.yaml.replace(/\n$/, '').split('\n') : []
  const shown = yamlOpen ? lines : lines.slice(0, 8)

  const btn = 'inline-flex h-6 items-center gap-1 rounded-md px-2 text-[12px] font-medium disabled:opacity-50'
  const secondary = `${btn} border border-border bg-card text-foreground hover:bg-accent`
  const primary = `${btn} bg-blue-600 text-white hover:bg-blue-500`

  let footer: ReactNode
  if (accepted && prUrl) {
    footer = (
      <Footer text="Changes apply once the PR is merged">
        <a href={prUrl} target="_blank" rel="noopener noreferrer" className={secondary} onClick={(e) => e.stopPropagation()}>
          <CircleCheck size={14} className="text-green-600" />
          {pullNumber ? `View PR #${pullNumber}` : 'View PR'}
        </a>
      </Footer>
    )
  } else if (accepted) {
    footer = (
      <Footer text={settingsUrl ? <a href={settingsUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline" onClick={(e) => e.stopPropagation()}>{t('env.viewInSettings')}</a> : undefined}>
        {buildUrl ? (
          <a href={buildUrl} target="_blank" rel="noopener noreferrer" className={secondary} onClick={(e) => e.stopPropagation()}>
            <CircleCheck size={14} className="text-green-600" />View build
          </a>
        ) : (
          <button type="button" disabled className={secondary}>
            <CircleCheck size={14} className="text-green-600" />Saved to environment
          </button>
        )}
      </Footer>
    )
  } else if (err && !err.retryable) {
    footer = (
      <Footer text={<span className="text-red-500">{err.error}</span>}>
        {settingsUrl ? (
          <a href={settingsUrl} target="_blank" rel="noopener noreferrer" className={secondary} onClick={(e) => e.stopPropagation()}>{t('env.viewSettings')}</a>
        ) : (
          <button type="button" disabled className={secondary}>{t('env.viewSettings')}</button>
        )}
      </Footer>
    )
  } else if (err) {
    footer = (
      <div className="flex items-center justify-between gap-3 py-2.5 pl-2.5 pr-3.5">
        <div className="flex w-full flex-col gap-1.5">
          <span className="text-[12px] text-red-500">{err.error}</span>
          <div className="flex items-center gap-2">
            <button type="button" disabled={!onApprove} onClick={(e) => { e.stopPropagation(); onApprove?.() }} className={cn(secondary, onApprove && 'cursor-pointer')}>{t('common.retry')}</button>
          </div>
        </div>
      </div>
    )
  } else if (saving) {
    footer = (
      <Footer text={git ? 'Creating PR…' : 'Saving…'}>
        <button type="button" disabled className={primary}><Loader2 size={14} className="animate-spin" />{git ? 'Creating PR…' : 'Saving…'}</button>
      </Footer>
    )
  } else if (superseded) {
    footer = (
      <Footer>
        <button
          type="button"
          className={cn(secondary, 'cursor-pointer')}
          onClick={(e) => {
            e.stopPropagation()
            document.querySelector(`[data-eid="${superseded}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
          }}
        >
          View newer suggestion
        </button>
      </Footer>
    )
  } else {
    const can = !!onApprove && (!!es?.contentsKey || git)
    footer = (
      <Footer wrap text={approveState === 'error' ? <span className="text-red-500">{t('env.approveFail')}</span> : git ? t('env.openPrUpdate', { p: es?.filePath ?? '' }) : t('env.saveFaster')}>
        <button type="button" disabled={!can} onClick={(e) => { e.stopPropagation(); if (can) onApprove?.() }} className={cn(primary, can && 'cursor-pointer')}>
          {git ? t('env.createPr') : t('env.approve')}
        </button>
      </Footer>
    )
  }

  return (
    <div data-eid={item.id} className="my-2 w-full overflow-hidden rounded-xl border border-border bg-card">
      <div
        className={cn('flex items-center justify-between gap-2 px-3 pt-2.5', outdated && 'cursor-pointer')}
        onClick={outdated ? () => setOpen(!open) : undefined}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 text-[13px]">
          <Lightbulb size={14} className="shrink-0 text-muted-foreground" />
          <span className="truncate">
            {accepted && prUrl ? (
              <Trans i18nKey="env.prCreatedFor" values={{ name }} components={{ b: <span className="font-medium text-foreground" /> }} />
            ) : accepted ? (
              <><span className="font-medium text-foreground">{name}</span> {org ? t('env.isSetup') : t('env.repoSetup')}</>
            ) : (
              <Trans i18nKey="env.suggestedSetup" values={{ name }} components={{ b: <span className="font-medium text-foreground" /> }} />
            )}
          </span>
          {outdated && (
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              <span className="rounded-full bg-orange-500/15 px-2 py-0.5 text-[11px] font-medium text-orange-600 dark:text-orange-400">{t('env.outdated')}</span>
              <button type="button" aria-expanded={open} aria-label={open ? t('common.collapse') : t('common.expand')} className="flex items-center" onClick={(e) => { e.stopPropagation(); setOpen(!open) }}>
                <ChevronRight size={14} className={cn('text-muted-foreground transition-transform', open && 'rotate-90')} />
              </button>
            </span>
          )}
        </div>
        <a href="https://docs.devin.ai/onboard-devin/environment-yaml" target="_blank" rel="noopener noreferrer" className="inline-flex shrink-0 items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground" onClick={(e) => e.stopPropagation()}>
          Docs <ArrowUpRight size={12} />
        </a>
      </div>
      {!collapsed && (
        <>
          <div className={cn(outdated && 'opacity-50 grayscale')}>
            {es?.summary && <p className="px-3 pb-2.5 pt-2 text-[13px] leading-[18px] text-muted-foreground">{es.summary}</p>}
            <p className="px-3 pb-2.5 text-[12px] text-muted-foreground">
              {org ? 'Applies to this org' : scope ? `Applies to this scope: ${scope}` : 'Applies to this repo'}
            </p>
            {lines.length > 0 && (
              <div className="relative mx-3 mb-2 overflow-hidden rounded-md border border-border">
                <pre className="max-w-full overflow-x-auto bg-green-500/10 py-1.5 text-[12px] leading-[18px]">
                  {shown.map((l, i) => (
                    <div key={i} className="flex">
                      <span className="w-8 shrink-0 select-none pr-2 text-right text-muted-foreground">{i + 1}</span>
                      <span className="whitespace-pre">{l}</span>
                    </div>
                  ))}
                </pre>
                {lines.length > 8 && (
                  <div className="flex justify-center border-t border-border bg-card py-1">
                    <button type="button" aria-expanded={yamlOpen} onClick={(e) => { e.stopPropagation(); setYamlOpen(!yamlOpen) }} className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-[12px] hover:bg-accent">
                      {yamlOpen ? t('common.collapse') : t('common.expand')} <ChevronDown size={13} className={cn(yamlOpen && 'rotate-180')} />
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
          {footer}
        </>
      )}
    </div>
  )
}

/** Official `Km`: actions left, hint text right (truncated unless `wrap`). */
function Footer({ text, wrap, children }: { text?: ReactNode; wrap?: boolean; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 pl-2.5 pr-3.5">
      <div className="flex shrink-0 items-center gap-2">{children}</div>
      <span className={cn('min-w-0 flex-1 text-right text-[12px] text-muted-foreground', !wrap && 'truncate')}>{text}</span>
    </div>
  )
}
