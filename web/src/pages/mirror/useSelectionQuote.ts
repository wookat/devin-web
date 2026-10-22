/**
 * useSelectionQuote — Selection → quote draft (official
 * SelectionQuoteAffordance, message-text scope): select text inside a
 * message bubble → floating pill → click adds it to the composer as a quote
 * chip; send() serializes drafts into <quoted_artifact> markup so the
 * round-trip renders real QuoteChips.
 */
import { useEffect, useRef, useState } from 'react'
import { type TimelineItem } from '@/components/Timeline'
import { type DraftQuote, type SelQuote } from './ComposerFooter'

type QuoteSrc = { text: string; eventId: string; author: 'user' | 'devin'; tsMs?: number; kind?: 'message' | 'worklog'; endEventId?: string }

export function useSelectionQuote({ isVisitor, isDraft, isSub, allItemsRef }: {
  isVisitor: boolean
  isDraft: boolean
  isSub: boolean
  allItemsRef: { current: TimelineItem[] }
}) {
  const [selQuote, setSelQuote] = useState<SelQuote | null>(null)
  const [draftQuotes, setDraftQuotes] = useState<DraftQuote[]>([])
  const quoteGuardUntil = useRef(0)
  const quoteDraftFrom = (q: QuoteSrc, caption: string): DraftQuote => ({
    kind: q.kind ?? 'message',
    label: q.kind === 'worklog' ? 'Worklog' : q.author === 'devin' ? 'Devin message' : 'User message',
    text: q.text, eventId: q.eventId, tsMs: q.tsMs, author: q.author,
    ...(q.endEventId ? { endEventId: q.endEventId } : {}),
    ...(caption ? { caption } : {}),
  } as DraftQuote)
  const stageQuoteDraft = (q: QuoteSrc, caption: string) => {
    setDraftQuotes((d) => d.some((x) => x.eventId === q.eventId && x.text === q.text) ? d : [...d, quoteDraftFrom(q, caption)])
    window.getSelection()?.removeAllRanges()
  }
  useEffect(() => {
    if (isVisitor || isDraft || isSub) { setSelQuote(null); return }
    const onSel = () => {
      const sel = window.getSelection()
      // Toolbar-opened quotes (expanded pill) outlive the selection collapse
      // that clicking the toolbar button itself fires; and while focus lives
      // inside the pill (caption input), collapses don't dismiss it either.
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        if (Date.now() > quoteGuardUntil.current && !document.activeElement?.closest?.('.dw-quote-pill')) setSelQuote(null)
        return
      }
      quoteGuardUntil.current = 0
      const node = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement
      const host = node?.closest?.('[data-eid]')
      if (!host) { setSelQuote(null); return }
      const range = sel.getRangeAt(0)
      // Official Bt/Wt/Ut port: anchor rect from getClientRects (≤3.5-line
      // spans anchor above the whole block; else backwards→start-above,
      // forwards→end-below), left-edge horizontal clamp (margin 8, gap 6),
      // pill size {w53,h28}, hidden when the anchor rect leaves every
      // overflow ancestor's vertical band.
      const quoteAnchor = (): { x: number; y: number; placement: 'above' | 'below'; hidden: boolean } => {
        const rects = range.getClientRects()
        const r0 = rects[0]; const rN = rects[rects.length - 1]
        const an = sel.anchorNode; const fn = sel.focusNode
        const backwards = !!an && !!fn && (an === fn ? sel.focusOffset < sel.anchorOffset : !!(an.compareDocumentPosition(fn) & Node.DOCUMENT_POSITION_PRECEDING))
        let ar: { top: number; bottom: number; left: number }; let above: boolean
        if (!r0 || !rN) { const b = range.getBoundingClientRect(); ar = { top: b.top, bottom: b.bottom, left: b.left }; above = backwards }
        else if (r0 !== rN && rN.bottom - r0.top <= Math.max(r0.height, rN.height) * 3.5) { ar = { top: r0.top, bottom: rN.bottom, left: r0.left }; above = true }
        else if (backwards) { ar = { top: r0.top, bottom: r0.bottom, left: r0.left }; above = true }
        else { ar = { top: rN.top, bottom: rN.bottom, left: rN.right }; above = false }
        const M = 8, G = 6, PW = 53, PH = 28
        const x = Math.min(Math.max(ar.left, M), window.innerWidth - M - PW)
        const fitsAbove = ar.top - G - PH >= M; const fitsBelow = ar.bottom + G + PH <= window.innerHeight - M
        const placement: 'above' | 'below' = above ? (fitsAbove || !fitsBelow ? 'above' : 'below') : (fitsBelow || !fitsAbove ? 'below' : 'above')
        const y = placement === 'above' ? ar.top - G : ar.bottom + G
        let hidden = false
        for (let el = (range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement); el; el = el.parentElement) {
          if (getComputedStyle(el).overflowY === 'visible') continue
          const er = el.getBoundingClientRect()
          if (ar.bottom <= er.top || ar.top >= er.bottom) { hidden = true; break }
        }
        return { x, y, placement, hidden }
      }
      const eid = host.getAttribute('data-eid')
      const item = allItemsRef.current.find((it) => it.id === eid)
      // Official second mechanism: selections spanning worklog rows resolve
      // to a kind:'worklog' quote over the [start,end) event-id range.
      if (!item || item.kind !== 'message') {
        const anchors = [...document.querySelectorAll<HTMLElement>('[data-quote-anchor]')]
          .filter((a) => range.intersectsNode(a))
        if (anchors.length >= 1 && item?.kind !== 'message') {
          const first = anchors[0].getAttribute('data-quote-anchor')
          const last = anchors[anchors.length - 1].getAttribute('data-quote-anchor')
          const text = sel.toString().replace(/\s+/g, ' ').trim()
          const pos = quoteAnchor()
          if (text && first && last) {
            setSelQuote({ ...pos, text, eventId: first, endEventId: last, author: 'devin', kind: 'worklog' })
            return
          }
        }
        setSelQuote(null); return
      }
      // Official extraction (xt): clone the range offscreen and strip
      // .select-none UI chrome (badges, action bars) before taking text.
      const frag = sel.getRangeAt(0).cloneContents()
      let text: string
      if (!frag.querySelector('.select-none')) text = sel.toString().replace(/\s+/g, ' ').trim()
      else {
        const off = host.ownerDocument.createElement('div')
        off.style.cssText = 'position:fixed;left:-99999px;top:0'
        off.appendChild(frag)
        off.querySelectorAll('.select-none').forEach((n) => n.remove())
        text = (off.innerText || '').replace(/\s+/g, ' ').trim()
        off.remove()
      }
      if (!text) { setSelQuote(null); return }
      const pos = quoteAnchor()
      setSelQuote({
        ...pos,
        text,
        eventId: eid!,
        author: item.role === 'user' ? 'user' : 'devin',
        tsMs: Date.parse(item.ts) || undefined,
      })
    }
    document.addEventListener('selectionchange', onSel)
    window.addEventListener('pointerup', onSel)
    return () => { document.removeEventListener('selectionchange', onSel); window.removeEventListener('pointerup', onSel) }
  }, [isVisitor, isDraft, isSub])

  return { selQuote, setSelQuote, draftQuotes, setDraftQuotes, quoteGuardUntil, quoteDraftFrom, stageQuoteDraft }
}
