// Static CSS harvest (Phase 0.5 of devin-parity). The compiled official CSS
// in _devin_assets/ contains RESOLVED values — selectors, custom props,
// exact rem/px/color literals. Extract the rules relevant to a feature.
//
//   node test/parity/extract-css.mjs <keyword> [keyword2 ...]
//   node test/parity/extract-css.mjs quotable transcript-message-actions
//
// Prints every rule whose selector or body mentions a keyword, across both
// css bundles. Zero deps. Output is the spec source for styles you then
// port verbatim.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ASSETS = '_devin_assets'
const kws = process.argv.slice(2)
if (!kws.length) { console.error('usage: extract-css.mjs <keyword> [...]'); process.exit(1) }

// Tiny CSS splitter: top-level rules incl. @media/@supports/@position-try.
const rules = (css) => {
  const out = []
  let i = 0, sel = '', depth = 0, at = null
  const pushRule = (s, b) => out.push({ sel: s.trim(), body: b.trim(), at })
  while (i < css.length) {
    const c = css[i]
    if (c === '{') {
      depth++
      if (depth === 1 && !at && /^@/.test(sel)) at = sel.trim()
      if (depth === 1 && at) sel = ''
      if (depth === 2 && at) sel = css.slice(css.lastIndexOf('}', i - 1) + 1, i)
      i++; continue
    }
    if (c === '}') {
      if (depth === 2 && at) pushRule(sel, css.slice(css.lastIndexOf('{', i) + 1, i))
      if (depth === 1 && !at) pushRule(sel, css.slice(css.lastIndexOf('{', i) + 1, i))
      depth--
      if (depth === 0) { at = null; sel = '' }
      i++; continue
    }
    if (depth === 0) sel += c
    i++
  }
  return out
}

const files = readdirSync(ASSETS).filter((f) => f.endsWith('.css'))
const seen = new Set()
for (const f of files) {
  const css = readFileSync(join(ASSETS, f), 'utf8')
  for (const r of rules(css)) {
    const hay = r.sel + r.body
    if (!kws.some((k) => hay.toLowerCase().includes(k.toLowerCase()))) continue
    const key = (r.at ?? '') + r.sel + r.body
    if (seen.has(key)) continue
    seen.add(key)
    console.log(`${r.at ? `@ruleset ${r.at.slice(0, 80)}\n  ` : ''}${r.sel} {\n  ${r.body.split(';').filter(Boolean).join(';\n  ')}\n}\n`)
  }
}
console.log(`--- ${seen.size} rules matched [${kws.join(', ')}] across ${files.join(', ')}`)
