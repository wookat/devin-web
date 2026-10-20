import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ThumbsUp, ThumbsDown } from 'lucide-react'
import { Textarea } from '@/components/ui'
import { cn } from '@/lib/utils'

const FEEDBACK_CATEGORIES = ['Incorrect code', 'Did not follow instructions', 'Incomplete', 'Other']

/** Official-style Good/Bad response dialog (POST /api/sessions/<id>/feedback upstream). */
function FeedbackDialog({ variant, onClose, onSubmit }: {
  variant: 'positive' | 'negative'
  onClose: () => void
  onSubmit: (comment: string, categories: string[]) => Promise<void>
}) {
  const { t } = useTranslation()
  const [comment, setComment] = useState('')
  const [cats, setCats] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const negative = variant === 'negative'
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-xl border border-border bg-background p-4 shadow-lg" onClick={(e) => e.stopPropagation()}>
        <p className="flex items-center gap-2 text-[14px] font-medium leading-[20px]">
          {negative ? <ThumbsDown size={15} /> : <ThumbsUp size={15} />}
          {negative ? 'Bad response' : 'Good response'}
        </p>
        <p className="mt-1 text-[13px] leading-[18px] text-muted-foreground">{t('dlg.tellMore')}</p>
        {negative && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {FEEDBACK_CATEGORIES.map((cat) => (
              <button
                key={cat}
                onClick={() => setCats((p) => p.includes(cat) ? p.filter((x) => x !== cat) : [...p, cat])}
                className={cn('cursor-pointer rounded-full border px-2.5 py-1 text-[12px] leading-[16px]', cats.includes(cat) ? 'border-foreground bg-foreground text-background' : 'border-border text-muted-foreground hover:text-foreground')}
              >
                {cat}
              </button>
            ))}
          </div>
        )}
        <Textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder={negative ? 'Add more details... (Optional but highly appreciated!)' : 'Add more details... (Optional)'}
          rows={3}
          className="mt-3 w-full text-[13px]"
        />
        {err && <p className="mt-2 text-[12px] text-red-500">{err}</p>}
        <div className="mt-3 flex justify-end gap-2">
          <button
            onClick={async () => {
              setBusy(true)
              try {
                await onSubmit('', [])
              } catch { /* skip is best-effort */ }
              setBusy(false)
              onClose()
            }}
            disabled={busy}
            className="cursor-pointer rounded-md px-3 py-1.5 text-[13px] text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            Skip
          </button>
          <button
            onClick={async () => {
              setBusy(true)
              setErr(null)
              try {
                await onSubmit(comment, cats)
                onClose()
              } catch (e) {
                setErr((e as Error).message)
              } finally {
                setBusy(false)
              }
            }}
            disabled={busy}
            className="cursor-pointer rounded-md bg-foreground px-3 py-1.5 text-[13px] text-background disabled:opacity-50"
          >
            {busy ? 'Submitting...' : 'Submit'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Preferred translation target from the browser locale (official derives it
 * from the user's preferred language).
 */

export { FEEDBACK_CATEGORIES, FeedbackDialog };
