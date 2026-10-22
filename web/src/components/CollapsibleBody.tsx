import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

const CLAMP = 298
const MASK = 'linear-gradient(black calc(100% - 76px), rgba(0, 0, 0, 0.15) calc(100% - 26px), transparent)'

/** Official user-message clamp: bodies taller than 298px collapse with a bottom fade. */
export default function CollapsibleBody({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => setOverflowing(el.scrollHeight > CLAMP)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const clamped = overflowing && !expanded
  return (
    <div
      className={cn('group/collapsible relative overflow-hidden -mx-3.5 -mb-2 !max-w-none', clamped && 'cursor-pointer')}
      onClick={clamped ? () => setExpanded(true) : undefined}
    >
      <div
        ref={ref}
        className="px-3.5 pb-2"
        style={clamped ? { maxHeight: CLAMP, maskImage: MASK, WebkitMaskImage: MASK } : undefined}
      >
        {children}
      </div>
      {overflowing && (
        <button
          type="button"
          aria-label={expanded ? t('common.collapse') : t('common.expand')}
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}
          className={cn(
            'relative z-10 -mt-5 flex h-[20px] w-full items-center justify-center',
            clamped && 'opacity-0 focus-visible:opacity-100 group-hover/collapsible:opacity-100',
          )}
        >
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-1 text-[12px] font-medium text-foreground hover:bg-accent">
            {expanded ? 'Collapse' : 'Expand'}
            {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </span>
        </button>
      )}
    </div>
  )
}
