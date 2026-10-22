import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SmilePlus, MoreHorizontal, Pencil, Link2, Copy, ArrowUpRight, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'

// Official reaction set: the 8 GitHub reactions, in the picker's order.
const REACTION_SET: readonly (readonly [string, string, string])[] = [
  ['+1', '👍', 'Thumbs up'], ['-1', '👎', 'Thumbs down'], ['laugh', '😄', 'Laugh'], ['hooray', '🎉', 'Hooray'],
  ['confused', '😕', 'Confused'], ['heart', '❤️', 'Heart'], ['rocket', '🚀', 'Rocket'], ['eyes', '👀', 'Eyes'],
]

/**
 * "Add reaction" picker, mirroring the official dialog popover: a search
 * input filtering the 8 GitHub reactions by name, click to add.
 */
function ReactionPicker({ onPick }: { onPick: (content: string) => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const shown = REACTION_SET.filter(([content, , label]) => !q.trim() || label.toLowerCase().includes(q.trim().toLowerCase()) || content.includes(q.trim().toLowerCase()))
  return (
    <span className="relative">
      <button aria-label={t('pr.addReaction')} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setOpen((v) => !v); setQ('') }} className="flex size-6 cursor-pointer items-center justify-center rounded-full border border-border text-muted-foreground hover:bg-accent hover:text-foreground">
        <SmilePlus size={13} />
      </button>
      {open && (
        <div role="dialog" className="absolute bottom-7 left-0 z-30 w-56 rounded-lg border border-border bg-popover p-2 shadow-lg">
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} className="mb-2 w-full rounded-md border border-border bg-background px-2 py-1 text-[12px] focus:outline-none" />
          <div className="flex flex-wrap gap-1">
            {shown.map(([content, emoji, label]) => (
              <button key={content} aria-label={t('pr.react.'+content)} title={t('pr.react.'+content)} onClick={() => { onPick(content); setOpen(false) }} className="flex size-7 cursor-pointer items-center justify-center rounded-md text-[15px] hover:bg-accent">{emoji}</button>
            ))}
          </div>
        </div>
      )}
    </span>
  )
}

/**
 * Reaction row: the official quick pills (Thumbs up / Eyes / Confused),
 * pills for any other reaction group with count > 0, and the Add reaction picker.
 */
/**
 * Official comment "More actions" menu (first-hand capture): Copy link /
 * Copy message / Open in GitHub on every comment; Edit and Delete additionally
 * on review comments (PRRC_ ids, the gh/review-comments write endpoint's type).
 * Copy link copies the session URL + #comment-<id>; Delete has no confirm dialog.
 */
function CommentActions({ comment, canWrite, onEdit, onDelete }: { comment: { id: string; body: string; url?: string }; canWrite: boolean; onEdit: () => void; onDelete: () => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  const item = 'flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[13px] hover:bg-accent'
  return (
    <div ref={ref} className="relative ml-auto">
      <button aria-label={t('pr.moreActions')} onClick={() => setOpen((v) => !v)} className="cursor-pointer rounded-md p-1 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100 aria-expanded:opacity-100" aria-expanded={open}>
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-6 z-20 min-w-[180px] overflow-hidden rounded-[10px] border border-border bg-popover py-1 shadow-lg">
          {canWrite && <button role="menuitem" className={item} onClick={() => { setOpen(false); onEdit() }}><Pencil size={13} /> {t('common.edit')}</button>}
          <button role="menuitem" className={item} onClick={() => { void navigator.clipboard.writeText(`${location.origin}${location.pathname}#comment-${comment.id}`); setOpen(false) }}><Link2 size={13} /> {t('common.copyLink')}</button>
          <button role="menuitem" className={item} onClick={() => { void navigator.clipboard.writeText(comment.body); setOpen(false) }}><Copy size={13} /> {t('common.copyMsg')}</button>
          {comment.url && <a role="menuitem" href={comment.url} target="_blank" rel="noreferrer" className={item} onClick={() => setOpen(false)}><ArrowUpRight size={13} /> {t('common.openGithub')}</a>}
          {canWrite && <button role="menuitem" className={cn(item, 'text-red-500 hover:text-red-500')} onClick={() => { setOpen(false); onDelete() }}><Trash2 size={13} /> {t('common.delete')}</button>}
        </div>
      )}
    </div>
  )
}

/** Official Edit editor semantics (first-hand capture): inline editor prefilled
 * with the raw body, Cancel/Save footer; Save PATCHes gh/review-comments. */
function CommentEditor({ value, onChange, busy, err, onCancel, onSave }: { value: string; onChange: (v: string) => void; busy: boolean; err: string; onCancel: () => void; onSave: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="rounded-md border border-border">
      <textarea autoFocus value={value} onChange={(e) => onChange(e.target.value)} className="min-h-24 w-full resize-y rounded-md bg-background p-2.5 font-mono text-[12px] focus:outline-none" />
      <div className="flex items-center justify-end gap-2 border-t border-border px-2 py-1.5">
        {err && <span className="mr-auto text-[12px] text-red-500">Failed: {err}</span>}
        <button onClick={onCancel} className="cursor-pointer rounded-md px-2.5 py-1 text-[12px] text-muted-foreground hover:bg-accent">{t('common.cancel')}</button>
        <button disabled={busy || !value.trim()} onClick={onSave} className={cn('rounded-md px-2.5 py-1 text-[12px] font-medium text-white', busy || !value.trim() ? 'cursor-not-allowed bg-blue-500/50' : 'cursor-pointer bg-blue-500 hover:bg-blue-600')}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  )
}

function ReactionRow({ commentId, reactions, reacting, onToggle }: { commentId: string; reactions?: { content: string; count: number; viewer_reacted: boolean }[]; reacting: string; onToggle: (commentId: string, content: string, has: boolean) => void }) {
  const { t } = useTranslation()
  const quick = ['+1', 'eyes', 'confused']
  const extra = REACTION_SET.filter(([content]) => !quick.includes(content) && (reactions?.find((x) => x.content === content)?.count ?? 0) > 0)
  const items = [...REACTION_SET.filter(([content]) => quick.includes(content)), ...extra]
  return (
    <div className="mt-1.5 flex items-center gap-1">
      {items.map(([content, emoji]) => {
        const grp = reactions?.find((x) => x.content === content)
        const has = !!grp?.viewer_reacted
        return (
          <button key={content} aria-label={t('pr.react.'+content)} title={t('pr.react.'+content)} disabled={reacting === `${commentId}:${content}`} onClick={() => onToggle(commentId, content, has)} className={cn('flex h-6 cursor-pointer items-center gap-1 rounded-full border px-2 text-[12px] disabled:opacity-50', has ? 'border-blue-500/40 bg-blue-500/10' : 'border-border hover:bg-accent')}>
            {emoji}
            {grp && grp.count > 0 ? <span className="tabular-nums">{grp.count}</span> : null}
          </button>
        )
      })}
      <ReactionPicker onPick={(content) => { const grp = reactions?.find((x) => x.content === content); onToggle(commentId, content, !!grp?.viewer_reacted) }} />
    </div>
  )
}

export { REACTION_SET, ReactionPicker, CommentActions, CommentEditor, ReactionRow };
