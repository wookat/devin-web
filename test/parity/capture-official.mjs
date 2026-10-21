// Pixel-parity forensics capture (Phase 0 of the devin-parity skill).
//
//   node test/parity/capture-official.mjs --url <page> --feature <name>
//   node test/parity/capture-official.mjs --url <local-page> --feature <name> --local
//
// Opens a REAL (headed) browser with a persistent profile so the official
// login state survives between runs (test/parity/.auth/). You drive the UI
// to the state you want captured (select text, hover a row, open a menu),
// then press Enter in this terminal → the script writes:
//   docs/parity/<feature>/official-spec.json     computed-style tree + rects + aria
//   docs/parity/<feature>/shots/shot-<n>.png     one screenshot per capture
//   docs/parity/<feature>/official-root-vars.json  :root custom properties (once)
// Repeat Enter for each state (idle/hover/expanded); Ctrl+C to finish.
// --local writes local-spec.json / shots-local/ instead.
//
// Requires `npm i -D playwright` once (kept out of package.json — forensics only).

import { createInterface } from 'node:readline'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d }
const has = (k) => args.includes(`--${k}`)

const url = arg('url')
const feature = arg('feature', 'unnamed')
const isLocal = has('local')
if (!url) { console.error('usage: --url <page> --feature <name> [--local]'); process.exit(1) }

const AUTH_DIR = join('test', 'parity', '.auth')
const OUT = join('docs', 'parity', feature)
const SPEC = join(OUT, isLocal ? 'local-spec.json' : 'official-spec.json')
const VARS = join(OUT, 'official-root-vars.json')
const SHOTS = join(OUT, isLocal ? 'shots-local' : 'shots')
mkdirSync(SHOTS, { recursive: true })

let chromium
try { ({ chromium } = await import('playwright')) } catch {
  console.error('playwright not installed — run: npm i -D playwright'); process.exit(1)
}

const ctx = await chromium.launchPersistentContext(AUTH_DIR, {
  headless: false,
  viewport: { width: 1280, height: 860 },
  args: ['--disable-blink-features=AutomationControlled'],
})
const page = ctx.pages()[0] ?? (await ctx.newPage())
await page.goto(url, { waitUntil: 'domcontentloaded' })
console.log(`\n[parity] browser open → ${url}`)
console.log('[parity] if the official site asks for login, log in now (profile persists).')
console.log('[parity] drive the UI into the state to capture, then press Enter. Ctrl+C to quit.\n')

// Computed-style spec extractor — serializes the interesting properties of a
// subtree. Runs inside the page.
const extractSpec = `(rootSel) => {
  const KEYS = ['display','position','flexDirection','alignItems','justifyContent','gap',
    'padding','paddingTop','paddingRight','paddingBottom','paddingLeft',
    'margin','marginTop','marginRight','marginBottom','marginLeft',
    'width','height','minWidth','minHeight','maxWidth','maxHeight',
    'fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','textAlign','whiteSpace',
    'color','backgroundColor','border','borderRadius','boxShadow','opacity',
    'transform','transformOrigin','transition','animation','overflow','textOverflow',
    'zIndex','cursor','userSelect','pointerEvents']
  const interesting = (el) => {
    if (!(el instanceof Element)) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && r.bottom > -50 && r.top < innerHeight + 50
  }
  const snap = (el, depth) => {
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    const node = {
      tag: el.tagName.toLowerCase(),
      cls: typeof el.className === 'string' ? el.className : '',
      id: el.id || undefined,
      aria: el.getAttribute('aria-label') || undefined,
      role: el.getAttribute('role') || undefined,
      text: el.children.length === 0 ? (el.textContent || '').slice(0, 120) : undefined,
      rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
      styles: {},
    }
    for (const k of KEYS) { const v = cs[k]; if (v && v !== 'none' && v !== 'normal' && v !== 'auto' && v !== '0px' && v !== 'rgba(0, 0, 0, 0)') node.styles[k] = v }
    if (depth < 6) {
      const kids = [...el.children].filter(interesting)
      if (kids.length) node.children = kids.map((k) => snap(k, depth + 1))
    }
    return node
  }
  const host = document.querySelector(rootSel)
  return host ? snap(host, 0) : null
}`

const extractVars = `() => {
  const cs = getComputedStyle(document.documentElement)
  const out = {}
  for (let i = 0; i < cs.length; i++) { const k = cs[i]; if (k.startsWith('--')) out[k] = cs.getPropertyValue(k).trim() }
  return out
}`

let shot = 0
const rl = createInterface({ input: process.stdin, output: process.stdout })
rl.on('line', async () => {
  shot++
  await page.screenshot({ path: join(SHOTS, `shot-${shot}.png`) })
  // Capture specs for the elements most relevant to parity work — floating
  // affordances, toolbars, composer chips. Extend this list per feature.
  const probes = {
    fixedOverlays: '[class*="fixed"], [role="tooltip"], [data-state="open"]',
    toolbar: '[class*="group"] [class*="absolute"] button',
    composer: 'form, textarea, [contenteditable="true"]',
  }
  const spec = { capturedAt: new Date().toISOString(), url: page.url(), viewport: page.viewportSize(), probes: {} }
  for (const [k, sel] of Object.entries(probes)) spec.probes[k] = await page.evaluate(`${extractSpec}(${JSON.stringify(sel)})`)
  const prev = existsSync(SPEC) ? JSON.parse(await import('node:fs').then((m) => m.readFileSync(SPEC, 'utf8'))) : { captures: [] }
  ;(prev.captures ??= []).push(spec)
  writeFileSync(SPEC, JSON.stringify(prev, null, 2))
  if (!isLocal && !existsSync(VARS)) writeFileSync(VARS, JSON.stringify(await page.evaluate(extractVars), null, 2))
  console.log(`[parity] captured shot-${shot}.png + spec (${Object.keys(spec.probes).length} probes)`)
})
rl.on('close', async () => { await ctx.close(); process.exit(0) })
