#!/usr/bin/env node
/**
 * auto-map.mjs — mechanical rename maps for every `_deob/all/*.js` module.
 *
 * Two zero-LLM patterns in webcrack output:
 *
 *  A) React-family vars — `var X;` later used as `X.useState/.memo/.jsx...`
 *     → `React` / `jsxRuntime` / `ReactDom` (deduped).
 *
 *  B) Literal constants inside init thunks —
 *       function yi(){ return (yi = e(() => { ni = `sessions-list`; ... }))(); }
 *     a `X = `string`` / `X = "str"` / `X = 'str'` assignment of a
 *     kebab/snake/plain literal → `SCREAMING_NAME` derived from the content
 *     (e.g. `sessions-list` → `SESSIONS_LIST`). Only when the derived name is
 *     unused and ≥3 chars; ambiguity falls back to leaving the name alone.
 *
 * Writes `_deob/maps/_auto/<file>.json`. Hand/agent maps in `_deob/maps/`
 * always win over `_auto/` per-key.
 *
 *   node test/parity/auto-map.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const srcDir = '_deob/all'
const outDir = '_deob/maps/_auto'
fs.mkdirSync(outDir, { recursive: true })

const IDENT = '[\\w$]'
const REACT_HINT = /\.(useState|useEffect|useMemo|useCallback|useRef|useContext|memo|forwardRef|createElement|Children|Suspense|lazy)\b/
const JSX_HINT = /\.(jsx|jsxs|Fragment)\b/
const DOM_HINT = /\.(createRoot|flushSync|createPortal|hydrateRoot)\b/

const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.js'))
let written = 0, totalRenames = 0
for (const file of files) {
  const code = fs.readFileSync(path.join(srcDir, file), 'utf8')
  const renames = {}
  const used = new Set()

  // Reserve all declared/imported names so generated names can't collide.
  for (const m of code.matchAll(/^(?:function|class|var|let|const)\s+([\w$]+)/gm)) used.add(m[1])
  for (const m of code.matchAll(/^import\s+([\w$]+)\s+from\b/gm)) used.add(m[1])
  for (const m of code.matchAll(/\{([\w$,\s]+)\}\s+from\s+"/g)) {
    for (const spec of m[1].split(',')) {
      const a = spec.trim().match(/(?:^|\bas\s+)([\w$]+)$/)
      if (a) used.add(a[1])
    }
  }
  const take = (base) => {
    let n = base, i = 2
    while (used.has(n)) n = base + i++
    used.add(n)
    return n
  }
  const claim = (from, to) => { if (from !== to && !renames[from]) renames[from] = take(to) }

  // Top-level `var X;` set (only these are thunk-assignable + react-shaped)
  const topVars = new Set()
  for (const m of code.matchAll(/^var\s+([\w$]+)\s*;/gm)) topVars.add(m[1])

  // A) React-family by usage
  for (const v of topVars) {
    const hit = (re) => code.includes(`${v}.`) && new RegExp(`(?<![\\w$])${v.replace(/\$/g, '\\$')}\\${REACT_HINT.source.slice(1)}`).test(code)
    let base = null
    const vEsc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`(?<![\\w$])${vEsc}\\.(jsx|jsxs|Fragment)\\b`).test(code)) base = 'jsxRuntime'
    else if (new RegExp(`(?<![\\w$])${vEsc}\\.(createRoot|flushSync|createPortal|hydrateRoot)\\b`).test(code)) base = 'ReactDom'
    else if (new RegExp(`(?<![\\w$])${vEsc}\\.(useState|useEffect|useMemo|useCallback|useRef|useContext|memo|forwardRef|createElement|Children|Suspense|lazy)\\b`).test(code)) base = 'React'
    if (base) claim(v, base)
  }

  // B) literal constants assigned inside init thunks:
  //    `X = `str`` / `X = "str"` / `X = 'str'` where X is a top var
  for (const m of code.matchAll(/([$\w]+)\s*=\s*[`'"]([A-Za-z][\w .\/:@+-]*[-\/][\w .\/:@+-]*|[a-z][\w-]*)[`'"]/g)) {
    const v = m[1], lit = m[2]
    if (!topVars.has(v) || v in renames) continue
    let base = lit
      .replace(/^["'`]|["'`]$/g, '')
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toUpperCase()
    if (base.length < 3 || !/^[A-Z_]/.test(base)) continue
    if (base.length > 40) base = base.slice(0, 40).replace(/_+$/, '')
    claim(v, base)
  }

  if (!Object.keys(renames).length) continue
  fs.writeFileSync(
    path.join(outDir, file.replace(/\.js$/, '.json')),
    JSON.stringify({ module: file, auto: true, renames })
  )
  written++; totalRenames += Object.keys(renames).length
}
console.log(`auto-maps: ${written}/${files.length} files, ${totalRenames} renames`)
