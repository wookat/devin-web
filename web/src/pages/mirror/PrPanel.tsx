import { cloneElement, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, ChevronDown, ChevronUp, Settings2, Copy, Check, Plus, XCircle, CheckCircle2, Circle, Link2, Expand, MessageSquare, Bug as BugIcon, Reply, Code, CircleDashed, ChevronsUpDown, ArrowUpRight, MoreHorizontal, Trash2, Pencil, GitPullRequest, Flag, SmilePlus, FileCode2 } from 'lucide-react'
import { adminFetch } from '@/lib/api'
import Markdown from '@/components/Markdown'
import { blockWordDiff, changedAfterRanges, otherSideLine, type WordSeg } from '@/lib/diff'
import { buildPrDiffRows, type PrDiffRow as PrDiffRowT } from '@/lib/prDiffRows'
import { cn } from '@/lib/utils'
import { reviewMirrorPath } from '@/lib/mirrorLinks'
import { relTime } from './treeCache'

interface PrBugItemT {
  title: string
  description: string
  file_path: string
  start_line: string
  severity: string
  category?: string
  cwe_id?: string
  needs_investigation?: boolean
}

interface PrDiffFileT {
  file_path: string
  old_file_path: string | null
  change_type: string
  base_content: string | null
  hunks: { before_lines: [number, number] | null; after_lines: [number, number] | null; before_content: string | null; after_content: string | null }[]
}

function rangeLength(range: [number, number] | null): number {
  return range ? Math.max(0, range[1] - range[0] + 1) : 0
}

function PrInlineComposer({ f, line, onAddComment, onClose }: { f: PrDiffFileT; line: number; onAddComment: NonNullable<Parameters<typeof PrDiffFile>[0]['onAddComment']>; onClose: () => void }) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const submit = async (startReview: boolean) => {
    if (busy || !text.trim()) return
    setBusy(true)
    setError('')
    const ranges = f.hunks.flatMap((h) => h.after_lines && h.after_content != null ? changedAfterRanges(h.before_content, h.after_content, h.after_lines[0]) : [])
    const hunk = f.hunks.find((h) => h.after_lines && line >= h.after_lines[0] && line <= h.after_lines[1])
    const otherSide = hunk?.after_lines && hunk.after_content != null && hunk.before_lines
      ? otherSideLine(hunk.before_content, hunk.after_content, hunk.after_lines[0], hunk.before_lines[0], line)
      : null
    const err = await onAddComment(f.file_path, line, text.trim(), startReview, ranges, otherSide)
    setBusy(false)
    if (err) setError(err)
    else { setText(''); onClose() }
  }
  return (
    <div className="col-span-2 m-2 min-w-0 overflow-hidden rounded-[10px] border border-border bg-popover font-sans text-[13px] shadow-md">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2"><span className="font-medium">{t('pr.newComment')}</span><span className="rounded-[4px] bg-muted px-1 text-[11px] text-muted-foreground">R{line}</span></div>
      <div className="p-2">
        <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={t('pr.commentPh')} rows={3} className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 outline-none focus:border-ring" />
        {error && <p className="mt-1 text-[12px] text-red-500">{error}</p>}
        <div className="mt-1.5 flex items-center justify-end gap-2">
          <button onClick={onClose} className="h-7 cursor-pointer rounded-md px-2.5 text-muted-foreground hover:bg-accent hover:text-foreground">{t('common.cancel')}</button>
          <div className="relative flex">
            <button disabled={busy || !text.trim()} onClick={() => void submit(true)} className="h-7 cursor-pointer rounded-l-md bg-primary px-2.5 text-primary-foreground disabled:cursor-default disabled:opacity-50">{t('pr.startReview')}</button>
            <button aria-label={t('pr.moreSend')} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)} className="flex h-7 cursor-pointer items-center rounded-r-md border-l border-primary-foreground/20 bg-primary px-1 text-primary-foreground"><ChevronDown size={12} /></button>
            {menuOpen && <div role="menu" className="absolute right-0 top-8 z-40 min-w-[140px] rounded-[10px] border border-border bg-popover p-1"><button role="menuitem" onClick={() => { setMenuOpen(false); void submit(false) }} className="flex h-[30px] w-full cursor-pointer items-center rounded-[6px] px-2 text-[13px] hover:bg-accent">{t('pr.comment')}</button></div>}
          </div>
        </div>
      </div>
    </div>
  )
}

function readViewedSet(key: string): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]') as string[]) } catch { return new Set() }
}

function toggleViewedStore(key: string, path: string, on: boolean) {
  const s = readViewedSet(key)
  if (on) s.add(path); else s.delete(path)
  try { localStorage.setItem(key, JSON.stringify([...s])) } catch { /* quota */ }
  window.dispatchEvent(new CustomEvent('pr-viewed-change', { detail: key }))
}

/** Section header "Mark all as viewed" progress ring (official n/m + circle). */
function PrSectionViewedProgress({ files, viewedKey }: { files: string[]; viewedKey: string }) {
  const { t } = useTranslation()
  const [, setTick] = useState(0)
  useEffect(() => {
    const h = (e: Event) => { if ((e as CustomEvent).detail === viewedKey) setTick((t) => t + 1) }
    window.addEventListener('pr-viewed-change', h)
    return () => window.removeEventListener('pr-viewed-change', h)
  }, [viewedKey])
  const set = readViewedSet(viewedKey)
  const done = files.filter((f) => set.has(f)).length
  const C = 2 * Math.PI * 8
  return (
    <button
      type="button"
      aria-label={t('pr.markAllViewed')}
      onClick={() => { const all = done < files.length; for (const f of files) toggleViewedStore(viewedKey, f, all) }}
      className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md p-1 hover:bg-accent"
    >
      <span className="text-[13px] tabular-nums text-muted-foreground">{done}/{files.length}</span>
      <svg className="size-4 shrink-0" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2" className="text-border" />
        <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" transform="rotate(-90 10 10)" strokeDasharray={`${(done / Math.max(1, files.length)) * C} ${C}`} className="text-emerald-500" opacity={done ? 1 : 0} />
      </svg>
    </button>
  )
}

/** Official Diff settings menu state (Split/Unified view, Hide whitespace, Hide highlights). */
interface DiffOptsT { split: boolean; hideWs: boolean; hideHl: boolean }
const DIFF_OPTS_KEY = 'pr-diff-settings'
function readDiffOpts(): DiffOptsT {
  try {
    const v = JSON.parse(localStorage.getItem(DIFF_OPTS_KEY) || '{}') as Partial<DiffOptsT>
    return { split: v.split === true, hideWs: v.hideWs === true, hideHl: v.hideHl === true }
  } catch { return { split: false, hideWs: false, hideHl: false } }
}

/** Renders a diff line with intra-line changed segments highlighted (official word-diff tokens). */
function WordDiffLine({ segs, kind }: { segs: WordSeg[]; kind: 'del' | 'add' }) {
  return (
    <>
      {segs.map((s, k) =>
        s.changed ? (
          <span key={k} className={cn('rounded-[2px] text-[rgb(25,25,25)]', kind === 'del' ? 'bg-[#fca5a5]' : 'bg-[#86efac]')}>{s.text}</span>
        ) : (
          <span key={k}>{s.text}</span>
        ),
      )}
    </>
  )
}

/** One file's diff in the PR Changes sub-tab (official job-result hunk shape). */
function PrDiffFile({ f, rawBase, viewedKey, threadLines, onGoToThread, bugsAt, onAddComment, diffOpts }: { f: PrDiffFileT; rawBase?: string; viewedKey?: string; threadLines?: Map<number, number>; onGoToThread?: () => void; bugsAt?: Map<number, PrBugItemT[]>; onAddComment?: (filePath: string, line: number, body: string, startReview: boolean, hunkRanges: [number, number][], otherSide?: number | null) => Promise<string | null>; diffOpts?: DiffOptsT }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(true)
  const [openBugs, setOpenBugs] = useState<Set<number>>(new Set())
  const [composerLine, setComposerLine] = useState(0)
  const [composerText, setComposerText] = useState('')
  const [composerBusy, setComposerBusy] = useState(false)
  const [composerErr, setComposerErr] = useState('')
  const [composerMenu, setComposerMenu] = useState(false)
  const [revealed, setRevealed] = useState<Record<number, { before: number; after: number; all?: boolean }>>({})
  const submitLineComment = async (startReview: boolean) => {
    if (!onAddComment || composerBusy || !composerText.trim()) return
    setComposerBusy(true)
    setComposerErr('')
    const ranges = f.hunks.flatMap((h) =>
      h.after_lines && h.after_content != null ? changedAfterRanges(h.before_content, h.after_content, h.after_lines[0]) : [],
    )
    const hunk = f.hunks.find((h) => h.after_lines && composerLine >= h.after_lines[0] && composerLine <= h.after_lines[1])
    const otherSide = hunk?.after_lines && hunk.after_content != null && hunk.before_lines
      ? otherSideLine(hunk.before_content, hunk.after_content, hunk.after_lines[0], hunk.before_lines[0], composerLine)
      : null
    const err = await onAddComment(f.file_path, composerLine, composerText.trim(), startReview, ranges, otherSide)
    setComposerBusy(false)
    if (err) { setComposerErr(err); return }
    setComposerLine(0)
    setComposerText('')
  }
  const [viewed, setViewed] = useState(() => (viewedKey ? readViewedSet(viewedKey).has(f.file_path) : false))
  useEffect(() => {
    if (!viewedKey) return
    const h = (e: Event) => { if ((e as CustomEvent).detail === viewedKey) setViewed(readViewedSet(viewedKey).has(f.file_path)) }
    window.addEventListener('pr-viewed-change', h)
    return () => window.removeEventListener('pr-viewed-change', h)
  }, [viewedKey, f.file_path])
  const toggleViewed = () => { if (viewedKey) toggleViewedStore(viewedKey, f.file_path, !viewed); else setViewed((v) => !v) }
  const [rendered, setRendered] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const isMd = /\.(md|markdown)$/i.test(f.file_path)
  const added = f.hunks.reduce((n, h) => n + rangeLength(h.after_lines), 0)
  const removed = f.hunks.reduce((n, h) => n + rangeLength(h.before_lines), 0)
  const rows = useMemo(() => buildPrDiffRows(f), [f])
  const gutterCh = useMemo(() => {
    const maxLine = rows.reduce((max, row) => Math.max(max, row.oldNo ?? 0, row.newNo ?? 0), 1)
    return String(maxLine).length + 3
  }, [rows])
  const displayRows = useMemo(() => {
    if (f.base_content == null) return rows
    const changed = rows.map((row, i) => row.kind !== 'ctx' ? i : -1).filter((i) => i >= 0)
    const visible = rows.map((row, i) => row.kind !== 'ctx' || changed.some((change) => Math.abs(change - i) <= 3))
    const out: (PrDiffRowT | { kind: 'bar'; id: number; hidden: PrDiffRowT[]; top: boolean; bottom: boolean })[] = []
    let i = 0
    let barId = 0
    while (i < rows.length) {
      if (rows[i].kind !== 'ctx' || visible[i]) {
        out.push(rows[i])
        i++
        continue
      }
      const start = i
      while (i < rows.length && rows[i].kind === 'ctx' && !visible[i]) i++
      const hidden = rows.slice(start, i)
      const top = !rows.slice(0, start).some((row) => row.kind !== 'ctx')
      const bottom = !rows.slice(i).some((row) => row.kind !== 'ctx')
      out.push({ kind: 'bar', id: barId++, hidden, top, bottom })
    }
    return out
  }, [f.base_content, rows])
  const bodyOpen = open && !viewed
  return (
    <div className="overflow-hidden rounded-[10px] border border-border-secondary bg-elevated">
      <div className="flex h-[42px] w-full items-center gap-1.5 border-b border-border-secondary px-2 py-1.5 text-[12px]">
        <button onClick={() => setOpen((o) => !o)} aria-label={bodyOpen ? 'Collapse file' : 'Expand file'} className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-accent hover:text-foreground">
          <ChevronDown size={18} className={cn('shrink-0 transition-transform', !bodyOpen && '-rotate-90')} />
        </button>
        <span className="min-w-0 flex-1 truncate font-sans text-[13px]" title={f.file_path}>{f.old_file_path && f.old_file_path !== f.file_path ? `${f.old_file_path} → ` : ''}{f.file_path}</span>
        <button aria-label={t('pr.copyPath')} title={t('pr.copyPath')} onClick={() => { void navigator.clipboard.writeText(f.file_path) }} className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-accent hover:text-foreground">
          <Copy size={18} />
        </button>
        <span className="flex shrink-0 gap-0.5 text-[12px]">
          {added > 0 && <span className="text-[rgb(0,165,88)]">+{added}</span>}
          {removed > 0 && <span className="text-[rgb(245,59,58)]">−{removed}</span>}
        </span>
        <span className="h-4 w-px shrink-0 bg-border-secondary" />
        <label className="flex h-7 shrink-0 cursor-pointer select-none items-center gap-1 whitespace-nowrap rounded-[6px] px-2.5 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground">
          <span
            role="checkbox"
            tabIndex={0}
            aria-checked={viewed}
            aria-label={t('pr.markViewed')}
            onClick={toggleViewed}
            onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleViewed() } }}
            className={cn('flex size-4 shrink-0 items-center justify-center rounded-[4px] border', viewed ? 'border-0 bg-primary text-primary-foreground' : 'border-border')}
          >
            {viewed && <Check size={10} />}
          </span>
          {viewed ? 'Viewed' : 'Mark as viewed'}
        </label>
        {isMd && (
          <button
            aria-label={t('pr.mdDiff')}
            title={t('pr.mdDiff')}
            onClick={() => setRendered((r) => !r)}
            className={cn('flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md', rendered ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}
          >
            <FileCode2 size={13} />
          </button>
        )}
        {rawBase && f.change_type !== 'removed' && (
          <div className="relative">
            <button
              aria-label={t('pr.moreActions')}
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((v) => !v)}
              className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <MoreHorizontal size={13} />
            </button>
            {moreOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setMoreOpen(false)} />
                <div role="menu" className="absolute right-0 top-7 z-40 min-w-[160px] rounded-[10px] border border-border bg-popover p-1 shadow-lg">
                  <a
                    role="menuitem"
                    href={`${rawBase}${f.file_path}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => setMoreOpen(false)}
                    className="flex h-[30px] cursor-pointer items-center rounded-[6px] px-2 text-[13px] hover:bg-accent"
                  >
                    View new raw file
                  </a>
                </div>
              </>
            )}
          </div>
        )}
      </div>
      {bodyOpen && rendered && isMd && (
        <div className="border-t border-border p-3 text-[13px]">
          <Markdown text={f.hunks.map((h) => h.after_content ?? '').filter(Boolean).join('\n')} />
        </div>
      )}
      {bodyOpen && !rendered && !diffOpts?.split && f.base_content != null && (
        <div className="grid grid-cols-[min-content_1fr] border-t border-border">
          {displayRows.map((row, i) => {
            if (row.kind === 'bar') {
              const state = revealed[row.id] || { before: 0, after: 0 }
              const all = !!state.all
              const beforeCount = all ? row.hidden.length : Math.min(row.hidden.length, state.before)
              const afterCount = all ? row.hidden.length : Math.min(row.hidden.length - beforeCount, state.after)
              const reveal = (side: 'before' | 'after') => setRevealed((current) => {
                const next = { ...(current[row.id] || { before: 0, after: 0 }) }
                next[side] = Math.min(row.hidden.length, next[side] + 5)
                if (next.before + next.after >= row.hidden.length) next.all = true
                return { ...current, [row.id]: next }
              })
              const revealAll = () => setRevealed((current) => ({ ...current, [row.id]: { before: 0, after: 0, all: true } }))
              const bar = (
                <div className="col-span-2 flex h-8 items-center bg-tint-blue">
                  <div className="flex items-center gap-3.5 pl-[2ch] text-[12px]">
                    {!row.top && <button type="button" aria-label={`Expand ${Math.min(5, row.hidden.length)} lines above`} onClick={() => reveal('before')} className="inline-flex cursor-pointer items-center gap-1 text-[rgba(13,133,185,0.85)] dark:text-blue-400"><ChevronUp size={12} />5 lines</button>}
                    <button type="button" aria-label={`Expand all ${row.hidden.length} lines`} onClick={revealAll} className="inline-flex cursor-pointer items-center gap-1 text-[rgba(13,133,185,0.85)] dark:text-blue-400"><ChevronsUpDown size={12} />All {row.hidden.length} lines</button>
                    {!row.bottom && <button type="button" aria-label={`Expand ${Math.min(5, row.hidden.length)} lines below`} onClick={() => reveal('after')} className="inline-flex cursor-pointer items-center gap-1 text-[rgba(13,133,185,0.85)] dark:text-blue-400"><ChevronDown size={12} />5 lines</button>}
                  </div>
                </div>
              )
              if (all) return row.hidden.map((line, j) => (
                <div key={`${i}-all-${j}`} className="col-span-2 grid grid-cols-[min-content_1fr] font-mono text-[11px] leading-[18px] sm:text-[12px] sm:leading-[20px]">
                  <span style={{ width: `${gutterCh}ch` }} className="flex shrink-0 select-none items-start justify-end border-r border-border bg-elevated pl-[2ch] pr-[1ch] text-[11px] text-muted-foreground">{line.newNo}</span>
                  <span className="relative whitespace-break-spaces break-all bg-elevated px-2 [overflow-wrap:anywhere] text-foreground">{line.text}</span>
                </div>
              ))
              const renderContext = (line: PrDiffRowT, key: string) => (
                <div key={key} className="col-span-2 grid grid-cols-[min-content_1fr] font-mono text-[11px] leading-[18px] sm:text-[12px] sm:leading-[20px]">
                  <span style={{ width: `${gutterCh}ch` }} className="flex shrink-0 select-none items-start justify-end border-r border-border bg-elevated pl-[2ch] pr-[1ch] text-[11px] text-muted-foreground">{line.newNo}</span>
                  <span className="relative whitespace-break-spaces break-all bg-elevated px-2 [overflow-wrap:anywhere] text-foreground">{line.text}</span>
                </div>
              )
              return [
                ...(beforeCount ? row.hidden.slice(0, beforeCount).map((line, j) => renderContext(line, `${i}-before-${j}`)) : []),
                cloneElement(bar, { key: `${i}-bar` }),
                ...(afterCount ? row.hidden.slice(row.hidden.length - afterCount).map((line, j) => renderContext(line, `${i}-after-${j}`)) : []),
              ]
            }
            const lineNo = row.kind === 'add' ? row.newNo : undefined
            const threadCount = lineNo ? threadLines?.get(lineNo) : undefined
            const bugItems = lineNo ? bugsAt?.get(lineNo) : undefined
            const rowBg = row.kind === 'del' ? 'bg-tint-red' : row.kind === 'add' ? 'bg-tint-green' : 'bg-elevated'
            return (
              <div key={`${row.kind}-${row.oldNo ?? row.newNo ?? i}`} className="col-span-2">
                <div className="grid grid-cols-[min-content_1fr] font-mono text-[11px] leading-[18px] sm:text-[12px] sm:leading-[20px]">
                <span style={{ width: `${gutterCh}ch` }} className={cn('flex shrink-0 select-none items-start justify-end border-r border-border pl-[2ch] pr-[1ch] text-[11px] text-muted-foreground', rowBg)}>{row.kind === 'del' ? row.oldNo : row.newNo ?? ''}</span>
                <span className={cn('group relative flex min-w-0 whitespace-break-spaces break-all px-2 [overflow-wrap:anywhere] text-foreground', rowBg, threadCount && !diffOpts?.hideHl && 'bg-amber-400/20')}>
                  {onAddComment && lineNo ? <button aria-label={t('pr.addComment')} onClick={() => { setComposerLine(lineNo); setComposerText(''); setComposerErr('') }} className="absolute -left-1.5 z-10 hidden size-4 cursor-pointer items-center justify-center rounded-[4px] bg-blue-500 text-white group-hover:flex"><Plus size={12} /></button> : null}
                  <span className="min-w-0 flex-1">{row.segs ? <WordDiffLine segs={row.segs} kind={row.kind === 'del' ? 'del' : 'add'} /> : row.text}</span>
                  {threadCount ? <button aria-label={t('pr.gotoComment')} onClick={onGoToThread} className="mr-1 flex shrink-0 cursor-pointer items-center gap-0.5 self-center rounded-[4px] px-1 text-[10px] text-amber-600 hover:bg-amber-500/20 dark:text-amber-400"><MessageSquare size={11} />{threadCount}</button> : null}
                  {lineNo && bugItems ? <button aria-label={openBugs.has(lineNo) ? 'Collapse comment' : 'Expand comment'} aria-expanded={openBugs.has(lineNo)} onClick={() => setOpenBugs((current) => { const next = new Set(current); if (next.has(lineNo)) next.delete(lineNo); else next.add(lineNo); return next })} className="mr-1 flex size-6 shrink-0 cursor-pointer items-center justify-center self-center rounded-[6px] border border-border bg-background hover:bg-accent"><BugIcon size={13} className="text-red-500" /></button> : null}
                </span>
                </div>
                {lineNo && composerLine === lineNo && onAddComment ? <PrInlineComposer f={f} line={lineNo} onAddComment={onAddComment} onClose={() => setComposerLine(0)} /> : null}
                {lineNo && openBugs.has(lineNo) && bugItems ? (
                  <div className="m-2 overflow-hidden rounded-[10px] border border-border bg-popover font-sans text-[12px] shadow-md">
                    {bugItems.map((it, k) => (
                      <div key={k} className={cn(k > 0 && 'border-t border-border')}>
                        <div className="flex items-center gap-1.5 border-b border-border py-1.5 pl-3 pr-2 text-[13px]"><BugIcon size={14} className="shrink-0 text-red-500" /><span className="min-w-0 flex-1 truncate font-medium">{it.title}</span>{it.severity && <span className="shrink-0 capitalize text-muted-foreground">{it.severity}</span>}</div>
                        {it.description && <p className="px-3 py-2 text-muted-foreground">{it.description}</p>}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      )}
      {bodyOpen && !rendered && (diffOpts?.split || f.base_content == null) && f.hunks.map((h, i) => {
        if (diffOpts?.hideWs && h.before_content != null && h.after_content != null) {
          const norm = (s: string) => s.split('\n').map((l) => l.replace(/\s+/g, '')).join('\n')
          if (norm(h.before_content) === norm(h.after_content)) return null
        }
        const wdBlock = h.before_content != null && h.after_content != null
          ? blockWordDiff(h.before_content.split('\n'), h.after_content.split('\n'))
          : null
        return (
        <div key={i} className="border-t border-border font-mono text-[11px] leading-[16px]">
          {diffOpts?.split && (h.before_content != null || h.after_content != null) ? (() => {
            const before = h.before_content != null ? h.before_content.split('\n') : []
            const after = h.after_content != null ? h.after_content.split('\n') : []
            const rows = Math.max(before.length, after.length)
            const stripe: React.CSSProperties = {
              backgroundImage: 'repeating-linear-gradient(-45deg, transparent, transparent 5px, var(--color-border) 5px, var(--color-border) 6px)',
            }
            return (
              <div className="grid" style={{ gridTemplateColumns: `${gutterCh}ch calc(50% - ${gutterCh}ch) ${gutterCh}ch calc(50% - ${gutterCh}ch)` }}>
                {Array.from({ length: rows }, (_, j) => {
                  const hasL = j < before.length
                  const hasR = j < after.length
                  const rn = hasR && h.after_lines ? h.after_lines[0] + j : 0
                  const tc = rn ? threadLines?.get(rn) : undefined
                  const wdL = hasL ? wdBlock?.[0][j] : undefined
                  const wdR = hasR ? wdBlock?.[1][j] : undefined
                  return (
                    <div key={`sp${j}`} className="col-span-4 grid" style={{ gridTemplateColumns: 'subgrid' }}>
                      <span style={{ width: `${gutterCh}ch` }} className={cn('shrink-0 select-none border-r border-border pr-[1ch] text-right text-muted-foreground', hasL && 'bg-tint-red')}>{hasL && h.before_lines ? h.before_lines[0] + j : ''}</span>
                      <span className={cn('min-w-0 whitespace-break-spaces break-all border-r border-border px-2', hasL ? 'bg-tint-red text-foreground' : '')} style={hasL ? undefined : stripe}>{hasL ? (wdL ? <WordDiffLine segs={wdL} kind="del" /> : before[j]) : ''}</span>
                      <span style={{ width: `${gutterCh}ch` }} className={cn('shrink-0 select-none border-r border-border pr-[1ch] text-right text-muted-foreground', hasR && 'bg-tint-green')}>{rn || ''}</span>
                      <span className={cn('group relative flex min-w-0', hasR ? cn('bg-tint-green', tc && !diffOpts?.hideHl && 'bg-amber-400/20') : '')} style={hasR ? undefined : stripe}>
                        {onAddComment && rn ? (
                          <button
                            aria-label={t('pr.addComment')}
                            onClick={() => { setComposerLine(rn); setComposerText(''); setComposerErr('') }}
                            className="absolute -left-0.5 z-10 hidden size-4 cursor-pointer items-center justify-center rounded-[4px] bg-blue-500 text-white group-hover:flex"
                          >
                            <Plus size={12} />
                          </button>
                        ) : null}
                        <span className="min-w-0 flex-1 whitespace-break-spaces break-all px-2 text-foreground">{hasR ? (wdR ? <WordDiffLine segs={wdR} kind="add" /> : after[j]) : ''}</span>
                        {tc ? (
                          <button
                            aria-label={t('pr.gotoComment')}
                            onClick={onGoToThread}
                            className="mr-1 flex shrink-0 cursor-pointer items-center gap-0.5 self-center rounded-[4px] px-1 text-[10px] text-amber-600 hover:bg-amber-500/20 dark:text-amber-400"
                          >
                            <MessageSquare size={11} />{tc}
                          </button>
                        ) : null}
                        {rn && bugsAt?.get(rn) ? (
                          <button
                            aria-label={openBugs.has(rn) ? 'Collapse comment' : 'Expand comment'}
                            aria-expanded={openBugs.has(rn)}
                            onClick={() => setOpenBugs((s) => { const ns = new Set(s); if (ns.has(rn)) ns.delete(rn); else ns.add(rn); return ns })}
                            className="mr-1 flex size-6 shrink-0 cursor-pointer items-center justify-center self-center rounded-[6px] border border-border bg-background hover:bg-accent"
                          >
                            <BugIcon size={13} className="text-red-500" />
                          </button>
                        ) : null}
                      </span>
                    </div>
                  )
                })}
              </div>
            )
          })() : null}
          {!diffOpts?.split && h.before_content != null && h.before_content.split('\n').map((ln, j) => {
            const segs = wdBlock?.[0][j]
            return (
              <div key={`b${j}`} className="grid grid-cols-[min-content_1fr] font-mono text-[11px] leading-[18px] sm:text-[12px] sm:leading-[20px]">
                <span style={{ width: `${gutterCh}ch` }} className="flex shrink-0 select-none items-start justify-end border-r border-border bg-tint-red pl-[2ch] pr-[1ch] text-[11px] text-muted-foreground">{h.before_lines ? h.before_lines[0] + j : ''}</span>
                <span className="whitespace-break-spaces break-all bg-tint-red px-2 [overflow-wrap:anywhere] text-foreground">{segs ? <WordDiffLine segs={segs} kind="del" /> : ln}</span>
              </div>
            )
          })}
          {!diffOpts?.split && h.after_content != null && h.after_content.split('\n').map((ln, j) => {
            const lineNo = h.after_lines ? h.after_lines[0] + j : 0
            const tc = lineNo ? threadLines?.get(lineNo) : undefined
            const segsA = wdBlock?.[1][j]
            return (
              <div key={`a${j}`} className={cn('group relative grid grid-cols-[min-content_1fr] font-mono text-[11px] leading-[18px] sm:text-[12px] sm:leading-[20px]', tc && !diffOpts?.hideHl && 'bg-amber-400/20')}>
                {onAddComment && lineNo ? (
                  <button
                    aria-label={t('pr.addComment')}
                    onClick={() => { setComposerLine(lineNo); setComposerText(''); setComposerErr('') }}
                    className="absolute -left-0.5 z-10 hidden size-4 cursor-pointer items-center justify-center rounded-[4px] bg-blue-500 text-white group-hover:flex"
                  >
                    <Plus size={12} />
                  </button>
                ) : null}
                <span style={{ width: `${gutterCh}ch` }} className="flex shrink-0 select-none items-start justify-end border-r border-border bg-tint-green pl-[2ch] pr-[1ch] text-[11px] text-muted-foreground">{lineNo || ''}</span>
                <span className="min-w-0 whitespace-break-spaces break-all bg-tint-green px-2 [overflow-wrap:anywhere] text-foreground">{segsA ? <WordDiffLine segs={segsA} kind="add" /> : ln}</span>
                {tc ? (
                  <button
                    aria-label={t('pr.gotoComment')}
                    onClick={onGoToThread}
                    className="mr-1 flex shrink-0 cursor-pointer items-center gap-0.5 self-center rounded-[4px] px-1 text-[10px] text-amber-600 hover:bg-amber-500/20 dark:text-amber-400"
                  >
                    <MessageSquare size={11} />{tc}
                  </button>
                ) : null}
                {lineNo && bugsAt?.get(lineNo) ? (
                  <button
                    aria-label={openBugs.has(lineNo) ? 'Collapse comment' : 'Expand comment'}
                    aria-expanded={openBugs.has(lineNo)}
                    onClick={() => setOpenBugs((s) => { const ns = new Set(s); if (ns.has(lineNo)) ns.delete(lineNo); else ns.add(lineNo); return ns })}
                    className="mr-1 flex size-7 shrink-0 cursor-pointer items-center justify-center self-center rounded-[6px] border border-border bg-background hover:bg-accent"
                  >
                    <BugIcon size={14} className="text-red-500" />
                  </button>
                ) : null}
              </div>
            )
          })}
          {h.after_content != null && h.after_lines && composerLine >= h.after_lines[0] && composerLine < h.after_lines[0] + h.after_content.split('\n').length && (
            <div className="m-2 min-w-0 overflow-hidden rounded-[10px] border border-border bg-popover font-sans text-[13px] shadow-md">
              <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                <span className="font-medium">{t('pr.newComment')}</span>
                <span className="rounded-[4px] bg-muted px-1 text-[11px] text-muted-foreground">R{composerLine}</span>
              </div>
              <div className="p-2">
                <textarea
                  autoFocus
                  value={composerText}
                  onChange={(e) => setComposerText(e.target.value)}
                  placeholder={t('pr.commentPh')}
                  rows={3}
                  className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 outline-none focus:border-ring"
                />
                {composerErr && <p className="mt-1 text-[12px] text-red-500">{composerErr}</p>}
                <div className="mt-1.5 flex items-center justify-end gap-2">
                  <button onClick={() => { setComposerLine(0); setComposerText('') }} className="h-7 cursor-pointer rounded-md px-2.5 text-muted-foreground hover:bg-accent hover:text-foreground">{t('common.cancel')}</button>
                  <div className="relative flex">
                    <button
                      disabled={composerBusy || !composerText.trim()}
                      onClick={() => submitLineComment(true)}
                      className="h-7 cursor-pointer rounded-l-md bg-primary px-2.5 text-primary-foreground disabled:cursor-default disabled:opacity-50"
                    >
                      Start a review
                    </button>
                    <button
                      aria-label={t('pr.moreSend')}
                      aria-haspopup="menu"
                      aria-expanded={composerMenu}
                      onClick={() => setComposerMenu((v) => !v)}
                      className="flex h-7 cursor-pointer items-center rounded-r-md border-l border-primary-foreground/20 bg-primary px-1 text-primary-foreground"
                    >
                      <ChevronDown size={12} />
                    </button>
                    {composerMenu && (
                      <>
                        <div className="fixed inset-0 z-30" onClick={() => setComposerMenu(false)} />
                        <div role="menu" className="absolute right-0 top-8 z-40 min-w-[140px] rounded-[10px] border border-border bg-popover p-1 shadow-lg">
                          <button
                            role="menuitem"
                            onClick={() => { setComposerMenu(false); void submitLineComment(false) }}
                            className="flex h-[30px] w-full cursor-pointer items-center rounded-[6px] px-2 text-[13px] hover:bg-accent"
                          >
                            Comment
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
          {h.after_content != null && h.after_lines && [...(bugsAt || new Map<number, PrBugItemT[]>())].filter(([ln]) => openBugs.has(ln) && ln >= h.after_lines![0] && ln < h.after_lines![0] + h.after_content!.split('\n').length).map(([ln, items]) => (
            <div key={`bug${ln}`} className="m-2 min-w-0 overflow-hidden rounded-[10px] border border-border bg-popover font-sans text-[12px] shadow-md">
              {items.map((it, k) => (
                <div key={k} className={cn(k > 0 && 'border-t border-border')}>
                  <div className="flex items-center gap-1.5 border-b border-border py-1.5 pl-3 pr-2 text-[13px]">
                    <BugIcon size={14} className="shrink-0 text-red-500" />
                    <span className="min-w-0 flex-1 truncate font-medium">{it.title}</span>
                    {it.severity && <span className={cn('shrink-0 capitalize text-muted-foreground', (it.severity === 'critical' || it.severity === 'severe') && 'text-red-600 dark:text-red-400')}>{it.severity}</span>}
                    {it.cwe_id && <span className="shrink-0 text-muted-foreground">{it.cwe_id}</span>}
                  </div>
                  {it.description && <p className="px-3 py-2 text-muted-foreground">{it.description}</p>}
                </div>
              ))}
            </div>
          ))}
        </div>
        )
      })}
    </div>
  )
}

function PrAnalysisPromo({ prUrl, analyzing, error, onRun }: { prUrl: string; analyzing: boolean; error: string | null; onRun: () => void }) {
  const { t } = useTranslation()
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(`pr-analysis-promo-dismissed:${prUrl}`) === '1' } catch { return false }
  })
  if (dismissed) return null
  const dismiss = () => {
    try { localStorage.setItem(`pr-analysis-promo-dismissed:${prUrl}`, '1') } catch { /* ignore */ }
    setDismissed(true)
  }
  return (
    <div className="flex flex-col items-center gap-4 rounded-[10px] border border-border-secondary bg-elevated px-5 py-6">
      <div className="flex w-full max-w-[420px] items-start justify-center gap-6">
        <div className="flex flex-1 flex-col items-center gap-2">
          <div className="h-[110px] w-full max-w-[160px] rounded-[6px] border border-border bg-tint-secondary p-3">
            <div className="h-2 w-3/4 rounded bg-tint-primary" />
            <div className="mt-2 h-2 w-full rounded bg-tint-primary" />
            <div className="mt-2 h-2 w-5/6 rounded bg-[#fca5a5]" />
            <div className="mt-2 h-2 w-2/3 rounded bg-tint-primary" />
          </div>
          <span className="text-center text-[13px] font-medium">{t('pr.smartDiffs')}</span>
        </div>
        <div className="flex flex-1 flex-col items-center gap-2">
          <div className="h-[110px] w-full max-w-[160px] rounded-[6px] border border-border bg-tint-secondary p-3">
            <div className="h-2 w-3/4 rounded bg-tint-primary" />
            <div className="mt-2 h-2 w-full rounded bg-[#86efac]" />
            <div className="mt-2 h-2 w-5/6 rounded bg-tint-primary" />
            <div className="mt-2 h-2 w-2/3 rounded bg-[#86efac]" />
          </div>
          <span className="text-center text-[13px] font-medium">{t('pr.bugDetect')}</span>
        </div>
      </div>
      <p className="max-w-[640px] text-center text-[13px] text-muted-foreground">
        Your <span className="text-[rgba(13,133,185,0.85)] dark:text-blue-400">{t('pr.reviewSettings')}</span> didn't auto-trigger Devin's AI analysis for this commit. Run it manually to organize diffs, detect moved code, and flag potential bugs.
      </p>
      <button disabled={analyzing} onClick={onRun} className={cn('h-8 w-full max-w-[640px] rounded-[6px] text-[13px] font-medium text-white', analyzing ? 'cursor-not-allowed bg-[#3b82f6]/50' : 'cursor-pointer bg-[#3b82f6] hover:bg-[#2563eb]')}>
        {analyzing ? 'Launching…' : "Run Devin's AI analysis"}
      </button>
      {error && <span className="text-[12px] text-red-500">Failed: {error}</span>}
      <button onClick={dismiss} className="cursor-pointer text-[13px] text-muted-foreground hover:text-foreground">{t('common.dismiss')}</button>
    </div>
  )
}

interface PrInfo {
  title?: string; number?: number; state?: string; draft?: boolean; merged?: boolean
  base_branch?: string; head_branch?: string; user?: string; additions?: number; deletions?: number
  changed_files?: number; html_url?: string; comments?: number; merged_by?: string
  body?: string
}

/** Official merge-status pill wording/colors (state × draft × merged). */
function prStateLabel(info: PrInfo | null, ms: Record<string, unknown> | null): { label: string; cls: string } {
  const st = String(ms?.state || (info?.merged ? 'MERGED' : info?.state === 'open' ? 'OPEN' : 'CLOSED')).toUpperCase()
  if (info?.draft || ms?.is_draft) return { label: 'Draft', cls: 'bg-muted text-muted-foreground' }
  if (st === 'MERGED') return { label: 'Merged', cls: 'bg-[rgba(149,108,222,0.12)] text-[rgb(149,108,222)]' }
  if (st === 'OPEN') return { label: 'Open', cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' }
  return { label: 'Closed', cls: 'bg-red-500/10 text-red-600 dark:text-red-400' }
}

// Official reaction set: the 8 GitHub reactions, in the picker's order.
const REACTION_SET: readonly (readonly [string, string, string])[] = [
  ['+1', '👍', 'Thumbs up'], ['-1', '👎', 'Thumbs down'], ['laugh', '😄', 'Laugh'], ['hooray', '🎉', 'Hooray'],
  ['confused', '😕', 'Confused'], ['heart', '❤️', 'Heart'], ['rocket', '🚀', 'Rocket'], ['eyes', '👀', 'Eyes'],
]

/**
 * "Add reaction" picker, mirroring the official dialog popover: a search
 * input filtering the 8 GitHub reactions by name, click to add.
 */
function ReactionPicker({ onPick }: { onPick: (content: string) => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const shown = REACTION_SET.filter(([content, , label]) => !q.trim() || label.toLowerCase().includes(q.trim().toLowerCase()) || content.includes(q.trim().toLowerCase()))
  return (
    <span className="relative">
      <button aria-label={t('pr.addReaction')} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setOpen((v) => !v); setQ('') }} className="flex size-6 cursor-pointer items-center justify-center rounded-full border border-border text-muted-foreground hover:bg-accent hover:text-foreground">
        <SmilePlus size={13} />
      </button>
      {open && (
        <div role="dialog" className="absolute bottom-7 left-0 z-30 w-56 rounded-lg border border-border bg-popover p-2 shadow-lg">
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} className="mb-2 w-full rounded-md border border-border bg-background px-2 py-1 text-[12px] focus:outline-none" />
          <div className="flex flex-wrap gap-1">
            {shown.map(([content, emoji, label]) => (
              <button key={content} aria-label={label} title={label} onClick={() => { onPick(content); setOpen(false) }} className="flex size-7 cursor-pointer items-center justify-center rounded-md text-[15px] hover:bg-accent">{emoji}</button>
            ))}
          </div>
        </div>
      )}
    </span>
  )
}

/**
 * Reaction row: the official quick pills (Thumbs up / Eyes / Confused),
 * pills for any other reaction group with count > 0, and the Add reaction picker.
 */
/**
 * Official comment "More actions" menu (first-hand capture): Copy link /
 * Copy message / Open in GitHub on every comment; Edit and Delete additionally
 * on review comments (PRRC_ ids, the gh/review-comments write endpoint's type).
 * Copy link copies the session URL + #comment-<id>; Delete has no confirm dialog.
 */
function CommentActions({ comment, canWrite, onEdit, onDelete }: { comment: { id: string; body: string; url?: string }; canWrite: boolean; onEdit: () => void; onDelete: () => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  const item = 'flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[13px] hover:bg-accent'
  return (
    <div ref={ref} className="relative ml-auto">
      <button aria-label={t('pr.moreActions')} onClick={() => setOpen((v) => !v)} className="cursor-pointer rounded-md p-1 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100 aria-expanded:opacity-100" aria-expanded={open}>
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-6 z-20 min-w-[180px] overflow-hidden rounded-[10px] border border-border bg-popover py-1 shadow-lg">
          {canWrite && <button role="menuitem" className={item} onClick={() => { setOpen(false); onEdit() }}><Pencil size={13} /> {t('common.edit')}</button>}
          <button role="menuitem" className={item} onClick={() => { void navigator.clipboard.writeText(`${location.origin}${location.pathname}#comment-${comment.id}`); setOpen(false) }}><Link2 size={13} /> {t('common.copyLink')}</button>
          <button role="menuitem" className={item} onClick={() => { void navigator.clipboard.writeText(comment.body); setOpen(false) }}><Copy size={13} /> {t('common.copyMsg')}</button>
          {comment.url && <a role="menuitem" href={comment.url} target="_blank" rel="noreferrer" className={item} onClick={() => setOpen(false)}><ArrowUpRight size={13} /> {t('common.openGithub')}</a>}
          {canWrite && <button role="menuitem" className={cn(item, 'text-red-500 hover:text-red-500')} onClick={() => { setOpen(false); onDelete() }}><Trash2 size={13} /> {t('common.delete')}</button>}
        </div>
      )}
    </div>
  )
}

/** Official Edit editor semantics (first-hand capture): inline editor prefilled
 * with the raw body, Cancel/Save footer; Save PATCHes gh/review-comments. */
function CommentEditor({ value, onChange, busy, err, onCancel, onSave }: { value: string; onChange: (v: string) => void; busy: boolean; err: string; onCancel: () => void; onSave: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="rounded-md border border-border">
      <textarea autoFocus value={value} onChange={(e) => onChange(e.target.value)} className="min-h-24 w-full resize-y rounded-md bg-background p-2.5 font-mono text-[12px] focus:outline-none" />
      <div className="flex items-center justify-end gap-2 border-t border-border px-2 py-1.5">
        {err && <span className="mr-auto text-[12px] text-red-500">Failed: {err}</span>}
        <button onClick={onCancel} className="cursor-pointer rounded-md px-2.5 py-1 text-[12px] text-muted-foreground hover:bg-accent">{t('common.cancel')}</button>
        <button disabled={busy || !value.trim()} onClick={onSave} className={cn('rounded-md px-2.5 py-1 text-[12px] font-medium text-white', busy || !value.trim() ? 'cursor-not-allowed bg-blue-500/50' : 'cursor-pointer bg-blue-500 hover:bg-blue-600')}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  )
}

function ReactionRow({ commentId, reactions, reacting, onToggle }: { commentId: string; reactions?: { content: string; count: number; viewer_reacted: boolean }[]; reacting: string; onToggle: (commentId: string, content: string, has: boolean) => void }) {
  const { t } = useTranslation()
  const quick = ['+1', 'eyes', 'confused']
  const extra = REACTION_SET.filter(([content]) => !quick.includes(content) && (reactions?.find((x) => x.content === content)?.count ?? 0) > 0)
  const items = [...REACTION_SET.filter(([content]) => quick.includes(content)), ...extra]
  return (
    <div className="mt-1.5 flex items-center gap-1">
      {items.map(([content, emoji, label]) => {
        const grp = reactions?.find((x) => x.content === content)
        const has = !!grp?.viewer_reacted
        return (
          <button key={content} aria-label={label} title={label} disabled={reacting === `${commentId}:${content}`} onClick={() => onToggle(commentId, content, has)} className={cn('flex h-6 cursor-pointer items-center gap-1 rounded-full border px-2 text-[12px] disabled:opacity-50', has ? 'border-blue-500/40 bg-blue-500/10' : 'border-border hover:bg-accent')}>
            {emoji}
            {grp && grp.count > 0 ? <span className="tabular-nums">{grp.count}</span> : null}
          </button>
        )
      })}
      <ReactionPicker onPick={(content) => { const grp = reactions?.find((x) => x.content === content); onToggle(commentId, content, !!grp?.viewer_reacted) }} />
    </div>
  )
}

/**
 * PR tab panel, mirroring the official Devin Review PR tab's read-only layout
 * (merge-status bar, repo path, title, branch row, files/± stats, Description/
 * Checks sections). Data comes from the admin-only /pr proxy over the official
 * pr-review endpoints (info | merge-status | checks).
 */
function PrPanel({ id, prUrl }: { id: string; prUrl: string }) {
  const { t } = useTranslation()
  const [data, setData] = useState<{ info: PrInfo | null; merge_status: Record<string, unknown> | null; checks: { checks?: { name: string; status?: string; conclusion?: string; description?: string; details_url?: string; is_required?: boolean }[] } | null; comments?: { id: string; body: string; login: string; avatar_url: string; is_bot: boolean; created_at: string; reactions?: { content: string; count: number; viewer_reacted: boolean }[]; url?: string }[]; threads?: { id: string; path: string; line: number; is_resolved: boolean; is_outdated: boolean; comments: { id: string; body: string; login: string; avatar_url: string; is_bot: boolean; created_at: string; reactions?: { content: string; count: number; viewer_reacted: boolean }[]; url?: string; pending?: boolean }[] }[]; commits?: { sha: string; headline: string; author: string; committed_at: string }[]; head_sha?: string; assignees?: { login: string; avatar_url: string }[]; requested_reviewers?: { login: string; avatar_url: string }[]; labels?: { name: string; color: string }[]; author?: { login: string; avatar_url: string; is_bot: boolean } | null } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [sub, setSub] = useState<'changes' | 'bugs' | 'description' | 'discussion' | 'commits'>('changes')
  const [diffOpts, setDiffOpts] = useState<DiffOptsT>(readDiffOpts)
  const [diffMenu, setDiffMenu] = useState(false)
  const updDiffOpts = (patch: Partial<DiffOptsT>) => {
    setDiffOpts((o) => {
      const n = { ...o, ...patch }
      try { localStorage.setItem(DIFF_OPTS_KEY, JSON.stringify(n)) } catch { /* ignore */ }
      return n
    })
  }
  const [diff, setDiff] = useState<{ files: PrDiffFileT[] | null; sections?: { title: string; text: string; files: string[] }[] | null; analysis_status: string; error: string | null } | null>(null)
  useEffect(() => {
    if ((sub !== 'changes' && sub !== 'bugs') || diff) return
    let alive = true
    adminFetch<{ files: PrDiffFileT[] | null; sections?: { title: string; text: string; files: string[] }[] | null; analysis_status: string; error: string | null }>(`/api/admin/session/${id}/pr-changes?pr_url=${encodeURIComponent(prUrl)}`)
      .then((r) => { if (alive) setDiff(r) })
      .catch((e) => { if (alive) setDiff({ files: null, analysis_status: '', error: (e as Error).message }) })
    return () => { alive = false }
  }, [sub, diff, id, prUrl])
  const [bugs, setBugs] = useState<{ data: { status: string; bugs: PrBugItemT[]; security_findings: PrBugItemT[]; flags: PrBugItemT[] } | null; error: string | null } | null>(null)
  useEffect(() => {
    if ((sub !== 'bugs' && sub !== 'changes') || bugs) return
    let alive = true
    adminFetch<{ data: { status: string; bugs: PrBugItemT[]; security_findings: PrBugItemT[]; flags: PrBugItemT[] } | null; error: string | null }>(`/api/admin/session/${id}/pr-bugs?pr_url=${encodeURIComponent(prUrl)}`)
      .then((r) => { if (alive) setBugs(r) })
      .catch((e) => { if (alive) setBugs({ data: null, error: (e as Error).message }) })
    return () => { alive = false }
  }, [sub, bugs, id, prUrl])
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzeErr, setAnalyzeErr] = useState<string | null>(null)
  const runAnalysis = async () => {
    if (analyzing) return
    setAnalyzing(true)
    setAnalyzeErr(null)
    try {
      await adminFetch(`/api/admin/session/${id}/pr-analyze`, { method: 'POST', body: JSON.stringify({ pr_url: prUrl }) })
      setBugs(null)
    } catch (e) {
      setAnalyzeErr((e as Error).message)
    } finally {
      setAnalyzing(false)
    }
  }
  useEffect(() => {
    if (sub !== 'bugs' || bugs?.data?.status !== 'running') return
    const t = setInterval(() => setBugs(null), 15000)
    return () => clearInterval(t)
  }, [sub, bugs])
  const [copiedBr, setCopiedBr] = useState(false)
  const [commentOpen, setCommentOpen] = useState(false)
  const [mergedOpen, setMergedOpen] = useState(false)
  const [cmtText, setCmtText] = useState('')
  const [discText, setDiscText] = useState('')
  const [posting, setPosting] = useState(false)
  const [postErr, setPostErr] = useState<string | null>(null)
  const postComment = async (text: string, done: () => void) => {
    if (!text.trim() || posting) return
    setPosting(true)
    setPostErr(null)
    try {
      await adminFetch(`/api/admin/session/${id}/pr-comment`, { method: 'POST', body: JSON.stringify({ pr_url: prUrl, body: text }) })
      done()
      const r = await adminFetch<{ data: typeof data; error: string | null }>(`/api/admin/session/${id}/pr?pr_url=${encodeURIComponent(prUrl)}`)
      if (r.data) setData(r.data)
    } catch (e) {
      setPostErr((e as Error).message)
    } finally {
      setPosting(false)
    }
  }
  useEffect(() => {
    let alive = true
    adminFetch<{ data: typeof data; error: string | null }>(`/api/admin/session/${id}/pr?pr_url=${encodeURIComponent(prUrl)}`)
      .then((r) => { if (!alive) return; if (r.data) setData(r.data); else setErr(r.error || 'unavailable') })
      .catch((e) => { if (alive) setErr((e as Error).message) })
    return () => { alive = false }
  }, [id, prUrl])
  // Official thread-card reaction protocol (first-hand capture):
  // add = POST gh/comments/{id}/reactions {pr_path, content}; remove = DELETE
  // .../reactions/{content}?pr_path. Mirror toggles via admin proxy, then refetches.
  const [reacting, setReacting] = useState('')
  const toggleReaction = async (commentId: string, content: string, has: boolean) => {
    if (reacting) return
    setReacting(`${commentId}:${content}`)
    try {
      await adminFetch(`/api/admin/session/${id}/pr-reaction`, { method: 'POST', body: JSON.stringify({ pr_url: prUrl, comment_id: commentId, content, op: has ? 'remove' : 'add' }) })
      const r = await adminFetch<{ data: typeof data; error: string | null }>(`/api/admin/session/${id}/pr?pr_url=${encodeURIComponent(prUrl)}`)
      if (r.data) setData(r.data)
    } catch { /* keep prior state */ } finally {
      setReacting('')
    }
  }
  // Official Mark resolved semantics (first-hand capture): footer button posts
  // gh/review_threads/{thread_id}/resolve|unresolve {pr_path, pr_number}.
  const [resolving, setResolving] = useState('')
  const toggleResolve = async (threadId: string, resolved: boolean) => {
    if (resolving) return
    setResolving(threadId)
    try {
      await adminFetch(`/api/admin/session/${id}/pr-thread-resolve`, { method: 'POST', body: JSON.stringify({ pr_url: prUrl, thread_id: threadId, op: resolved ? 'unresolve' : 'resolve' }) })
      const r = await adminFetch<{ data: typeof data; error: string | null }>(`/api/admin/session/${id}/pr?pr_url=${encodeURIComponent(prUrl)}`)
      if (r.data) setData(r.data)
    } catch { /* keep prior state */ } finally {
      setResolving('')
    }
  }
  // Official thread reply semantics (first-hand capture): "Reply to this thread..."
  // expands an editor whose submit posts gh/review_threads/{thread_id}/replies
  // {pr_path, body, start_review:false}.
  // Official resolved-thread semantics (first-hand capture): resolved threads
  // collapse to a "<file> · Resolved  L<line>" header row; clicking toggles the body.
  const [expandedThreads, setExpandedThreads] = useState<Record<string, boolean>>({})
  const [replyThread, setReplyThread] = useState('')
  const [replyText, setReplyText] = useState('')
  const [replying, setReplying] = useState(false)
  const [replyErr, setReplyErr] = useState('')
  // Official pending-review semantics (first-hand capture): "Start a review"
  // posts the same replies endpoint with start_review:true; the comment renders
  // with an orange "Pending" badge and the composer button becomes "Add to review".
  // Pending comments are deletable via the same DELETE gh/review-comments protocol.
  const [pendingReplies, setPendingReplies] = useState<Record<string, { id: string; body: string }[]>>({})
  const submitReply = async (threadId: string, startReview = false) => {
    if (replying || !replyText.trim()) return
    setReplying(true)
    setReplyErr('')
    try {
      const r = await adminFetch<{ ok: boolean; error: string | null; comment_id?: string | null }>(`/api/admin/session/${id}/pr-thread-reply`, { method: 'POST', body: JSON.stringify({ pr_url: prUrl, thread_id: threadId, body: replyText.trim(), start_review: startReview }) })
      if (!r.ok) { setReplyErr(r.error || 'failed'); return }
      if (startReview) setPendingReplies((m) => ({ ...m, [threadId]: [...(m[threadId] || []), { id: r.comment_id || '', body: replyText.trim() }] }))
      setReplyThread('')
      setReplyText('')
      const d = await adminFetch<{ data: typeof data; error: string | null }>(`/api/admin/session/${id}/pr?pr_url=${encodeURIComponent(prUrl)}`)
      if (d.data) setData(d.data)
    } catch {
      setReplyErr('network error')
    } finally {
      setReplying(false)
    }
  }
  // Official More actions Edit/Delete protocols (first-hand capture):
  // PATCH gh/review-comments/{id} {pr_path, body}; DELETE ...?pr_path (no confirm).
  const [editingComment, setEditingComment] = useState('')
  const [editText, setEditText] = useState('')
  const [editBusy, setEditBusy] = useState(false)
  const [editErr, setEditErr] = useState('')
  const refetchPr = async () => {
    const r = await adminFetch<{ data: typeof data; error: string | null }>(`/api/admin/session/${id}/pr?pr_url=${encodeURIComponent(prUrl)}`)
    if (r.data) setData(r.data)
  }
  // Official inline "Add a comment" (+) protocol (first-hand capture):
  // POST gh/review-threads {file_path, body, subject_type:"LINE", line, side:"RIGHT", pr_path},
  // then (single comment) POST gh/reviews/{pending_review_id}/submit {pr_path, event:"COMMENT"}.
  const addLineComment = async (filePath: string, line: number, body: string, startReview: boolean, hunkRanges: [number, number][], otherSide: number | null = null): Promise<string | null> => {
    try {
      const r = await adminFetch<{ ok: boolean; error: string | null }>(`/api/admin/session/${id}/pr-line-comment`, { method: 'POST', body: JSON.stringify({ pr_url: prUrl, file_path: filePath, line, body, start_review: startReview, hunk_ranges: hunkRanges, other_side_line: otherSide }) })
      if (!r.ok) return r.error || 'failed'
      await refetchPr()
      return null
    } catch {
      return 'network error'
    }
  }
  const saveEdit = async (commentId: string) => {
    if (editBusy || !editText.trim()) return
    setEditBusy(true)
    setEditErr('')
    try {
      const r = await adminFetch<{ ok: boolean; error: string | null }>(`/api/admin/session/${id}/pr-comment-edit`, { method: 'POST', body: JSON.stringify({ pr_url: prUrl, comment_id: commentId, body: editText.trim() }) })
      if (!r.ok) { setEditErr(r.error || 'failed'); return }
      setEditingComment('')
      setEditText('')
      await refetchPr()
    } catch {
      setEditErr('network error')
    } finally {
      setEditBusy(false)
    }
  }
  const deleteComment = async (commentId: string) => {
    if (editBusy) return
    setEditBusy(true)
    try {
      await adminFetch(`/api/admin/session/${id}/pr-comment-delete`, { method: 'POST', body: JSON.stringify({ pr_url: prUrl, comment_id: commentId }) })
      await refetchPr()
    } catch { /* keep prior state */ } finally {
      setEditBusy(false)
    }
  }
  if (err) return <div className="p-3 text-[13px] text-muted-foreground">PR data unavailable: {err}</div>
  if (!data) return <div className="p-3 text-[13px] text-muted-foreground">{t('pr.loading')}</div>
  const info = data.info
  const pill = prStateLabel(info, data.merge_status)
  const repoPath = prUrl.replace('https://', '').replace(/\/(pull|merge_requests|pull-requests)\/\d+$/, '').replace(/^(github\.com|gitlab\.com|bitbucket\.org)\//, '')
  const checks = data.checks?.checks || []
  const comments = data.comments || []
  const threads = data.threads || []
  const commits = data.commits || []
  const discussion: ({ kind: 'comment'; at: string; cm: typeof comments[number] } | { kind: 'thread'; at: string; th: typeof threads[number] })[] = [
    ...comments.map((cm) => ({ kind: 'comment' as const, at: cm.created_at, cm })),
    ...threads.map((th) => ({ kind: 'thread' as const, at: th.comments[0]?.created_at || '', th })),
  ].sort((a, b) => a.at.localeCompare(b.at))
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center gap-2" data-testid="merge-status-bar">
        <span className={cn('flex h-7 items-center gap-1 rounded-full px-[11px] text-[13px] font-medium', pill.cls)}>
          <GitPullRequest size={13} /> {pill.label}
        </span>
        <span className="flex-1" />
        <a href={prUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground">
          GitHub <ArrowUpRight size={12} />
        </a>
        <a href={reviewMirrorPath(repoPath, info?.number ?? '')} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground">
          Full view <ArrowUpRight size={12} />
        </a>
        <div className="relative">
          <button onClick={() => setCommentOpen((o) => !o)} className="flex cursor-pointer items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[13px] font-medium hover:bg-accent">
            Comment <ChevronDown size={12} />
          </button>
          {commentOpen && (
            <div className="absolute right-0 top-full z-30 mt-1 w-80 rounded-lg border border-border bg-background p-3 shadow-lg">
              <textarea value={cmtText} onChange={(e) => setCmtText(e.target.value)} placeholder={t('pr.writeComment')} className="min-h-24 w-full resize-none rounded-md border border-border bg-background p-2 text-[13px] placeholder:text-muted-foreground" />
              {pill.label === 'Merged' && <p className="mt-2 text-[12px] text-muted-foreground">{t('pr.mergedNote')}</p>}
              {postErr && <p className="mt-1 text-[12px] text-red-500">Failed: {postErr}</p>}
              <div className="mt-2 flex justify-end gap-2">
                <button onClick={() => setCommentOpen(false)} className="cursor-pointer rounded-md border border-border px-3 py-1 text-[13px] hover:bg-accent">{t('common.cancel')}</button>
                <button disabled={!cmtText.trim() || posting} onClick={() => void postComment(cmtText, () => { setCmtText(''); setCommentOpen(false) })} className={cn('rounded-md px-3 py-1 text-[13px] font-medium text-white', !cmtText.trim() || posting ? 'cursor-not-allowed bg-blue-500/50' : 'cursor-pointer bg-blue-500 hover:bg-blue-600')}>{posting ? 'Submitting…' : 'Submit'}</button>
              </div>
            </div>
          )}
        </div>
      </div>
      <div>
        <div className="text-[12px] text-muted-foreground">{repoPath} #{info?.number}</div>
        <h2 className="text-[17px] font-semibold leading-snug">{info?.title || 'Pull request'}</h2>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
        {data.author?.avatar_url && <img loading="lazy" decoding="async" src={data.author.avatar_url} alt="" className="size-5 rounded-full" />}
        {info?.user && <span className="text-muted-foreground">{info.user.replace(/\s*\[bot\]\s*$/, '')}</span>}
        {info?.base_branch && <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{info.base_branch}</span>}
        {info?.head_branch && (
          <>
            <span className="text-muted-foreground">←</span>
            <span className="max-w-56 truncate rounded bg-muted px-1.5 py-0.5 font-mono">{info.head_branch}</span>
            <button
              aria-label={t('pr.copyBranch')}
              title={t('pr.copyBranch')}
              onClick={() => { void navigator.clipboard.writeText(info.head_branch || ''); setCopiedBr(true); setTimeout(() => setCopiedBr(false), 1200) }}
              className="flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {copiedBr ? <Check size={11} /> : <Copy size={11} />}
            </button>
          </>
        )}
        {info?.changed_files != null && <span className="text-muted-foreground">{info.changed_files} {info.changed_files === 1 ? 'file' : 'files'}</span>}
        {info?.additions != null && <span className="font-medium text-emerald-600 dark:text-emerald-400">+{info.additions}</span>}
        {info?.deletions != null && <span className="font-medium text-red-600 dark:text-red-400">−{info.deletions}</span>}
      </div>
      <div className="relative min-h-[46px] rounded-[10px] border border-border p-2 text-[13px]">
        <button
          onClick={() => setMergedOpen((o) => !o)}
          aria-label={pill.label === 'Merged' ? 'Merged — view checks, reviewers, assignees, and labels' : undefined}
          className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md text-left"
        >
          <GitPullRequest size={14} className="text-muted-foreground" />
          <span data-testid="merge-status-message">{pill.label}</span>
          <ChevronDown size={12} className={cn('text-muted-foreground transition-transform', mergedOpen && 'rotate-180')} />
        </button>
        {mergedOpen && (
          <div className="absolute left-0 top-full z-30 mt-1 w-80 rounded-lg border border-border bg-background p-3 shadow-lg">
            {(() => {
              const ms = data.merge_status as { checks_pending?: boolean; checks_failing?: boolean } | null
              const label = ms?.checks_failing ? 'Some checks failed' : ms?.checks_pending ? 'Checks pending' : 'All checks passed'
              const cls = ms?.checks_failing ? 'bg-red-500 text-red-600' : ms?.checks_pending ? 'bg-amber-500 text-amber-600' : 'bg-emerald-500 text-emerald-600'
              return (
                <div className="mb-3 border-b border-border pb-3">
                  <div className={cn('mb-2 h-1 rounded-full', cls.split(' ')[0])} />
                  <div className={cn('flex items-center gap-1.5 text-[13px]', cls.split(' ')[1])}>
                    {ms?.checks_failing ? <XCircle size={13} /> : <Check size={13} />} {label}
                  </div>
                  {checks.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {checks.map((ck, i) => (
                        <li key={i} className="flex items-center gap-2 text-[12px]">
                          {(() => {
                            const st = String(ck.conclusion || ck.status || '').toUpperCase()
                            if (st === 'SUCCESS') return <CheckCircle2 size={12} className="shrink-0 text-emerald-500" />
                            if (st === 'QUEUED' || st === 'IN_PROGRESS' || st === 'PENDING' || st === '') return <CircleDashed size={12} className="shrink-0 text-amber-500" />
                            if (st === 'NEUTRAL' || st === 'SKIPPED') return <Circle size={12} className="shrink-0 text-muted-foreground" />
                            return <XCircle size={12} className="shrink-0 text-red-500" />
                          })()}
                          {ck.details_url && /^https:\/\//.test(ck.details_url) ? (
                            <a href={ck.details_url} target="_blank" rel="noreferrer" className="min-w-0 truncate hover:underline">{ck.name}</a>
                          ) : <span className="min-w-0 truncate">{ck.name}</span>}
                          {ck.is_required && <span className="rounded border border-border px-1 text-[10px] text-muted-foreground">{t('pr.required')}</span>}
                          {ck.description && <span className="min-w-0 truncate text-muted-foreground">{ck.description}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )
            })()}
            {([['Reviewers', data.requested_reviewers || [], 'No reviewers'], ['Assignees', data.assignees || [], 'No assignees']] as const).map(([title, people, empty]) => (
              <div key={title} className="mb-3">
                <div className="mb-1 text-[13px] font-medium">{title}</div>
                {people.length ? people.map((u) => (
                  <div key={u.login} className="flex items-center gap-2 py-0.5 text-[13px]">
                    {u.avatar_url && <img loading="lazy" decoding="async" src={u.avatar_url} alt="" className="size-5 rounded-full" />}
                    <span>{u.login}</span>
                  </div>
                )) : <div className="text-[13px] text-muted-foreground">{empty}</div>}
              </div>
            ))}
            <div>
              <div className="mb-1 text-[13px] font-medium">{t('pr.labels')}</div>
              {data.labels?.length ? (
                <div className="flex flex-wrap gap-1">
                  {data.labels.map((l) => <span key={l.name} className="rounded-full border border-border px-2 py-0.5 text-[12px]" style={l.color ? { borderColor: `#${l.color}`, color: `#${l.color}` } : undefined}>{l.name}</span>)}
                </div>
              ) : <div className="text-[13px] text-muted-foreground">{t('pr.noLabels')}</div>}
            </div>
          </div>
        )}
      </div>
      <div className="flex items-center gap-1 border-b border-border">
        <div role="tablist" aria-orientation="horizontal" className="flex min-w-0 items-center gap-1 overflow-x-auto">
          {(['changes', 'bugs', 'description', 'discussion', 'commits'] as const).map((k) => {
            const n = k === 'discussion' ? comments.length + threads.length : k === 'commits' ? commits.length : k === 'bugs' && bugs?.data ? bugs.data.bugs.length + bugs.data.security_findings.length + bugs.data.flags.length : 0
            const label = k[0].toUpperCase() + k.slice(1)
            return (
              <button
                key={k}
                id={`pr-tab-${k}`}
                role="tab"
                aria-selected={sub === k}
                aria-controls="pr-tabpanel"
                data-active={sub === k ? '' : undefined}
                onClick={() => setSub(k)}
                className="cursor-pointer text-muted-foreground text-[13px] group/tab relative flex h-[28px] touch-manipulation select-none items-center whitespace-nowrap font-medium rounded-full px-3 hover:bg-tint-secondary data-[active]:text-foreground data-[active]:bg-tint-secondary"
              >
                <span className="flex flex-1 items-center gap-1.5">
                  {label}{n ? <span className="text-[13px] text-muted-foreground min-w-3.5 text-center tabular-nums">{n}</span> : null}
                </span>
              </button>
            )
          })}
        </div>
        <span className="flex-1" />
        <div className="relative">
          <button
            aria-label={t('pr.diffSettings')}
            aria-haspopup="menu"
            aria-expanded={diffMenu}
            onClick={() => setDiffMenu((v) => !v)}
            className={cn('flex size-6 cursor-pointer items-center justify-center rounded-[6px]', diffMenu ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground')}
          >
            <Settings2 size={15} />
          </button>
          {diffMenu && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setDiffMenu(false)} />
              <div role="menu" className="absolute right-0 top-7 z-40 min-w-[220px] rounded-[10px] border border-border bg-popover p-1 shadow-lg">
                <div role="presentation" className="px-2 py-[5px] text-[12px] font-medium text-muted-foreground">{t('pr.diffView')}</div>
                {([['Split view', true], ['Unified view', false]] as const).map(([label, val]) => (
                  <button
                    key={label}
                    role="menuitemradio"
                    aria-checked={diffOpts.split === val}
                    onClick={() => updDiffOpts({ split: val })}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-[13px] hover:bg-accent"
                  >
                    <span className="flex size-4 items-center justify-center">{diffOpts.split === val && <Check size={13} />}</span>
                    {label}
                  </button>
                ))}
                <button
                  role="menuitemcheckbox"
                  aria-checked={diffOpts.hideWs}
                  onClick={() => updDiffOpts({ hideWs: !diffOpts.hideWs })}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-[13px] hover:bg-accent"
                >
                  <span className="flex size-4 items-center justify-center">{diffOpts.hideWs && <Check size={13} />}</span>
                  Hide whitespace
                </button>
                <div role="presentation" className="px-2 py-[5px] text-[12px] font-medium text-muted-foreground">{t('pr.comments')}</div>
                <button
                  role="menuitemcheckbox"
                  aria-checked={diffOpts.hideHl}
                  onClick={() => updDiffOpts({ hideHl: !diffOpts.hideHl })}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-[13px] hover:bg-accent"
                >
                  <span className="flex size-4 items-center justify-center">{diffOpts.hideHl && <Check size={13} />}</span>
                  Hide highlights
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      <div id="pr-tabpanel" role="tabpanel" tabIndex={0} aria-labelledby={`pr-tab-${sub}`} className="px-2 pb-2">
      {sub === 'changes' ? (
        !diff ? <p className="text-[13px] text-muted-foreground">{t('pr.loadingChanges')}</p>
        : diff.files?.length ? (() => {
            const repoBase = prUrl.replace(/\/pull\/\d+.*$/, '')
            const rawBase = data.head_sha ? `${repoBase}/blob/${data.head_sha}/` : undefined
            const viewedKey = `pr-viewed-files:${prUrl}`
            const threadsByFile = new Map<string, Map<number, number>>()
            for (const t of data.threads || []) {
              if (!t.path || !t.line || t.is_resolved) continue
              const m2 = threadsByFile.get(t.path) || new Map<number, number>()
              m2.set(t.line, (m2.get(t.line) || 0) + t.comments.length)
              threadsByFile.set(t.path, m2)
            }
            const goDiscussion = () => setSub('discussion')
            const bugsByFile = new Map<string, Map<number, PrBugItemT[]>>()
            if (bugs?.data?.status === 'completed') {
              for (const it of [...bugs.data.security_findings, ...bugs.data.bugs, ...bugs.data.flags]) {
                const ln = parseInt(it.start_line, 10)
                if (!it.file_path || !ln) continue
                const m3 = bugsByFile.get(it.file_path) || new Map<number, PrBugItemT[]>()
                m3.set(ln, [...(m3.get(ln) || []), it])
                bugsByFile.set(it.file_path, m3)
              }
            }
            const byPath = new Map(diff.files.map((f) => [f.file_path, f]))
            const grouped = (diff.sections || []).filter((s) => s.title || s.text)
            const promo = diff.analysis_status !== 'completed'
              ? <PrAnalysisPromo prUrl={prUrl} analyzing={analyzing} error={analyzeErr} onRun={() => void runAnalysis()} />
              : null
            const renderFile = (f: PrDiffFileT) => <PrDiffFile key={f.file_path} f={f} rawBase={rawBase} viewedKey={viewedKey} threadLines={threadsByFile.get(f.file_path)} onGoToThread={goDiscussion} bugsAt={bugsByFile.get(f.file_path)} onAddComment={addLineComment} diffOpts={diffOpts} />
            if (!grouped.length) return <>{promo}<div className="flex flex-col gap-2">{diff.files.map(renderFile)}</div></>
            if (grouped.length === 1 && /^changes$/i.test(grouped[0].title.trim())) {
              const files = grouped[0].files.map((p) => byPath.get(p)).filter((f): f is PrDiffFileT => !!f)
              return <>{promo}<div className="px-4 py-3 text-[15px] font-medium">{t('pr.changes')}</div><div className="flex flex-col gap-2">{files.map(renderFile)}</div></>
            }
            let n = 0
            return (
              <>
              {promo}
              <div className="flex flex-col gap-3">
                {grouped.map((s, i) => {
                  const secFiles = s.files.map((p) => byPath.get(p)).filter((f): f is PrDiffFileT => !!f)
                  const num = secFiles.length ? ++n : 0
                  return (
                    <div key={i} className="flex flex-col gap-2">
                      {s.title && (
                        <div className="sticky top-0 z-20 flex h-12 items-center gap-2 bg-background px-1 py-2">
                          <h1 className="min-w-0 flex-1 truncate text-[15px] font-medium" title={s.title}>
                            {num > 0 && <span className="mr-3 inline-flex size-[18px] -translate-y-px items-center justify-center rounded-full bg-foreground text-center align-middle text-[12px] font-normal tabular-nums text-background">{num}</span>}
                            {s.title.replace(/^\d+\.\s*/, '').split(/`([^`]+)`/).map((part, k) =>
                              k % 2 === 1 ? <span key={k} className="rounded-[6px] bg-muted px-[4px] py-[2px] font-mono text-[13px] font-normal">{part}</span> : part)}
                          </h1>
                          {secFiles.length > 0 && <PrSectionViewedProgress files={secFiles.map((f) => f.file_path)} viewedKey={viewedKey} />}
                        </div>
                      )}
                      {s.text && <div className="text-[13px]"><Markdown text={s.text.replace(/<\/?cite[^>]*>/g, '')} /></div>}
                      {secFiles.map((f) => <PrDiffFile key={f.file_path} f={f} rawBase={rawBase} viewedKey={viewedKey} threadLines={threadsByFile.get(f.file_path)} onGoToThread={goDiscussion} bugsAt={bugsByFile.get(f.file_path)} onAddComment={addLineComment} diffOpts={diffOpts} />)}
                    </div>
                  )
                })}
              </div>
              </>
            )
          })()
        : <p className="text-[13px] text-muted-foreground">{diff.error ? `Changes unavailable: ${diff.error}` : 'No changes.'}</p>
      ) : sub === 'bugs' ? (
        !bugs ? <p className="text-[13px] text-muted-foreground">{t('pr.loadingAnalysis')}</p>
        : bugs.error || !bugs.data ? <p className="text-[13px] text-muted-foreground">Bugs unavailable: {bugs.error || 'unknown'}</p>
        : diff != null && diff.analysis_status !== 'completed' ? (
          <PrAnalysisPromo prUrl={prUrl} analyzing={analyzing} error={analyzeErr} onRun={() => void runAnalysis()} />
        ) : bugs.data.status === 'running' ? (
          <div className="flex items-center gap-2 rounded-lg border border-border px-4 py-6 text-[13px] text-muted-foreground"><Loader2 size={14} className="animate-spin" /> {t('pr.analyzing')}</div>
        ) : bugs.data.status === 'completed' ? (
          <div className="flex flex-col gap-3">
            {[
              { label: 'Vulnerability', labelPlural: 'Vulnerabilities', items: bugs.data.security_findings, tone: 'text-red-600 dark:text-red-400' },
              { label: 'Bug', labelPlural: 'Bugs', items: bugs.data.bugs, tone: 'text-red-600 dark:text-red-400' },
              { label: 'Flag', labelPlural: 'Flags', items: bugs.data.flags, tone: 'text-orange-600 dark:text-orange-400' },
            ].filter((s) => s.items.length).map((s) => (
              <div key={s.label} className="rounded-lg border border-border p-3">
                <div className={cn('mb-2 text-[13px] font-medium', s.tone)}>{s.items.length} {s.items.length === 1 ? s.label : s.labelPlural}</div>
                <div className="flex flex-col gap-2.5">
                  {s.items.map((it, i) => (
                    <div key={i}>
                      <div className="text-[13px] font-medium">{it.title}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
                        {it.severity && <span className={cn('font-medium capitalize', it.severity === 'critical' || it.severity === 'severe' ? 'text-red-600 dark:text-red-400' : '')}>{it.severity}</span>}
                        {it.category && <span>{it.category}</span>}
                        <span className="font-mono">{it.file_path.split('/').pop()}:{it.start_line}</span>
                        {it.cwe_id && <span>• {it.cwe_id}</span>}
                      </div>
                      {it.description && <p className="mt-1 text-[12px] text-muted-foreground">{it.description}</p>}
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {!bugs.data.security_findings.length && !bugs.data.bugs.length && !bugs.data.flags.length && <p className="text-[13px] text-muted-foreground">{t('pr.noBugs')}</p>}
          </div>
        ) : <PrAnalysisPromo prUrl={prUrl} analyzing={analyzing} error={analyzeErr} onRun={() => void runAnalysis()} />
      ) : sub === 'discussion' ? (
        <div className="flex flex-col gap-3">
          {discussion.length ? discussion.map((it, i) => it.kind === 'comment' ? (
            <div key={i} className="group rounded-lg border border-border p-3">
              <div className="mb-1.5 flex items-center gap-2 text-[12px]">
                {it.cm.avatar_url && <img loading="lazy" decoding="async" src={it.cm.avatar_url} alt="" className="size-5 rounded-full" />}
                <span className="font-medium">{it.cm.login}</span>
                <span className="text-muted-foreground">{it.cm.created_at ? new Date(it.cm.created_at).toLocaleString() : ''}</span>
                {it.cm.id && <CommentActions comment={it.cm} canWrite={it.cm.id.startsWith('PRRC_')} onEdit={() => { setEditingComment(it.cm.id); setEditText(it.cm.body); setEditErr('') }} onDelete={() => void deleteComment(it.cm.id)} />}
              </div>
              {editingComment === it.cm.id ? (
                <CommentEditor value={editText} onChange={setEditText} busy={editBusy} err={editErr} onCancel={() => { setEditingComment(''); setEditText(''); setEditErr('') }} onSave={() => void saveEdit(it.cm.id)} />
              ) : <div className="text-[13px]"><Markdown text={it.cm.body} /></div>}
              {it.cm.id && <ReactionRow commentId={it.cm.id} reactions={it.cm.reactions} reacting={reacting} onToggle={(cid, content, has) => void toggleReaction(cid, content, has)} />}
            </div>
          ) : (
            <div key={i} className="ml-6 overflow-hidden rounded-lg border border-border">
              <div
                role={it.th.is_resolved ? 'button' : undefined}
                onClick={it.th.is_resolved ? () => setExpandedThreads((m) => ({ ...m, [it.th.id]: !m[it.th.id] })) : undefined}
                className={cn('flex min-h-8 items-center gap-2 bg-muted/40 px-3 py-1.5', (!it.th.is_resolved || expandedThreads[it.th.id]) && 'border-b border-border', it.th.is_resolved && 'cursor-pointer hover:bg-muted/70')}
              >
                <Code size={14} className="shrink-0 text-muted-foreground" />
                <span className="truncate text-[12px] font-medium text-muted-foreground">{it.th.path.split('/').pop()}</span>
                <span className="ml-auto flex items-center gap-1.5 text-[12px] text-muted-foreground">
                  {it.th.is_resolved && <span>{t('pr.resolved')}</span>}
                  {it.th.is_outdated && <span>{t('pr.outdated')}</span>}
                  L{it.th.line}
                  {it.th.is_resolved && <ChevronDown size={12} className={cn('transition-transform', expandedThreads[it.th.id] && 'rotate-180')} />}
                </span>
              </div>
              {(!it.th.is_resolved || expandedThreads[it.th.id]) && <div className="flex flex-col gap-2.5 p-3">
                {it.th.comments.map((cm, j) => (
                  <div key={j} className="group">
                    <div className="mb-1 flex items-center gap-2 text-[12px]">
                      {cm.avatar_url && <img loading="lazy" decoding="async" src={cm.avatar_url} alt="" className="size-5 rounded-full" />}
                      <span className="font-medium">{cm.login}</span>
                      <span className="text-muted-foreground">{cm.created_at ? new Date(cm.created_at).toLocaleString() : ''}</span>
                      {cm.pending && <span className="rounded bg-orange-500/15 px-1.5 py-0.5 text-[11px] font-medium text-orange-500">{t('pr.pending')}</span>}
                      {cm.id && <CommentActions comment={cm} canWrite={cm.id.startsWith('PRRC_')} onEdit={() => { setEditingComment(cm.id); setEditText(cm.body); setEditErr('') }} onDelete={() => void deleteComment(cm.id)} />}
                    </div>
                    {editingComment === cm.id ? (
                      <CommentEditor value={editText} onChange={setEditText} busy={editBusy} err={editErr} onCancel={() => { setEditingComment(''); setEditText(''); setEditErr('') }} onSave={() => void saveEdit(cm.id)} />
                    ) : <div className="text-[13px]"><Markdown text={cm.body} /></div>}
                    {cm.id && <ReactionRow commentId={cm.id} reactions={cm.reactions} reacting={reacting} onToggle={(cid, content, has) => void toggleReaction(cid, content, has)} />}
                  </div>
                ))}
                {(pendingReplies[it.th.id] || []).filter((pr2) => !it.th.comments.some((c) => c.id === pr2.id)).map((pr2, j) => (
                  <div key={`p${j}`} className="group">
                    <div className="mb-1 flex items-center gap-2 text-[12px]">
                      <span className="font-medium">{t('pr.you')}</span>
                      <span className="rounded bg-orange-500/15 px-1.5 py-0.5 text-[11px] font-medium text-orange-500">{t('pr.pending')}</span>
                      {pr2.id && (
                        <button
                          onClick={() => { void deleteComment(pr2.id); setPendingReplies((m) => ({ ...m, [it.th.id]: (m[it.th.id] || []).filter((x) => x !== pr2) })) }}
                          className="ml-auto cursor-pointer text-[11px] text-muted-foreground opacity-0 hover:text-red-500 group-hover:opacity-100"
                        >
                          Delete
                        </button>
                      )}
                    </div>
                    <div className="text-[13px]"><Markdown text={pr2.body} /></div>
                  </div>
                ))}
                {it.th.id && (replyThread === it.th.id ? (
                  <div className="rounded-md border border-border">
                    <textarea
                      autoFocus
                      value={replyText}
                      onChange={(e) => setReplyText(e.target.value)}
                      onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submitReply(it.th.id) }}
                      placeholder="Reply to this thread..."
                      className="min-h-14 w-full resize-none rounded-md bg-background p-2.5 text-[13px] placeholder:text-muted-foreground focus:outline-none"
                    />
                    <div className="flex items-center justify-end gap-2 border-t border-border px-2 py-1.5">
                      {replyErr && <span className="mr-auto text-[12px] text-red-500">Failed: {replyErr}</span>}
                      <button onClick={() => { setReplyThread(''); setReplyText(''); setReplyErr('') }} className="cursor-pointer rounded-md px-2.5 py-1 text-[12px] text-muted-foreground hover:bg-accent">{t('common.cancel')}</button>
                      <button
                        disabled={replying || !replyText.trim()}
                        onClick={() => void submitReply(it.th.id, true)}
                        className={cn('rounded-md border border-border px-2.5 py-1 text-[12px] font-medium', replying || !replyText.trim() ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-accent')}
                      >
                        {(pendingReplies[it.th.id] || []).length || it.th.comments.some((c) => c.pending) ? 'Add to review' : 'Start a review'}
                      </button>
                      <button
                        disabled={replying || !replyText.trim()}
                        onClick={() => void submitReply(it.th.id)}
                        className={cn('rounded-md px-2.5 py-1 text-[12px] font-medium text-white', replying || !replyText.trim() ? 'cursor-not-allowed bg-blue-500/50' : 'cursor-pointer bg-blue-500 hover:bg-blue-600')}
                      >
                        {replying ? 'Replying…' : 'Reply'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => { setReplyThread(it.th.id); setReplyText(''); setReplyErr('') }}
                    className="w-full cursor-pointer rounded-md border border-border px-2.5 py-1.5 text-left text-[12px] text-muted-foreground hover:bg-accent"
                  >
                    Reply to this thread...
                  </button>
                ))}
                {it.th.id && (
                  <div className="flex justify-end">
                    <button
                      disabled={resolving === it.th.id}
                      onClick={() => void toggleResolve(it.th.id, it.th.is_resolved)}
                      className="flex cursor-pointer items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                    >
                      <Check size={12} />
                      {it.th.is_resolved ? 'Mark unresolved' : 'Mark resolved'}
                    </button>
                  </div>
                )}
              </div>}
            </div>
          )) : <p className="text-[13px] text-muted-foreground">{t('pr.noComments')}</p>}
          <div className="rounded-lg border border-border">
            <textarea value={discText} onChange={(e) => setDiscText(e.target.value)} placeholder={t('pr.addCommentPh')} className="min-h-16 w-full resize-none rounded-lg bg-background p-3 text-[13px] placeholder:text-muted-foreground focus:outline-none" />
            {(discText.trim() || postErr) && (
              <div className="flex items-center justify-end gap-2 border-t border-border px-2 py-1.5">
                {postErr && <span className="mr-auto text-[12px] text-red-500">Failed: {postErr}</span>}
                <button disabled={!discText.trim() || posting} onClick={() => void postComment(discText, () => setDiscText(''))} className={cn('rounded-md px-3 py-1 text-[13px] font-medium text-white', !discText.trim() || posting ? 'cursor-not-allowed bg-blue-500/50' : 'cursor-pointer bg-blue-500 hover:bg-blue-600')}>{posting ? 'Submitting…' : 'Comment'}</button>
              </div>
            )}
          </div>
        </div>
      ) : sub === 'commits' ? (
        commits.length ? (
          <div className="flex flex-col gap-2">
            {commits.map((cm) => (
              <div key={cm.sha} className="rounded-lg border border-border px-3 py-2.5">
                <div className="text-[13px] font-medium">{cm.headline}</div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
                  {cm.sha === data.head_sha && <span className="font-medium text-emerald-600 dark:text-emerald-400">{t('pr.current')}</span>}
                  {cm.committed_at && <span>• {relTime(cm.committed_at)}</span>}
                  {cm.author && <span>• {cm.author}</span>}
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{cm.sha.slice(0, 7)}</span>
                  <button aria-label="Copy commit SHA" onClick={() => void navigator.clipboard.writeText(cm.sha)} className="flex size-5 cursor-pointer items-center justify-center rounded hover:bg-accent hover:text-foreground"><Copy size={11} /></button>
                </div>
              </div>
            ))}
          </div>
        ) : <p className="text-[13px] text-muted-foreground">{t('pr.noCommits')}</p>
      ) : (
        info?.body ? <div className="text-[13px]"><Markdown text={info.body} /></div> : <p className="text-[13px] text-muted-foreground">{t('pr.noDesc')}</p>
      )}
      </div>
    </div>
  )
}

/**
 * Editor: hosted VS Code for the session's machine (official Editor tab).
 * The Worker calls the official vscode-server endpoint and returns a
 * short-lived link, which is embedded as an iframe. Admin-only.
 */

export { type PrBugItemT, type PrDiffFileT, rangeLength, PrInlineComposer, readViewedSet, toggleViewedStore, PrSectionViewedProgress, type DiffOptsT, DIFF_OPTS_KEY, readDiffOpts, WordDiffLine, PrDiffFile, PrAnalysisPromo, type PrInfo, prStateLabel, REACTION_SET, ReactionPicker, CommentActions, CommentEditor, ReactionRow, PrPanel };
