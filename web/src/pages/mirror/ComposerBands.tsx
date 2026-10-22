import { useRef, type Dispatch, type SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, Pencil, X } from 'lucide-react'
import { type TimelineItem } from '@/components/Timeline'
import { type ViewerCaps } from '@/lib/viewer'
import { BandItem } from '@/components/BeardBand'
import QuestionPanel from '@/components/QuestionPanel'
import { QUEUE_DASHED_SVG, QUEUE_DRAG_SVG } from './composerMeta'

/** Queue-row preview: stored queue text is the raw wire string — it can carry
 *  <quoted_artifact …> XML wrappers, ATTACHMENT:"url" marker lines and multi-line
 *  bodies. Render a readable one-line summary instead of raw markup. */
function queuePreview(raw: string): string {
  let s = raw
  s = s.replace(/<quoted_artifact\b[^>]*>([\s\S]*?)<\/quoted_artifact>/g, (_m, inner: string) => {
    const cap = inner.match(/<caption>([\s\S]*?)<\/caption>/)?.[1]?.trim()
    const body = inner.match(/<content>([\s\S]*?)<\/content>/)?.[1]?.trim()
    const excerpt = (cap || body || '').split('\n')[0].slice(0, 60)
    return excerpt ? `❝${excerpt}❞` : ''
  })
  s = s.replace(/^ATTACHMENT:"?([^"\n]+)"?\s*$/gm, '[附件] $1')
  s = s.replace(/<[^>]+>/g, '')
  return s.replace(/\s+/g, ' ').trim()
}

/** The BeardBand band rows: the sortable send-queue list (drag reorder, edit /
 *  remove / send-now) and the pending-question panel. Rendered only when the
 *  parent's band condition holds. */
function ComposerBands({ queued, setQueued, queueOpReq, queueReorder, queueEditStart, queueOp, editingQ, pending, caps, answerQuestion, setDismissedQ, sending }: {
  queued: { id: string; text: string }[]
  setQueued: Dispatch<SetStateAction<{ id: string; text: string }[]>>
  queueOpReq: (payload: { op: string; id?: string; ids?: string[]; held?: boolean; message?: string }) => Promise<boolean>
  queueReorder: (fromId: string, toId: string) => void
  queueEditStart: (qid: string, text: string) => void
  queueOp: (op: 'remove' | 'send_now', qid: string) => void
  editingQ: string | null
  pending: TimelineItem | null
  caps: ViewerCaps
  answerQuestion: (answers: string[][]) => void
  setDismissedQ: (v: string) => void
  sending: boolean
}) {
    const { t } = useTranslation()
    const dragQ = useRef<string | null>(null)
  return (
              <>
          {queued.length > 0 && (
            // Official queue band (sampled 2026-09-01): summary row h-8 "N message(s) queued" + Clear all icon;
            // sortable rows min-h-9 rounded-xl, clock icon, hover icon actions Edit / Remove from queue / Send now.
            <BandItem>
              <div className="flex h-8 items-center justify-between gap-2 py-1 pl-3.5 pr-1">
                <span className="truncate text-[12px] text-muted-foreground">{t('composer.queuedCount', { count: queued.length })}</span>
                <button
                  onClick={() => { void queueOpReq({ op: 'clear' }).then((ok) => { if (ok) setQueued([]) }) }}
                  aria-label={t('composer.clearAll')}
                  title={t('composer.clearAll')}
                  className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X size={16} />
                </button>
              </div>
              <ol className="flex max-h-60 flex-col overflow-y-auto">
                {queued.map((q) => (
                  <li
                    key={q.id}
                    draggable
                    role="button"
                    aria-roledescription="sortable"
                    onDragStart={() => { dragQ.current = q.id }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => { if (dragQ.current && dragQ.current !== q.id) void queueReorder(dragQ.current, q.id); dragQ.current = null }}
                    className={`group flex min-h-9 cursor-grab items-center gap-2 rounded-xl py-1.5 pl-3 pr-1.5 text-[13px] leading-[18px] opacity-80 hover:bg-accent hover:opacity-100 active:cursor-grabbing ${editingQ === q.id ? 'opacity-50' : ''}`}
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground group-hover:hidden" dangerouslySetInnerHTML={{ __html: QUEUE_DASHED_SVG }} />
                    <span className="hidden size-6 shrink-0 items-center justify-center text-muted-foreground group-hover:flex" dangerouslySetInnerHTML={{ __html: QUEUE_DRAG_SVG }} />
                    <span className="min-w-0 flex-1 truncate">{queuePreview(q.text)}</span>
                    <button
                      onClick={() => void queueEditStart(q.id, q.text)}
                      aria-label={t('composer.editMsg')}
                      title={t('composer.editMsg')}
                      className="hidden size-6 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-muted hover:text-foreground group-hover:flex"
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      onClick={() => void queueOp('remove', q.id)}
                      aria-label={t('composer.removeFromQueue')}
                      title={t('composer.removeFromQueue')}
                      className="hidden size-6 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-muted hover:text-foreground group-hover:flex"
                    >
                      <X size={16} />
                    </button>
                    <button
                      onClick={() => void queueOp('send_now', q.id)}
                      aria-label={t('composer.sendNow')}
                      title={t('composer.sendNow')}
                      className="hidden size-6 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-muted hover:text-foreground group-hover:flex"
                    >
                      <ArrowUp size={16} />
                    </button>
                  </li>
                ))}
              </ol>
            </BandItem>
          )}
          {pending && pending.questions?.length && caps.canAnswerQuestion ? (
            <BandItem>
              <QuestionPanel
                key={pending.id}
                questions={pending.questions}
                onSubmit={(answers) => void answerQuestion(answers)}
                onDismiss={() => setDismissedQ(pending.id)}
                disabled={sending}
              />
            </BandItem>
          ) : null}
              </>
  )
}

export { ComposerBands };
