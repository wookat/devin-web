import { useState } from 'react'
import type { QuoteAttachment } from '../../shared/quotes'
import { LightboxImage } from './Lightbox'
import { cn } from '@/lib/utils'

/**
 * Official quote pill (quote-pill bundle + live sample): 46px tall, 4px rounded
 * bar (text-tertiary), p-1.5 pl-[12px] pr-[32px], gap-[10px], rounded-[10px];
 * 12px secondary line + 13px primary line (see the two-line rule below). A quote
 * that carries a screenshot (preview-element capture) leads with a 36px
 * thumbnail (`size-9 rounded-[6px] object-cover`) that opens the image preview.
 */
/** Official `useQuoteLink` resolves a target for message/worklog (event), shell (tab) and file (path) quotes. */
export function quoteHasTarget(q: QuoteAttachment): boolean {
  return !!(q.eventId || q.path || q.kind === 'shell')
}

export default function QuoteChip({ quote, onNavigate }: { quote: QuoteAttachment; onNavigate?: (quote: QuoteAttachment) => void }) {
  // Official quote-pill: with a caption the primary line is the “caption” and
  // the secondary line the quoted text; without one the primary line is the
  // quoted text (truncated) and the secondary line the artifact label
  // ("Devin message", "Worklog", file basename, preview component/selector).
  const isPreview = quote.kind === 'preview'
  const hasCaption = quote.caption !== undefined
  const top = hasCaption
    ? isPreview ? quote.text || quote.label || 'Preview element' : quote.text
    : quote.label
  const main = hasCaption ? `\u201c${quote.caption}\u201d` : isPreview ? quote.text || 'Preview element' : quote.text
  const clickable = !!(onNavigate && quoteHasTarget(quote))
  // Official screenshot provider renders nothing when the image fails to load.
  const [shotFailed, setShotFailed] = useState(false)
  const cls = cn(
    'group/attachment relative flex w-fit max-w-full shrink-0 items-center gap-[10px] rounded-[10px] bg-tint-tertiary p-1.5 pl-[12px] pr-[32px] text-left text-foreground no-underline',
    clickable && 'cursor-pointer hover:bg-tint-secondary',
  )
  const inner = (
    <>
      {quote.screenshot && !shotFailed && (
        <span
          data-quote-screenshot
          className="flex size-9 shrink-0 overflow-hidden rounded-[6px]"
          onClick={(e) => e.stopPropagation()}
        >
          <LightboxImage
            src={quote.screenshot.url}
            alt={quote.screenshot.filename || ''}
            className="size-9 rounded-[6px] object-cover"
            onError={() => setShotFailed(true)}
          />
        </span>
      )}
      <div className="mb-[3.5px] mt-[5px] w-1 shrink-0 self-stretch rounded-full bg-text-tertiary" aria-hidden="true" />
      <div className="flex min-w-0 flex-col justify-center">
        <span className="block min-w-0 text-[12px] font-normal leading-4 text-muted-foreground">
          <span className="block min-w-0 truncate" title={top}>{top}</span>
        </span>
        <span className="block min-w-0 text-[13px] font-normal leading-[18px] text-foreground">
          {hasCaption ? (
            <span className="block min-w-0 whitespace-pre-wrap break-words">{main}</span>
          ) : (
            <span className="block min-w-0 truncate" title={main}>{main}</span>
          )}
        </span>
      </div>
    </>
  )
  if (clickable) {
    return (
      <button type="button" data-quote-chip className={cls} onClick={() => onNavigate?.(quote)} aria-label={`Quoted ${quote.label}`}>
        {inner}
      </button>
    )
  }
  return <div data-quote-chip className={cls}>{inner}</div>
}
