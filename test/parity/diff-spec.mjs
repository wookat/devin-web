// Spec diff — compares official vs local computed-style captures (Phase 3).
//
//   node test/parity/diff-spec.mjs docs/parity/<f>/official-spec.json docs/parity/<f>/local-spec.json [--probe <name>]
//
// Walks both spec trees in parallel, reports every property whose computed
// value differs. Key visual properties (box model, font, color, radius,
// shadow, gap) are marked CRITICAL; the rest are informational. Exit code 1
// if any critical diff — wire into CI/smoke if desired. Zero deps.

import { readFileSync } from 'node:fs'

const [aPath, bPath] = process.argv.slice(2)
if (!aPath || !bPath) { console.error('usage: diff-spec.mjs <official.json> <local.json>'); process.exit(1) }
const probeFilter = process.argv.includes('--probe') ? process.argv[process.argv.indexOf('--probe') + 1] : null

const CRITICAL = new Set([
  'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
  'color', 'backgroundColor', 'borderRadius', 'boxShadow', 'border',
  'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'gap', 'height', 'width', 'minWidth', 'minHeight',
  'display', 'alignItems', 'justifyContent', 'flexDirection', 'transform',
])

const load = (p) => JSON.parse(readFileSync(p, 'utf8'))

// Flatten a spec tree into path → styles map. Path = tag+cls breadcrumb.
const flatten = (node, path, out) => {
  if (!node) return
  const label = `${node.tag}${node.cls ? '.' + node.cls.split(' ').filter(Boolean).slice(0, 3).join('.') : ''}${node.aria ? `[${node.aria}]` : ''}`
  const here = path ? `${path} > ${label}` : label
  out[here] = node.styles ?? {}
  ;(node.children ?? []).forEach((c) => flatten(c, here, out))
}

const a = load(aPath); const b = load(bPath)
const aCaps = a.captures ?? [a]; const bCaps = b.captures ?? [b]
// Compare the LAST capture of each (the final state you snapshotted), or all
// pairwise when counts match.
const pairs = aCaps.length === bCaps.length ? aCaps.map((c, i) => [c, bCaps[i], i + 1]) : [[aCaps.at(-1), bCaps.at(-1), 'last']]

let critical = 0, minor = 0
for (const [ca, cb, tag] of pairs) {
  for (const probe of Object.keys(ca.probes ?? {})) {
    if (probeFilter && probe !== probeFilter) continue
    const fa = {}; const fb = {}
    flatten(ca.probes[probe], '', fa)
    flatten(cb.probes[probe], '', fb)
    const paths = new Set([...Object.keys(fa), ...Object.keys(fb)])
    for (const p of paths) {
      const sa = fa[p] ?? {}; const sb = fb[p] ?? {}
      for (const k of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
        if (sa[k] === sb[k]) continue
        const crit = CRITICAL.has(k)
        if (crit) critical++; else minor++
        console.log(`${crit ? '✗ CRIT' : '· info'} [capture ${tag}] ${probe}\n    ${p}\n    ${k}: official=${JSON.stringify(sa[k])} local=${JSON.stringify(sb[k])}`)
      }
    }
  }
}
console.log(`\n${critical} critical diffs, ${minor} informational`)
process.exit(critical ? 1 : 0)
