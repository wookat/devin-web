const timers = new WeakMap<Element, number>()

/** Show the scrollbar thumb while an element is actively scrolling (official-style reveal). */
export function initScrollReveal() {
  document.addEventListener(
    'scroll',
    (e) => {
      const el = e.target
      if (!(el instanceof Element)) return
      el.setAttribute('data-wb-scrolling', '')
      const prev = timers.get(el)
      if (prev !== undefined) window.clearTimeout(prev)
      timers.set(el, window.setTimeout(() => el.removeAttribute('data-wb-scrolling'), 800))
    },
    { capture: true, passive: true },
  )
}
