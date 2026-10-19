import { blockWordDiff, type WordSeg } from './diff'

export interface PrDiffFileInput {
  base_content: string | null
  hunks: {
    before_lines: [number, number] | null
    after_lines: [number, number] | null
    before_content: string | null
    after_content: string | null
  }[]
}

export interface PrDiffRow {
  kind: 'ctx' | 'del' | 'add'
  oldNo?: number
  newNo?: number
  text: string
  segs?: WordSeg[]
  hunkIndex?: number
}

export function buildPrDiffRows(f: PrDiffFileInput): PrDiffRow[] {
  const rows: PrDiffRow[] = []
  const hunks = f.hunks
    .map((h, hunkIndex) => ({ h, hunkIndex }))
    .sort((a, b) => (a.h.before_lines?.[0] ?? a.h.after_lines?.[0] ?? Number.MAX_SAFE_INTEGER) - (b.h.before_lines?.[0] ?? b.h.after_lines?.[0] ?? Number.MAX_SAFE_INTEGER))
  const base = f.base_content == null ? null : f.base_content.split('\n')
  let oldCursor = 1
  let newCursor = 1
  for (const { h, hunkIndex } of hunks) {
    const oldStart = h.before_lines?.[0] ?? oldCursor
    const contextNewStart = newCursor
    newCursor += Math.max(0, oldStart - oldCursor)
    if (base) {
      for (let oldNo = oldCursor; oldNo < oldStart; oldNo++) {
        const text = base[oldNo - 1]
        if (text !== undefined) rows.push({ kind: 'ctx', oldNo, newNo: contextNewStart + oldNo - oldCursor, text })
      }
    }
    const before = h.before_content != null ? h.before_content.split('\n') : []
    const after = h.after_content != null ? h.after_content.split('\n') : []
    const wdBlock = h.before_content != null && h.after_content != null
      ? blockWordDiff(before, after)
      : null
    for (let i = 0; i < before.length; i++) {
      rows.push({ kind: 'del', oldNo: h.before_lines ? h.before_lines[0] + i : undefined, text: before[i], segs: wdBlock?.[0][i], hunkIndex })
    }
    const newStart = h.after_lines?.[0] ?? newCursor
    for (let i = 0; i < after.length; i++) {
      rows.push({ kind: 'add', newNo: newStart + i, text: after[i], segs: wdBlock?.[1][i], hunkIndex })
    }
    if (h.before_lines) oldCursor = Math.max(oldCursor, h.before_lines[1] + 1)
    newCursor = newStart + after.length
  }
  if (base) {
    for (let oldNo = oldCursor; oldNo <= base.length; oldNo++) {
      rows.push({ kind: 'ctx', oldNo, newNo: newCursor + oldNo - oldCursor, text: base[oldNo - 1] })
    }
  }
  return rows
}
