import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { Loader2, ChevronRight, ChevronDown, ChevronUp, Copy, Check, PanelLeft, PanelRight, FolderTree, X, Expand, ChevronsUpDown, Search, Ellipsis } from 'lucide-react'
import { FileIcon } from '@/lib/fileIcon'
import { sessionFetch, fetchFileContents } from '@/lib/viewer'
import { type TimelineItem } from '@/components/Timeline'
import { lineDiffFull, blockWordDiff, type DiffLine, type WordSeg } from '@/lib/diff'
import { cn } from '@/lib/utils'
import { WordDiffLine } from './PrPanel'
import { useShikiTokens, type Tok } from '@/components/CodeView'

interface AggFile {
  path: string
  added: number
  removed: number
  firstPrevKey?: string
  lastKey?: string
  actionType?: string
}

interface SessionChangesResponse {
  files: AggFile[]
  truncated: boolean
  error: string | null
}

function aggregateFiles(items: TimelineItem[], includeRead = false): AggFile[] {
  const map = new Map<string, AggFile>()
  for (const it of items) {
    if (it.kind !== 'edit' && !(includeRead && it.kind === 'read')) continue
    for (const f of it.fileUpdates || []) {
      const cur = map.get(f.file_path)
      if (!cur) {
        map.set(f.file_path, {
          path: f.file_path,
          added: f.lines_added ?? 0,
          removed: f.lines_removed ?? 0,
          firstPrevKey: f.prev_contents_key ?? f.prevFileId,
          lastKey: f.contents_key ?? f.fileId,
          actionType: f.action_type,
        })
      } else {
        cur.added += f.lines_added ?? 0
        cur.removed += f.lines_removed ?? 0
        cur.lastKey = f.contents_key || f.fileId || cur.lastKey
        if (!cur.firstPrevKey) cur.firstPrevKey = f.prev_contents_key ?? f.prevFileId
      }
    }
  }
  return [...map.values()]
}

/** Initial diff visibility keeps changed lines plus nearby context, exposing hunk gaps. */
function initialVisible(lines: DiffLine[], context = 3): boolean[] {
  if (!lines.some((line) => line.type !== 'same')) return lines.map(() => true)
  const visible = new Array<boolean>(lines.length).fill(false)
  lines.forEach((line, index) => {
    if (line.type === 'same') return
    for (let i = Math.max(0, index - context); i <= Math.min(lines.length - 1, index + context); i++) visible[i] = true
  })
  return visible
}

function wordSegmentsForDiff(lines: DiffLine[]): Map<number, WordSeg[]> {
  const result = new Map<number, WordSeg[]>()
  let start = 0
  while (start < lines.length) {
    while (start < lines.length && lines[start].type === 'same') start++
    if (start >= lines.length) break
    let end = start
    while (end < lines.length && lines[end].type !== 'same') end++
    const before = lines.slice(start, end).filter((line) => line.type === 'del').map((line) => line.text)
    const after = lines.slice(start, end).filter((line) => line.type === 'add').map((line) => line.text)
    if (before.length && after.length) {
      const [beforeSegments, afterSegments] = blockWordDiff(before, after)
      let beforeIndex = 0
      let afterIndex = 0
      for (let index = start; index < end; index++) {
        if (lines[index].type === 'del') {
          const segments = beforeSegments[beforeIndex++]
          if (segments) result.set(index, segments)
        } else if (lines[index].type === 'add') {
          const segments = afterSegments[afterIndex++]
          if (segments) result.set(index, segments)
        }
      }
    }
    start = end
  }
  return result
}

function ChangesPanel({ items, step, onClearStep, focus, embedded, sessionId, viewMode = false, fileCardsOnly = false }: { items: TimelineItem[]; step?: TimelineItem | null; onClearStep?: () => void; focus?: { path: string; n: number } | null; embedded?: boolean; sessionId?: string; viewMode?: boolean; fileCardsOnly?: boolean }) {
  const { t } = useTranslation()
  const [scope, setScope] = useState<'all' | 'lastTurn'>('all')
  const scopeItems = useMemo(() => step ? [step] : items, [items, step])
  const scopedItems = useMemo(() => {
    if (scope === 'all') return scopeItems
    let lastUserMs = -Infinity
    for (const item of scopeItems) {
      if (item.kind !== 'message' || item.role !== 'user') continue
      const tsMs = new Date(item.ts).getTime()
      if (Number.isFinite(tsMs)) lastUserMs = Math.max(lastUserMs, tsMs)
    }
    return lastUserMs === -Infinity
      ? scopeItems
      : scopeItems.filter((item) => new Date(item.ts).getTime() > lastUserMs)
  }, [scope, scopeItems])
  const localFiles = useMemo(() => aggregateFiles(scopeItems, viewMode), [scopeItems, viewMode])
  const scopedLocalFiles = useMemo(() => aggregateFiles(scopedItems, viewMode), [scopedItems, viewMode])
  useEffect(() => {
    setScope('all')
  }, [sessionId])
  const oldestLoadedMs = useMemo(() => {
    let oldest = Infinity
    for (const item of items) {
      const tsMs = new Date(item.ts).getTime()
      if (Number.isFinite(tsMs) && tsMs < oldest) oldest = tsMs
    }
    return oldest === Infinity ? undefined : oldest
  }, [items])
  const [serverFiles, setServerFiles] = useState<AggFile[] | null>(null)
  const changesRequest = useRef<{ sessionId: string; sinceMs?: number; promise: Promise<SessionChangesResponse> } | null>(null)
  useEffect(() => {
    if (step || embedded || !sessionId) {
      setServerFiles(null)
      return
    }
    let alive = true
    setServerFiles(null)
    const viewportHeight = window.innerHeight
    const viewportWidth = window.innerWidth
    const params = new URLSearchParams()
    if (oldestLoadedMs) params.set('since', String(oldestLoadedMs))
    params.set('vh', String(viewportHeight))
    params.set('vw', String(viewportWidth))
    const existing = changesRequest.current
    const promise = existing?.sessionId === sessionId && existing.sinceMs === oldestLoadedMs
      ? existing.promise
      : sessionFetch<SessionChangesResponse>(`/changes?${params.toString()}`)
    if (!existing || existing.sessionId !== sessionId || existing.sinceMs !== oldestLoadedMs) {
      changesRequest.current = { sessionId, sinceMs: oldestLoadedMs, promise }
    }
    promise.then((response) => {
      if (alive && !response.error) setServerFiles(response.files)
    }).catch(() => {})
    return () => { alive = false }
  }, [embedded, oldestLoadedMs, sessionId, step])
  const files = scope === 'lastTurn' || step || embedded ? scopedLocalFiles : serverFiles ?? localFiles
  const [diffs, setDiffs] = useState<Record<string, { lines: DiffLine[]; vis: boolean[]; loading: boolean; text?: string; oldText?: string; addCount?: number; delCount?: number }>>({})
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [closedFolders, setClosedFolders] = useState<Set<string>>(new Set())
  const [treeHidden, setTreeHidden] = useState(false)
  const [treeView, setTreeView] = useState(true)
  // Official FileHeader "viewed" checkbox — persisted per session+file.
  const [viewed, setViewed] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(`dw-chg-viewed:${sessionId}`) || '[]')) } catch { return new Set() }
  })
  const toggleViewed = (path: string) => setViewed((prev) => {
    const next = new Set(prev)
    if (next.has(path)) next.delete(path); else next.add(path)
    try { localStorage.setItem(`dw-chg-viewed:${sessionId}`, JSON.stringify([...next])) } catch {}
    return next
  })
  const [treeQuery, setTreeQuery] = useState('')
  const [scopeOpen, setScopeOpen] = useState(false)
  const [scopeMenuPos, setScopeMenuPos] = useState({ left: 5, top: 0 })
  const [fileMenu, setFileMenu] = useState<{ path: string; left: number; top: number } | null>(null)
  const scopeButtonRef = useRef<HTMLButtonElement>(null)
  const scopeMenuRef = useRef<HTMLDivElement>(null)
  const loadingPaths = useRef(new Set<string>())

  const updateScopeMenuPosition = useCallback(() => {
    const rect = scopeButtonRef.current?.getBoundingClientRect()
    if (!rect) return
    setScopeMenuPos({
      left: Math.max(5, Math.min(rect.left, window.innerWidth - 225)),
      top: rect.bottom + 4,
    })
  }, [])

  useLayoutEffect(() => {
    if (!scopeOpen) return
    updateScopeMenuPosition()
  }, [scopeOpen, updateScopeMenuPosition])

  useEffect(() => {
    if (!scopeOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setScopeOpen(false)
        scopeButtonRef.current?.focus()
      }
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!scopeButtonRef.current?.contains(target) && !scopeMenuRef.current?.contains(target)) setScopeOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('resize', updateScopeMenuPosition)
    window.addEventListener('scroll', updateScopeMenuPosition, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('resize', updateScopeMenuPosition)
      window.removeEventListener('scroll', updateScopeMenuPosition, true)
    }
  }, [scopeOpen, updateScopeMenuPosition])

  useEffect(() => {
    const present = new Set(files.map((f) => f.path))
    for (const path of loadingPaths.current) if (!present.has(path)) loadingPaths.current.delete(path)
    const pending = files.filter((f) => !loadingPaths.current.has(f.path))
    if (!pending.length) return
    pending.forEach((f) => loadingPaths.current.add(f.path))
    setDiffs((prev) => {
      const next = { ...prev }
      for (const f of pending) {
        next[f.path] = { lines: [], vis: [], loading: true }
      }
      return next
    })
    let cancelled = false
    const load = async () => {
      for (let i = 0; i < pending.length; i += 3) {
        const batch = pending.slice(i, i + 3)
        const keys = [...new Set(batch.flatMap((f) => [f.firstPrevKey, f.lastKey].filter((k): k is string => !!k)))]
        try {
          const r = await fetchFileContents(keys)
          if (cancelled) return
          setDiffs((prev) => {
            const next = { ...prev }
            for (const f of batch) {
              const oldText = f.firstPrevKey ? r.files[f.firstPrevKey] ?? '' : ''
              const newText = f.lastKey ? r.files[f.lastKey] ?? '' : ''
              const lines = viewMode
                ? newText.split('\n').map((text): DiffLine => ({ type: 'same', text }))
                : lineDiffFull(oldText, newText)
              next[f.path] = {
                lines,
                vis: initialVisible(lines),
                loading: false,
                text: newText,
                oldText,
                addCount: lines.filter((line) => line.type === 'add').length,
                delCount: lines.filter((line) => line.type === 'del').length,
              }
            }
            return next
          })
        } catch {
          if (cancelled) return
          setDiffs((prev) => {
            const next = { ...prev }
            for (const f of batch) next[f.path] = { lines: [{ type: 'same', text: t('chg.readFail') }], vis: [true], loading: false }
            return next
          })
        }
      }
    }
    void load()
    return () => { cancelled = true }
  }, [files, viewMode])

  const toggleFile = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const scrollRef = useRef<HTMLDivElement>(null)
  // Scroll compensation: expanding a collapsed region above the viewport must
  // not shove the viewed content — remember the first still-visible line after
  // the revealed range and restore its viewport offset after the re-render.
  const compRef = useRef<{ sel: string; top: number } | null>(null)
  const reveal = useCallback((path: string, from: number, to: number) => {
    const cur = diffs[path]
    if (cur) {
      let anchor = -1
      for (let k = Math.max(0, to); k < cur.lines.length; k++) if (cur.vis[k]) { anchor = k; break }
      if (anchor >= 0) {
        const newNo = cur.lines.slice(0, anchor + 1).filter((l) => l.type !== 'del').length
        const sel = `[data-change-path="${CSS.escape(path)}"] [data-line-number="${newNo}"]`
        const el = document.querySelector(sel)
        if (el) compRef.current = { sel, top: el.getBoundingClientRect().top }
      }
    }
    setDiffs((prev) => {
      const diff = prev[path]
      if (!diff) return prev
      const vis = diff.vis.slice()
      for (let k = Math.max(0, from); k < Math.min(vis.length, to); k++) vis[k] = true
      return { ...prev, [path]: { ...diff, vis } }
    })
  }, [diffs])
  useLayoutEffect(() => {
    const comp = compRef.current
    compRef.current = null
    const scroller = scrollRef.current
    if (!comp || !scroller) return
    const el = document.querySelector(comp.sel)
    if (el) scroller.scrollTop += el.getBoundingClientRect().top - comp.top
  }, [diffs])

  const focusN = useRef(0)
  useEffect(() => {
    if (!focus || focus.n === focusN.current) return
    focusN.current = focus.n
    const f = files.find((x) => x.path === focus.path) || files.find((x) => x.path.endsWith(`/${focus.path}`) || focus.path.endsWith(`/${x.path}`))
    if (!f) return
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.delete(f.path)
      return next
    })
    requestAnimationFrame(() => document.querySelector(`[data-change-path="${CSS.escape(f.path)}"]`)?.scrollIntoView({ block: 'nearest' }))
  }, [focus, files])

  const stats = (file: AggFile) => {
    const diff = diffs[file.path]
    return {
      added: diff?.addCount ?? file.added,
      removed: diff?.delCount ?? file.removed,
    }
  }
  const tot = files.reduce((a, f) => {
    const stat = stats(f)
    return { add: a.add + stat.added, rem: a.rem + stat.removed }
  }, { add: 0, rem: 0 })
  const allCollapsed = files.length > 0 && files.every((f) => collapsed.has(f.path))
  const displayPath = (path: string) => path.replace(/^\/home\/ubuntu\/repos\//, '').replace(/^\/home\/ubuntu\//, '').replace(/^\//, '')
  const statusFor = (file: AggFile) => {
    const action = (file.actionType || '').toLowerCase()
    if (action.includes('rename')) return { letter: 'R', color: 'text-[rgb(230,130,20)]' }
    if (action.includes('remove') || action.includes('delete')) return { letter: 'D', color: 'text-[rgb(245,59,58)]' }
    if (action.includes('add') || action.includes('create')) return { letter: 'A', color: 'text-[rgb(0,165,88)]' }
    return { letter: 'M', color: 'text-[rgb(230,130,20)]' }
  }
  type TreeNode = { name: string; path: string; folders: Map<string, TreeNode>; files: AggFile[] }
  const treeFiles = useMemo(() => {
    const query = treeQuery.trim().toLowerCase()
    return query ? files.filter((file) => displayPath(file.path).toLowerCase().includes(query)) : files
  }, [files, treeQuery])
  const treeRoot = useMemo(() => {
    const root: TreeNode = { name: '', path: '', folders: new Map(), files: [] }
    for (const file of treeFiles) {
      const shown = displayPath(file.path)
      const parts = shown.split('/').filter(Boolean)
      let node = root
      for (let i = 0; i < parts.length - 1; i++) {
        const partPath = node.path ? `${node.path}/${parts[i]}` : parts[i]
        let child = node.folders.get(parts[i])
        if (!child) {
          child = { name: parts[i], path: partPath, folders: new Map(), files: [] }
          node.folders.set(parts[i], child)
        }
        node = child
      }
      node.files.push(file)
    }
    return root
  }, [treeFiles])
  const flatTreeFiles = treeFiles.map((file) => ({ file, level: 1 }))
  const hasModifiedDescendant = (node: TreeNode): boolean =>
    node.files.some((file) => statusFor(file).letter === 'M' || statusFor(file).letter === 'R') ||
    [...node.folders.values()].some(hasModifiedDescendant)
  const treeRows = (node: TreeNode, level: number): ReactNode[] => {
    const rows: ReactNode[] = []
    for (const folder of [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const modified = hasModifiedDescendant(folder)
      const folderOpen = !closedFolders.has(folder.path)
      rows.push(
        <button key={`folder-${folder.path}`} type="button" role="treeitem" aria-level={level} aria-expanded={folderOpen} data-item-type="folder" data-item-path={folder.path}
          onClick={() => setClosedFolders((prev) => { const next = new Set(prev); folderOpen ? next.add(folder.path) : next.delete(folder.path); return next })}
          className="flex h-[22px] min-h-[22px] w-full cursor-pointer items-center gap-1 rounded-[5px] px-[3px] text-left text-[13px] leading-[22px] hover:bg-tint-secondary" style={{ paddingLeft: level * 5 + 3 }}>
          {folderOpen
            ? <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
            : <ChevronRight size={14} className="shrink-0 text-muted-foreground" />}
          <span className="min-w-0 flex-1 truncate">{folder.name}</span>
          {modified && <span className="size-1.5 shrink-0 rounded-[1px] bg-[rgb(230,130,20)]" />}
        </button>,
      )
      if (folderOpen) rows.push(...treeRows(folder, level + 1))
    }
    for (const file of [...node.files].sort((a, b) => displayPath(a.path).localeCompare(displayPath(b.path)))) {
      const shown = displayPath(file.path)
      const name = shown.split('/').pop() || shown
      const status = statusFor(file)
      rows.push(
        <button key={`file-${file.path}`} type="button" role="treeitem" aria-label={name} aria-level={level} data-item-parent-path={node.path} data-item-path={file.path} data-item-type="file" data-type="item" data-item-git-status={status.letter === 'M' ? 'modified' : status.letter === 'A' ? 'added' : status.letter === 'D' ? 'deleted' : 'renamed'} style={{ minHeight: 22, paddingLeft: level * 5 + 3 }} className="flex h-[22px] w-full items-center gap-1 rounded-[5px] px-[3px] text-left text-[13px] leading-[22px] text-foreground" onClick={() => { setCollapsed((prev) => { const next = new Set(prev); next.delete(file.path); return next }); requestAnimationFrame(() => document.querySelector(`[data-change-path="${CSS.escape(file.path)}"]`)?.scrollIntoView({ block: 'nearest' })) }}>
          <FileIcon path={name} size={16} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{name}</span>
          {(stats(file).added > 0 || stats(file).removed > 0) && (
            <span className="flex shrink-0 items-center gap-0.5 text-[11px] tabular-nums"><span className="text-[rgb(0,165,88)]">+{stats(file).added}</span><span className="text-[rgb(245,59,58)]">−{stats(file).removed}</span></span>
          )}
          <span title={t('chg.gitStatus', { s: t(status.letter === 'M' ? 'chg.gitModified' : status.letter === 'A' ? 'chg.gitAdded' : status.letter === 'D' ? 'chg.gitDeleted' : 'chg.gitRenamed') })} className={cn('w-[10px] shrink-0 text-center text-[12px] leading-[22px]', status.color)}>{status.letter}</span>
        </button>,
      )
    }
    return rows
  }
  const renderLegacy = () => (
    <div className="flex h-full min-h-0 flex-col">
      {!fileCardsOnly && (
        <div className="flex h-9 shrink-0 items-center gap-2 overflow-hidden border-b border-border pl-1 pr-2">
          <span className="pl-2 text-[13px] leading-[18px] font-medium">{t('chg.all')}</span>
          <span className="flex items-center gap-1.5 text-[12px] leading-[16px] tabular-nums text-muted-foreground">
            <span>{files.length} {t('chg.files', { count: files.length })}</span>
            {!viewMode && <><span className="text-text-green">+{tot.add}</span><span className="text-text-red">−{tot.rem}</span></>}
          </span>
        </div>
      )}
      {step && !embedded && <div className="flex items-center gap-2 px-3 py-1.5 text-[12px] leading-[16px] text-muted-foreground">{t('chg.fromStep')}<button onClick={onClearStep} aria-label={t('chg.showAll')} className="ml-auto flex size-5 cursor-pointer items-center justify-center rounded hover:bg-accent hover:text-foreground"><X size={12} /></button></div>}
      {files.length === 0 ? <div className="mx-2 mb-4 mt-1"><span className="text-[14px] leading-[20px] text-muted-foreground">{t('chg.none')}</span></div> : (
        <div className="flex flex-col divide-y divide-border">
          {files.map((f) => {
            const diff = diffs[f.path]
            return <div key={f.path} data-change-path={f.path}>
              <button onClick={() => toggleFile(f.path)} className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[13px] leading-[18px] hover:bg-muted">
                {collapsed.has(f.path) ? <ChevronRight size={12} className="shrink-0" /> : <ChevronDown size={12} className="shrink-0" />}
                <FileIcon path={f.path} size={14} className="shrink-0" />
                <span className="min-w-0 truncate text-[13px]">{f.path.split('/').pop() || f.path}</span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">{f.path.match(/\/repos\/([^/]+)/)?.[1]}</span>
                <span className="text-text-green">+{stats(f).added}</span><span className="text-text-red">−{stats(f).removed}</span>
              </button>
              {!collapsed.has(f.path) && (diff?.loading || !diff ? <div className="px-3 py-3"><Loader2 size={14} className="animate-spin text-muted-foreground" /></div> : viewMode ? <pre className="max-h-[60dvh] overflow-auto whitespace-pre-wrap break-words bg-muted/40 px-3 py-2 font-mono text-[12px] leading-[18px]">{diff.text || ''}</pre> : renderOfficialDiff(f))}
            </div>
          })}
        </div>
      )}
    </div>
  )
  if (viewMode || fileCardsOnly) return renderLegacy()
  function renderOfficialDiff(file: AggFile) {
    const diff = diffs[file.path]
    if (!diff || diff.loading) return <div className="px-3 py-3"><Loader2 size={14} className="animate-spin text-muted-foreground" /></div>
    return <FileDiffBody file={file} diff={diff} reveal={reveal} />
  }
  return (
    <div className="relative flex h-full min-h-0 @container/changes">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center gap-2 overflow-hidden border-b border-border-secondary pl-1 pr-2">
          <button
            ref={scopeButtonRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={scopeOpen}
            onClick={() => setScopeOpen((value) => !value)}
            className="flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-[6px] border border-transparent px-[10px] text-[13px] leading-[18px] font-medium text-foreground hover:bg-tint-secondary"
          >
            <span className="truncate">{scope === 'all' ? t('chg.all') : t('chg.lastTurn')}</span>
            <ChevronDown size={16} className="shrink-0 text-muted-foreground" />
          </button>
          <span className="flex items-center gap-1.5 text-[12px] leading-[16px] tabular-nums text-muted-foreground"><span>{files.length} {t('chg.files', { count: files.length })}</span><span className="text-[rgb(0,165,88)]">+{tot.add}</span><span className="text-[rgb(245,59,58)]">−{tot.rem}</span></span>
          <span className="ml-auto flex items-center gap-1">
            {treeHidden && <button type="button" aria-label={t('chg.showTree')} onClick={() => setTreeHidden(false)} className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground"><PanelLeft size={18} /></button>}
            {files.length > 0 && <button type="button" onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(files.map((f) => f.path)))} aria-label={allCollapsed ? t('chg.expandAllFiles') : t('chg.collapseAllFiles')} className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground"><ChevronsUpDown size={18} /></button>}
          </span>
        </div>
        {step && !embedded && <div className="flex items-center gap-2 px-3 py-1.5 text-[12px] leading-[16px] text-muted-foreground">{t('chg.fromStep')}<button onClick={onClearStep} aria-label={t('chg.showAll')} className="ml-auto flex size-5 cursor-pointer items-center justify-center rounded hover:bg-accent hover:text-foreground"><X size={12} /></button></div>}
        <div ref={scrollRef} tabIndex={-1} className="min-h-0 min-w-0 flex-1 overflow-y-auto outline-none">
          {files.length === 0 ? <div className="mx-2 mb-4 mt-1"><span className="text-[14px] leading-[20px] text-muted-foreground">{t('chg.none')}</span></div> : files.map((file) => {
            const bodyOpen = !collapsed.has(file.path)
            const name = file.path.split('/').pop() || file.path
            const repoLabel = file.path.match(/\/repos\/([^/]+)/)?.[1]
            return <div key={file.path} data-change-path={file.path} className="border-b border-border-secondary">
              <div className="sticky top-0 z-10 bg-background">
                <div role="presentation" onClick={() => toggleFile(file.path)} className="flex h-[42px] cursor-pointer select-none items-center gap-1.5 overflow-x-auto border-b border-border-secondary bg-wash px-2 py-1.5 pr-3 [scrollbar-width:none]">
                  <button type="button" aria-label={bodyOpen ? t('chg.collapseFile') : t('chg.expandFile')} onClick={(event) => { event.stopPropagation(); toggleFile(file.path) }} className="flex size-7 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground"><ChevronDown size={18} className={cn(!bodyOpen && '-rotate-90')} /></button>
                  <div className="flex min-w-10 flex-1 items-center gap-1.5 font-sans text-[13px]"><span className="flex min-w-0 items-center gap-1.5"><FileIcon path={name} size={15} className="shrink-0" /><span className="shrink select-text truncate whitespace-nowrap text-foreground">{name}</span>{repoLabel && <span className="shrink-[1000000] select-text truncate text-muted-foreground">{repoLabel}</span>}</span></div>
                  <button type="button" aria-label={t('chg.copyPath')} onClick={(event) => { event.stopPropagation(); navigator.clipboard.writeText(file.path).catch(() => {}) }} className="hidden size-7 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground sm:flex"><Copy size={18} /></button>
                  <div className="hidden shrink-0 gap-0.5 text-[12px] font-normal sm:flex"><span className="text-[rgb(0,165,88)]">+{stats(file).added}</span><span className="text-[rgb(245,59,58)]">−{stats(file).removed}</span></div>
                  <label title={t('chg.markViewed')} onClick={(event) => event.stopPropagation()} className="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-muted-foreground">
                    <input type="checkbox" checked={viewed.has(file.path)} onChange={() => toggleViewed(file.path)} className="size-3.5 cursor-pointer accent-[rgb(0,165,88)]" />
                    <span className="hidden sm:inline">{t('chg.viewed')}</span>
                  </label>
                  <button
                    type="button"
                    aria-label={t('chg.moreActions')}
                    aria-haspopup="menu"
                    onClick={(event) => {
                      event.stopPropagation()
                      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
                      setFileMenu({ path: file.path, left: rect.right - 180, top: rect.bottom + 4 })
                    }}
                    className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground"
                  >
                    <Ellipsis size={16} />
                  </button>
                </div>
              </div>
              {bodyOpen && renderOfficialDiff(file)}
            </div>
          })}
        </div>
      </div>
      {!treeHidden && <div className="hidden shrink-0 @[640px]/changes:block" style={{ width: 240, maxWidth: '60%', minWidth: 200 }}>
        <div className="flex h-full min-h-0 flex-col overflow-hidden border-l border-border-secondary">
          <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border-secondary px-1">
            <div className="flex h-7 min-w-0 flex-1 items-center rounded-[6px] border border-border-secondary"><Search size={16} className="ml-2 shrink-0 text-muted-foreground" /><input value={treeQuery} onChange={(event) => setTreeQuery(event.target.value)} placeholder={t('chg.searchFiles')} className="h-full min-w-0 flex-1 bg-transparent px-[6px] text-[13px] leading-[16px] outline-none placeholder:text-muted-foreground" /></div>
            <button type="button" aria-label={t('chg.viewTree')} aria-pressed={treeView} onClick={() => setTreeView((value) => !value)} className="flex size-7 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground hover:text-foreground aria-pressed:bg-tint-secondary aria-pressed:text-foreground"><FolderTree size={16} /></button>
            <button type="button" aria-label={t('chg.hideTree')} onClick={() => setTreeHidden(true)} className="flex size-7 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground"><PanelRight size={18} /></button>
          </div>
          <div role="tree" className="min-h-0 flex-1 overflow-y-auto px-1 pt-1">
            {treeView ? treeRows(treeRoot, 1) : flatTreeFiles.map(({ file, level }) => treeRows({ name: '', path: '', folders: new Map(), files: [file] }, level))}
          </div>
        </div>
      </div>}
      {fileMenu && createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={() => setFileMenu(null)} />
          <div role="menu" className="fixed z-50 flex w-[200px] flex-col overflow-hidden rounded-[10px] bg-white/[.94] p-1 text-foreground shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)] outline outline-1 outline-black/[.06] backdrop-blur-[8px] dark:bg-[#1f1f1f]/[.94]" style={{ left: fileMenu.left, top: fileMenu.top }}>
            <button type="button" role="menuitem" onClick={() => { navigator.clipboard.writeText(fileMenu.path).catch(() => {}); setFileMenu(null) }} className="flex cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] hover:bg-tint-secondary"><Copy size={14} className="shrink-0 text-muted-foreground" />{t('chg.copyPath')}</button>
            <button type="button" role="menuitem" onClick={() => { toggleViewed(fileMenu.path); setFileMenu(null) }} className="flex cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] hover:bg-tint-secondary"><Check size={14} className="shrink-0 text-muted-foreground" />{viewed.has(fileMenu.path) ? t('chg.unmarkViewed') : t('chg.markViewed')}</button>
          </div>
        </>,
        document.body,
      )}
      {scopeOpen && createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={() => setScopeOpen(false)} />
          <div
            ref={scopeMenuRef}
            role="menu"
            aria-orientation="vertical"
            className="fixed z-50 flex w-[220px] min-w-[220px] max-w-[calc(100vw-10px)] flex-col overflow-hidden rounded-[10px] bg-white/[.94] p-1 text-foreground shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)] outline outline-1 outline-black/[.06] backdrop-blur-[8px] dark:bg-[#1f1f1f]/[.94] dark:outline-white/[.06] dark:-outline-offset-1"
            style={{ left: scopeMenuPos.left, top: scopeMenuPos.top }}
          >
            <button
              type="button"
              role="menuitemradio"
              aria-checked={scope === 'all'}
              onClick={() => { setScope('all'); setScopeOpen(false) }}
              className="flex cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-[13px] leading-[18px] text-foreground hover:bg-tint-secondary"
            >
              <span className="mr-auto min-w-0">{t('chg.all')}</span>
              <span className="ml-auto flex items-center justify-center text-muted-foreground">{scope === 'all' && <Check size={16} />}</span>
            </button>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={scope === 'lastTurn'}
              onClick={() => { setScope('lastTurn'); setScopeOpen(false) }}
              className="flex cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-[13px] leading-[18px] text-foreground hover:bg-tint-secondary"
            >
              <span className="mr-auto min-w-0">
                <span className="flex flex-col">
                  <span>{t('chg.lastTurn')}</span>
                  <span className="text-[11px] leading-[14px] text-muted-foreground">{t('chg.since')}</span>
                </span>
              </span>
              <span className="ml-auto flex items-center justify-center text-muted-foreground">{scope === 'lastTurn' && <Check size={16} />}</span>
            </button>
          </div>
        </>,
        document.body,
      )}
    </div>
  )
}


/* Per-file diff body — official RenderDisplayItems shape: syntax-highlighted
 * rows (shiki dual-theme tokens, word-level diff emphasis on changed lines)
 * with collapsed regions expanding ±5 / All N (official EXPAND_STEP_LINES=5). */
function FileDiffBody({ file, diff, reveal }: { file: AggFile; diff: { lines: DiffLine[]; vis: boolean[]; text?: string; oldText?: string }; reveal: (path: string, from: number, to: number) => void }) {
  const { t } = useTranslation()
  const newToks = useShikiTokens(diff.text ?? '', file.path)
  const oldToks = useShikiTokens(diff.oldText ?? '', file.path)
  const wordSegments = useMemo(() => wordSegmentsForDiff(diff.lines), [diff.lines])
  const codeCell = (toks: Tok[] | undefined, segs: WordSeg[] | undefined, kind: 'del' | 'add' | 'same') => {
    if (segs) return <WordDiffLine segs={segs} kind={kind === 'same' ? 'add' : kind} />
    if (toks?.length) return toks.map((tk, j) => (
      <span key={j} className={tk.color || tk.darkColor ? 'text-[var(--shiki-light)] dark:text-[var(--shiki-dark)]' : undefined} style={tk.color || tk.darkColor ? ({ '--shiki-light': tk.color, '--shiki-dark': tk.darkColor } as React.CSSProperties) : undefined}>{tk.content}</span>
    ))
    return null
  }
  let oldNo = 1
  let newNo = 1
  const numbered = diff.lines.map((line) => {
    const row = { line, oldNo: line.type === 'add' ? null : oldNo, newNo: line.type === 'del' ? null : newNo }
    if (line.type !== 'add') oldNo++
    if (line.type !== 'del') newNo++
    return row
  })
  const rows: ReactNode[] = []
  let i = 0
  while (i < numbered.length) {
    if (diff.vis[i]) {
      const { line, oldNo: oldLine, newNo: newLine } = numbered[i]
      const rowBg = line.type === 'del' ? 'bg-tint-red' : line.type === 'add' ? 'bg-tint-green' : 'bg-elevated'
      const toks = line.type === 'del' ? oldToks?.[(oldLine ?? 1) - 1] : newToks?.[(newLine ?? 1) - 1]
      rows.push(
        <div key={`line-${i}`} className="group/line col-span-2 grid grid-cols-subgrid font-mono text-[11px] !leading-[18px] sm:text-[12px] sm:!leading-[20px]" data-line-number={newLine ?? oldLine ?? undefined}>
          <div className={cn('relative flex select-none items-start justify-end border-r border-r-border pl-[2ch] pr-[1ch]', rowBg, line.type !== 'same' && 'before:absolute before:left-0 before:top-0 before:h-full before:w-[3px]', line.type === 'del' && 'before:bg-[rgb(245,59,58)]', line.type === 'add' && 'before:bg-[rgb(0,165,88)]')}>
            <div className={cn('text-[11px]', line.type === 'same' ? 'text-muted-foreground' : 'text-foreground')}>{line.type === 'del' ? oldLine : newLine}</div>
            <span className="h-[16px] sm:h-[20px]" />
          </div>
          <div className={cn('line-content relative', rowBg)}>
            <div className="relative z-[1] whitespace-break-spaces break-all px-2 text-foreground [overflow-wrap:anywhere] cursor-text">
              <code className="select-text break-all">{codeCell(toks, wordSegments.get(i), line.type) ?? line.text}</code>
            </div>
          </div>
        </div>,
      )
      i++
    } else {
      const start = i
      while (i < numbered.length && !diff.vis[i]) i++
      const len = i - start
      // Official collapsed region (RenderDisplayItems): [↑ N lines | All N
      // lines | ↓ N lines], N=5 (EXPAND_STEP), step buttons only when the gap
      // is ≥10 lines. "Above" grows the upper region downward (reveals the
      // gap's TOP lines, scroll-compensated); "below" grows the lower region
      // upward (reveals the gap's BOTTOM lines).
      rows.push(
        <div key={`gap-${start}`} data-collapsed-region={start} data-find-exclude="" className="group col-span-2 grid grid-cols-subgrid bg-tint-blue">
          <div className="col-span-2 select-none py-2">
            <div className="flex items-center pl-[2ch] text-[12px]">
              <span className="inline-flex items-center gap-3.5 text-[12px]">
                {len >= 10 && <button type="button" aria-label={t('chg.expandAbove', { n: Math.min(5, len) })} onClick={() => reveal(file.path, start, start + 5)} className="inline-flex cursor-pointer items-center gap-1 text-[rgba(13,133,185,0.85)] dark:text-blue-400"><ChevronUp size={12} />{t('chg.nLines', { n: 5 })}</button>}
                <button type="button" aria-label={t('chg.expandAll', { n: len })} onClick={() => reveal(file.path, start, i)} className="inline-flex cursor-pointer items-center gap-1 text-[rgba(13,133,185,0.85)] dark:text-blue-400"><ChevronsUpDown size={12} />{t('chg.allLines', { n: len })}</button>
                {len >= 10 && <button type="button" aria-label={t('chg.expandBelow', { n: Math.min(5, len) })} onClick={() => reveal(file.path, i - 5, i)} className="inline-flex cursor-pointer items-center gap-1 text-[rgba(13,133,185,0.85)] dark:text-blue-400"><ChevronDown size={12} />{t('chg.nLines', { n: 5 })}</button>}
              </span>
            </div>
          </div>
        </div>,
      )
    }
  }
  return <div className="overflow-hidden border-0 bg-elevated"><div data-diff-table="true" className="grid w-full grid-cols-[min-content_1fr]">{rows}</div></div>
}

export { type AggFile, type SessionChangesResponse, aggregateFiles, initialVisible, wordSegmentsForDiff, ChangesPanel };
