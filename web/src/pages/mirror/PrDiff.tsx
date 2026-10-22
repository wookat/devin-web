import { cloneElement, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, Copy, Check, Plus, MoreHorizontal, MessageSquare, Bug as BugIcon, ChevronsUpDown, FileCode2 } from 'lucide-react'
import { FileIcon } from '@/lib/fileIcon'
import Markdown from '@/components/Markdown'
import { blockWordDiff, changedAfterRanges, otherSideLine, type WordSeg } from '@/lib/diff'
import { buildPrDiffRows, type PrDiffRow as PrDiffRowT } from '@/lib/prDiffRows'
import { cn } from '@/lib/utils'

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
        <button onClick={() => setOpen((o) => !o)} aria-label={bodyOpen ? t('pr.collapseFile') : t('pr.expandFile')} className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-accent hover:text-foreground">
          <ChevronDown size={18} className={cn('shrink-0 transition-transform', !bodyOpen && '-rotate-90')} />
        </button>
        <FileIcon path={f.file_path} size={14} className="shrink-0" />
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
          {viewed ? t('pr.viewed') : t('pr.markViewed')}
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
                    {!row.top && <button type="button" aria-label={t('chg.expandAbove', { n: Math.min(5, row.hidden.length) })} onClick={() => reveal('before')} className="inline-flex cursor-pointer items-center gap-1 text-[rgba(13,133,185,0.85)] dark:text-blue-400"><ChevronUp size={12} />5 lines</button>}
                    <button type="button" aria-label={t('chg.expandAll', { n: row.hidden.length })} onClick={revealAll} className="inline-flex cursor-pointer items-center gap-1 text-[rgba(13,133,185,0.85)] dark:text-blue-400"><ChevronsUpDown size={12} />All {row.hidden.length} lines</button>
                    {!row.bottom && <button type="button" aria-label={t('chg.expandBelow', { n: Math.min(5, row.hidden.length) })} onClick={() => reveal('after')} className="inline-flex cursor-pointer items-center gap-1 text-[rgba(13,133,185,0.85)] dark:text-blue-400"><ChevronDown size={12} />5 lines</button>}
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
                  {lineNo && bugItems ? <button aria-label={openBugs.has(lineNo) ? t('pr.collapseComment') : t('pr.expandComment')} aria-expanded={openBugs.has(lineNo)} onClick={() => setOpenBugs((current) => { const next = new Set(current); if (next.has(lineNo)) next.delete(lineNo); else next.add(lineNo); return next })} className="mr-1 flex size-6 shrink-0 cursor-pointer items-center justify-center self-center rounded-[6px] border border-border bg-background hover:bg-accent"><BugIcon size={13} className="text-red-500" /></button> : null}
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
                            aria-label={openBugs.has(rn) ? t('pr.collapseComment') : t('pr.expandComment')}
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
                    aria-label={openBugs.has(lineNo) ? t('pr.collapseComment') : t('pr.expandComment')}
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
        {analyzing ? t('pr.launching') : t('pr.runAnalysis')}
      </button>
      {error && <span className="text-[12px] text-red-500">Failed: {error}</span>}
      <button onClick={dismiss} className="cursor-pointer text-[13px] text-muted-foreground hover:text-foreground">{t('common.dismiss')}</button>
    </div>
  )
}

export { type PrBugItemT, type PrDiffFileT, rangeLength, PrInlineComposer, readViewedSet, toggleViewedStore, PrSectionViewedProgress, type DiffOptsT, DIFF_OPTS_KEY, readDiffOpts, WordDiffLine, PrDiffFile, PrAnalysisPromo };
