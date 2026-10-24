/** Clipboard with insecure-context fallback — navigator.clipboard only exists
 *  in secure contexts (https/localhost); http://<lan-ip> access gets
 *  undefined and every call site throws TypeError. The execCommand path is
 *  deprecated but still works everywhere for same-origin user gestures. */
export function copyText(text: string): Promise<void> {
  const clip = navigator.clipboard
  if (clip?.writeText) return clip.writeText(text)
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none'
  document.body.appendChild(ta)
  ta.select()
  try { document.execCommand('copy') } catch { /* best-effort */ }
  ta.remove()
  return Promise.resolve()
}
