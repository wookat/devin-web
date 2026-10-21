#!/usr/bin/env node
/**
 * build-srctree.mjs — emit `_deob/all/` as a real source tree in `_deob/src/`.
 *
 * Pass 1: scan every module — top-level decls, import records, export table
 *         (incl. `export {X as Y} from` re-exports and `export *` chains).
 * Pass 2: merge rename maps (_deob/maps/*.json win over _deob/maps/_auto/*.json)
 *         and compute each module's semantic export name for every specifier
 *         by resolving re-export chains back to the real declaration.
 * Pass 3: write each file to `_deob/src/<dir>/<name>.js` with
 *          - top-level renames applied (engine shared with apply-renames.mjs)
 *          - import specifiers rewritten to the semantic export name
 *            (`import { C as c }` → `import { initProgrammaticQuote as c }`)
 *          - import paths rewritten to the module's new location
 *          - `export { X as Y }` simplified to `export { newX }` when the
 *            whole tree resolves (all importers rewritten accordingly)
 *
 *   node test/parity/build-srctree.mjs            :: full emit
 *   node test/parity/build-srctree.mjs --check    :: esbuild syntax check
 */
import fs from 'node:fs'
import path from 'node:path'
import { maskStrings } from './mask-strings.mjs'

const SRC = '_deob/all'
const MAPS = '_deob/maps'
const AUTO = '_deob/maps/_auto'
const OUT = '_deob/src'

const checkOnly = process.argv.includes('--check')
const only = process.argv.find((a) => a.endsWith('.js'))

/* ---------------- pass 1: parse ---------------- */
const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.js'))
const modules = new Map() // file -> {imports:[], exports:Map, decls:Set}

const SPEC_RE = /([\w$]+)(?:\s+as\s+([\w$]+))?/g
for (const file of files) {
  const code = fs.readFileSync(path.join(SRC, file), 'utf8')
  const mod = { imports: [], exports: new Map(), decls: new Set(), declKinds: new Map(), code }

  for (const m of code.matchAll(/^import\s+([^'"]*?)\s+from\s+["']([^"']+)["']/gm)) {
    const clause = m[1].trim(), source = m[2]
    const rec = { source, specs: [], dflt: null, ns: null }
    if (clause.startsWith('{')) {
      for (const s of clause.slice(1, -1).split(',')) {
        const p = s.trim().match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/)
        if (p) rec.specs.push({ imported: p[1], local: p[2] ?? p[1] })
      }
    } else if (clause.startsWith('*')) {
      rec.ns = clause.match(/\bas\s+([\w$]+)/)?.[1]
    } else if (clause.includes('{')) {
      rec.dflt = clause.slice(0, clause.indexOf(',')).trim()
      for (const s of clause.slice(clause.indexOf('{') + 1, -1).split(',')) {
        const p = s.trim().match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/)
        if (p) rec.specs.push({ imported: p[1], local: p[2] ?? p[1] })
      }
    } else rec.dflt = clause
    mod.imports.push(rec)
  }
  for (const m of code.matchAll(/^import\s+["']([^"']+)["']/gm)) {
    mod.imports.push({ source: m[1], specs: [], bare: true })
  }

  for (const m of code.matchAll(/^export\s+\{([^}]*)\}\s*;?/gm)) {
    for (const s of m[1].split(',')) {
      const p = s.trim().match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/)
      if (p) mod.exports.set(p[2] ?? p[1], { kind: 'decl', local: p[1] })
    }
  }
  for (const m of code.matchAll(/^export\s+\{([^}]*)\}\s*from\s+["']([^"']+)["']/gm)) {
    for (const s of m[1].split(',')) {
      const p = s.trim().match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/)
      if (p) mod.exports.set(p[2] ?? p[1], { kind: 'reexport', source: m[2], name: p[1] })
    }
  }
  for (const m of code.matchAll(/^export\s+\*\s+from\s+["']([^"']+)["']/gm)) {
    mod.exports.set('*', { kind: 'star', source: m[1] })
  }
  for (const m of code.matchAll(/^export\s+(?:default\s+)?(?:async\s+)?(function\*?|class|var|let|const)\s+([\w$]+)/gm)) {
    mod.exports.set(m[2], { kind: 'decl', local: m[2] })
    mod.decls.add(m[2])
    mod.declKinds.set(m[2], m[1].replace('*', ''))
  }
  for (const m of code.matchAll(/^(?:async\s+)?(function|class|var|let|const)\s*\*?\s*([\w$]+)/gm)) {
    mod.decls.add(m[2])
    mod.declKinds.set(m[2], m[1])
  }
  modules.set(file, mod)
}

/* ---------------- pass 2: maps + paths + export resolution ---------------- */
const maps = new Map() // file -> {renames, suggestedDir, suggestedName}
const loadMapDir = (dir, auto) => {
  if (!fs.existsSync(dir)) return
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    // `X.p1.json` is a slice map for bundle `X.js` (huge files split for agents)
    const mod = f.replace(/\.json$/, '.js').replace(/\.p\d+\.js$/, '.js')
    const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
    // agents sometimes emit {suggestedName,...} objects as values — coerce
    for (const [k, v] of Object.entries(m.renames ?? {})) {
      if (typeof v === 'string') continue
      m.renames[k] = typeof v?.suggestedName === 'string' ? v.suggestedName : undefined
      if (m.renames[k] === undefined) delete m.renames[k]
    }
    const cur = maps.get(mod) ?? { renames: {} }
    cur.renames = auto ? { ...m.renames, ...cur.renames } : { ...cur.renames, ...m.renames }
    if (!auto) { cur.suggestedDir = m.suggestedDir; cur.suggestedName = m.suggestedName }
    maps.set(mod, cur)
  }
}
loadMapDir(AUTO, true)
loadMapDir(MAPS, false)

// Dedup pass — BEFORE semanticExport so export-side and import-side agree.
// Maps may give several decls the same semantic name; ESM only allows
// var+var co-declaration — everything else gets a numeric suffix.
// Exported decls are processed first so they keep the canonical name
// (importers reference them); unexported colliders get suffixes.
for (const [file, mod] of modules) {
  const m = maps.get(file)
  if (!m) continue
  const exportedLocals = new Set()
  for (const e of mod.exports.values()) if (e.kind === 'decl') exportedLocals.add(e.local)
  const importLocals = new Set()
  for (const r of mod.imports) {
    r.specs.forEach((s) => importLocals.add(s.local))
    if (r.dflt) importLocals.add(r.dflt)
    if (r.ns) importLocals.add(r.ns)
  }
  // Names that have LOCAL bindings (function-scope decls/params/catch/
  // destructured patterns/for-of heads) shadow top-level decls — renaming
  // them would rewrite unrelated locals and can create same-scope
  // collisions (e.g. `let jsxRuntime` ×2). Skip those keys entirely.
  // Plain USES — `g(X)` call args, `(X = …)` lazy-init self-assigns,
  // `{k: X}` property values, `X.prop`, `arr[X]` subscripts — do NOT create
  // bindings and must not block renames. The only kept ambiguity guard is
  // `{X,`/`{X}`/`,X}`-style positions (object shorthand in expressions vs
  // destructure patterns are indistinguishable without parsing, and
  // renaming a shorthand changes the emitted key) — those still block.
  const localBound = new Set()
  const bound = localBound
  const splitTop = (s) => {
    const parts = []
    let d = 0, last = 0
    for (let i = 0; i < s.length; i++) {
      const c = s[i]
      if (c === '(' || c === '[' || c === '{') d++
      else if (c === ')' || c === ']' || c === '}') d--
      else if (c === ',' && d === 0) { parts.push(s.slice(last, i)); last = i + 1 }
    }
    parts.push(s.slice(last))
    return parts
  }
  const topIndexOf = (s, ch) => {
    let d = 0
    for (let i = 0; i < s.length; i++) {
      const c = s[i]
      if (c === '(' || c === '[' || c === '{') d++
      else if (c === ')' || c === ']' || c === '}') d--
      else if (c === ch && d === 0) return i
    }
    return -1
  }
  const stripDefault = (p) => { // LHS before a top-level `=` (not `==`/`=>`)
    const i = topIndexOf(p, '=')
    if (i >= 0 && p[i + 1] !== '=' && p[i + 1] !== '>' && p[i - 1] !== '=' && p[i - 1] !== '!' && p[i - 1] !== '<' && p[i - 1] !== '>') return p.slice(0, i)
    return p
  }
  const bindPattern = (text) => { // destructure pattern incl. outer {}/[]
    const inner = text.trim().slice(1, -1)
    for (const el of splitTop(inner)) {
      let e = el.trim()
      if (!e) continue
      if (e.startsWith('...')) e = e.slice(3).trim()
      const colonAt = topIndexOf(e, ':')
      const eqAt = topIndexOf(e, '=')
      if (colonAt >= 0 && (eqAt < 0 || colonAt < eqAt)) e = e.slice(colonAt + 1).trim() // `key: pat` → bind pat
      if (e.startsWith('{') || e.startsWith('[')) { bindPattern(e); continue }
      e = stripDefault(e).trim()
      if (e.startsWith('{') || e.startsWith('[')) { bindPattern(e); continue }
      const id = e.match(/^[\w$]+/)
      if (id) bound.add(id[0])
    }
  }
  const bindParams = (plist) => {
    for (const el of splitTop(plist)) {
      let e = el.trim()
      if (!e) continue
      if (e.startsWith('...')) e = e.slice(3).trim()
      e = stripDefault(e).trim()
      if (e.startsWith('{') || e.startsWith('[')) { bindPattern(e); continue }
      const id = e.match(/^[\w$]+/)
      if (id) bound.add(id[0])
    }
  }
  const balancedFrom = (idx) => { // text from `{`/`[`/`(` at idx to its match
    const open = mod.code[idx]
    const close = open === '{' ? '}' : open === '[' ? ']' : ')'
    let d = 0
    for (let i = idx; i < mod.code.length; i++) {
      if (mod.code[i] === open) d++
      else if (mod.code[i] === close) { d--; if (!d) return mod.code.slice(idx, i + 1) }
    }
    return mod.code.slice(idx)
  }
  // function-scope declarations (incl. async/generator fns + class exprs)
  for (const m of mod.code.matchAll(/^[ \t]+(?:let|const|var|class)\s+([\w$]+)/gm)) bound.add(m[1])
  for (const m of mod.code.matchAll(/^[ \t]+(?:async\s+)?function\s*\*?\s*([\w$]+)/gm)) bound.add(m[1])
  // `let|const|var {…}|[…]` destructure declarations (also inside `for (`)
  for (const m of mod.code.matchAll(/\b(?:let|const|var)\s*([{[])/g)) bindPattern(balancedFrom(m.index + m[0].length - 1))
  // `for (let|const|var X of|in …)` loop heads
  for (const m of mod.code.matchAll(/\bfor\s*(?:await\s*)?\(\s*(?:let|const|var)\s*([\w$]+)/g)) bound.add(m[1])
  // single-ident arrow params `x =>`
  for (const m of mod.code.matchAll(/(?<![\w$])([\w$]+)\s*=>/g)) bound.add(m[1])
  // param lists: `function …(…)`, `catch (…)`, `(…) =>`, method `m(…) {`
  const KW = /\b(if|for|while|switch|return|new|typeof|else|do|in|of|instanceof|case|throw|await|yield|delete|void|with|assert|import|require|function|class|extends|super|this|try|finally)\s*$/
  for (const m of mod.code.matchAll(/\(/g)) {
    const open = m.index
    let d = 1, i = open + 1
    for (; i < mod.code.length && d; i++) {
      const c = mod.code[i]
      if (c === '(') d++
      else if (c === ')') d--
    }
    if (d) break
    const plist = mod.code.slice(open + 1, i - 1)
    const before = mod.code.slice(Math.max(0, open - 60), open)
    const after = mod.code.slice(i, i + 30)
    if (/function\s*\*?\s*[\w$]*\s*$/.test(before)
      || (/\bcatch\s*$/.test(before) && !/\.\s*catch\s*$/.test(before)) // real `catch (e)`, not `.catch(x)`
      || /^\s*=>/.test(after)
      || (/[\w$]+\s*$/.test(before) && /^\s*\{/.test(after) && !KW.test(before))) {
      bindParams(plist)
    }
  }
  // shorthand-position guard: `{X,` / `{X}` / `,X}` / `{X\n` / `,X\n`
  // (expression shorthand — renaming would change the key — or ambiguous
  // destructure). `X:` keys and `:X` values no longer block. `{X` is
  // allowed through when it's clearly a use: `${X}` template interpolation,
  // `prop={X}` JSX attribute, `>{X}` JSX child.
  for (const m of mod.code.matchAll(/[{,]\s*([\w$]+)\s*(?=[,}\n])/g)) {
    if (mod.code[m.index] === '{') {
      const prev = mod.code[m.index - 1]
      const prev2 = mod.code[m.index - 2]
      if (prev === '$' || prev === '=' || (prev === '>' && prev2 !== '=')) continue
    }
    bound.add(m[1])
  }
  for (const k of Object.keys(m.renames)) {
    // keys must be top-level decls in THIS file (agents sometimes emit local
    // names); shadowed names are dropped too (renaming rewrites locals →
    // same-scope collisions like `let jsxRuntime` ×2)
    if (!mod.decls.has(k) || localBound.has(k)) delete m.renames[k]
  }

  const finalKinds = new Map()
  const order = [...mod.decls].sort((a, b) => (exportedLocals.has(b) ? 1 : 0) - (exportedLocals.has(a) ? 1 : 0))
  for (const d of order) {
    const kind = mod.declKinds.get(d) ?? 'var'
    const base = m.renames[d] ?? d
    let final = base
    const clash = () => {
      const k = finalKinds.get(final)
      if (k !== undefined) return !(k === 'var' && kind === 'var')
      return importLocals.has(final)
    }
    let n = 2
    while (clash()) final = base + n++
    if (final !== d) m.renames[d] = final
    finalKinds.set(final, kind)
  }
}

// Directory assignment: chunk basenames ARE mostly original module names
// (rolldown preserves them) — strip the content hash and bucket by name
// convention. agent/hand maps' suggestedDir always wins.
const HASH_RE = /-[A-Za-z0-9_-]{7,10}\.js$/
const stripHash = (f) => f.replace(HASH_RE, '.js')
const dirFor = (file) => {
  const b = stripHash(file).replace(/\.js$/, '')
  if (/^(Icon|Glyph|Logo)[A-Z]/.test(b)) return 'icons'
  if (/^(use[A-Z]|use-)/.test(b)) return 'hooks'
  if (/(^|-)Route$|Page$|^route-/.test(b)) return 'routes'
  if (/^(react|jsx-runtime|scheduler|react-dom|zod|jotai|swr|immer|lodash|floating-ui|react-textarea|wouter|sonner|vaul|cmdk|radix|@)/i.test(b)) return 'vendor'
  if (/^(app-initial|helpers|lib|webapp|main|index|entry|client|runtime|rolldown|modulepreload|common)/.test(file)) return 'core'
  if (/^[A-Z]/.test(b)) return 'components'
  if (/^(api|rpc|client|server)/.test(b)) return 'api'
  return 'misc'
}
const usedPaths = new Map() // path.toLowerCase() -> file (NTFS-insensitive)
const outPathOf = (file) => {
  const m = maps.get(file)
  const dir = m?.suggestedDir ?? dirFor(file)
  let name = m?.suggestedName ?? stripHash(file)
  if (!name.endsWith('.js')) name += '.js'
  let rel = `${dir}/${name}`
  const prev = usedPaths.get(rel.toLowerCase())
  if (prev && prev !== file) {
    rel = `${dir}/${file}` // hash/case collision (route-* etc.) — keep hashed name
    usedPaths.set(rel.toLowerCase(), file)
  } else usedPaths.set(rel.toLowerCase(), file)
  return rel
}
for (const f of files) outPathOf(f)

const resolveSource = (fromFile, spec) => {
  if (!spec.startsWith('.')) return null // package import — leave alone
  const base = path.posix.basename(spec.replace(/\\/g, '/'))
  for (const cand of [base, `${base}.js`, `${base}.ts`, `${base}.jsx`]) {
    if (modules.has(cand)) return cand
  }
  return null // chunk not captured in _devin_assets — keep spec as-is
}

const localNameOf = (file, exported, depth = 0) => {
  if (depth > 8) return null
  const e = modules.get(file)?.exports.get(exported)
  if (!e) return null
  if (e.kind === 'decl') return { file, local: e.local }
  if (e.kind === 'reexport') {
    const tgt = resolveSource(file, e.source)
    return tgt ? localNameOf(tgt, e.name, depth + 1) : null
  }
  return null
}
const semanticExport = (file, exported, depth = 0) => {
  const hit = localNameOf(file, exported, depth)
  if (!hit) return exported
  const rn = maps.get(hit.file)?.renames?.[hit.local]
  return rn ?? hit.local
}

// Import-alias deepening: `import { X as y }` where X resolved to a semantic
// export → rename local alias `y` to X throughout the file (drop the `as`).
// Only when the semantic name is a real identifier, ≥3 chars, and collides
// with nothing else declared/imported in THIS module.
const aliasRenames = new Map() // file -> Map(localAlias -> semantic)
for (const [file, mod] of modules) {
  const used = new Set(mod.decls)
  for (const r of mod.imports) {
    r.specs.forEach((s) => used.add(s.local))
    if (r.dflt) used.add(r.dflt)
    if (r.ns) used.add(r.ns)
  }
  const taken = new Set(Object.values(maps.get(file)?.renames ?? {}))
  const am = new Map()
  for (const r of mod.imports) {
    const tgt = resolveSource(file, r.source)
    if (!tgt) continue
    for (const s of r.specs) {
      const sem = semanticExport(tgt, s.imported)
      if (sem === s.local) continue
      if (!/^[A-Za-z_$][\w$]{2,}$/.test(sem)) continue
      if (used.has(sem) || taken.has(sem) || am.has(s.local)) continue
      am.set(s.local, sem); used.add(sem); taken.add(sem)
    }
  }
  if (am.size) aliasRenames.set(file, am)
}

/* ---------------- pass 3: emit ---------------- */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const applyFile = (file) => {
  const mod = modules.get(file)
  const aliasMap = aliasRenames.get(file) ?? new Map()
  const renames = { ...(maps.get(file)?.renames ?? {}), ...Object.fromEntries(aliasMap) }

  let code = mod.code

  // 3a) rewrite imports: specifier left side → semantic export name; path → new rel
  const relImport = (spec) => {
    const tgt = resolveSource(file, spec)
    if (!tgt) return spec // external package — keep
    const fromDir = path.posix.dirname(outPathOf(file))
    let rel = path.posix.relative(fromDir, outPathOf(tgt))
    if (!rel.startsWith('.')) rel = './' + rel
    return rel
  }
  code = code.replace(/^(import\s+)([^'"]*?)\s+from\s+(["'])([^"']+)\3/gm, (all, p1, clause, q, src) => {
    const tgt = resolveSource(file, src)
    const newSrc = relImport(src)
    if (clause.trim().startsWith('{') || clause.includes('{')) {
      const brace = clause.indexOf('{')
      const head = clause.slice(0, brace), inner = clause.slice(brace + 1, clause.lastIndexOf('}'))
      const tail = clause.slice(clause.lastIndexOf('}') + 1)
      const specs = inner.split(',').map((s) => {
        const p = s.trim().match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/)
        if (!p || !tgt) return s
        const sem = semanticExport(tgt, p[1])
        const local = p[2] ?? p[1]
        // deep-alias: local binding renamed to the semantic name → bare spec
        if (aliasMap.get(local) === sem) return ` ${sem}`
        return ` ${sem}${p[2] ? ` as ${p[2]}` : p[1] !== sem ? ` as ${p[1]}` : ''}`
      })
      return `${p1}${head}{${specs.join(',')}}${tail} from ${q}${newSrc}${q}`
    }
    return `${p1}${clause} from ${q}${newSrc}${q}`
  })
  code = code.replace(/^(import\s+)(["'])([^"']+)\2/gm, (all, p1, q, src) => `${p1}${q}${relImport(src)}${q}`)
  // re-exports: `export { A as B } from 'x'` — A is a FOREIGN export name in x;
  // resolve it to the semantic decl name, keep B (our export contract).
  code = code.replace(/^(export\s+)\{([^}]*)\}\s+from\s+(["'])([^"']+)\3/gm, (all, p1, inner, q, src) => {
    const tgt = resolveSource(file, src)
    const specs = inner.split(',').map((s) => {
      const p = s.trim().match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/)
      if (!p || !tgt) return s
      const sem = semanticExport(tgt, p[1])
      return ` ${sem}${p[2] ? ` as ${p[2]}` : p[1] !== sem ? ` as ${p[1]}` : ''}`
    })
    return `${p1}{${specs.join(',')}} from ${q}${relImport(src)}${q}`
  })
  code = code.replace(/^(export\s+\*\s+from\s+)(["'])([^"']+)\2/gm, (all, p1, q, src) =>
    `${p1}${q}${relImport(src)}${q}`)

  // 3b) semantic export names: `export { X as Y }` → `export { renamedX }`
  //     when X has a rename (importers already rewritten to the new name).
  const doExportLine = (line) => {
    if (/\}\s*from\b/.test(line)) return line // re-export specifiers already handled
    let head, body, tail, wrap
    const m = line.match(/^(\s*export\s*)\{([^}]*?)(?:\}(.*))?$/)
    if (m) { head = m[1]; body = m[2]; tail = (m[3] !== undefined ? '}' + m[3] : ''); wrap = true }
    else if (inExport) {
      // continuation of a multi-line export block — whole line is brace-body
      const close = line.indexOf('}')
      head = ''; body = close < 0 ? line : line.slice(0, close); tail = close < 0 ? '' : line.slice(close); wrap = false
    } else return line
    const out = body.split(',').map((s) => {
      const p = s.trim().match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/)
      if (!p) return s
      // p[1] is ALREADY renamed by the 3c pass — never re-lookup renames here
      // (a renamed local can coincide with another renames key → double rename)
      return ` ${p[1]}` // drop the minified alias — importers use the semantic name
    })
    return wrap ? `${head}{${out.join(',')}${tail}` : out.join(',') + tail
  }

  // 3c) top-level renames on string-masked code (identifiers inside string/
  //     comment/regex literals — Tailwind `pt-2`, `\`dt\`` tags — must never
  //     be renamed). `${...}` interiors of templates stay live.
  const names = Object.keys(renames).sort((a, b) => b.length - a.length)
  const { masked, restore } = maskStrings(code)
  // one combined regex — alternation order = longest-first, so prefix names
  // (`_Component16` vs `_Component1`) resolve greedily and correctly.
  const idRe = names.length
    ? new RegExp(`(?<![\\w$])(${names.map(esc).join('|')})(?![\\w$])`, 'g')
    : null
  // `of`/`in` are legal identifiers AND for-of/for-in keywords — a minified
  // import alias named `of` must not rewrite `for (let t of e)`. Protect every
  // `of`/`in` occurrence inside `for (...)` parens (tracked across newlines) by
  // absolute offset in the masked source.
  const forProtected = new Set()
  if (renames.of !== undefined || renames.in !== undefined) {
    const re = /\bfor\s*\(/g
    let m
    while ((m = re.exec(masked))) {
      let i = m.index + m[0].length, d = 1
      while (i < masked.length && d > 0) {
        if (masked[i] === '(') d++
        else if (masked[i] === ')') d--
        i++
      }
      const inner = masked.slice(m.index + m[0].length, i)
      const ir = /\b(of|in)\b/g
      let mm
      while ((mm = ir.exec(inner))) forProtected.add(m.index + m[0].length + mm.index)
    }
  }
  const ren = (text, baseOff = 0) => text.replace(idRe, (mm, _g, off) => {
    const absOff = baseOff + off
    const prev = text[off - 1]
    const next = text[off + mm.length]
    // `obj.X` member access keeps the key — but `...X` spread is a use
    if (prev === '.' && !(text[off - 2] === '.' && text[off - 3] === '.')) return mm
    if (next === ':' && /[{,]\s*$/.test(text.slice(0, off))) return mm
    if (mm === '$' && next === '{') return mm
    if ((mm === 'of' || mm === 'in') && forProtected.has(absOff)) return mm
    return renames[mm]
  })
  let inExport = false
  let cursor = 0
  let work = masked.split('\n').map((line) => {
    const baseOff = cursor
    cursor += line.length + 1
    const isExportBlock = inExport || /^\s*export\s*\{[^}]*$/.test(line) || /^\s*export\s*\{.*\}/.test(line)
    if (/^\s*import[\s{*]/.test(line)) return line // already rewritten
    if (/^\s*export\s*\{[^}]*\}\s*from\b/.test(line)) return line // re-export — foreign names
    if (isExportBlock) {
      const braceAt = line.indexOf('{')
      const bodyStart = braceAt < 0 ? 0 : braceAt + 1
      const closeAt = line.indexOf('}', bodyStart)
      const bodySeg = line.slice(bodyStart, closeAt < 0 ? undefined : closeAt)
      const out = line.slice(0, bodyStart) + bodySeg.split(',').map((seg, segIdx) => {
        // baseOff inside a spec line is approximate — of/in don't appear here anyway
        const p = seg.match(/^(\s*)([\w$]+)(\s+as\s+[\w$]+.*)$/)
        return p ? p[1] + ren(p[2], baseOff + bodyStart) + p[3] : ren(seg, baseOff + bodyStart)
      }).join(',') + (closeAt < 0 ? '' : line.slice(closeAt))
      inExport = closeAt < 0
      return out
    }
    return ren(line, baseOff)
  }).join('\n')
  code = restore(work)
  inExport = false
  code = code.split('\n').map((line) => {
    if (/^\s*import[\s{*]/.test(line)) return line
    if (/^\s*export\s*\{/.test(line) || inExport) {
      const out = doExportLine(line)
      inExport = !line.includes('}')
      return out
    }
    return line
  }).join('\n')

  const rel = outPathOf(file)
  const dst = path.join(OUT, rel)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  const m = maps.get(file)
  const header = [
    `// Deobfuscated from _devin_assets/${file} — semantic rename + import rewiring`,
    m?.description ? `// ${m.description}` : null,
    ``,
  ].filter((l) => l !== null).join('\n')
  fs.writeFileSync(dst, header + code)
  return rel
}

if (!checkOnly) {
  if (!only) fs.rmSync(OUT, { recursive: true, force: true }) // clean slate on full emit
  const todo = only ? [only] : files
  let n = 0
  for (const f of todo) { applyFile(f); n++ }
  console.log(`emitted ${n} files → _deob/src/`)
  // manifest
  const manifest = {}
  for (const f of files) manifest[f] = outPathOf(f)
  fs.writeFileSync('_deob/src-manifest.json', JSON.stringify(manifest, null, 1))
  console.log('manifest → _deob/src-manifest.json')
}
