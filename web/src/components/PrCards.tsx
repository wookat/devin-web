import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { EyeOff, GitBranch, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, MessageSquareText, TriangleAlert, X } from 'lucide-react'
import { type PrInfo, type SessionPr, type TimelineItem } from '@/components/Timeline'
import { cn } from '@/lib/utils'

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
