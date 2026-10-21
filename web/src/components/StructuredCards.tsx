import { useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight, Check, Circle, CircleCheck, CircleDashed, EyeOff, GitBranch, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, ListChecks, MessageSquareText, TriangleAlert, Workflow, X } from 'lucide-react'
import { type PrInfo, type SessionPr, type TimelineItem, type TodoRow, todoLabel } from '@/components/Timeline'
import { DwLogo } from '@/components/DwMark'
import { cn } from '@/lib/utils'

/** Official horizontal key glyph used by the credentials card header. */
export function KeyGlyph() {
  return (
    <svg aria-hidden width={16} height={16} viewBox="0 0 24 24" fill="none">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M6.380 6.040 C 3.755 6.323,1.676 8.218,1.115 10.840 C 0.984 11.450,0.984 12.558,1.114 13.160 C 1.639 15.588,3.418 17.366,5.840 17.885 C 6.187 17.959,6.388 17.975,7.000 17.976 C 7.832 17.978,8.164 17.929,8.862 17.700 C 9.902 17.360,10.805 16.758,11.538 15.918 L 11.885 15.520 12.773 15.519 C 13.739 15.518,14.115 15.481,14.390 15.360 C 14.489 15.316,14.871 15.091,15.240 14.860 C 15.608 14.629,15.951 14.440,16.000 14.440 C 16.049 14.440,16.392 14.629,16.760 14.860 C 17.129 15.091,17.512 15.316,17.612 15.361 C 17.911 15.493,18.368 15.531,19.414 15.510 C 20.873 15.481,20.864 15.486,21.995 14.104 C 23.009 12.865,22.989 12.892,23.102 12.572 C 23.233 12.202,23.233 11.798,23.102 11.428 C 22.989 11.108,23.008 11.134,21.998 9.900 C 21.211 8.938,21.073 8.803,20.700 8.632 L 20.500 8.540 16.205 8.520 L 11.910 8.500 11.647 8.200 C 10.652 7.066,9.512 6.384,8.164 6.117 C 7.716 6.028,6.838 5.990,6.380 6.040 M7.784 7.577 C 8.688 7.736,9.553 8.194,10.180 8.845 C 10.885 9.577,11.027 9.706,11.220 9.797 C 11.661 10.005,11.527 9.999,15.960 10.001 C 19.151 10.002,20.114 10.014,20.163 10.051 C 20.306 10.163,21.720 11.932,21.720 12.000 C 21.720 12.068,20.314 13.833,20.168 13.950 C 20.121 13.987,19.856 14.000,19.162 14.000 L 18.219 14.000 17.501 13.554 C 16.644 13.022,16.465 12.949,16.000 12.949 C 15.535 12.949,15.356 13.022,14.499 13.554 L 13.781 14.000 12.832 14.000 C 11.818 14.000,11.583 14.028,11.260 14.190 C 10.954 14.343,10.866 14.416,10.513 14.811 C 9.958 15.429,9.585 15.729,9.014 16.015 C 8.383 16.332,7.742 16.484,7.018 16.486 C 5.685 16.491,4.523 15.969,3.624 14.961 C 3.185 14.469,2.844 13.830,2.651 13.138 C 2.549 12.769,2.541 12.686,2.541 12.000 C 2.541 11.315,2.549 11.230,2.651 10.860 C 2.786 10.372,3.123 9.670,3.391 9.320 C 3.628 9.010,4.056 8.586,4.360 8.358 C 4.814 8.018,5.666 7.664,6.277 7.560 C 6.589 7.508,7.443 7.517,7.784 7.577 M6.516 10.577 C 5.466 10.979,5.167 12.277,5.945 13.055 C 6.528 13.638,7.472 13.638,8.055 13.055 C 8.781 12.330,8.577 11.126,7.650 10.657 C 7.455 10.558,7.370 10.541,7.042 10.532 C 6.789 10.525,6.611 10.540,6.516 10.577"
      />
    </svg>
  )
}

/** Official quarter-arc spinner (14px) layered over a faint circle for in-progress todos. */
function QuarterSpinner({ live }: { live: boolean }) {
  const { t } = useTranslation()
  return (
    <span className="relative mt-0.5 h-3.5 w-3.5 shrink-0">
      <Circle size={14} className="text-muted-foreground opacity-30" />
      <svg aria-label={t('scc.inProgress')} role="img" width={14} height={14} viewBox="0 0 24 24" fill="none" className={cn('absolute inset-0 text-muted-foreground', live && 'motion-safe:animate-spin')}>
        <path d="M20.960 11.301 C 20.788 11.379,20.651 11.504,20.573 11.654 C 20.534 11.730,20.502 11.977,20.479 12.377 C 20.440 13.072,20.366 13.574,20.224 14.120 C 19.595 16.538,17.963 18.539,15.740 19.621 C 14.633 20.160,13.668 20.406,12.377 20.479 C 11.717 20.516,11.603 20.550,11.426 20.760 C 11.179 21.054,11.186 21.442,11.443 21.734 C 11.666 21.988,11.783 22.017,12.458 21.986 C 14.551 21.892,16.658 21.098,18.266 19.798 C 18.669 19.472,19.472 18.669,19.798 18.266 C 21.134 16.613,21.964 14.354,21.976 12.333 C 21.980 11.659,21.972 11.632,21.673 11.390 C 21.495 11.246,21.172 11.206,20.960 11.301" fill="currentColor" fillRule="evenodd" />
      </svg>
    </span>
  )
}

export function TodoStatusIcon({ status, live }: { status: string; live: boolean }) {
  const { t } = useTranslation()
  if (status === 'completed') return <CircleCheck size={14} className="mt-0.5 shrink-0 text-[rgb(0,165,88)]" />
  if (status === 'in_progress') return <QuarterSpinner live={live} />
  return <CircleDashed size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
}

/**
 * Official `transcript-todo-steps` (sampled 2026-08-31): rounded-xl bordered card,
 * 32px "Execution plan" header (14px icon + 12px label), border-t body with
 * `flex items-start gap-2.5` rows: 14px status icon + 13px text.
 */
export function TodoSteps({ todos }: { todos: TodoRow[] }) {
  const { t } = useTranslation()
  return (
    <div data-testid="transcript-todo-steps" className="relative flex w-full flex-col overflow-hidden rounded-xl border border-muted bg-card">
      <div className="flex items-center gap-1.5 px-2.5 py-2">
        <ListChecks size={14} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[12px] leading-[16px] text-muted-foreground">{t('scc.execPlan')}</span>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5 border-t border-muted px-2.5 py-2">
        {todos.map((t, i) => (
          <div key={i} className="flex items-start gap-2.5">
            <TodoStatusIcon status={t.status} live />
            <span className={cn('min-w-0 break-words text-[13px] leading-[18px]', t.status === 'pending' ? 'text-muted-foreground' : 'text-foreground')}>
              {todoLabel(t)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Official nested collapse body for an expanded worklog row: 1rem rail (1px line,
 * click collapses) + 0.5rem content gap, so nested cards sit 24px in from the row text.
 */
export function NestedBody({ onCollapse, children }: { onCollapse?: () => void; children: ReactNode }) {
  return (
    <div className="flex pt-2">
      <div
        role="presentation"
        onClick={onCollapse}
        className={cn('group/rail relative z-10 flex w-4 shrink-0 justify-center', onCollapse && 'cursor-pointer')}
      >
        <div className="w-px bg-border group-hover/rail:bg-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1 pl-2">{children}</div>
    </div>
  )
}

/** Official structured card shell: rounded-xl bordered card, 12px header row, border-t body. */
export function StructuredCard({ icon, label, actions, children, testId }: {
  icon: ReactNode
  label: ReactNode
  actions?: ReactNode
  children: ReactNode
  testId?: string
}) {
  const { t } = useTranslation()
  return (
    <div data-testid={testId} className="relative mb-5 flex w-full flex-col overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center gap-1.5 px-2.5 py-2">
        <span className="flex shrink-0 items-center text-muted-foreground">{icon}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] leading-[16px] text-muted-foreground">{label}</span>
        {actions}
      </div>
      <div className="flex w-full min-w-0 flex-col gap-2 border-t border-border px-2.5 py-2">{children}</div>
    </div>
  )
}

export type PermissionAction = 'approve' | 'deny' | 'approve_session'

/** Official 24px card buttons (variants primary / primary-accent / secondary / destructive-muted). */
const PERM_BTN = 'inline-flex h-6 shrink-0 cursor-pointer select-none items-center gap-1 whitespace-nowrap rounded-[6px] border px-2 text-[12px] font-medium leading-4 disabled:cursor-not-allowed disabled:opacity-50'
const PERM_BTN_VARIANT = {
  primary: 'border-black/10 bg-foreground text-background hover:brightness-[.92]',
  accent: 'border-black/10 bg-[rgb(49,124,255)] text-white hover:brightness-[.92]',
  secondary: 'border-border bg-card text-foreground hover:bg-tint-secondary',
  destructive: 'border-border bg-card text-red-600 hover:bg-tint-secondary',
} as const

function fmtTime(ts: string): string {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Official body preview: headings flattened, whitespace collapsed, 2-line clamp handles the rest. */
function previewText(s: string): string {
  return s.replace(/^#{1,6}\s+/gm, '').replace(/\s+/g, ' ').trim()
}

/**
 * Official `transcript-approval-request` (runtime-sampled 2026-08-31 on a real
 * knowledge-note request): rounded-2xl bordered card, 36px header (14px Devin
 * glyph + 12px title + 20px "Open in sidebar"), border-t summary (15px/500
 * title, 13px "Label: value" metadata, 13px 2-line body), border-t footer
 * with 24px buttons (accent/primary action 160px-ish + secondary Deny).
 * Once resolved the card collapses to a single 13px row "<Approved|Denied> …".
 * Tool-style requests (no resource summary) use the bundle's callout layout:
 * warning rail, label/value rows, Approve / Allow for session / Deny.
 */
export function PermissionRequestCard({ item, resolved, busy, error, onRespond, onOpenSidebar, children }: {
  item: TimelineItem
  resolved?: 'approved' | 'denied'
  busy?: PermissionAction | null
  error?: string
  /** absent for visitors: card is informational, no buttons */
  onRespond?: (action: PermissionAction) => void
  onOpenSidebar?: () => void
  /** admin-only richer summary (e.g. automation form) replacing the resource summary */
  children?: ReactNode
}) {
  const { t } = useTranslation()
  const p = item.permission
  if (!p) return null
  const title = p.title || item.title || `Devin is requesting permission for ${p.toolName || 'unknown'}`
  if (resolved) {
    const text = p.resolvedTitles?.[resolved] || `Permission ${resolved} for ${p.toolName || 'unknown'}`
    return (
      <div data-eid={item.id} data-testid="transcript-approval-resolved" className="group/event-item relative my-2 flex items-start gap-2 text-[13px] leading-[18px] text-muted-foreground">
        {p.workflow && <Workflow size={14} className="mt-0.5 shrink-0" />}
        <span className="min-w-0 flex-1 break-words">{text}</span>
        <span className="shrink-0 select-none text-[12px] leading-[18px] opacity-0 transition-opacity group-hover/event-item:opacity-100">{fmtTime(item.ts)}</span>
      </div>
    )
  }
  const disabled = !!busy || !onRespond
  const resource = !!p.actionLabel
  const meta = p.resourceMetadata || []
  const body = p.resourceBody ? previewText(p.resourceBody) : ''
  const hasSummary = !!(children || p.resourceTitle || meta.length || body || p.sessionRequests?.length || p.workflow)

  if (!resource) {
    // bundle fallback (`fe`): callout with 2px warning rail
    const allowSession = p.localMachine && p.toolName !== 'local_write'
    return (
      <div data-eid={item.id} data-testid="transcript-approval-request" className="my-4 flex w-full gap-3">
        <div className="w-0.5 shrink-0 self-stretch rounded-full bg-amber-500" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 text-[13px] leading-[18px] text-muted-foreground">
          <div className="flex items-center gap-1.5 text-foreground">
            <TriangleAlert size={14} className="shrink-0 text-amber-500" />
            <span className="min-w-0 flex-1 break-words">{title}</span>
            {onOpenSidebar && (
              <button type="button" onClick={onOpenSidebar} aria-label={t('scc.openSidebar')} className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground">
                <ArrowUpRight size={14} />
              </button>
            )}
          </div>
          {(p.details?.length ?? 0) > 0 && (
            <ul className="flex max-h-40 flex-col gap-0.5 overflow-auto">
              {p.details!.map((d, i) => (
                <li key={i} className="flex min-w-0 gap-1.5">
                  <span className="shrink-0 font-medium">{d.label}:</span>
                  <span className="min-w-0 break-all font-mono text-[12px] leading-[18px] text-foreground">{d.value}</span>
                </li>
              ))}
            </ul>
          )}
          {onRespond && (
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              <button type="button" disabled={disabled} onClick={() => onRespond('approve')} className={cn(PERM_BTN, PERM_BTN_VARIANT.accent)}>
                <Check size={14} />
                {busy === 'approve' ? 'Approving…' : p.localMachine ? 'Allow once' : 'Approve'}
              </button>
              {allowSession && (
                <button type="button" disabled={disabled} onClick={() => onRespond('approve_session')} className={cn(PERM_BTN, PERM_BTN_VARIANT.secondary)}>
                  {busy === 'approve_session' ? 'Allowing…' : 'Allow for this session'}
                </button>
              )}
              <button type="button" disabled={disabled} onClick={() => onRespond('deny')} className={cn(PERM_BTN, PERM_BTN_VARIANT.destructive)}>
                <X size={14} />
                {busy === 'deny' ? 'Denying…' : 'Deny'}
              </button>
              {error && <span className="text-[12px] text-red-600">{error}</span>}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div data-eid={item.id} data-testid="transcript-approval-request" className="relative my-4 flex w-full flex-col overflow-hidden rounded-2xl border border-border bg-card">
      <div
        className={cn('flex min-h-9 items-center gap-2 px-2.5 py-2', onOpenSidebar && 'cursor-pointer')}
        onClick={onOpenSidebar}
      >
        <DwLogo size={14} className="shrink-0 text-foreground/40" />
        <span className="min-w-0 flex-1 truncate text-[12px] leading-[16px] text-muted-foreground">{title}</span>
        {onOpenSidebar && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onOpenSidebar() }}
            aria-label={t('scc.openSidebar')}
            className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground"
          >
            <ArrowUpRight size={14} />
          </button>
        )}
      </div>
      {hasSummary && (
        <div className="flex min-w-0 flex-col gap-1 border-t border-border px-2.5 py-2">
          {children ?? (
            <>
              {p.resourceTitle && <div className="truncate text-[15px] font-medium leading-[22px] text-foreground">{p.resourceTitle}</div>}
              {meta.length > 0 && (
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[13px] leading-[18px] text-muted-foreground">
                  {meta.map((m, i) => (
                    <span key={i} className="min-w-0 break-words">{m.label ? `${m.label}: ` : ''}{m.value}</span>
                  ))}
                </div>
              )}
              {body && <p className="line-clamp-2 break-words text-[13px] leading-[18px] text-foreground">{body}</p>}
              {p.sessionRequests?.map((s, i) => (
                <div key={i} className="flex min-w-0 flex-col">
                  <span className="truncate text-[13px] font-medium leading-[18px] text-foreground">{s.title}</span>
                  {s.prompt && <p className="line-clamp-2 break-words text-[13px] leading-[18px] text-muted-foreground">{previewText(s.prompt)}</p>}
                </div>
              ))}
              {p.workflow && (
                <div className="flex flex-wrap gap-x-3 text-[13px] leading-[18px] text-muted-foreground">
                  {p.workflow.scriptLineCount != null && <span>{p.workflow.scriptLineCount} lines</span>}
                  {p.workflow.timeoutSecs != null && <span>Timeout: {p.workflow.timeoutSecs}s</span>}
                </div>
              )}
            </>
          )}
        </div>
      )}
      {onRespond && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-2.5 py-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onRespond('approve')}
            className={cn(PERM_BTN, p.actionPrimary ? PERM_BTN_VARIANT.primary : PERM_BTN_VARIANT.accent)}
          >
            {busy === 'approve' ? 'Approving…' : p.actionLabel}
          </button>
          <button type="button" disabled={disabled} onClick={() => onRespond('deny')} className={cn(PERM_BTN, PERM_BTN_VARIANT.secondary)}>
            {busy === 'deny' ? 'Denying…' : 'Deny'}
          </button>
          {error && <span className="text-[12px] text-red-600">{error}</span>}
        </div>
      )}
    </div>
  )
}

/** Fill state / diff counts from the live PR list when the event payload lacks them. */
export function mergeLivePr(pr: PrInfo, live?: SessionPr[]): PrInfo {
  const hit = live?.find((p) => (pr.pullNumber !== undefined && p.number === pr.pullNumber) || (!!pr.prUrl && p.pr_url === pr.prUrl))
  if (!hit) return pr
  return {
    ...pr,
    state: hit.state === 'merged' || pr.merged ? 'merged' : hit.state || pr.state,
    draft: hit.draft || pr.draft,
    additions: pr.additions ?? hit.additions,
    deletions: pr.deletions ?? hit.deletions,
  }
}

/** Official PR state glyph colours (14px in cards/chips): open green, merged purple, closed red, draft muted. */
export function PrStateIcon({ state, draft, size = 14, className }: { state?: string; draft?: boolean; size?: number; className?: string }) {
  if (draft) return <GitPullRequestDraft size={size} className={cn('shrink-0 text-muted-foreground', className)} />
  if (state === 'merged') return <GitMerge size={size} className={cn('shrink-0 text-[rgb(149,108,222)]', className)} />
  if (state === 'closed') return <GitPullRequestClosed size={size} className={cn('shrink-0 text-[#f53b3a]', className)} />
  return <GitPullRequest size={size} className={cn('shrink-0 text-[rgb(0,165,88)]', className)} />
}

/** Official worklog inline link: dotted underline, link colour. */
export const PR_LINK = 'text-blue-600 underline decoration-dotted decoration-blue-600/50 underline-offset-2 hover:text-blue-700 hover:decoration-blue-700 dark:text-blue-400 dark:decoration-blue-400/50'

function PrLink({ href, children }: { href?: string; children: ReactNode }) {
  if (!href) return <>{children}</>
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className={PR_LINK}>
      {children}
    </a>
  )
}

/**
 * Official worklog wording for PR / branch rows (bundle renderers km/Am/jm/Nm/Mm/
 * _g/Fm/Im/Lm/Pm), driven by the Worker's explicit `pr` fields. Falls back to the
 * server title when a row type has no dedicated wording.
 */
export function PrRowText({ item }: { item: TimelineItem }) {
  const { t } = useTranslation()
  const pr = item.pr
  if (!pr) return <>{item.title}</>
  const repoLink = pr.repo ? <PrLink href={pr.repoUrl}>{pr.repo}</PrLink> : null
  const inRepo = repoLink ? <> in {repoLink}</> : null
  const prNum = pr.pullNumber !== undefined ? <PrLink href={pr.prUrl}>#{pr.pullNumber}</PrLink> : null
  switch (item.raw_type) {
    case 'git_push':
      return <>{t('scc.pushedBranch')}<PrLink href={pr.branchUrl}>{pr.branch}</PrLink>{repoLink && <> to {repoLink}</>}</>
    case 'git_view_pr':
      return prNum ? <>Viewed pull request {prNum}{inRepo}</> : <>Viewed a PR{inRepo}</>
    case 'git_pr_checks':
      return <>Viewed CI status for {prNum ? <>PR {prNum}</> : 'a PR'}{repoLink && <> in repo {repoLink}</>}</>
    case 'git_ci_job_logs':
      return pr.jobId ? <>Viewed CI job logs for job {pr.jobId}{inRepo}</> : <>Viewed CI job logs{inRepo}</>
    case 'git_update_pr':
      return prNum ? <>Updated PR {prNum}{inRepo}</> : <>Updated a PR{inRepo}</>
    case 'git_comment_on_pr':
      return prNum ? <>Commented on PR {prNum}{inRepo}</> : <>Commented on a PR{inRepo}</>
    case 'pr_merge_conflict':
      return pr.pullNumber === undefined ? <>{t('scc.mergeConflict')}</> : <>{t('scc.mergeConflictOn')}PR {prNum}{pr.title ? `: ${pr.title}` : ''}</>
    case 'pr_merged':
      return <>PR {prNum} merged{pr.title ? `: ${pr.title}` : ''}</>
    default:
      return <>{item.title}</>
  }
}

/**
 * Official standalone PR / branch worklog row (`Fm`/`Im`/`Lm`/`Pm`): 16px icon,
 * 13px/18px text, gap-2, right-aligned 12px timestamp; ack_branch_push rows link
 * to the commit as a whole. Sits outside "Worked for" groups (8px row gap).
 * The push glyph is a lucide approximation of the official custom icon.
 */
export function StandaloneGitRow({ item, timestamp }: { item: TimelineItem; timestamp: string }) {
  const { t } = useTranslation()
  const pr = item.pr
  const href = item.raw_type === 'ack_branch_push' ? pr?.commitUrl : item.raw_type === 'pr_merged' || item.raw_type === 'pr_merge_conflict' ? pr?.prUrl : undefined
  const Row = href ? 'a' : 'div'
  const icon = item.raw_type === 'ack_branch_push'
    ? <GitBranch size={16} />
    : item.raw_type === 'pr_merged'
      ? <GitMerge size={16} />
      : item.raw_type === 'pr_merge_conflict'
        ? <TriangleAlert size={16} />
        : item.raw_type === 'ci_failed'
          ? <X size={16} className="text-[#f53b3a]" />
          : item.raw_type === 'pr_comment'
            // official `lg`: bubble-text icon; ignored comments swap in the eye-slash
            ? (item.title || '').startsWith('Ignored') ? <EyeOff size={16} /> : <MessageSquareText size={16} />
            : <GitPullRequest size={16} />
  return (
    <Row
      data-testid="transcript-worklog-row"
      data-eid={item.id}
      {...(href ? { href, target: '_blank', rel: 'noopener noreferrer' } : {})}
      className={cn('group/event-item wg-time-host relative flex items-start gap-2 pb-2 text-[13px] leading-[18px] text-muted-foreground no-underline', href ? 'cursor-pointer hover:text-foreground' : 'cursor-default')}
    >
      <span className="mt-px flex size-4 shrink-0 items-center justify-center [&>svg]:size-4">{icon}</span>
      <span className="min-w-0 flex-1 break-words">
        {item.raw_type === 'ack_branch_push' && pr ? (
          pr.muted
            ? <>{t('scc.userActivity')}<span className="text-foreground">{pr.branch}</span> by {pr.sender || 'A user'}: handing over ownership until next user message</>
            : pr.forced
              ? <><span className="text-foreground">{pr.branch}</span> was force-pushed ({pr.shortSha})</>
              : <>{t('scc.newCommits')}<span className="text-foreground">{pr.branch}</span> ({pr.shortSha})</>
        ) : (
          <PrRowText item={item} />
        )}
      </span>
      <span className="wg-gutter-time shrink-0 select-none text-[12px] leading-[18px]">{timestamp}</span>
    </Row>
  )
}

/**
 * Official `transcript-pr-created` (runtime-sampled 2026-09-05): rounded-2xl
 * bordered elevated card, p-4 / gap-4; title link (14px/500, break-words) over a
 * 12px metadata row (14px state icon · repo#N · +A −D · author); then the
 * `pr-review-status` row whose idle state is a 28px "Analyze" button; the
 * mirror routes it to the PR panel via `onAnalyze` (admin) and keeps it inert
 * otherwise (visitors).
 */
export function PrCreatedCard({ pr, onAnalyze }: { pr: PrInfo; onAnalyze?: () => void }) {
  const { t } = useTranslation()
  const repoShort = pr.repo ? pr.repo.split('/').pop() : undefined
  const hasCounts = pr.additions !== undefined || pr.deletions !== undefined
  const Title = pr.prUrl ? 'a' : 'div'
  const analyze = 'inline-flex h-7 max-w-full shrink-0 select-none items-center justify-center overflow-hidden whitespace-nowrap rounded-[6px] border border-black/10 bg-foreground px-2.5 text-[13px] font-medium text-background'
  return (
    <div data-testid="transcript-pr-created" className="group/prcard relative flex w-full min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex w-full min-w-0 flex-col gap-4 p-4">
        <Title
          {...(pr.prUrl ? { href: pr.prUrl, target: '_blank', rel: 'noopener noreferrer' } : {})}
          className="-mx-4 -mt-4 flex min-w-0 flex-col gap-1 rounded-t-[inherit] px-4 pt-4 hover:bg-foreground/[0.03]"
        >
          <div className="w-full min-w-0 break-words text-[14px] font-medium leading-[20px] text-foreground">{pr.title || `PR #${pr.pullNumber ?? ''}`}</div>
          <div className="flex min-w-0 items-center gap-1 text-[12px] leading-[16px] text-muted-foreground">
            <PrStateIcon state={pr.state} draft={pr.draft} />
            <span className="min-w-0 shrink truncate [direction:rtl]">{repoShort}{pr.pullNumber !== undefined ? `#${pr.pullNumber}` : ''}</span>
            {hasCounts && (
              <>
                <span className="text-[8px] text-muted-foreground/50">•</span>
                <span className="flex items-center gap-[2px]">
                  <span className="text-text-green">+{pr.additions ?? 0}</span>
                  <span className="text-text-red">−{pr.deletions ?? 0}</span>
                </span>
              </>
            )}
            {pr.authorLogin && (
              <>
                <span className="text-[8px] text-muted-foreground/50">•</span>
                <span className="truncate">{pr.authorLogin}</span>
              </>
            )}
          </div>
        </Title>
        <div className="flex w-full min-w-0 items-center gap-1.5">
          <span data-testid="pr-review-status" className="contents">
            {onAnalyze ? (
              <button type="button" onClick={onAnalyze} className={cn(analyze, 'cursor-pointer hover:brightness-[.92]')}>
                <span className="truncate">{t('scc.analyze')}</span>
              </button>
            ) : (
              <button type="button" title={t('scc.reviewOnly')} className={cn(analyze, 'cursor-default')}>
                <span className="truncate">{t('scc.analyze')}</span>
              </button>
            )}
          </span>
        </div>
      </div>
    </div>
  )
}

/**
 * Official request_secret card. Only metadata (name/type/note) is shown; the
 * typed value goes straight to `onProvide` and is never kept after submit.
 * Without `onProvide` (visitors / readonly) the card is informational only.
 */
export function SecretRequestCard({ item, provided, onProvide }: {
  item: TimelineItem
  provided: boolean
  onProvide?: (requestId: string, value: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const req = item.secretRequest
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [err, setErr] = useState('')
  if (!req) return null
  const totp = req.secretType === 'totp'

  // Official `nf` (suggest_save_secret): "Save secret: <ENV_VAR>" + note; saving is
  // done in the official app, so the mirror shows the state only.
  if (req.save) {
    return (
      <StructuredCard
        testId="transcript-save-secret"
        icon={<KeyGlyph />}
        label={<>{t('scc.saveSecret')}<span className="font-mono font-medium text-foreground">{req.name}</span></>}
      >
        {req.note && <div className="text-[12px] leading-[16px] text-muted-foreground">{req.note}</div>}
        {provided ? (
          <div className="flex items-center gap-1.5 text-[13px] leading-[18px] text-green-600">
            <Check size={16} />
            Secret saved
          </div>
        ) : (
          <div className="text-[12px] leading-[16px] text-muted-foreground">{t('scc.saveFuture')}</div>
        )}
      </StructuredCard>
    )
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!onProvide || !value.trim() || busy) return
    setBusy(true)
    setErr('')
    try {
      await onProvide(req.requestId, value.trim())
      setDone(true)
      setOpen(false)
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : t('scc.submitFail'))
    } finally {
      setValue('')
      setBusy(false)
    }
  }

  return (
    <StructuredCard
      testId="transcript-secret-request"
      icon={<KeyGlyph />}
      label={<>{t('scc.credsReq')}<span className="font-mono font-medium text-foreground">{req.name}</span></>}
      actions={totp ? <span className="shrink-0 rounded-md border border-border px-1.5 text-[11px] leading-[18px] text-muted-foreground">{t('scc.totp')}</span> : undefined}
    >
      {provided || done ? (
        <div className="flex items-center gap-1.5 text-[13px] leading-[18px] text-green-600">
          <Check size={16} />
          Secret provided
        </div>
      ) : onProvide ? (
        <>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="h-6 w-fit cursor-pointer self-start rounded-md border border-border bg-card px-2 text-[12px] font-medium leading-[16px] text-foreground hover:bg-muted"
          >
            {totp ? 'Provide 2FA Secret' : 'Provide Secret'}
          </button>
          {open && (
            <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={() => setOpen(false)}>
              <form
                onSubmit={submit}
                onClick={(e) => e.stopPropagation()}
                className="flex w-full flex-col gap-2 rounded-t-2xl bg-card p-5 shadow-xl sm:max-w-md sm:rounded-2xl"
              >
                <h2 className="text-[15px] font-semibold leading-5">{totp ? 'Provide 2FA Secret' : 'Provide Secret'}</h2>
                {req.note && <p className="text-[13px] leading-[18px] text-muted-foreground">{req.note}</p>}
                {err && <div className="text-[12px] text-red-600">{err}</div>}
                <input
                  type="password"
                  autoComplete="off"
                  autoFocus
                  value={value}
                  placeholder={totp ? 'TOTP secret or QR code' : req.name}
                  onChange={(e) => setValue(e.target.value)}
                  className="h-8 w-full rounded-md border border-border bg-background px-2.5 font-mono text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                />
                <div className="flex items-center justify-end gap-2">
                  <button type="button" onClick={() => setOpen(false)} className="h-7 cursor-pointer rounded-md px-2.5 text-[12px] font-medium text-muted-foreground hover:bg-muted">{t('common.cancel')}</button>
                  <button
                    type="submit"
                    disabled={!value.trim() || busy}
                    className="h-7 cursor-pointer rounded-md bg-foreground px-3 text-[12px] font-medium text-background disabled:cursor-default disabled:opacity-50"
                  >
                    {busy ? 'Submitting…' : 'Submit'}
                  </button>
                </div>
              </form>
            </div>
          )}
        </>
      ) : (
        <div className="text-[12px] leading-[16px] text-muted-foreground">{t('scc.waiting')}</div>
      )}
    </StructuredCard>
  )
}
