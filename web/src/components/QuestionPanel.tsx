import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight, Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface PanelQuestion {
  question: string
  options: string[]
  allow_multiple?: boolean
}

// Official pending-question band item (sampled live 2026-09-01, session 299a7039):
// header row min-h-10 pl-14 pr-4 gap-2 with 14/20 question text, 24px pager controls and
// "N of M" 13/18 tabular label; option rows role=button 36px rounded-12 py-2 pl-3 pr-1.5 gap-2,
// left slot h-5 holding either a 16px role=checkbox (multi) or a 12/16 secondary <kbd> letter
// (single); multi-select footer mt-2 right-aligned 24px "Next" button (12/16, px-2, radius 6).
const NAV_BTN =
  'flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-black/[0.04] hover:text-foreground disabled:pointer-events-none disabled:opacity-50 dark:hover:bg-white/[0.06]'

export default function QuestionPanel({ questions, onSubmit, onDismiss, disabled }: {
  questions: PanelQuestion[]
  onSubmit: (answers: string[][]) => void
  onDismiss: () => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const [idx, setIdx] = useState(0)
  const [picked, setPicked] = useState<string[][]>(() => questions.map(() => []))
  const q = questions[Math.min(idx, questions.length - 1)]
  if (!q) return null
  const last = idx >= questions.length - 1

  function finish(next: string[][]) {
    if (last) onSubmit(next)
    else setIdx(idx + 1)
  }

  function pickSingle(o: string) {
    const next = picked.map((p, i) => (i === idx ? [o] : p))
    setPicked(next)
    finish(next)
  }

  function toggle(o: string) {
    setPicked(picked.map((p, i) => (i === idx ? (p.includes(o) ? p.filter((x) => x !== o) : [...p, o]) : p)))
  }

  const multi = !!q.allow_multiple

  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex min-h-10 items-center gap-2 pl-3.5 pr-1">
        <p className="min-w-0 flex-1 text-[14px] leading-5 text-foreground">{q.question}</p>
        {questions.length > 1 && (
          <div className="flex shrink-0 items-center" role="presentation">
            <button aria-label={t('composer.qPrev')} disabled={idx === 0} onClick={() => setIdx(idx - 1)} className={NAV_BTN}>
              <ChevronLeft size={16} />
            </button>
            <span className="w-9 text-center text-[13px] leading-[18px] tabular-nums text-muted-foreground/70">
              {t('composer.qOf', { i: idx + 1, n: questions.length })}
            </span>
            <button aria-label={t('composer.qNext')} disabled={last} onClick={() => setIdx(idx + 1)} className={NAV_BTN}>
              <ChevronRight size={16} />
            </button>
          </div>
        )}
        <button onClick={onDismiss} aria-label={t('common.dismiss')} className={NAV_BTN}>
          <X size={16} />
        </button>
      </div>
      <div role="presentation" className="max-h-[300px] overflow-y-auto">
        <div className="flex flex-col">
          {q.options.map((o, i) => {
            const sel = !!picked[idx]?.includes(o)
            return (
              <div
                key={o}
                role="button"
                tabIndex={disabled ? -1 : 0}
                onClick={() => !disabled && (multi ? toggle(o) : pickSingle(o))}
                onKeyDown={(e) => {
                  if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); (multi ? toggle : pickSingle)(o) }
                }}
                className={cn(
                  'flex min-h-9 items-center gap-2 rounded-xl py-2 pl-3 pr-1.5',
                  disabled ? 'cursor-default opacity-60' : 'cursor-pointer hover:bg-black/[0.04] dark:hover:bg-white/[0.06]',
                  multi && sel && 'bg-black/[0.04] dark:bg-white/[0.06]',
                )}
              >
                <div className="flex h-5 shrink-0 items-center">
                  {multi ? (
                    <span
                      role="checkbox"
                      aria-checked={sel}
                      className={cn(
                        'flex size-4 items-center justify-center rounded-[4px] border',
                        sel ? 'border-blue-500 bg-blue-500 text-white' : 'border-black/[0.08] bg-transparent dark:border-white/[0.12]',
                      )}
                    >
                      {sel && <Check size={12} strokeWidth={3} />}
                    </span>
                  ) : (
                    <kbd className="font-sans text-[12px] leading-4 text-muted-foreground">{String.fromCharCode(65 + i)}</kbd>
                  )}
                </div>
                <p className="min-w-0 flex-1 text-[14px] leading-5 text-foreground">{o}</p>
              </div>
            )
          })}
        </div>
      </div>
      {multi && (
        <div className="mt-2 flex justify-end">
          <button
            disabled={disabled || !picked[idx]?.length}
            onClick={() => finish(picked)}
            className="flex h-6 cursor-pointer items-center gap-[3px] rounded-[6px] border border-border bg-card px-2 text-[12px] font-medium leading-4 text-foreground hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
          >
            <span>{last ? t('composer.qSubmit') : t('composer.qNextBtn')}</span>
          </button>
        </div>
      )}
    </div>
  )
}
