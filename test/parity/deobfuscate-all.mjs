#!/usr/bin/env node
/**
 * Batch-deobfuscate every cached official Devin bundle in `_devin_assets/` into
 * `_deob/all/<name>.js` via webcrack — near-source JSX/control-flow recovery.
 * Re-runnable: skips existing outputs. `node test/parity/deobfuscate-all.mjs`
 * Options: --filter <substr>   only matching files
 *          --limit  <n>        process at most n files
 *          --size   <kb>       skip files larger than this (default 3000)
 */
import { webcrack } from 'webcrack'
import fs from 'node:fs'
import path from 'node:path'

const SRC = '_devin_assets'
const OUT = '_deob/all'
const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1] }
const filter = opt('--filter', '')
const limit = Number(opt('--limit', '0')) || Infinity
const maxKb = Number(opt('--size', '3000'))

fs.mkdirSync(OUT, { recursive: true })
const files = fs.readdirSync(SRC)
  .filter((f) => f.endsWith('.js') && f.includes(filter))
  .map((f) => ({ f, kb: fs.statSync(path.join(SRC, f)).size / 1024 }))
  .filter((x) => x.kb <= maxKb)
  .sort((a, b) => a.kb - b.kb) // small first — fast wins land early
  .slice(0, limit)

let done = 0, failed = 0, skipped = 0
const t0 = Date.now()
for (const { f, kb } of files) {
  const dst = path.join(OUT, f)
  if (fs.existsSync(dst)) { skipped++; continue }
  try {
    const code = fs.readFileSync(path.join(SRC, f), 'utf8')
    const res = await webcrack(code)
    fs.writeFileSync(dst, res.code)
    done++
    if (done % 25 === 0 || kb > 500) {
      console.log(`[${done} done ${failed} failed ${skipped} skip] ${f} ${kb.toFixed(0)}KB ${((Date.now() - t0) / 1000).toFixed(0)}s`)
    }
  } catch (e) {
    failed++
    console.log(`FAIL ${f}: ${String(e).slice(0, 120)}`)
  }
}
console.log(`\nDONE: ${done} deobfuscated, ${skipped} skipped, ${failed} failed in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
