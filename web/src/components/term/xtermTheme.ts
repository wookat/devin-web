import type { ITheme } from '@xterm/xterm'

/**
 * Theme bridge: maps the app's design tokens (--color-*) onto an xterm ITheme.
 *
 * Two resolution steps are needed because xterm's own css parser only
 * understands #hex / comma-rgb(a) / opaque canvas-parsed colors, while our
 * tokens can be rgba-with-alpha or oklch()/color-mix() that serialize back in
 * forms xterm can't read (alpha < 1 canvas parses throw inside xterm):
 *   1. a hidden probe element resolves `var(--x)` / `color-mix()` / `oklch()`
 *      to whatever getComputedStyle reports (rgb()/oklch()/color(srgb …)),
 *   2. a 1px canvas composites that color over --color-card, so every theme
 *      entry comes out an opaque #rrggbb xterm can always parse.
 */

let probe: HTMLSpanElement | null = null
let cvs: HTMLCanvasElement | null = null
let ctx2d: CanvasRenderingContext2D | null = null

function computed(expr: string): string {
  if (!probe) {
    probe = document.createElement('span')
    probe.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden;pointer-events:none'
    document.body.appendChild(probe)
  }
  probe.style.color = ''
  probe.style.color = expr
  return getComputedStyle(probe).color
}

function canvas(): CanvasRenderingContext2D | null {
  if (!ctx2d) {
    cvs = document.createElement('canvas')
    cvs.width = cvs.height = 1
    ctx2d = cvs.getContext('2d', { willReadFrequently: true })
  }
  return ctx2d
}

const hex = (n: number) => n.toString(16).padStart(2, '0')

/** Resolve any CSS color expression to opaque #rrggbb over the card surface. */
function solid(expr: string, over: string): string {
  const c = canvas()
  const resolved = computed(expr)
  if (!c) return resolved // no 2d context — hand xterm the browser-resolved form
  try {
    c.globalCompositeOperation = 'copy'
    c.fillStyle = computed(over)
    c.fillRect(0, 0, 1, 1)
    c.globalCompositeOperation = 'source-over'
    c.fillStyle = resolved
    c.fillRect(0, 0, 1, 1)
    const d = c.getImageData(0, 0, 1, 1).data
    return `#${hex(d[0])}${hex(d[1])}${hex(d[2])}`
  } catch {
    return resolved
  }
}

/** Comma-form rgba() — the one alpha-bearing syntax xterm parses natively. */
function alpha(expr: string, a: number): string {
  const s = solid(expr, 'var(--color-card)')
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s)
  if (!m) return s
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${a})`
}

/** xterm theme derived entirely from the app's CSS tokens (light+dark). */
export function termTheme(): ITheme {
  const card = 'var(--color-card)'
  const s = (expr: string) => solid(expr, card)
  const bright = (expr: string) => s(`color-mix(in srgb, ${expr} 78%, var(--color-foreground))`)
  const fg = s('var(--color-foreground)')
  return {
    foreground: fg,
    background: s(card),
    cursor: fg,
    cursorAccent: s(card),
    selectionBackground: alpha('var(--color-accent-primary)', 0.28),
    selectionInactiveBackground: alpha('var(--color-accent-primary)', 0.16),
    // ANSI 0-7 — the app's semantic colors flattened over the card surface.
    black: s('var(--color-muted-foreground)'),
    red: s('var(--color-text-red)'),
    green: s('var(--color-text-green)'),
    yellow: s('var(--color-text-orange)'),
    blue: s('var(--color-accent-primary)'),
    magenta: s('var(--color-text-purple)'),
    cyan: s('color-mix(in srgb, var(--color-accent-primary) 55%, var(--color-text-green))'),
    white: fg,
    // ANSI 8-15 — same hues nudged toward the foreground (the theme's idea of "bright").
    brightBlack: s('var(--color-text-tertiary)'),
    brightRed: bright('var(--color-text-red)'),
    brightGreen: bright('var(--color-text-green)'),
    brightYellow: bright('var(--color-text-orange)'),
    brightBlue: bright('var(--color-accent-primary)'),
    brightMagenta: bright('var(--color-text-purple)'),
    brightCyan: bright('color-mix(in srgb, var(--color-accent-primary) 55%, var(--color-text-green))'),
    brightWhite: fg,
  }
}

/** Re-run `cb` whenever the effective theme flips: the app toggles `.dark` on
 *  <html> (both manual and prefers-color-scheme paths land there), and we also
 *  watch the media query directly in case the class order races. */
export function watchTermTheme(cb: () => void): () => void {
  const mo = new MutationObserver(cb)
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  mq.addEventListener('change', cb)
  return () => { mo.disconnect(); mq.removeEventListener('change', cb) }
}
