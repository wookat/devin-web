import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, Code } from 'lucide-react'
import { adminFetch } from '@/lib/api'
import Markdown from '@/components/Markdown'
import { cn } from '@/lib/utils'
import { CommentActions, CommentEditor, ReactionRow } from './PrComments'

/** A PR conversation comment (issue comments and review-thread replies share
 * this shape; `pending` marks a draft review reply on thread comments). */
interface PrCommentT {
  id: string; body: string; login: string; avatar_url: string; is_bot: boolean; created_at: string
  reactions?: { content: string; count: number; viewer_reacted: boolean }[]
  url?: string; pending?: boolean
}

/** A review thread anchored to a diff line. */
interface PrThreadT {
  id: string; path: string; line: number; is_resolved: boolean; is_outdated: boolean
  comments: PrCommentT[]
}

/** Discussion feed entry: issue comment or review thread, sorted by time. */
type PrDiscussionItemT = { kind: 'comment'; at: string; cm: PrCommentT } | { kind: 'thread'; at: string; th: PrThreadT }

/**
 * Discussion-tab controller: all comment/thread write state and the wire
 * protocols that mutate it. Lives in a hook so the state persists across
 * sub-tab switches (the hook is always called, the tab body unmounts).
 */
function usePrDiscussion(id: string, prUrl: string, refetchPr: () => Promise<void>) {
  // Official thread-card reaction protocol (first-hand capture):
  // add = POST gh/comments/{id}/reactions {pr_path, content}; remove = DELETE
  // .../reactions/{content}?pr_path. Mirror toggles via admin proxy, then refetches.
  const [reacting, setReacting] = useState('')
  const toggleReaction = async (commentId: string, content: string, has: boolean) => {
    if (reacting) return
    setReacting(`${commentId}:${content}`)
    try {
      await adminFetch(`/api/admin/session/${id}/pr-reaction`, { method: 'POST', body: JSON.stringify({ pr_url: prUrl, comment_id: commentId, content, op: has ? 'remove' : 'add' }) })
      await refetchPr()
    } catch { /* keep prior state */ } finally {
      setReacting('')
    }
  }
  // Official Mark resolved semantics (first-hand capture): footer button posts
  // gh/review_threads/{thread_id}/resolve|unresolve {pr_path, pr_number}.
  const [resolving, setResolving] = useState('')
  const toggleResolve = async (threadId: string, resolved: boolean) => {
    if (resolving) return
    setResolving(threadId)
    try {
      await adminFetch(`/api/admin/session/${id}/pr-thread-resolve`, { method: 'POST', body: JSON.stringify({ pr_url: prUrl, thread_id: threadId, op: resolved ? 'unresolve' : 'resolve' }) })
      await refetchPr()
    } catch { /* keep prior state */ } finally {
      setResolving('')
    }
  }
  // Official thread reply semantics (first-hand capture): "Reply to this thread..."
  // expands an editor whose submit posts gh/review_threads/{thread_id}/replies
  // {pr_path, body, start_review:false}.
  // Official resolved-thread semantics (first-hand capture): resolved threads
  // collapse to a "<file> · Resolved  L<line>" header row; clicking toggles the body.
  const [expandedThreads, setExpandedThreads] = useState<Record<string, boolean>>({})
  const [replyThread, setReplyThread] = useState('')
  const [replyText, setReplyText] = useState('')
  const [replying, setReplying] = useState(false)
  const [replyErr, setReplyErr] = useState('')
  // Official pending-review semantics (first-hand capture): "Start a review"
  // posts the same replies endpoint with start_review:true; the comment renders
  // with an orange "Pending" badge and the composer button becomes "Add to review".
  // Pending comments are deletable via the same DELETE gh/review-comments protocol.
  const [pendingReplies, setPendingReplies] = useState<Record<string, { id: string; body: string }[]>>({})
  const submitReply = async (threadId: string, startReview = false) => {
    if (replying || !replyText.trim()) return
    setReplying(true)
    setReplyErr('')
    try {
      const r = await adminFetch<{ ok: boolean; error: string | null; comment_id?: string | null }>(`/api/admin/session/${id}/pr-thread-reply`, { method: 'POST', body: JSON.stringify({ pr_url: prUrl, thread_id: threadId, body: replyText.trim(), start_review: startReview }) })
      if (!r.ok) { setReplyErr(r.error || 'failed'); return }
      if (startReview) setPendingReplies((m) => ({ ...m, [threadId]: [...(m[threadId] || []), { id: r.comment_id || '', body: replyText.trim() }] }))
      setReplyThread('')
      setReplyText('')
      await refetchPr()
    } catch {
      setReplyErr('network error')
    } finally {
      setReplying(false)
    }
  }
  // Official More actions Edit/Delete protocols (first-hand capture):
  // PATCH gh/review-comments/{id} {pr_path, body}; DELETE ...?pr_path (no confirm).
  const [editingComment, setEditingComment] = useState('')
  const [editText, setEditText] = useState('')
  const [editBusy, setEditBusy] = useState(false)
  const [editErr, setEditErr] = useState('')
  const [discText, setDiscText] = useState('')
  const saveEdit = async (commentId: string) => {
    if (editBusy || !editText.trim()) return
    setEditBusy(true)
    setEditErr('')
    try {
      const r = await adminFetch<{ ok: boolean; error: string | null }>(`/api/admin/session/${id}/pr-comment-edit`, { method: 'POST', body: JSON.stringify({ pr_url: prUrl, comment_id: commentId, body: editText.trim() }) })
      if (!r.ok) { setEditErr(r.error || 'failed'); return }
      setEditingComment('')
      setEditText('')
      await refetchPr()
    } catch {
      setEditErr('network error')
    } finally {
      setEditBusy(false)
    }
  }
  const deleteComment = async (commentId: string) => {
    if (editBusy) return
    setEditBusy(true)
    try {
      await adminFetch(`/api/admin/session/${id}/pr-comment-delete`, { method: 'POST', body: JSON.stringify({ pr_url: prUrl, comment_id: commentId }) })
      await refetchPr()
    } catch { /* keep prior state */ } finally {
      setEditBusy(false)
    }
  }
  return {
    reacting, resolving, expandedThreads, replyThread, replyText, replying, replyErr,
    pendingReplies, editingComment, editText, editBusy, editErr, discText,
    setExpandedThreads, setReplyThread, setReplyText, setReplyErr, setPendingReplies,
    setEditingComment, setEditText, setEditErr, setDiscText,
    toggleReaction, toggleResolve, submitReply, saveEdit, deleteComment,
  }
}

/** Discussion sub-tab: comments + review threads feed and the bottom composer. */
function PrDiscussion({ discussion, h, posting, postErr, postComment }: {
  discussion: PrDiscussionItemT[]
  h: ReturnType<typeof usePrDiscussion>
  posting: boolean
  postErr: string | null
  postComment: (text: string, done: () => void) => Promise<void>
}) {
  const { t } = useTranslation()
  const {
    reacting, resolving, expandedThreads, replyThread, replyText, replying, replyErr,
    pendingReplies, editingComment, editText, editBusy, editErr, discText,
    setExpandedThreads, setReplyThread, setReplyText, setReplyErr, setPendingReplies,
    setEditingComment, setEditText, setEditErr, setDiscText,
    toggleReaction, toggleResolve, submitReply, saveEdit, deleteComment,
  } = h
  return (
    <div className="flex flex-col gap-3">
      {discussion.length ? discussion.map((it, i) => it.kind === 'comment' ? (
        <div key={i} className="group rounded-lg border border-border p-3">
          <div className="mb-1.5 flex items-center gap-2 text-[12px]">
            {it.cm.avatar_url && <img loading="lazy" decoding="async" src={it.cm.avatar_url} alt="" className="size-5 rounded-full" />}
            <span className="font-medium">{it.cm.login}</span>
            <span className="text-muted-foreground">{it.cm.created_at ? new Date(it.cm.created_at).toLocaleString() : ''}</span>
            {it.cm.id && <CommentActions comment={it.cm} canWrite={it.cm.id.startsWith('PRRC_')} onEdit={() => { setEditingComment(it.cm.id); setEditText(it.cm.body); setEditErr('') }} onDelete={() => void deleteComment(it.cm.id)} />}
          </div>
          {editingComment === it.cm.id ? (
            <CommentEditor value={editText} onChange={setEditText} busy={editBusy} err={editErr} onCancel={() => { setEditingComment(''); setEditText(''); setEditErr('') }} onSave={() => void saveEdit(it.cm.id)} />
          ) : <div className="text-[13px]"><Markdown text={it.cm.body} /></div>}
          {it.cm.id && <ReactionRow commentId={it.cm.id} reactions={it.cm.reactions} reacting={reacting} onToggle={(cid, content, has) => void toggleReaction(cid, content, has)} />}
        </div>
      ) : (
        <div key={i} className="ml-6 overflow-hidden rounded-lg border border-border">
          <div
            role={it.th.is_resolved ? 'button' : undefined}
            onClick={it.th.is_resolved ? () => setExpandedThreads((m) => ({ ...m, [it.th.id]: !m[it.th.id] })) : undefined}
            className={cn('flex min-h-8 items-center gap-2 bg-muted/40 px-3 py-1.5', (!it.th.is_resolved || expandedThreads[it.th.id]) && 'border-b border-border', it.th.is_resolved && 'cursor-pointer hover:bg-muted/70')}
          >
            <Code size={14} className="shrink-0 text-muted-foreground" />
            <span className="truncate text-[12px] font-medium text-muted-foreground">{it.th.path.split('/').pop()}</span>
            <span className="ml-auto flex items-center gap-1.5 text-[12px] text-muted-foreground">
              {it.th.is_resolved && <span>{t('pr.resolved')}</span>}
              {it.th.is_outdated && <span>{t('pr.outdated')}</span>}
              L{it.th.line}
              {it.th.is_resolved && <ChevronDown size={12} className={cn('transition-transform', expandedThreads[it.th.id] && 'rotate-180')} />}
            </span>
          </div>
          {(!it.th.is_resolved || expandedThreads[it.th.id]) && <div className="flex flex-col gap-2.5 p-3">
            {it.th.comments.map((cm, j) => (
              <div key={j} className="group">
                <div className="mb-1 flex items-center gap-2 text-[12px]">
                  {cm.avatar_url && <img loading="lazy" decoding="async" src={cm.avatar_url} alt="" className="size-5 rounded-full" />}
                  <span className="font-medium">{cm.login}</span>
                  <span className="text-muted-foreground">{cm.created_at ? new Date(cm.created_at).toLocaleString() : ''}</span>
                  {cm.pending && <span className="rounded bg-orange-500/15 px-1.5 py-0.5 text-[11px] font-medium text-orange-500">{t('pr.pending')}</span>}
                  {cm.id && <CommentActions comment={cm} canWrite={cm.id.startsWith('PRRC_')} onEdit={() => { setEditingComment(cm.id); setEditText(cm.body); setEditErr('') }} onDelete={() => void deleteComment(cm.id)} />}
                </div>
                {editingComment === cm.id ? (
                  <CommentEditor value={editText} onChange={setEditText} busy={editBusy} err={editErr} onCancel={() => { setEditingComment(''); setEditText(''); setEditErr('') }} onSave={() => void saveEdit(cm.id)} />
                ) : <div className="text-[13px]"><Markdown text={cm.body} /></div>}
                {cm.id && <ReactionRow commentId={cm.id} reactions={cm.reactions} reacting={reacting} onToggle={(cid, content, has) => void toggleReaction(cid, content, has)} />}
              </div>
            ))}
            {(pendingReplies[it.th.id] || []).filter((pr2) => !it.th.comments.some((c) => c.id === pr2.id)).map((pr2, j) => (
              <div key={`p${j}`} className="group">
                <div className="mb-1 flex items-center gap-2 text-[12px]">
                  <span className="font-medium">{t('pr.you')}</span>
                  <span className="rounded bg-orange-500/15 px-1.5 py-0.5 text-[11px] font-medium text-orange-500">{t('pr.pending')}</span>
                  {pr2.id && (
                    <button
                      onClick={() => { void deleteComment(pr2.id); setPendingReplies((m) => ({ ...m, [it.th.id]: (m[it.th.id] || []).filter((x) => x !== pr2) })) }}
                      className="ml-auto cursor-pointer text-[11px] text-muted-foreground opacity-0 hover:text-red-500 group-hover:opacity-100"
                    >
                      Delete
                    </button>
                  )}
                </div>
                <div className="text-[13px]"><Markdown text={pr2.body} /></div>
              </div>
            ))}
            {it.th.id && (replyThread === it.th.id ? (
              <div className="rounded-md border border-border">
                <textarea
                  autoFocus
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submitReply(it.th.id) }}
                  placeholder={t('pr.replyPh')}
                  className="min-h-14 w-full resize-none rounded-md bg-background p-2.5 text-[13px] placeholder:text-muted-foreground focus:outline-none"
                />
                <div className="flex items-center justify-end gap-2 border-t border-border px-2 py-1.5">
                  {replyErr && <span className="mr-auto text-[12px] text-red-500">Failed: {replyErr}</span>}
                  <button onClick={() => { setReplyThread(''); setReplyText(''); setReplyErr('') }} className="cursor-pointer rounded-md px-2.5 py-1 text-[12px] text-muted-foreground hover:bg-accent">{t('common.cancel')}</button>
                  <button
                    disabled={replying || !replyText.trim()}
                    onClick={() => void submitReply(it.th.id, true)}
                    className={cn('rounded-md border border-border px-2.5 py-1 text-[12px] font-medium', replying || !replyText.trim() ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-accent')}
                  >
                    {(pendingReplies[it.th.id] || []).length || it.th.comments.some((c) => c.pending) ? t('pr.addReview') : t('pr.startReview')}
                  </button>
                  <button
                    disabled={replying || !replyText.trim()}
                    onClick={() => void submitReply(it.th.id)}
                    className={cn('rounded-md px-2.5 py-1 text-[12px] font-medium text-white', replying || !replyText.trim() ? 'cursor-not-allowed bg-blue-500/50' : 'cursor-pointer bg-blue-500 hover:bg-blue-600')}
                  >
                    {replying ? 'Replying…' : 'Reply'}
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => { setReplyThread(it.th.id); setReplyText(''); setReplyErr('') }}
                className="w-full cursor-pointer rounded-md border border-border px-2.5 py-1.5 text-left text-[12px] text-muted-foreground hover:bg-accent"
              >
                Reply to this thread...
              </button>
            ))}
            {it.th.id && (
              <div className="flex justify-end">
                <button
                  disabled={resolving === it.th.id}
                  onClick={() => void toggleResolve(it.th.id, it.th.is_resolved)}
                  className="flex cursor-pointer items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  <Check size={12} />
                  {it.th.is_resolved ? t('pr.markUnresolved') : t('pr.markResolved')}
                </button>
              </div>
            )}
          </div>}
        </div>
      )) : <p className="text-[13px] text-muted-foreground">{t('pr.noComments')}</p>}
      <div className="rounded-lg border border-border">
        <textarea value={discText} onChange={(e) => setDiscText(e.target.value)} placeholder={t('pr.addCommentPh')} className="min-h-16 w-full resize-none rounded-lg bg-background p-3 text-[13px] placeholder:text-muted-foreground focus:outline-none" />
        {(discText.trim() || postErr) && (
          <div className="flex items-center justify-end gap-2 border-t border-border px-2 py-1.5">
            {postErr && <span className="mr-auto text-[12px] text-red-500">Failed: {postErr}</span>}
            <button disabled={!discText.trim() || posting} onClick={() => void postComment(discText, () => setDiscText(''))} className={cn('rounded-md px-3 py-1 text-[13px] font-medium text-white', !discText.trim() || posting ? 'cursor-not-allowed bg-blue-500/50' : 'cursor-pointer bg-blue-500 hover:bg-blue-600')}>{posting ? 'Submitting…' : 'Comment'}</button>
          </div>
        )}
      </div>
    </div>
  )
}

export { type PrCommentT, type PrThreadT, type PrDiscussionItemT, usePrDiscussion, PrDiscussion };
