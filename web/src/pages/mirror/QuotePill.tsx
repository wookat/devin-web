import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Languages, Copy, Check, Loader2 } from 'lucide-react'
import { BubblePlusGlyph, CloseQuoteGlyph } from './glyphs'
import { translateText } from '@/lib/translate'
import { copyText } from '../../lib/clipboard'

/* Official dark-quote tokens (verbatim from app.devin.ai .dark scope):
   wax bg rgb(31,31,31,.94)+blur, border white/.04, text white/.9, hint /.52. */
const QWAX = 'rgb(31 31 31 / 0.94)'
const QBORDER = 'rgb(255 255 255 / 0.04)'
const QBORDER_FOCUS = 'rgb(255 255 255 / 0.08)'
const QTEXT = 'rgb(255 255 255 / 0.9)'
const QTINT = 'rgb(255 255 255 / 0.05)'

/** Floating quote affordance — official SelectionQuoteAffordance, two states:
 *  minimal  = dark pill above the anchor, [bubble-plus=Add caption]
 *             [close-quote-2=Add to chat ⏎]; typing begins the caption.
 *  expanded = the official 360px wax card: quoted-text preview header,
 *             caption input (min-h 28), footer split button
 *             [Add to chat | ▾ → Send immediately ⌘⏎]. Enter commits,
 *             ⌘/Ctrl+Enter sends immediately, Esc dismisses. */
function QuotePill({ x, y, placement = 'above', hidden, startExpanded, quoteText, onCommit, onSend, onClose }: {
  x: number; y: number; placement?: 'above' | 'below'; hidden?: boolean; startExpanded?: boolean; quoteText?: string
  onCommit: (caption: string) => void; onSend?: (caption: string) => void; onClose: () => void
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(!!startExpanded)
  const [caption, setCaption] = useState('')
  const [sendMenu, setSendMenu] = useState(false)
  // Selection translate: busy → result text card; fail flashes the icon red.
  const [trState, setTrState] = useState<'idle' | 'busy' | 'fail' | { text: string }>('idle')
  const [trCopied, setTrCopied] = useState(false)
  const doTranslate = async () => {
    if (trState === 'busy') return
    setTrState('busy')
    try {
      const result = await translateText(quoteText ?? '')
      setTrState({ text: result })
    } catch {
      setTrState('fail')
      setTimeout(() => setTrState('idle'), 1500)
    }
  }
  const capRef = useRef<HTMLInputElement>(null)
  const cardRef = useRef<HTMLFormElement>(null)
  const resultRef = useRef<HTMLDivElement>(null)
  const [cardH, setCardH] = useState(0)
  useEffect(() => { if (expanded) capRef.current?.focus() }, [expanded])
  // Official card geometry: top = anchor - measuredHeight when 'above' (the
  // anchor point is the layer origin; gap 6 already folded into y). The
  // translation result card is tall too — measure it the same way.
  const showingResult = typeof trState === 'object'
  const trText = showingResult ? trState.text : ''
  // The pill isn't remounted per selection — a stale translation from the
  // previous selection must not paint over a fresh one.
  useEffect(() => { setTrState('idle'); setTrCopied(false) }, [quoteText])
  useLayoutEffect(() => {
    const el = expanded ? cardRef.current : showingResult ? resultRef.current : null
    if (el) setCardH(el.getBoundingClientRect().height)
  }, [expanded, showingResult, trState])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        if (onSend) { e.preventDefault(); onSend(caption.trim()); return }
      }
      if (expanded) return
      if (e.key === 'Enter') { e.preventDefault(); onCommit(caption); return }
      if (e.key.length === 1 && !/\p{C}/u.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        setExpanded(true); setCaption(e.key)
      }
    }
    // Official: while the pill is up, a plain-text paste becomes the caption
    // (file clipboard items are ignored).
    const onPaste = (e: ClipboardEvent) => {
      if ([...(e.clipboardData?.items ?? [])].some((i) => i.kind === 'file')) return
      const txt = e.clipboardData?.getData('text/plain')
      if (txt) { e.preventDefault(); e.stopPropagation(); setExpanded(true); setCaption(txt) }
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('paste', onPaste, true)
    return () => { document.removeEventListener('keydown', onKey, true); document.removeEventListener('paste', onPaste, true) }
  }, [expanded, caption, onCommit, onSend, onClose])
  const iconBtn = 'flex h-6 w-6 items-center justify-center rounded-md'
  return (
    <div
      className="dw-quote-pill fixed left-0 top-0 z-50 select-none"
      style={{
        transform: `translate(${x}px, ${(expanded || showingResult) ? (placement === 'above' ? y - cardH : y) : (placement === 'above' ? y - 28 : y)}px)`,
        transformOrigin: placement === 'above' ? 'center bottom' : 'center top',
        visibility: hidden ? 'hidden' : undefined,
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {showingResult ? (
        /* Translation result card — same 360px wax geometry as the quote
           card: quoted source on top (faded, clamped), translation body,
           footer [copy][close]. */
        <div
          ref={resultRef}
          className="dark w-[360px] overflow-hidden rounded-[12px] border backdrop-blur"
          style={{ background: QWAX, borderColor: QBORDER, color: QTEXT }}
        >
          <div className="flex flex-col" style={{ padding: 6, gap: 10 }}>
            {quoteText && (
              <div className="line-clamp-3 text-[12px] leading-4" style={{ color: 'rgb(255 255 255 / 0.52)' }}>
                {quoteText}
              </div>
            )}
            <div className="max-h-48 overflow-auto whitespace-pre-wrap text-[13px] leading-5">
              {trText}
            </div>
            <div className="flex h-7 items-center justify-end gap-1">
              <button
                type="button"
                title={t('quote.copyTranslation')}
                aria-label={t('quote.copyTranslation')}
                className={iconBtn}
                style={{ color: QTEXT }}
                onMouseOver={(e) => (e.currentTarget.style.background = QTINT)}
                onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
                onClick={async () => {
                  await copyText(trText)
                  setTrCopied(true)
                  setTimeout(() => setTrCopied(false), 1200)
                }}
              >
                {trCopied ? <Check size={14} /> : <Copy size={14} />}
              </button>
              <button
                type="button"
                title={t('common.close')}
                aria-label={t('common.close')}
                className={iconBtn}
                style={{ color: QTEXT }}
                onMouseOver={(e) => (e.currentTarget.style.background = QTINT)}
                onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
                onClick={onClose}
              >
                ×
              </button>
            </div>
          </div>
        </div>
      ) : expanded ? (
        /* Official expanded card: 360px wax, r12, border secondary, blur, p6 gap10 */
        <form
          ref={cardRef}
          className="dark w-[360px] overflow-hidden rounded-[12px] border backdrop-blur"
          style={{ background: QWAX, borderColor: sendMenu ? QBORDER_FOCUS : QBORDER, color: QTEXT }}
          onSubmit={(e) => { e.preventDefault(); onCommit(caption.trim()) }}
        >
          <div className="flex flex-col" style={{ padding: 6, gap: 10 }}>
            {quoteText && (
              <div className="line-clamp-3 text-[12px] leading-4" style={{ color: 'rgb(255 255 255 / 0.52)' }}>
                {quoteText}
              </div>
            )}
            <input
              ref={capRef}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onCommit(caption.trim()) }
                if (e.key === 'Escape') { e.preventDefault(); setCaption(''); onClose() }
                e.stopPropagation()
              }}
              placeholder={t('quote.captionPh')}
              className="min-h-7 w-full bg-transparent text-[13px] leading-5 outline-none"
              style={{ color: QTEXT }}
            />
            <div className="flex h-7 items-stretch justify-end">
              {onSend ? (
                /* Official split button: [Add to chat][|][▾ → Send immediately ⌘⏎] */
                <div className="relative flex items-stretch rounded-[6px] border" style={{ borderColor: QBORDER_FOCUS, background: QTINT }}>
                  <button
                    type="submit"
                    className="rounded-l-[5px] px-2 text-[13px] hover:bg-[rgb(255_255_255/0.08)]"
                    style={{ color: QTEXT }}
                  >{t('quote.addToChat')}</button>
                  <div className="w-px" style={{ background: QBORDER_FOCUS }} />
                  <button
                    type="button"
                    aria-label={t('quote.moreOptions')}
                    className="flex w-6 items-center justify-center rounded-r-[5px] hover:bg-[rgb(255_255_255/0.08)]"
                    onClick={() => setSendMenu((v) => !v)}
                  >
                    <ChevronDown size={13} />
                  </button>
                  {sendMenu && (
                    <div className="absolute right-0 top-[30px] z-10 min-w-[180px] rounded-lg border p-1 shadow-md" style={{ background: QWAX, borderColor: QBORDER, backdropFilter: 'blur(8px)' }}>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1 text-left text-[13px] hover:bg-[rgb(255_255_255/0.05)]"
                        style={{ color: QTEXT }}
                        onClick={() => onSend(caption.trim())}
                      >
                        <span>{t('quote.sendImmediately')}</span>
                        <kbd className="flex gap-0.5 text-[10px]" style={{ color: 'rgb(255 255 255 / 0.52)' }}>⌘⏎</kbd>
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <button type="submit" className="rounded-[6px] px-2 text-[13px] hover:bg-[rgb(255_255_255/0.08)]" style={{ color: QTEXT, background: QTINT }}>
                  {t('quote.addToChat')}
                </button>
              )}
            </div>
          </div>
        </form>
      ) : (
        /* Official minimal pill (verbatim `ht` class): h-7 gap-px rounded-8
           p-0.5, bg-elevated, shadow-L1, ring-inset border-secondary */
        <div
          className="flex h-7 min-w-fit items-center gap-px whitespace-nowrap rounded-[8px] p-0.5 shadow-[0_1px_2px_0_rgba(0,0,0,0.2)] ring-1 ring-inset ring-[rgb(255_255_255/0.04)]"
          style={{ background: 'rgb(31 31 31)', color: QTEXT }}
        >
          <button
            type="button"
            title={`${t('quote.addCaption')} — ${t('quote.startTyping')}`}
            aria-label={t('quote.addCaption')}
            className={iconBtn}
            style={{ color: QTEXT }}
            onMouseOver={(e) => (e.currentTarget.style.background = QTINT)}
            onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
            onClick={() => setExpanded(true)}
          >
            <BubblePlusGlyph className="size-4" />
          </button>
          <button
            type="submit"
            title={`${t('quote.addToChat')} ⏎`}
            aria-label={t('quote.addToChat')}
            className={iconBtn}
            style={{ color: QTEXT }}
            onMouseOver={(e) => (e.currentTarget.style.background = QTINT)}
            onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
            onClick={() => onCommit(caption.trim())}
          >
            <CloseQuoteGlyph className="size-4" />
          </button>
          {!!quoteText?.trim() && (
            <button
              type="button"
              title={trState === 'fail' ? t('sc.translateUnavailable') : t('quote.translate')}
              aria-label={t('quote.translate')}
              className={iconBtn}
              style={{ color: trState === 'fail' ? 'rgb(239 68 68)' : QTEXT }}
              onMouseOver={(e) => (e.currentTarget.style.background = QTINT)}
              onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
              onClick={() => void doTranslate()}
            >
              {trState === 'busy' ? <Loader2 size={14} className="animate-spin" /> : <Languages size={14} />}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export { QuotePill }
