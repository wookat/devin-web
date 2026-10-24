import { Children, createContext, isValidElement, useContext, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { Element as HastElement, ElementContent } from 'hast'
import { ArrowDown, ArrowUp, ArrowUpDown, Check, Copy } from 'lucide-react'
import { copyText } from '../lib/clipboard'

/** Official markdown table (app.devin.ai DOM + bundle, sampled 2026-09-05):
 *  elevated rounded-12 card (p-1.5) with a hover "Copy table" pill, hidden
 *  horizontal scrollbar, borderless rows separated by 2px spacing, transparent
 *  12/16 secondary headers that sort on click (numeric-aware, asc → desc →
 *  none), row hover lifts cell text to primary, and the official
 *  min/max-per-column width distribution (32px cell padding, caps by
 *  character count) applied as a fixed table layout. */

type Sort = { col: number; dir: 'asc' | 'desc' } | null

interface TableState {
  sort: Sort
  toggle: (col: number) => void
  order: number[] | null
}

const TableCtx = createContext<TableState | null>(null)
const HeadCtx = createContext(false)

function hastText(n: ElementContent): string {
  if (n.type === 'text') return n.value
  if (n.type === 'element') return n.children.map(hastText).join('')
  return ''
}

function hastRows(node: HastElement | undefined): string[][] {
  if (!node) return []
  const rows: string[][] = []
  const walk = (el: HastElement) => {
    for (const c of el.children) {
      if (c.type !== 'element') continue
      if (c.tagName === 'tr') {
        rows.push(c.children.filter((k): k is HastElement => k.type === 'element' && (k.tagName === 'th' || k.tagName === 'td')).map((k) => hastText(k).trim()))
      } else walk(c)
    }
  }
  walk(node)
  return rows
}

function numOf(s: string): number {
  const t = s.replace(/^[<>≈±+~$\s]*([-−]?)[$\s]*/, '$1').replace(/^−/, '-').replace(/%$/, '').trim()
  const n = /^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(t) ? t.replace(/,/g, '') : t
  return /^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(n) ? parseFloat(n) : NaN
}

function cmpCells(a: string, b: string, dir: 'asc' | 'desc'): number {
  const x = numOf(a)
  const y = numOf(b)
  const s = dir === 'asc' ? 1 : -1
  if (!Number.isNaN(x) && !Number.isNaN(y)) return s * (x - y)
  if (Number.isNaN(x)) return Number.isNaN(y) ? s * a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }) : 1
  return -1
}

function nextSort(cur: Sort, col: number): Sort {
  if (cur?.col === col) return cur.dir === 'asc' ? { col, dir: 'desc' } : null
  return { col, dir: 'asc' }
}

function bodyOrder(rows: string[][], sort: Sort): number[] | null {
  if (!sort || rows.length < 2) return null
  const cols = rows[0].length
  const body = rows.slice(1).map((cells, i) => ({ cells, i }))
  const same = body.filter((r) => r.cells.length === cols)
  const rest = body.filter((r) => r.cells.length !== cols)
  same.sort((a, b) => cmpCells(a.cells[sort.col] ?? '', b.cells[sort.col] ?? '', sort.dir))
  return same.concat(rest).map((r) => r.i)
}

function tableToMarkdown(t: HTMLTableElement): string {
  const cell = (c: HTMLTableCellElement) => (c.textContent ?? '').replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')
  const rows = Array.from(t.rows).map((r) => Array.from(r.cells).map(cell))
  if (rows.length === 0) return ''
  const width = Math.max(...rows.map((r) => r.length))
  const [head = [], ...body] = rows.map((r) => { const c = [...r]; while (c.length < width) c.push(''); return c })
  return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...body.map((r) => `| ${r.join(' | ')} |`)].join('\n')
}

/* ---- official column sizing (cell padding 32, caps by char count) ---- */
const PAD = 32
const CAPS = [{ maxChars: 5, maxWidth: 80 }, { maxChars: 20, maxWidth: 200 }, { maxChars: 50, maxWidth: 300 }]
const CAP_MAX = 400
const BREAKOUT_GUTTER = 32
const FALLBACK_CH = 8

let canvas: CanvasRenderingContext2D | null | undefined

function textWidth(text: string, font: string): number {
  if (!text) return 0
  if (canvas === undefined) canvas = document.createElement('canvas').getContext('2d')
  if (!canvas) return text.length * FALLBACK_CH
  canvas.font = font
  return canvas.measureText(text).width
}

let segmenter: Intl.Segmenter | null | undefined
/** Trailing punctuation that stays glued to the preceding unit. */
const TRAIL = new Set(['.', ',', '!', '?', ':', ';', ')', ']', '}', '%', '"', '”', '’', '»', '›', '…', '-', '，', '。', '！', '：', '；', '？', '、', '）', '」', '』', '】', '》', '〉', '〕'])

/** Break opportunities: word-granularity segments (punctuation glued to the previous unit). */
function breakUnits(text: string): string[] {
  if (segmenter === undefined) segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null
  const segs = segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : text.split(/(\s+)/)
  const out: string[] = []
  for (const s of segs) {
    if (!s.trim()) continue
    if (out.length > 0 && Array.from(s).every((ch) => TRAIL.has(ch))) out[out.length - 1] += s
    else out.push(s)
  }
  return out
}

function measure(text: string, font: string): { minPx: number; maxPx: number } {
  if (!text) return { minPx: 0, maxPx: 0 }
  let minPx = 0
  for (const u of breakUnits(text)) minPx = Math.max(minPx, textWidth(u, font))
  let maxPx = 0
  for (const line of text.split('\n')) maxPx = Math.max(maxPx, textWidth(line, font))
  return { minPx, maxPx }
}

function fontOf(el: Element): string {
  const s = getComputedStyle(el)
  return s.font || `${s.fontStyle} ${s.fontWeight} ${s.fontSize}/${s.lineHeight} ${s.fontFamily}`
}

function capFor(chars: number): number {
  for (const { maxChars, maxWidth } of CAPS) if (chars <= maxChars) return maxWidth
  return CAP_MAX
}

interface Constraint { minPx: number; maxPx: number; maxChars: number }

function constraintsOf(table: HTMLTableElement): { constraints: Constraint[]; headerCells: HTMLTableCellElement[] } {
  const head = table.tHead?.rows[0]
  if (!head) return { constraints: [], headerCells: [] }
  const headerCells = Array.from(head.cells)
  const n = headerCells.length
  const constraints: Constraint[] = Array.from({ length: n }, () => ({ minPx: 0, maxPx: 0, maxChars: 0 }))
  const fonts = new Map<string, string>()
  for (const row of Array.from(table.rows)) {
    const m = Math.min(row.cells.length, n)
    for (let i = 0; i < m; i++) {
      const cell = row.cells[i]
      const c = constraints[i]
      let font = fonts.get(cell.tagName)
      if (font === undefined) { font = fontOf(cell); fonts.set(cell.tagName, font) }
      const text = (cell.textContent ?? '').trim()
      const { minPx, maxPx } = measure(text, font)
      if (text.length > c.maxChars) c.maxChars = text.length
      if (maxPx > c.maxPx) c.maxPx = maxPx
      if (minPx > c.minPx) c.minPx = minPx
    }
  }
  return { constraints, headerCells }
}

function distribute(cons: Constraint[], width: number): number[] {
  if (cons.length === 0) return []
  const mins = cons.map((c) => Math.max(c.minPx + PAD, PAD))
  const maxs = cons.map((c, i) => Math.max(Math.min(c.maxPx + PAD, capFor(c.maxChars)), mins[i]))
  const minSum = mins.reduce((a, b) => a + b, 0)
  if (minSum >= width || width === 0) return mins
  const extra = width - minSum
  const room = maxs.map((m, i) => m - mins[i])
  const roomSum = room.reduce((a, b) => a + b, 0)
  if (roomSum === 0) {
    const each = extra / cons.length
    return mins.map((m) => m + each)
  }
  const out = mins.map((m, i) => Math.min(m + (room[i] / roomSum) * extra, maxs[i]))
  let left = width - out.reduce((a, b) => a + b, 0)
  if (left > 1) {
    const open = out.map((w, i) => (w < maxs[i] ? i : -1)).filter((i) => i >= 0)
    if (open.length > 0) {
      const each = left / open.length
      for (const i of open) {
        const add = Math.min(each, maxs[i] - out[i])
        out[i] += add
        left -= add
      }
    }
    if (left > 1) {
      const each = left / out.length
      for (let i = 0; i < out.length; i++) out[i] += each
    }
  }
  return out
}

/** Natural table width: every column at its (capped) max. */
function desiredWidth(cons: Constraint[]): number {
  let sum = 0
  for (const c of cons) {
    const min = Math.max(c.minPx + PAD, PAD)
    sum += Math.max(Math.min(c.maxPx + PAD, capFor(c.maxChars)), min)
  }
  return sum
}

function closestScroller(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY
    if (o === 'auto' || o === 'scroll') return p
  }
  return null
}

/**
 * Breakout: a table wider than its message column grows up to the transcript
 * width (minus BREAKOUT_GUTTER) and is centred within the scroll viewport.
 */
function applyBreakout(outer: HTMLElement, natural: number) {
  const parent = outer.parentElement
  const scroller = closestScroller(outer)
  if (!parent || !scroller || natural <= parent.clientWidth) {
    outer.style.width = ''
    outer.style.maxWidth = ''
    outer.style.marginLeft = '0px'
    return
  }
  const avail = Math.max(0, scroller.clientWidth - BREAKOUT_GUTTER)
  outer.style.maxWidth = `${avail}px`
  outer.style.width = `${Math.min(natural, avail)}px`
  outer.style.marginLeft = '0px'
  const w = outer.offsetWidth
  if (w <= parent.clientWidth) return
  const left = outer.getBoundingClientRect().left - scroller.getBoundingClientRect().left
  outer.style.marginLeft = `${(scroller.clientWidth - w) / 2 - left}px`
}

function applyWidths(outer: HTMLElement, table: HTMLTableElement, viewport: HTMLElement) {
  const { constraints, headerCells } = constraintsOf(table)
  if (headerCells.length === 0) return
  applyBreakout(outer, desiredWidth(constraints))
  const width = viewport.clientWidth
  const widths = distribute(constraints, width)
  const sum = widths.reduce((a, b) => a + b, 0)
  table.style.tableLayout = 'fixed'
  table.style.width = `${Math.max(sum, width)}px`
  headerCells.forEach((cell, i) => { cell.style.width = `${widths[i]}px` })
}

function useColumnSizing() {
  const outerRef = useRef<HTMLDivElement>(null)
  const tableRef = useRef<HTMLTableElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const outer = outerRef.current
    const table = tableRef.current
    const viewport = viewportRef.current
    if (!outer || !table || !viewport) return
    let raf = 0
    const run = () => applyWidths(outer, table, viewport)
    const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(run) }
    run()
    const mo = new MutationObserver(schedule)
    mo.observe(table, { childList: true, subtree: true, characterData: true })
    const ro = new ResizeObserver(schedule)
    ro.observe(viewport)
    if (outer.parentElement) ro.observe(outer.parentElement)
    const scroller = closestScroller(outer)
    if (scroller) ro.observe(scroller)
    let dead = false
    document.fonts?.ready.then(() => { if (!dead) schedule() })
    return () => { dead = true; cancelAnimationFrame(raf); mo.disconnect(); ro.disconnect() }
  }, [])
  return { outerRef, tableRef, viewportRef }
}

/* ---- components wired into react-markdown ---- */

export function MdTable({ node, children }: { node?: HastElement; children?: ReactNode }) {
  const { t } = useTranslation()
  const [sort, setSort] = useState<Sort>(null)
  const [copied, setCopied] = useState(false)
  const rows = hastRows(node)
  const order = bodyOrder(rows, sort)
  const { outerRef, tableRef, viewportRef } = useColumnSizing()
  const copy = () => {
    const t = tableRef.current
    if (!t) return
    copyText(tableToMarkdown(t)).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => { /* clipboard unavailable */ })
  }
  return (
    <TableCtx.Provider value={{ sort, toggle: (col) => setSort((s) => nextSort(s, col)), order }}>
      <div ref={outerRef} className="relative isolate my-4 [&:first-child]:mt-0 [&:last-child]:mb-0" data-md-table="">
        <span className="absolute right-2 top-2 z-10 inline-flex rounded-[8px] border border-border-secondary bg-elevated p-[2px] shadow-sm opacity-0 focus-within:opacity-100 [div:hover>&]:opacity-100">
          <button
            type="button"
            aria-label={t('md.copyTable')}
            onClick={copy}
            className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-[6px] bg-transparent text-muted-foreground hover:bg-tint-secondary hover:text-foreground"
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
          </button>
        </span>
        <div className="@container relative w-full overflow-hidden rounded-[12px] border border-border-secondary bg-elevated p-1.5 [&_td]:whitespace-normal [&_td]:break-words [&_th]:whitespace-normal [&_th]:break-words">
          <div ref={viewportRef} className="w-full overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <table ref={tableRef} className="w-full caption-bottom border-separate border-spacing-x-0 border-spacing-y-0.5 overflow-x-clip text-[13px] leading-[18px] text-muted-foreground">
              {children}
            </table>
          </div>
        </div>
      </div>
    </TableCtx.Provider>
  )
}

export function MdThead({ children }: { children?: ReactNode }) {
  return <HeadCtx.Provider value={true}><thead>{children}</thead></HeadCtx.Provider>
}

export function MdTbody({ children }: { children?: ReactNode }) {
  const ctx = useContext(TableCtx)
  const kids = Children.toArray(children).filter(isValidElement)
  const ordered = ctx?.order && ctx.order.length === kids.length ? ctx.order.map((i) => kids[i]) : kids
  return <tbody>{ordered}</tbody>
}

const ROW_CLASS = 'group/row text-[13px]'

export function MdTr({ children }: { children?: ReactNode }) {
  const head = useContext(HeadCtx)
  if (!head) return <tr className={ROW_CLASS}>{children}</tr>
  const cells = Children.toArray(children).filter((c): c is ReactElement<{ children?: ReactNode }> => isValidElement(c))
  return (
    <tr className={ROW_CLASS}>
      {cells.map((c, i) => <SortTh key={i} col={i}>{c.props.children}</SortTh>)}
    </tr>
  )
}

function SortTh({ col, children }: { col: number; children?: ReactNode }) {
  const { t } = useTranslation()
  const ctx = useContext(TableCtx)
  const dir = ctx?.sort?.col === col ? ctx.sort.dir : null
  const label = (() => {
    const text = Children.toArray(children).map((c) => (typeof c === 'string' || typeof c === 'number' ? String(c) : '')).join('').trim()
    return text ? t('md.sortBy', { col: text }) : t('md.sortCol', { n: col + 1 })
  })()
  const Icon = dir === 'asc' ? ArrowUp : dir === 'desc' ? ArrowDown : ArrowUpDown
  return (
    <th
      className="relative h-7 cursor-pointer whitespace-nowrap px-3 py-2 text-left align-middle text-[12px] font-medium leading-[16px] text-muted-foreground @sm:px-4"
      aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}
      onClick={(e) => { if (e.target instanceof Element && e.target.closest('a')) return; ctx?.toggle(col) }}
    >
      {children}
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={(e) => { e.stopPropagation(); ctx?.toggle(col) }}
        className={`absolute right-1 top-1/2 flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center focus-visible:!opacity-100 ${dir ? '' : 'opacity-0 [th:focus-within>&]:opacity-60 [th:hover>&]:opacity-60'}`}
      >
        <Icon size={12} aria-hidden="true" />
      </button>
    </th>
  )
}

export function MdTh({ children }: { children?: ReactNode }) {
  return <th className="h-7 whitespace-nowrap px-3 py-2 text-left align-middle text-[12px] font-medium leading-[16px] text-muted-foreground @sm:px-4">{children}</th>
}

export function MdTd({ children }: { children?: ReactNode }) {
  return (
    <td className="whitespace-nowrap px-3 py-2 align-middle text-[12px] leading-[16px] group-hover/row:text-foreground @sm:px-4 [&>*]:align-middle [&_img]:m-0 [&_img]:inline">
      {children}
    </td>
  )
}
