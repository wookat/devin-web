import { useLayoutEffect, useRef, useState } from 'react'

// Official composer collapse (decoded from the deob'd bundle — kE/OE/DE):
// the toolbar row reports clientWidth; the collapsible "leading" cluster
// reports scrollWidth−clientWidth overflow. overflow>1 → level+1, recording
// the width that level needed (hysteresis, so levels don't flicker); when the
// row later has room for the recorded need → level−1. A 200ms cooldown
// between escalations prevents thrash. RO watches the row, the cluster, and
// every cluster child (MutationObserver keeps the child set current).
function useCollapseLevel(toolbarEl: HTMLElement | null, leadingEl: HTMLElement | null, maxLevel = 3): number {
  const [level, setLevel] = useState(0)
  const st = useRef({ level: 0, requiredAt: [] as (number | undefined)[], cooldown: 0, timer: 0 })
  const measureRef = useRef<() => void>(() => {})
  useLayoutEffect(() => {
    const s = st.current
    if (!toolbarEl || !leadingEl) {
      s.level = 0
      s.requiredAt = []
      setLevel(0)
      return
    }
    const measure = () => {
      const available = toolbarEl.clientWidth
      if (available <= 0) return
      const overflow = leadingEl.scrollWidth - leadingEl.clientWidth
      const now = Date.now()
      const cooling = now < s.cooldown
      if (cooling) {
        // During cooldown escalations are capped at the current level; a
        // deferred re-measure runs right after the cooldown ends.
        window.clearTimeout(s.timer)
        s.timer = window.setTimeout(() => measureRef.current(), s.cooldown - now + 25)
      }
      const cap = cooling ? s.level : maxLevel
      if (overflow > 1 && s.level < cap) {
        s.requiredAt[s.level] = available + overflow
        s.level += 1
        s.cooldown = now + 200
        setLevel(s.level)
      } else if (s.level > 0) {
        const need = s.requiredAt[s.level - 1]
        if (need === undefined || available >= need) {
          s.requiredAt[s.level - 1] = undefined
          s.level -= 1
          setLevel(s.level)
        }
      }
    }
    measureRef.current = measure
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(toolbarEl)
    ro.observe(leadingEl)
    const seen = new Set<Element>()
    const watchChildren = () => {
      for (const el of seen) if (!leadingEl.contains(el)) { ro.unobserve(el); seen.delete(el) }
      for (const el of Array.from(leadingEl.children)) if (!seen.has(el)) { ro.observe(el); seen.add(el) }
    }
    watchChildren()
    const mo = new MutationObserver(() => { watchChildren(); measure() })
    mo.observe(leadingEl, { childList: true })
    return () => { ro.disconnect(); mo.disconnect(); window.clearTimeout(s.timer) }
  }, [toolbarEl, leadingEl, maxLevel])
  return level
}

export { useCollapseLevel }
