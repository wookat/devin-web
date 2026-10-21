#!/usr/bin/env node
/**
 * Apply `_deob/maps/<file>.json` rename maps to `_deob/all/<file>` →
 * `_deob/src/<suggestedDir or '_'>/<suggestedName or file>`.
 *
 * Only TOP-LEVEL (module-scope) identifiers are renamed: `function X`,
 * `var X`, `let X`, `const X`, `class X` declarations at column 0, plus every
 * whole-word use of that identifier *except* inside property positions
 * (`obj.X` / `{ X:`). Scoped locals keep their minified names — renaming them
 * would collide across functions.
 *
 *   node test/parity/apply-renames.mjs            :: apply all maps
 *   node test/parity/apply-renames.mjs <file>     :: one module
 */
import fs from 'node:fs'
import path from 'node:path'
import { maskStrings } from './mask-strings.mjs'

const only = process.argv[2]
const mapsDir = '_deob/maps'
const srcDir = '_deob/all'
const outDir = '_deob/src'

const maps = fs.existsSync(mapsDir)
  ? fs.readdirSync(mapsDir).filter((f) => f.endsWith('.json') && (!only || f === `${only}.json` || f === only))
  : []
if (!maps.length) { console.log('no maps found in _deob/maps'); process.exit(0) }

let applied = 0
for (const mf of maps) {
  const map = JSON.parse(fs.readFileSync(path.join(mapsDir, mf), 'utf8'))
  const src = path.join(srcDir, map.module ?? mf.replace(/\.json$/, '.js'))
  if (!fs.existsSync(src)) { console.log(`skip ${mf}: no source ${src}`); continue }
  let code = fs.readFileSync(src, 'utf8')
  const renames = map.renames ?? {}
  // longest-first so e.g. `_Component16` never partially hits `_Component1`
  const names = Object.keys(renames).sort((a, b) => b.length - a.length)
  const header = [
    `// Deobfuscated from _devin_assets/${map.module ?? mf.replace(/\.json$/, '.js')} (webcrack + semantic rename)`,
    map.description ? `// ${map.description}` : null,
    `// Renames: ${Object.entries(renames).map(([a, b]) => `${a}→${b}`).join(', ')}`,
    ``,
  ].filter((l) => l !== null).join('\n')
  for (const from of names) {
    const to = renames[from]
    if (!/^[\w$]+$/.test(from) || !/^[\w$]+$/.test(to)) continue
    // Identifier boundary = not surrounded by [\w$] (covers `$`-leading
    // names like `$t` where \b fails). Metachars in `from` are escaped or
    // `$` becomes a zero-width end-of-line assertion.
    const pat = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const idRe = new RegExp(`(?<![\\w$])${pat}(?![\\w$])`, 'g')
    const ren = (text) => text.replace(idRe, (m, off) => {
      const prev = text[off - 1]
      const next = text[off + from.length]
      // `obj.X` member access keeps the key — `...X` spread is a use
      if (prev === '.' && !(text[off - 2] === '.' && text[off - 3] === '.')) return m
      if (next === ':' && /[{,]\s*$/.test(text.slice(0, off))) return m
      if (from === '$' && next === '{') return m // `${` template opener, not an identifier
      if (from === 'of' || from === 'in') { // for-of/for-in keyword, not an identifier
        const before = text.slice(0, off)
        const lastFor = before.lastIndexOf('for')
        if (lastFor > before.lastIndexOf(')') && lastFor > before.lastIndexOf('}') && /\bfor\s*\(/.test(before.slice(lastFor))) return m
      }
      return to
    })
    // Mask string/comment/regex spans (and template text) first — Tailwind
    // `pt-2`, `'dt'` tags etc. share names with minified ids and must not
    // be rewritten. `${...}` interiors stay live (real code inside).
    const masked = maskStrings(code)
    // Process per line so import specifiers (`import { C as c }` — the LEFT
    // side names a foreign module's export) are never rewritten. Inside
    // `export { X as Y, ... }` blocks, only X (the local name) is renamed —
    // `as` may itself be a minified function name, but here it's keyword.
    let inExport = false
    code = masked.masked.split('\n').map((line) => {
      if (/^\s*import[\s{*]/.test(line)) return line
      const isExportLine = inExport || /^\s*export\s*\{/.test(line)
      if (isExportLine) {
        const braceAt = line.indexOf('{')
        const bodyStart = braceAt < 0 ? 0 : braceAt + 1
        const closeAt = line.indexOf('}', bodyStart)
        const body = line.slice(bodyStart, closeAt < 0 ? undefined : closeAt)
        const fixed = body.split(',').map((seg) => {
          // `X as Y` (X may itself literally be `as` — e.g. `as as t`)
          const m2 = seg.match(/^(\s*)([\w$]+)(\s+as\s+[\w$]+.*)$/)
          return m2 ? m2[1] + ren(m2[2]) + m2[3] : ren(seg)
        }).join(',')
        inExport = closeAt < 0
        return line.slice(0, bodyStart) + fixed + (closeAt < 0 ? '' : line.slice(closeAt))
      }
      return ren(line)
    }).join('\n')
    code = masked.restore(code)
  }
  const rel = path.join(map.suggestedDir ?? '_', map.suggestedName ?? path.basename(src))
  const dst = path.join(outDir, rel)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.writeFileSync(dst, header + code)
  applied++
  console.log(`${mf} → _deob/src/${rel} (${names.length} renames)`)
}
console.log(`applied ${applied} map(s)`)
