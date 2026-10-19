// Official pill tooltip (sampled live): role=tooltip dark card above the pill
// (rounded-md, 12px text, elevated bg + border + shadow, 6px offset, centered).
export function showPillTooltip(anchor: HTMLElement, text: string): () => void {
  const tip = document.createElement('div')
  tip.setAttribute('role', 'tooltip')
  tip.className =
    'pointer-events-none fixed z-[100] max-h-64 max-w-[360px] overflow-hidden whitespace-pre-line rounded-md border border-border bg-popover px-2 py-1 text-[12px] text-foreground shadow-md'
  tip.textContent = text
  // Official enter/exit: scale 0.96→1 + opacity 0→1 over 75ms (sampled computed styles).
  tip.style.opacity = '0'
  tip.style.transform = 'scale(0.96)'
  tip.style.transition = 'transform 75ms, opacity 75ms'
  document.body.appendChild(tip)
  const r = anchor.getBoundingClientRect()
  const tr = tip.getBoundingClientRect()
  tip.style.left = `${Math.max(4, r.left + r.width / 2 - tr.width / 2)}px`
  tip.style.top = `${Math.max(4, r.top - tr.height - 6)}px`
  requestAnimationFrame(() => {
    tip.style.opacity = '1'
    tip.style.transform = 'none'
  })
  const remove = () => {
    tip.style.opacity = '0'
    tip.style.transform = 'scale(0.96)'
    window.setTimeout(() => tip.remove(), 80)
  }
  const guard = window.setInterval(() => {
    if (!anchor.isConnected) {
      tip.remove()
      window.clearInterval(guard)
    }
  }, 300)
  return () => {
    remove()
    window.clearInterval(guard)
  }
}
