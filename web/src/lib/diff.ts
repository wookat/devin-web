export interface WordSeg {
  text: string
  changed: boolean
}

/** Intra-line diff for a paired removed/added line: common prefix + suffix, changed middle. */
export function wordDiff(before: string, after: string): [WordSeg[], WordSeg[]] {
  if (before === after) return [[{ text: before, changed: false }], [{ text: after, changed: false }]]
  let p = 0
  const max = Math.min(before.length, after.length)
  while (p < max && before[p] === after[p]) p++
  let s = 0
  while (s < max - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++
  const seg = (t: string, midEnd: number): WordSeg[] => {
    const out: WordSeg[] = []
    if (p > 0) out.push({ text: t.slice(0, p), changed: false })
    if (midEnd > p) out.push({ text: t.slice(p, midEnd), changed: true })
    if (s > 0) out.push({ text: t.slice(midEnd), changed: false })
    return out.length ? out : [{ text: t, changed: false }]
  }
  return [seg(before, before.length - s), seg(after, after.length - s)]
}

/**
 * Block-level word diff (official semantics): token LCS computed across the whole
 * removed block vs added block, so words shared across line boundaries stay unhighlighted.
 * Returns per-line segments for each side.
 */
export function blockWordDiff(before: string[], after: string[]): [WordSeg[][], WordSeg[][]] {
  const tokenize = (lines: string[]): string[] => {
    const out: string[] = []
    lines.forEach((l, i) => {
      if (i > 0) out.push('\n')
      for (const m of l.match(/[A-Za-z0-9_]+|\s+|./g) || []) out.push(m)
    })
    return out
  }
  const a = tokenize(before)
  const b = tokenize(after)
  const fallback = (): [WordSeg[][], WordSeg[][]] => {
    const bs: WordSeg[][] = []
    const as: WordSeg[][] = []
    const rows = Math.max(before.length, after.length)
    for (let j = 0; j < rows; j++) {
      const [l, r] = j < before.length && j < after.length ? wordDiff(before[j], after[j]) : [null, null]
      if (j < before.length) bs.push(l ?? [{ text: before[j], changed: true }])
      if (j < after.length) as.push(r ?? [{ text: after[j], changed: true }])
    }
    return [bs, as]
  }
  if (a.length * b.length > 1_000_000) return fallback()
  const n = a.length
  const m = b.length
  const dp: Uint32Array[] = []
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const flagA: boolean[] = new Array(n).fill(true)
  const flagB: boolean[] = new Array(m).fill(true)
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { flagA[i] = false; flagB[j] = false; i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  const rebuild = (toks: string[], flags: boolean[]): WordSeg[][] => {
    const lines: WordSeg[][] = [[]]
    for (let k = 0; k < toks.length; k++) {
      if (toks[k] === '\n') { lines.push([]); continue }
      const cur = lines[lines.length - 1]
      const last = cur[cur.length - 1]
      if (last && last.changed === flags[k]) last.text += toks[k]
      else cur.push({ text: toks[k], changed: flags[k] })
    }
    return lines
  }
  return [rebuild(a, flagA), rebuild(b, flagB)]
}

export interface DiffLine {
  type: 'same' | 'add' | 'del'
  text: string
}

/** Simple LCS-based line diff, collapsed to changed hunks with 2 lines of context. */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  return collapse(lineDiffFull(oldText, newText), 2)
}

/** Full LCS-based line diff with every context line kept. */
export function lineDiffFull(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n')
  const b = newText.split('\n')
  const n = a.length
  const m = b.length
  if (n * m > 4_000_000) {
    return [{ type: 'same', text: '(文件过大，跳过 diff)' }]
  }
  const dp: Uint32Array[] = []
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] })
      i++; j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: a[i] })
      i++
    } else {
      out.push({ type: 'add', text: b[j] })
      j++
    }
  }
  while (i < n) out.push({ type: 'del', text: a[i++] })
  while (j < m) out.push({ type: 'add', text: b[j++] })
  return out
}

function collapse(lines: DiffLine[], context: number): DiffLine[] {
  if (!lines.some((l) => l.type !== 'same')) return lines
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((l, idx) => {
    if (l.type !== 'same') {
      for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) keep[k] = true
    }
  })
  const out: DiffLine[] = []
  let skipping = false
  lines.forEach((l, idx) => {
    if (keep[idx]) {
      out.push(l)
      skipping = false
    } else if (!skipping) {
      out.push({ type: 'same', text: '…' })
      skipping = true
    }
  })
  return out
}

/** After-side changed-line runs of a hunk, as inclusive [start, end] line-number ranges. */
export function changedAfterRanges(beforeContent: string | null, afterContent: string, afterStart: number): [number, number][] {
  const lines = beforeContent == null
    ? afterContent.split('\n').map((text) => ({ type: 'add' as const, text }))
    : lineDiffFull(beforeContent, afterContent)
  const out: [number, number][] = []
  let after = afterStart
  for (const l of lines) {
    if (l.type === 'del') continue
    if (l.type === 'add') {
      const last = out[out.length - 1]
      if (last && last[1] === after - 1) last[1] = after
      else out.push([after, after])
    }
    after++
  }
  return out
}

/** Before-side line number matching an after-side context (unchanged) line, or null for changed lines. */
export function otherSideLine(beforeContent: string | null, afterContent: string, afterStart: number, beforeStart: number, targetAfterLine: number): number | null {
  if (beforeContent == null) return null
  const lines = lineDiffFull(beforeContent, afterContent)
  let after = afterStart
  let before = beforeStart
  for (const l of lines) {
    if (l.type === 'del') { before++; continue }
    if (l.type === 'same' && after === targetAfterLine) return before
    if (after === targetAfterLine) return null
    after++
    if (l.type === 'same') before++
  }
  return null
}
