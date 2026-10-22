import { useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { OSearch } from '../../components/officialIcons'
import { type TimelineItem } from '@/components/Timeline'
import { findItemText } from './panelTabs'

/* Ctrl+F in-transcript find (desktop parity): search item text, jump via
 * data-eid rows inside the transcript scroll container. Owns open/query/
 * position state + the window keydown listener; renders null while closed
 * (state persists across open/close, matching the pre-extraction page). */
function FindInSession({ items, scrollRef }: { items: TimelineItem[]; scrollRef: RefObject<HTMLDivElement> }) {
  const [findOpen, setFindOpen] = useState(false)
  const [findQ, setFindQ] = useState('')
  const [findPos, setFindPos] = useState(0)
  const findInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setFindOpen(true)
        requestAnimationFrame(() => findInputRef.current?.select())
      } else if (e.key === 'Escape' && findOpen) setFindOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [findOpen])

  // Matching item ids for the current query.
  const findHits = useMemo(() => {
    const q = findQ.trim().toLowerCase()
    if (!q) return [] as string[]
    const hits: string[] = []
    for (const it of items) {
      if (findItemText(it).includes(q)) hits.push(it.id)
      if (hits.length >= 500) break
    }
    return hits
  }, [items, findQ])
  const findCur = findHits.length ? findHits[Math.min(findPos, findHits.length - 1)] : null
  useEffect(() => { setFindPos(0) }, [findQ])
  useEffect(() => {
    if (!findCur) return
    const node = scrollRef.current?.querySelector<HTMLElement>(`[data-eid="${CSS.escape(findCur)}"]`)
    if (!node) return
    node.scrollIntoView({ block: 'center' })
    node.classList.add('dw-find-hit')
    return () => node.classList.remove('dw-find-hit')
  }, [findCur, scrollRef])

  if (!findOpen) return null
  return (
    <div className="absolute right-4 top-2 z-30 flex items-center gap-1 rounded-lg border border-border bg-card px-2 py-1 shadow-lg">
      <OSearch size={13} className="text-muted-foreground" />
      <input
        ref={findInputRef}
        autoFocus
        value={findQ}
        onChange={(e) => setFindQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); if (findHits.length) setFindPos((p) => (p + (e.shiftKey ? -1 : 1) + findHits.length) % findHits.length) }
          if (e.key === 'Escape') setFindOpen(false)
        }}
        placeholder="Find in session"
        className="w-44 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground"
      />
      <span className="min-w-[42px] text-center text-[11px] tabular-nums text-muted-foreground">
        {findQ ? `${findHits.length ? Math.min(findPos, findHits.length - 1) + 1 : 0}/${findHits.length}` : ''}
      </span>
      <button type="button" aria-label="Previous match" className="rounded p-0.5 hover:bg-accent disabled:opacity-40" disabled={!findHits.length}
        onClick={() => setFindPos((p) => (p - 1 + findHits.length) % findHits.length)}><ChevronUp size={14} /></button>
      <button type="button" aria-label="Next match" className="rounded p-0.5 hover:bg-accent disabled:opacity-40" disabled={!findHits.length}
        onClick={() => setFindPos((p) => (p + 1) % findHits.length)}><ChevronDown size={14} /></button>
      <button type="button" aria-label="Close find" className="rounded p-0.5 hover:bg-accent" onClick={() => setFindOpen(false)}><X size={14} /></button>
    </div>
  )
}

export { FindInSession }
