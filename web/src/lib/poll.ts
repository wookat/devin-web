/** setInterval that pauses while the tab is hidden and fires once on return. */
export function visibleInterval(fn: () => void, ms: number): () => void {
  let iv: number | null = null
  const start = () => {
    if (iv == null && document.visibilityState === 'visible') iv = window.setInterval(fn, ms)
  }
  const stop = () => {
    if (iv != null) { clearInterval(iv); iv = null }
  }
  const onVis = () => {
    if (document.visibilityState === 'visible') { fn(); start() } else stop()
  }
  start()
  document.addEventListener('visibilitychange', onVis)
  return () => { stop(); document.removeEventListener('visibilitychange', onVis) }
}
