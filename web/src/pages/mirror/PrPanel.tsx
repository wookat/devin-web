import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Settings2, Check, Copy } from 'lucide-react'
import { adminFetch } from '@/lib/api'
import Markdown from '@/components/Markdown'
import { cn } from '@/lib/utils'
import { relTime } from './treeCache'
import { type PrBugItemT, type PrDiffFileT, PrDiffFile, PrAnalysisPromo, PrSectionViewedProgress, type DiffOptsT, DIFF_OPTS_KEY, readDiffOpts } from './PrDiff'
import { PrHeader, type PrInfo, type PrCheckT } from './PrHeader'
import { PrDiscussion, usePrDiscussion, type PrCommentT, type PrThreadT, type PrDiscussionItemT } from './PrDiscussion'
import { copyText } from '../../lib/clipboard'

/**
 * PR tab panel, mirroring the official Devin Review PR tab's read-only layout
 * (merge-status bar, repo path, title, branch row, files/± stats, Description/
 * Checks sections). Data comes from the admin-only /pr proxy over the official
 * pr-review endpoints (info | merge-status | checks).
 */
function PrPanel({ id, prUrl }: { id: string; prUrl: string }) {
  const { t } = useTranslation()
  const [data, setData] = useState<{ info: PrInfo | null; merge_status: Record<string, unknown> | null; checks: { checks?: PrCheckT[] } | null; comments?: PrCommentT[]; threads?: PrThreadT[]; commits?: { sha: string; headline: string; author: string; committed_at: string }[]; head_sha?: string; viewer_pending_review_id?: number | null; assignees?: { login: string; avatar_url: string }[]; requested_reviewers?: { login: string; avatar_url: string }[]; labels?: { name: string; color: string }[]; author?: { login: string; avatar_url: string; is_bot: boolean } | null } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [sub, setSub] = useState<'changes' | 'bugs' | 'description' | 'discussion' | 'commits'>('changes')
  const [diffOpts, setDiffOpts] = useState<DiffOptsT>(readDiffOpts)
  const [diffMenu, setDiffMenu] = useState(false)
  const updDiffOpts = (patch: Partial<DiffOptsT>) => {
    setDiffOpts((o) => {
      const n = { ...o, ...patch }
      try { localStorage.setItem(DIFF_OPTS_KEY, JSON.stringify(n)) } catch { /* ignore */ }
      return n
    })
  }
  const [diff, setDiff] = useState<{ files: PrDiffFileT[] | null; sections?: { title: string; text: string; files: string[] }[] | null; analysis_status: string; error: string | null } | null>(null)
  useEffect(() => {
    if ((sub !== 'changes' && sub !== 'bugs') || diff) return
    let alive = true
    adminFetch<{ files: PrDiffFileT[] | null; sections?: { title: string; text: string; files: string[] }[] | null; analysis_status: string; error: string | null }>(`/api/admin/session/${id}/pr-changes?pr_url=${encodeURIComponent(prUrl)}`)
      .then((r) => { if (alive) setDiff(r) })
      .catch((e) => { if (alive) setDiff({ files: null, analysis_status: '', error: (e as Error).message }) })
    return () => { alive = false }
  }, [sub, diff, id, prUrl])
  const [bugs, setBugs] = useState<{ data: { status: string; bugs: PrBugItemT[]; security_findings: PrBugItemT[]; flags: PrBugItemT[] } | null; error: string | null } | null>(null)
  useEffect(() => {
    if ((sub !== 'bugs' && sub !== 'changes') || bugs) return
    let alive = true
    adminFetch<{ data: { status: string; bugs: PrBugItemT[]; security_findings: PrBugItemT[]; flags: PrBugItemT[] } | null; error: string | null }>(`/api/admin/session/${id}/pr-bugs?pr_url=${encodeURIComponent(prUrl)}`)
      .then((r) => { if (alive) setBugs(r) })
      .catch((e) => { if (alive) setBugs({ data: null, error: (e as Error).message }) })
    return () => { alive = false }
  }, [sub, bugs, id, prUrl])
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzeErr, setAnalyzeErr] = useState<string | null>(null)
  const runAnalysis = async () => {
    if (analyzing) return
    setAnalyzing(true)
    setAnalyzeErr(null)
    try {
      await adminFetch(`/api/admin/session/${id}/pr-analyze`, { method: 'POST', body: JSON.stringify({ pr_url: prUrl }) })
      setBugs(null)
    } catch (e) {
      setAnalyzeErr((e as Error).message)
    } finally {
      setAnalyzing(false)
    }
  }
  useEffect(() => {
    if (sub !== 'bugs' || bugs?.data?.status !== 'running') return
    const t = setInterval(() => setBugs(null), 15000)
    return () => clearInterval(t)
  }, [sub, bugs])
  const [posting, setPosting] = useState(false)
  const [postErr, setPostErr] = useState<string | null>(null)
  const postComment = async (text: string, done: () => void) => {
    if (!text.trim() || posting) return
    setPosting(true)
    setPostErr(null)
    try {
      await adminFetch(`/api/admin/session/${id}/pr-comment`, { method: 'POST', body: JSON.stringify({ pr_url: prUrl, body: text }) })
      done()
      const r = await adminFetch<{ data: typeof data; error: string | null }>(`/api/admin/session/${id}/pr?pr_url=${encodeURIComponent(prUrl)}`)
      if (r.data) setData(r.data)
    } catch (e) {
      setPostErr((e as Error).message)
    } finally {
      setPosting(false)
    }
  }
  useEffect(() => {
    let alive = true
    adminFetch<{ data: typeof data; error: string | null }>(`/api/admin/session/${id}/pr?pr_url=${encodeURIComponent(prUrl)}`)
      .then((r) => { if (!alive) return; if (r.data) setData(r.data); else setErr(r.error || 'unavailable') })
      .catch((e) => { if (alive) setErr((e as Error).message) })
    return () => { alive = false }
  }, [id, prUrl])
  const refetchPr = async () => {
    const r = await adminFetch<{ data: typeof data; error: string | null }>(`/api/admin/session/${id}/pr?pr_url=${encodeURIComponent(prUrl)}`)
    if (r.data) setData(r.data)
  }
  const disc = usePrDiscussion(id, prUrl, refetchPr)
  // Official inline "Add a comment" (+) protocol (first-hand capture):
  // POST gh/review-threads {file_path, body, subject_type:"LINE", line, side:"RIGHT", pr_path},
  // then (single comment) POST gh/reviews/{pending_review_id}/submit {pr_path, event:"COMMENT"}.
  const addLineComment = async (filePath: string, line: number, body: string, startReview: boolean, hunkRanges: [number, number][], otherSide: number | null = null): Promise<string | null> => {
    try {
      const r = await adminFetch<{ ok: boolean; error: string | null }>(`/api/admin/session/${id}/pr-line-comment`, { method: 'POST', body: JSON.stringify({ pr_url: prUrl, file_path: filePath, line, body, start_review: startReview, hunk_ranges: hunkRanges, other_side_line: otherSide }) })
      if (!r.ok) return r.error || 'failed'
      await refetchPr()
      return null
    } catch {
      return 'network error'
    }
  }
  if (err) return <div className="p-3 text-[13px] text-muted-foreground">PR data unavailable: {err}</div>
  if (!data) return <div className="p-3 text-[13px] text-muted-foreground">{t('pr.loading')}</div>
  const info = data.info
  const comments = data.comments || []
  const threads = data.threads || []
  const commits = data.commits || []
  const discussion: PrDiscussionItemT[] = [
    ...comments.map((cm) => ({ kind: 'comment' as const, at: cm.created_at, cm })),
    ...threads.map((th) => ({ kind: 'thread' as const, at: th.comments[0]?.created_at || '', th })),
  ].sort((a, b) => a.at.localeCompare(b.at))
  return (
    <div className="flex flex-col gap-3 p-3">
      <PrHeader
        id={id}
        prUrl={prUrl}
        info={info}
        mergeStatus={data.merge_status}
        checks={data.checks?.checks || []}
        pendingReviewId={data.viewer_pending_review_id}
        author={data.author}
        reviewers={data.requested_reviewers}
        assignees={data.assignees}
        labels={data.labels}
        onRefetch={refetchPr}
        postComment={postComment}
        posting={posting}
        postErr={postErr}
      />
      <div className="flex items-center gap-1 border-b border-border">
        <div role="tablist" aria-orientation="horizontal" className="flex min-w-0 items-center gap-1 overflow-x-auto">
          {(['changes', 'bugs', 'description', 'discussion', 'commits'] as const).map((k) => {
            const n = k === 'discussion' ? comments.length + threads.length : k === 'commits' ? commits.length : k === 'bugs' && bugs?.data ? bugs.data.bugs.length + bugs.data.security_findings.length + bugs.data.flags.length : 0
            const label = k[0].toUpperCase() + k.slice(1)
            return (
              <button
                key={k}
                id={`pr-tab-${k}`}
                role="tab"
                aria-selected={sub === k}
                aria-controls="pr-tabpanel"
                data-active={sub === k ? '' : undefined}
                onClick={() => setSub(k)}
                className="cursor-pointer text-muted-foreground text-[13px] group/tab relative flex h-[28px] touch-manipulation select-none items-center whitespace-nowrap font-medium rounded-full px-3 hover:bg-tint-secondary data-[active]:text-foreground data-[active]:bg-tint-secondary"
              >
                <span className="flex flex-1 items-center gap-1.5">
                  {label}{n ? <span className="text-[13px] text-muted-foreground min-w-3.5 text-center tabular-nums">{n}</span> : null}
                </span>
              </button>
            )
          })}
        </div>
        <span className="flex-1" />
        <div className="relative">
          <button
            aria-label={t('pr.diffSettings')}
            aria-haspopup="menu"
            aria-expanded={diffMenu}
            onClick={() => setDiffMenu((v) => !v)}
            className={cn('flex size-6 cursor-pointer items-center justify-center rounded-[6px]', diffMenu ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground')}
          >
            <Settings2 size={15} />
          </button>
          {diffMenu && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setDiffMenu(false)} />
              <div role="menu" className="absolute right-0 top-7 z-40 min-w-[220px] rounded-[10px] border border-border bg-popover p-1 shadow-lg">
                <div role="presentation" className="px-2 py-[5px] text-[12px] font-medium text-muted-foreground">{t('pr.diffView')}</div>
                {([[t('pr.splitView'), true], [t('pr.unifiedView'), false]] as const).map(([label, val]) => (
                  <button
                    key={label}
                    role="menuitemradio"
                    aria-checked={diffOpts.split === val}
                    onClick={() => updDiffOpts({ split: val })}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-[13px] hover:bg-accent"
                  >
                    <span className="flex size-4 items-center justify-center">{diffOpts.split === val && <Check size={13} />}</span>
                    {label}
                  </button>
                ))}
                <button
                  role="menuitemcheckbox"
                  aria-checked={diffOpts.hideWs}
                  onClick={() => updDiffOpts({ hideWs: !diffOpts.hideWs })}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-[13px] hover:bg-accent"
                >
                  <span className="flex size-4 items-center justify-center">{diffOpts.hideWs && <Check size={13} />}</span>
                  Hide whitespace
                </button>
                <div role="presentation" className="px-2 py-[5px] text-[12px] font-medium text-muted-foreground">{t('pr.comments')}</div>
                <button
                  role="menuitemcheckbox"
                  aria-checked={diffOpts.hideHl}
                  onClick={() => updDiffOpts({ hideHl: !diffOpts.hideHl })}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-[13px] hover:bg-accent"
                >
                  <span className="flex size-4 items-center justify-center">{diffOpts.hideHl && <Check size={13} />}</span>
                  Hide highlights
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      <div id="pr-tabpanel" role="tabpanel" tabIndex={0} aria-labelledby={`pr-tab-${sub}`} className="px-2 pb-2">
      {sub === 'changes' ? (
        !diff ? <p className="text-[13px] text-muted-foreground">{t('pr.loadingChanges')}</p>
        : diff.files?.length ? (() => {
            const repoBase = prUrl.replace(/\/pull\/\d+.*$/, '')
            const rawBase = data.head_sha ? `${repoBase}/blob/${data.head_sha}/` : undefined
            const viewedKey = `pr-viewed-files:${prUrl}`
            const threadsByFile = new Map<string, Map<number, number>>()
            for (const t of data.threads || []) {
              if (!t.path || !t.line || t.is_resolved) continue
              const m2 = threadsByFile.get(t.path) || new Map<number, number>()
              m2.set(t.line, (m2.get(t.line) || 0) + t.comments.length)
              threadsByFile.set(t.path, m2)
            }
            const goDiscussion = () => setSub('discussion')
            const bugsByFile = new Map<string, Map<number, PrBugItemT[]>>()
            if (bugs?.data?.status === 'completed') {
              for (const it of [...bugs.data.security_findings, ...bugs.data.bugs, ...bugs.data.flags]) {
                const ln = parseInt(it.start_line, 10)
                if (!it.file_path || !ln) continue
                const m3 = bugsByFile.get(it.file_path) || new Map<number, PrBugItemT[]>()
                m3.set(ln, [...(m3.get(ln) || []), it])
                bugsByFile.set(it.file_path, m3)
              }
            }
            const byPath = new Map(diff.files.map((f) => [f.file_path, f]))
            const grouped = (diff.sections || []).filter((s) => s.title || s.text)
            const promo = diff.analysis_status !== 'completed'
              ? <PrAnalysisPromo prUrl={prUrl} analyzing={analyzing} error={analyzeErr} onRun={() => void runAnalysis()} />
              : null
            const renderFile = (f: PrDiffFileT) => <PrDiffFile key={f.file_path} f={f} rawBase={rawBase} viewedKey={viewedKey} threadLines={threadsByFile.get(f.file_path)} onGoToThread={goDiscussion} bugsAt={bugsByFile.get(f.file_path)} onAddComment={addLineComment} diffOpts={diffOpts} />
            if (!grouped.length) return <>{promo}<div className="flex flex-col gap-2">{diff.files.map(renderFile)}</div></>
            if (grouped.length === 1 && /^changes$/i.test(grouped[0].title.trim())) {
              const files = grouped[0].files.map((p) => byPath.get(p)).filter((f): f is PrDiffFileT => !!f)
              return <>{promo}<div className="px-4 py-3 text-[15px] font-medium">{t('pr.changes')}</div><div className="flex flex-col gap-2">{files.map(renderFile)}</div></>
            }
            let n = 0
            return (
              <>
              {promo}
              <div className="flex flex-col gap-3">
                {grouped.map((s, i) => {
                  const secFiles = s.files.map((p) => byPath.get(p)).filter((f): f is PrDiffFileT => !!f)
                  const num = secFiles.length ? ++n : 0
                  return (
                    <div key={i} className="flex flex-col gap-2">
                      {s.title && (
                        <div className="sticky top-0 z-20 flex h-12 items-center gap-2 bg-background px-1 py-2">
                          <h1 className="min-w-0 flex-1 truncate text-[15px] font-medium" title={s.title}>
                            {num > 0 && <span className="mr-3 inline-flex size-[18px] -translate-y-px items-center justify-center rounded-full bg-foreground text-center align-middle text-[12px] font-normal tabular-nums text-background">{num}</span>}
                            {s.title.replace(/^\d+\.\s*/, '').split(/`([^`]+)`/).map((part, k) =>
                              k % 2 === 1 ? <span key={k} className="rounded-[6px] bg-muted px-[4px] py-[2px] font-mono text-[13px] font-normal">{part}</span> : part)}
                          </h1>
                          {secFiles.length > 0 && <PrSectionViewedProgress files={secFiles.map((f) => f.file_path)} viewedKey={viewedKey} />}
                        </div>
                      )}
                      {s.text && <div className="text-[13px]"><Markdown text={s.text.replace(/<\/?cite[^>]*>/g, '')} /></div>}
                      {secFiles.map((f) => <PrDiffFile key={f.file_path} f={f} rawBase={rawBase} viewedKey={viewedKey} threadLines={threadsByFile.get(f.file_path)} onGoToThread={goDiscussion} bugsAt={bugsByFile.get(f.file_path)} onAddComment={addLineComment} diffOpts={diffOpts} />)}
                    </div>
                  )
                })}
              </div>
              </>
            )
          })()
        : <p className="text-[13px] text-muted-foreground">{diff.error ? `Changes unavailable: ${diff.error}` : 'No changes.'}</p>
      ) : sub === 'bugs' ? (
        !bugs ? <p className="text-[13px] text-muted-foreground">{t('pr.loadingAnalysis')}</p>
        : bugs.error || !bugs.data ? <p className="text-[13px] text-muted-foreground">Bugs unavailable: {bugs.error || 'unknown'}</p>
        : diff != null && diff.analysis_status !== 'completed' ? (
          <PrAnalysisPromo prUrl={prUrl} analyzing={analyzing} error={analyzeErr} onRun={() => void runAnalysis()} />
        ) : bugs.data.status === 'running' ? (
          <div className="flex items-center gap-2 rounded-lg border border-border px-4 py-6 text-[13px] text-muted-foreground"><Loader2 size={14} className="animate-spin" /> {t('pr.analyzing')}</div>
        ) : bugs.data.status === 'completed' ? (
          <div className="flex flex-col gap-3">
            {[
              { label: 'Vulnerability', labelPlural: 'Vulnerabilities', items: bugs.data.security_findings, tone: 'text-red-600 dark:text-red-400' },
              { label: 'Bug', labelPlural: 'Bugs', items: bugs.data.bugs, tone: 'text-red-600 dark:text-red-400' },
              { label: 'Flag', labelPlural: 'Flags', items: bugs.data.flags, tone: 'text-orange-600 dark:text-orange-400' },
            ].filter((s) => s.items.length).map((s) => (
              <div key={s.label} className="rounded-lg border border-border p-3">
                <div className={cn('mb-2 text-[13px] font-medium', s.tone)}>{s.items.length} {s.items.length === 1 ? s.label : s.labelPlural}</div>
                <div className="flex flex-col gap-2.5">
                  {s.items.map((it, i) => (
                    <div key={i}>
                      <div className="text-[13px] font-medium">{it.title}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
                        {it.severity && <span className={cn('font-medium capitalize', it.severity === 'critical' || it.severity === 'severe' ? 'text-red-600 dark:text-red-400' : '')}>{it.severity}</span>}
                        {it.category && <span>{it.category}</span>}
                        <span className="font-mono">{it.file_path.split('/').pop()}:{it.start_line}</span>
                        {it.cwe_id && <span>• {it.cwe_id}</span>}
                      </div>
                      {it.description && <p className="mt-1 text-[12px] text-muted-foreground">{it.description}</p>}
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {!bugs.data.security_findings.length && !bugs.data.bugs.length && !bugs.data.flags.length && <p className="text-[13px] text-muted-foreground">{t('pr.noBugs')}</p>}
          </div>
        ) : <PrAnalysisPromo prUrl={prUrl} analyzing={analyzing} error={analyzeErr} onRun={() => void runAnalysis()} />
      ) : sub === 'discussion' ? (
        <PrDiscussion discussion={discussion} h={disc} posting={posting} postErr={postErr} postComment={postComment} />
      ) : sub === 'commits' ? (
        commits.length ? (
          <div className="flex flex-col gap-2">
            {commits.map((cm) => (
              <div key={cm.sha} className="rounded-lg border border-border px-3 py-2.5">
                <div className="text-[13px] font-medium">{cm.headline}</div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
                  {cm.sha === data.head_sha && <span className="font-medium text-emerald-600 dark:text-emerald-400">{t('pr.current')}</span>}
                  {cm.committed_at && <span>• {relTime(cm.committed_at)}</span>}
                  {cm.author && <span>• {cm.author}</span>}
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{cm.sha.slice(0, 7)}</span>
                  <button aria-label={t('pr.copySha')} onClick={() => void copyText(cm.sha)} className="flex size-5 cursor-pointer items-center justify-center rounded hover:bg-accent hover:text-foreground"><Copy size={11} /></button>
                </div>
              </div>
            ))}
          </div>
        ) : <p className="text-[13px] text-muted-foreground">{t('pr.noCommits')}</p>
      ) : (
        info?.body ? <div className="text-[13px]"><Markdown text={info.body} /></div> : <p className="text-[13px] text-muted-foreground">{t('pr.noDesc')}</p>
      )}
      </div>
    </div>
  )
}

/**
 * Editor: hosted VS Code for the session's machine (official Editor tab).
 * The Worker calls the official vscode-server endpoint and returns a
 * short-lived link, which is embedded as an iframe. Admin-only.
 */

export { type PrBugItemT, type PrDiffFileT, rangeLength, PrInlineComposer, readViewedSet, toggleViewedStore, PrSectionViewedProgress, type DiffOptsT, DIFF_OPTS_KEY, readDiffOpts, WordDiffLine, PrDiffFile, PrAnalysisPromo } from './PrDiff'
export { type PrInfo, prStateLabel } from './PrHeader'
export { REACTION_SET, ReactionPicker, CommentActions, CommentEditor, ReactionRow } from './PrComments'
export { PrPanel }
