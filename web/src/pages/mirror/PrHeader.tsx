import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Check, Copy, XCircle, CheckCircle2, Circle, CircleDashed, ArrowUpRight, GitPullRequest } from 'lucide-react'
import { adminFetch } from '@/lib/api'
import { cn } from '@/lib/utils'
import { reviewMirrorPath } from '@/lib/mirrorLinks'

interface PrInfo {
  title?: string; number?: number; state?: string; draft?: boolean; merged?: boolean
  base_branch?: string; head_branch?: string; user?: string; additions?: number; deletions?: number
  changed_files?: number; html_url?: string; comments?: number; merged_by?: string
  body?: string
}

/** A single status check row in the merge-status popover. */
interface PrCheckT { name: string; status?: string; conclusion?: string; description?: string; summary?: string; details_url?: string; is_required?: boolean }

/** Official merge-status pill wording/colors (state × draft × merged). */
function prStateLabel(info: PrInfo | null, ms: Record<string, unknown> | null): { label: string; cls: string } {
  const st = String(ms?.state || (info?.merged ? 'MERGED' : info?.state === 'open' ? 'OPEN' : 'CLOSED')).toUpperCase()
  if (info?.draft || ms?.is_draft) return { label: 'Draft', cls: 'bg-muted text-muted-foreground' }
  if (st === 'MERGED') return { label: 'Merged', cls: 'bg-[rgba(149,108,222,0.12)] text-[rgb(149,108,222)]' }
  if (st === 'OPEN') return { label: 'Open', cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' }
  return { label: 'Closed', cls: 'bg-red-500/10 text-red-600 dark:text-red-400' }
}

/** PR header block: merge-status bar, title, branch/stats row, and the
 * merged-details popover (checks, reviewers, assignees, labels). Owns the
 * review-lifecycle writes (submit review / merge) and the comment dropdown. */
function PrHeader({ id, prUrl, info, mergeStatus, checks, pendingReviewId, author, reviewers, assignees, labels, onRefetch, postComment, posting, postErr }: {
  id: string; prUrl: string; info: PrInfo | null; mergeStatus: Record<string, unknown> | null
  checks: PrCheckT[]; pendingReviewId: number | null | undefined
  author: { login: string; avatar_url: string; is_bot: boolean } | null | undefined
  reviewers: { login: string; avatar_url: string }[] | undefined
  assignees: { login: string; avatar_url: string }[] | undefined
  labels: { name: string; color: string }[] | undefined
  onRefetch: () => Promise<void>
  postComment: (text: string, done: () => void) => Promise<void>
  posting: boolean; postErr: string | null
}) {
  const { t } = useTranslation()
  const [copiedBr, setCopiedBr] = useState(false)
  const [commentOpen, setCommentOpen] = useState(false)
  const [mergedOpen, setMergedOpen] = useState(false)
  const [expandedCheck, setExpandedCheck] = useState(-1)
  const [cmtText, setCmtText] = useState('')
  // Official review-lifecycle writes: pending-review submit (events endpoint)
  // and merge/close. Buttons render only in matching states (pending review →
  // Submit review split; open+mergeable → Merge split) — same gating as the
  // official review page.
  const [actBusy, setActBusy] = useState(false)
  const [actErr, setActErr] = useState('')
  const [mergeOpen, setMergeOpen] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewBody, setReviewBody] = useState('')
  const submitReview = async (event: string) => {
    if (actBusy) return
    setActBusy(true)
    setActErr('')
    try {
      const r = await adminFetch<{ ok: boolean; error: string | null }>(`/api/admin/session/${id}/pr-submit-review`, { method: 'POST', body: JSON.stringify({ pr_url: prUrl, event, body: reviewBody.trim() || undefined }) })
      if (!r.ok) { setActErr(r.error || 'failed'); return }
      setReviewOpen(false)
      setReviewBody('')
      await onRefetch()
    } catch {
      setActErr('network error')
    } finally {
      setActBusy(false)
    }
  }
  const mergePr = async (method: string) => {
    if (actBusy) return
    setActBusy(true)
    setActErr('')
    try {
      const r = await adminFetch<{ ok: boolean; error: string | null }>(`/api/admin/session/${id}/pr-merge`, { method: 'POST', body: JSON.stringify({ pr_url: prUrl, method }) })
      if (!r.ok) { setActErr(r.error || 'failed'); return }
      setMergeOpen(false)
      await onRefetch()
    } catch {
      setActErr('network error')
    } finally {
      setActBusy(false)
    }
  }
  const pill = prStateLabel(info, mergeStatus)
  const repoPath = prUrl.replace('https://', '').replace(/\/(pull|merge_requests|pull-requests)\/\d+$/, '').replace(/^(github\.com|gitlab\.com|bitbucket\.org)\//, '')
  return (
    <>
      <div className="flex items-center gap-2" data-testid="merge-status-bar">
        <span className={cn('flex h-7 items-center gap-1 rounded-full px-[11px] text-[13px] font-medium', pill.cls)}>
          <GitPullRequest size={13} /> {pill.label}
        </span>
        <span className="flex-1" />
        <a href={prUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground">
          GitHub <ArrowUpRight size={12} />
        </a>
        <a href={reviewMirrorPath(repoPath, info?.number ?? '')} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground">
          Full view <ArrowUpRight size={12} />
        </a>
        {info?.state === 'open' && !info?.merged && pendingReviewId != null && (
          <div className="relative">
            <button onClick={() => { setMergeOpen(false); setReviewOpen((o) => !o) }} className="flex cursor-pointer items-center gap-1 rounded-md border border-amber-500/50 bg-amber-500/10 px-2.5 py-1 text-[13px] font-medium text-amber-600 hover:bg-amber-500/20 dark:text-amber-400">
              {t('pr.submitReview')} <ChevronDown size={12} />
            </button>
            {reviewOpen && (
              <div className="absolute right-0 top-full z-30 mt-1 w-80 rounded-lg border border-border bg-background p-3 shadow-lg">
                <textarea value={reviewBody} onChange={(e) => setReviewBody(e.target.value)} placeholder={t('pr.reviewBodyPh')} className="min-h-20 w-full resize-none rounded-md border border-border bg-background p-2 text-[13px] placeholder:text-muted-foreground" />
                {actErr && <p className="mt-1 text-[12px] text-red-500">Failed: {actErr}</p>}
                <div className="mt-2 flex justify-end gap-2">
                  <button disabled={actBusy} onClick={() => void submitReview('COMMENT')} className="cursor-pointer rounded-md border border-border px-2.5 py-1 text-[12px] hover:bg-accent disabled:opacity-50">{t('pr.comment')}</button>
                  <button disabled={actBusy} onClick={() => void submitReview('REQUEST_CHANGES')} className="cursor-pointer rounded-md border border-red-500/40 px-2.5 py-1 text-[12px] text-red-600 hover:bg-red-500/10 disabled:opacity-50 dark:text-red-400">{t('pr.requestChanges')}</button>
                  <button disabled={actBusy} onClick={() => void submitReview('APPROVE')} className="cursor-pointer rounded-md bg-emerald-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50">{t('pr.approve')}</button>
                </div>
              </div>
            )}
          </div>
        )}
        {info?.state === 'open' && !info?.merged && (
          <div className="relative">
            <button
              disabled={mergeStatus?.mergeable === 'CONFLICTING'}
              onClick={() => { setReviewOpen(false); setMergeOpen((o) => !o) }}
              className="flex cursor-pointer items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-[13px] font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('pr.merge')} <ChevronDown size={12} />
            </button>
            {mergeOpen && (
              <div className="absolute right-0 top-full z-30 mt-1 min-w-[170px] rounded-lg border border-border bg-background p-1 shadow-lg">
                {(['merge', 'squash', 'rebase'] as const).map((m) => (
                  <button key={m} disabled={actBusy} onClick={() => void mergePr(m)} className="flex h-8 w-full cursor-pointer items-center rounded-md px-2.5 text-[13px] hover:bg-accent disabled:opacity-50">
                    {m === 'merge' ? t('pr.mergeCreate') : m === 'squash' ? t('pr.mergeSquash') : t('pr.mergeRebase')}
                  </button>
                ))}
                {actErr && <p className="px-2.5 py-1 text-[12px] text-red-500">Failed: {actErr}</p>}
              </div>
            )}
          </div>
        )}
        <div className="relative">
          <button onClick={() => setCommentOpen((o) => !o)} className="flex cursor-pointer items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[13px] font-medium hover:bg-accent">
            Comment <ChevronDown size={12} />
          </button>
          {commentOpen && (
            <div className="absolute right-0 top-full z-30 mt-1 w-80 rounded-lg border border-border bg-background p-3 shadow-lg">
              <textarea value={cmtText} onChange={(e) => setCmtText(e.target.value)} placeholder={t('pr.writeComment')} className="min-h-24 w-full resize-none rounded-md border border-border bg-background p-2 text-[13px] placeholder:text-muted-foreground" />
              {pill.label === 'Merged' && <p className="mt-2 text-[12px] text-muted-foreground">{t('pr.mergedNote')}</p>}
              {postErr && <p className="mt-1 text-[12px] text-red-500">Failed: {postErr}</p>}
              <div className="mt-2 flex justify-end gap-2">
                <button onClick={() => setCommentOpen(false)} className="cursor-pointer rounded-md border border-border px-3 py-1 text-[13px] hover:bg-accent">{t('common.cancel')}</button>
                <button disabled={!cmtText.trim() || posting} onClick={() => void postComment(cmtText, () => { setCmtText(''); setCommentOpen(false) })} className={cn('rounded-md px-3 py-1 text-[13px] font-medium text-white', !cmtText.trim() || posting ? 'cursor-not-allowed bg-blue-500/50' : 'cursor-pointer bg-blue-500 hover:bg-blue-600')}>{posting ? 'Submitting…' : 'Submit'}</button>
              </div>
            </div>
          )}
        </div>
      </div>
      <div>
        <div className="text-[12px] text-muted-foreground">{repoPath} #{info?.number}</div>
        <h2 className="text-[17px] font-semibold leading-snug">{info?.title || 'Pull request'}</h2>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
        {author?.avatar_url && <img loading="lazy" decoding="async" src={author.avatar_url} alt="" className="size-5 rounded-full" />}
        {info?.user && <span className="text-muted-foreground">{info.user.replace(/\s*\[bot\]\s*$/, '')}</span>}
        {info?.base_branch && <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{info.base_branch}</span>}
        {info?.head_branch && (
          <>
            <span className="text-muted-foreground">←</span>
            <span className="max-w-56 truncate rounded bg-muted px-1.5 py-0.5 font-mono">{info.head_branch}</span>
            <button
              aria-label={t('pr.copyBranch')}
              title={t('pr.copyBranch')}
              onClick={() => { void navigator.clipboard.writeText(info.head_branch || ''); setCopiedBr(true); setTimeout(() => setCopiedBr(false), 1200) }}
              className="flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {copiedBr ? <Check size={11} /> : <Copy size={11} />}
            </button>
          </>
        )}
        {info?.changed_files != null && <span className="text-muted-foreground">{info.changed_files} {info.changed_files === 1 ? 'file' : 'files'}</span>}
        {info?.additions != null && <span className="font-medium text-emerald-600 dark:text-emerald-400">+{info.additions}</span>}
        {info?.deletions != null && <span className="font-medium text-red-600 dark:text-red-400">−{info.deletions}</span>}
      </div>
      <div className="relative min-h-[46px] rounded-[10px] border border-border p-2 text-[13px]">
        <button
          onClick={() => setMergedOpen((o) => !o)}
          aria-label={pill.label === 'Merged' ? 'Merged — view checks, reviewers, assignees, and labels' : undefined}
          className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md text-left"
        >
          <GitPullRequest size={14} className="text-muted-foreground" />
          <span data-testid="merge-status-message">{pill.label}</span>
          <ChevronDown size={12} className={cn('text-muted-foreground transition-transform', mergedOpen && 'rotate-180')} />
        </button>
        {mergedOpen && (
          <div className="absolute left-0 top-full z-30 mt-1 w-80 rounded-lg border border-border bg-background p-3 shadow-lg">
            {(() => {
              const ms = mergeStatus as { checks_pending?: boolean; checks_failing?: boolean } | null
              const label = ms?.checks_failing ? 'Some checks failed' : ms?.checks_pending ? 'Checks pending' : 'All checks passed'
              const cls = ms?.checks_failing ? 'bg-red-500 text-red-600' : ms?.checks_pending ? 'bg-amber-500 text-amber-600' : 'bg-emerald-500 text-emerald-600'
              return (
                <div className="mb-3 border-b border-border pb-3">
                  <div className={cn('mb-2 h-1 rounded-full', cls.split(' ')[0])} />
                  <div className={cn('flex items-center gap-1.5 text-[13px]', cls.split(' ')[1])}>
                    {ms?.checks_failing ? <XCircle size={13} /> : <Check size={13} />} {label}
                  </div>
                  {checks.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {checks.map((ck, i) => (
                        <li key={i} className="text-[12px]">
                          <div className="flex items-center gap-2">
                            {(() => {
                              const st = String(ck.conclusion || ck.status || '').toUpperCase()
                              if (st === 'SUCCESS') return <CheckCircle2 size={12} className="shrink-0 text-emerald-500" />
                              if (st === 'QUEUED' || st === 'IN_PROGRESS' || st === 'PENDING' || st === '') return <CircleDashed size={12} className="shrink-0 text-amber-500" />
                              if (st === 'NEUTRAL' || st === 'SKIPPED') return <Circle size={12} className="shrink-0 text-muted-foreground" />
                              return <XCircle size={12} className="shrink-0 text-red-500" />
                            })()}
                            {ck.summary ? (
                              <button onClick={() => setExpandedCheck(expandedCheck === i ? -1 : i)} className="flex min-w-0 cursor-pointer items-center gap-1 text-left hover:text-foreground">
                                <ChevronDown size={11} className={cn('shrink-0 text-muted-foreground transition-transform', expandedCheck === i && 'rotate-180')} />
                                <span className="min-w-0 truncate">{ck.name}</span>
                              </button>
                            ) : ck.details_url && /^https:\/\//.test(ck.details_url) ? (
                              <a href={ck.details_url} target="_blank" rel="noreferrer" className="min-w-0 truncate hover:underline">{ck.name}</a>
                            ) : <span className="min-w-0 truncate">{ck.name}</span>}
                            {ck.is_required && <span className="rounded border border-border px-1 text-[10px] text-muted-foreground">{t('pr.required')}</span>}
                            {ck.description && <span className="min-w-0 truncate text-muted-foreground">{ck.description}</span>}
                          </div>
                          {expandedCheck === i && ck.summary && (
                            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] leading-snug">{ck.summary}</pre>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )
            })()}
            {([['Reviewers', reviewers || [], 'No reviewers'], ['Assignees', assignees || [], 'No assignees']] as const).map(([title, people, empty]) => (
              <div key={title} className="mb-3">
                <div className="mb-1 text-[13px] font-medium">{title}</div>
                {people.length ? people.map((u) => (
                  <div key={u.login} className="flex items-center gap-2 py-0.5 text-[13px]">
                    {u.avatar_url && <img loading="lazy" decoding="async" src={u.avatar_url} alt="" className="size-5 rounded-full" />}
                    <span>{u.login}</span>
                  </div>
                )) : <div className="text-[13px] text-muted-foreground">{empty}</div>}
              </div>
            ))}
            <div>
              <div className="mb-1 text-[13px] font-medium">{t('pr.labels')}</div>
              {labels?.length ? (
                <div className="flex flex-wrap gap-1">
                  {labels.map((l) => <span key={l.name} className="rounded-full border border-border px-2 py-0.5 text-[12px]" style={l.color ? { borderColor: `#${l.color}`, color: `#${l.color}` } : undefined}>{l.name}</span>)}
                </div>
              ) : <div className="text-[13px] text-muted-foreground">{t('pr.noLabels')}</div>}
            </div>
          </div>
        )}
      </div>
    </>
  )
}

export { type PrInfo, type PrCheckT, prStateLabel, PrHeader };
