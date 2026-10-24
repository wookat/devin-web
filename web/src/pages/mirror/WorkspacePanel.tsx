import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, FileCode, ChevronFirst, ChevronLast } from 'lucide-react'
import { adminFetch } from '@/lib/api'
import { OChevronDown, OChevronRight, OSearch, OX } from '@/components/officialIcons'
import { cn } from '@/lib/utils'
import { type WsEntry, type FileResp, base, parentOf, kindOf, EDITABLE, gitCls, gitTitle, TypeIcon, type MenuPos, type CtxItem, CtxMenu } from './WsShared'
import { Viewer } from './WorkspaceViewers'
import { copyText } from '../../lib/clipboard'

function EditorPanel({ id }: { id: string }) {
  const { t } = useTranslation()
  const [link, setLink] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    adminFetch<{ data: { link?: string } | null; error: string | null }>(`/api/admin/session/${id}/editor`, { method: 'POST' })
      .then((r) => {
        if (!alive) return
        if (r.data?.link) setLink(r.data.link)
        else setErr(r.error || 'no link')
      })
      .catch((e) => { if (alive) setErr((e as Error).message) })
    return () => { alive = false }
  }, [id])

  if (err) return <div className="p-3 text-[13px] text-red-500">{err}</div>
  if (!link) return <div className="p-3 text-[13px] text-muted-foreground">{t('ws.loadingEditor')}</div>
  return <iframe src={link} title={t('tabs.editor')} className="h-full w-full border-0" allow="clipboard-read; clipboard-write" />
}

// ---------------------------------------------------------------------------
// Official-style editor: tabs + editable viewers on the left, REPOS tree right
// ---------------------------------------------------------------------------

/* Persist tabs/tree across panel switches; also draft edits so a tab switch
   never loses unsaved text. */
interface Sess { tabs: string[]; active: string | null; expanded: Record<string, boolean>; filter: string; drafts: Record<string, string>; treeCollapsed?: boolean }
const mem = new Map<string, Sess>()

function WorkspacePanel({ id }: { id: string }) {
  const { t } = useTranslation()
  const saved = mem.get(id)
  const [tabs, setTabs] = useState<string[]>(saved?.tabs ?? [])
  const [active, setActive] = useState<string | null>(saved?.active ?? null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>(saved?.expanded ?? {})
  const [filter, setFilter] = useState(saved?.filter ?? '')
  const [dirs, setDirs] = useState<Record<string, { entries: WsEntry[] } | 'loading' | 'error'>>({})
  const [cwd, setCwd] = useState('')
  const [files, setFiles] = useState<Record<string, FileResp>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>(saved?.drafts ?? {})
  const [renaming, setRenaming] = useState<string | null>(null)
  const [treeCollapsed, setTreeCollapsed] = useState(saved?.treeCollapsed ?? false)
  const [ctxMenu, setCtxMenu] = useState<{ pos: MenuPos; node: Node | null } | null>(null)
  const [tabMenu, setTabMenu] = useState<{ pos: MenuPos; path: string } | null>(null)
  const [dragTab, setDragTab] = useState<string | null>(null)
  const [dropDir, setDropDir] = useState<string | null>(null)
  const [gitMap, setGitMap] = useState<Record<string, string>>({})
  const stripRef = useRef<HTMLDivElement>(null)

  useEffect(() => { mem.set(id, { tabs, active, expanded, filter, drafts, treeCollapsed }) }, [id, tabs, active, expanded, filter, drafts, treeCollapsed])

  const loadDir = useCallback(async (p: string, force = false) => {
    if (!force && dirs[p] === 'loading') return
    setDirs((d) => ({ ...d, [p]: 'loading' }))
    try {
      const r = await adminFetch<{ cwd: string; path: string; entries: WsEntry[]; error: string | null }>(
        `/api/admin/session/${id}/files?path=${encodeURIComponent(p)}&all=1`)
      setCwd(r.cwd)
      const entries = [...(r.entries ?? [])].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
      setDirs((d) => ({ ...d, [p]: { entries } }))
    } catch { setDirs((d) => ({ ...d, [p]: 'error' })) }
  }, [id, dirs])

  useEffect(() => { if (!dirs['']) void loadDir('') }, [dirs, loadDir])

  useEffect(() => {
    let dead = false
    const pull = () => adminFetch<{ git?: boolean; map?: Record<string, string> }>(`/api/admin/session/${id}/file-git`)
      .then((r) => { if (!dead && r.git) setGitMap(r.map ?? {}) })
      .catch(() => {})
    void pull()
    const t = setInterval(pull, 15000)
    return () => { dead = true; clearInterval(t) }
  }, [id])

  const openFile = useCallback(async (p: string, force = false) => {
    if (!force) setFiles((f) => ({ ...f, [p]: { path: p, text: null } }))
    try {
      const r = await adminFetch<FileResp>(`/api/admin/session/${id}/file?path=${encodeURIComponent(p)}`)
      setFiles((f) => ({ ...f, [p]: r }))
    } catch (e) { setFiles((f) => ({ ...f, [p]: { path: p, text: null, error: (e as Error).message } })) }
  }, [id])

  const open = useCallback((p: string) => {
    setTabs((t) => (t.includes(p) ? t : [...t, p]))
    setActive(p)
    if (EDITABLE[kindOf(p)] && !files[p]) void openFile(p)
  }, [files, openFile])

  const toggleDir = useCallback((p: string) => {
    setExpanded((x) => {
      const isOpen = !x[p]
      if (isOpen && !dirs[p]) void loadDir(p)
      return { ...x, [p]: isOpen }
    })
  }, [dirs, loadDir])

  const closeTab = useCallback((p: string) => {
    setTabs((t) => {
      const i = t.indexOf(p)
      const next = t.filter((x) => x !== p)
      setActive((a) => (a === p ? next[Math.min(i, next.length - 1)] ?? null : a))
      return next
    })
  }, [])
  const closeOthers = (p: string) => { setTabs([p]); setActive(p) }
  const closeSide = (p: string, side: 'left' | 'right') => setTabs((t) => {
    const i = t.indexOf(p)
    const next = side === 'left' ? t.slice(i) : t.slice(0, i + 1)
    if (active && !next.includes(active)) setActive(next[next.length - 1] ?? null)
    return next
  })

  /* file ops */
  const op = useCallback(async (o: string, path: string, to?: string) => {
    let r: { ok?: boolean; error?: string }
    try {
      r = await adminFetch<{ ok?: boolean; error?: string }>(`/api/admin/session/${id}/file-ops`, { method: 'POST', body: JSON.stringify({ op: o, path, to }) })
    } catch (e) {
      window.alert(`${t('ws.opFail')}${(e as Error).message}`)
      return (e as Error).message
    }
    if (r.error) { window.alert(`${t('ws.opFail')}${r.error}`); return r.error }
    // refresh affected dirs
    const ps = new Set([parentOf(path), to ? parentOf(to) : '', to ?? ''])
    for (const p of ps) if (p === '' || dirs[p]) void loadDir(p, true)
    if (o === 'rename' || o === 'move' || o === 'delete') {
      const np = o === 'delete' ? null : (o === 'move' ? `${to}/${base(path)}` : to!)
      setFiles((f) => { const n = { ...f }; delete n[path]; if (np && f[path]) n[np] = { ...f[path], path: np }; return n })
      setTabs((t) => t.map((x) => (x === path ? np! : x)))
      setActive((a) => (a === path ? np : a))
      if (o === 'delete') { setTabs((t) => t.filter((x) => x !== path)); setActive((a) => (a === path ? null : a)) }
    }
    return null
  }, [id, dirs, loadDir, active])

  const saveFile = useCallback(async (p: string, text: string) => {
    try {
      const r = await adminFetch<{ ok?: boolean; error?: string }>(`/api/admin/session/${id}/file-write`, { method: 'POST', body: JSON.stringify({ path: p, text }) })
      if (!r.error) {
        setDrafts((d) => { const n = { ...d }; delete n[p]; return n })
        void openFile(p, true)
        return null
      }
      window.alert(`${t('ws.saveFail')}${r.error}`)
      return r.error
    } catch (e) { window.alert(`${t('ws.saveFail')}${(e as Error).message}`); return (e as Error).message }
  }, [id, openFile])

  const saveBinary = useCallback(async (p: string, buf: ArrayBuffer | Blob) => {
    try {
      const b = buf instanceof Blob ? await buf.arrayBuffer() : buf
      let bin = ''
      const bytes = new Uint8Array(b)
      for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192))
      const r = await adminFetch<{ ok?: boolean; error?: string }>(`/api/admin/session/${id}/file-write`, { method: 'POST', body: JSON.stringify({ path: p, base64: btoa(bin) }) })
      if (r.error) window.alert(`${t('ws.saveFail')}${r.error}`)
      return r.error ?? null
    } catch (e) { window.alert(`${t('ws.saveFail')}${(e as Error).message}`); return (e as Error).message }
  }, [id])

  /* -------- tree -------- */
  interface Node { entry: WsEntry; path: string }
  const buildNodes = useCallback((p: string): Node[] => {
    const d = dirs[p]
    if (!d || d === 'loading' || d === 'error') return []
    return d.entries.map((e) => ({ entry: e, path: p ? `${p}/${e.name}` : e.name }))
  }, [dirs])
  const matches = useCallback((n: Node, qq: string): boolean => {
    if (n.entry.name.toLowerCase().includes(qq)) return true
    if (!n.entry.dir || !expanded[n.path]) return false
    return buildNodes(n.path).some((k) => matches(k, qq))
  }, [buildNodes, expanded])

  const [dragNode, setDragNode] = useState<string | null>(null)
  const q = filter.trim().toLowerCase()
  const renderNode = (n: Node, depth: number): React.ReactNode => {
    if (q && !matches(n, q)) return null
    const isOpen = !!expanded[n.path]
    const kids = n.entry.dir && isOpen ? buildNodes(n.path) : []
    return (
      <div key={n.path}>
        <div
          role="button"
          tabIndex={0}
          draggable={renaming !== n.path}
          onDragStart={(e) => { setDragNode(n.path); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/x-dw-path', n.path) }}
          onDragEnd={() => { setDragNode(null); setDropDir(null) }}
          onDragOver={n.entry.dir ? (e) => { e.preventDefault(); e.stopPropagation(); setDropDir(n.path) } : undefined}
          onDragLeave={n.entry.dir ? () => setDropDir((d) => (d === n.path ? null : d)) : undefined}
          onDrop={n.entry.dir ? (e) => {
            e.preventDefault(); e.stopPropagation(); setDropDir(null)
            const src = dragNode
            setDragNode(null)
            if (src && src !== n.path && parentOf(src) !== n.path) void op('move', src, n.path)
          } : undefined}
          onClick={() => { if (renaming === n.path) return; n.entry.dir ? toggleDir(n.path) : open(n.path) }}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtxMenu({ pos: { x: e.clientX, y: e.clientY }, node: n }) }}
          className={cn(
            'flex h-[26px] w-full cursor-pointer select-none items-center gap-1 rounded-[4px] pr-1 text-left text-[13px] leading-[18px] hover:bg-tint-secondary',
            active === n.path && 'bg-tint-secondary text-foreground',
            dropDir === n.path && 'bg-accent-fill/15 outline-1 outline-accent-primary',
            dragNode === n.path && 'opacity-50',
          )}
          style={{ paddingLeft: 6 + depth * 14 }}
        >
          {n.entry.dir
            ? <span className="flex size-4 items-center justify-center text-muted-foreground">{isOpen ? <OChevronDown size={12} /> : <OChevronRight size={12} />}</span>
            : <span className="size-4 shrink-0" />}
          <TypeIcon path={n.path} dir={n.entry.dir} />
          {renaming === n.path ? (
            <input
              autoFocus
              defaultValue={n.entry.name}
              className="min-w-0 flex-1 rounded-[3px] border border-accent-primary bg-background px-1 text-[13px] outline-none"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { const v = (e.target as HTMLInputElement).value.trim(); setRenaming(null); if (v && v !== n.entry.name) void op('rename', n.path, parentOf(n.path) ? `${parentOf(n.path)}/${v}` : v) }
                if (e.key === 'Escape') setRenaming(null)
              }}
              onBlur={(e) => { const v = e.target.value.trim(); setRenaming(null); if (v && v !== n.entry.name) void op('rename', n.path, parentOf(n.path) ? `${parentOf(n.path)}/${v}` : v) }}
            />
          ) : <span className={cn('min-w-0 flex-1 truncate', gitCls(gitMap[n.path]))}>{n.entry.name}</span>}
          {!n.entry.dir && gitMap[n.path] && (
            <span className={cn('ml-1 shrink-0 text-[10px] font-medium', gitCls(gitMap[n.path]))} title={gitTitle(t, gitMap[n.path])}>{gitMap[n.path]}</span>
          )}
        </div>
        {n.entry.dir && isOpen && (
          <div>
            {dirs[n.path] === 'loading' && <div className="py-0.5 text-[12px] text-muted-foreground" style={{ paddingLeft: 6 + (depth + 1) * 14 }}>{t('common.loading')}</div>}
            {kids.map((k) => renderNode(k, depth + 1))}
          </div>
        )}
      </div>
    )
  }

  const nodeMenuItems = (n: Node | null): (CtxItem | null)[] => {
    const dirPath = n ? (n.entry.dir ? n.path : parentOf(n.path)) : ''
    return [
      { label: t('ws.newFile'), onClick: () => { const v = window.prompt(t('ws.fileName'), 'new-file.txt'); if (v) void op('newfile', dirPath ? `${dirPath}/${v}` : v).then(() => open(dirPath ? `${dirPath}/${v}` : v)) } },
      { label: t('ws.newFolder'), onClick: () => { const v = window.prompt(t('ws.folderName'), 'new-folder'); if (v) void op('mkdir', dirPath ? `${dirPath}/${v}` : v) } },
      n ? { sep: true, label: '' } : null,
      n ? { label: t('ws.rename'), onClick: () => setRenaming(n.path) } : null,
      n ? { label: t('ws.copy'), onClick: () => { const v = window.prompt(t('ws.copyTo'), `${n.path}.copy`); if (v) void op('copy', n.path, v) } } : null,
      n ? { label: t('ws.delete'), danger: true, onClick: () => { if (window.confirm(`${t('ws.delConfirm')}${n.entry.name}?`)) void op('delete', n.path) } } : null,
      n ? { sep: true, label: '' } : null,
      n ? { label: t('ws.copyPath'), onClick: () => void copyText(cwd ? `${cwd}/${n.path}` : n.path) } : null,
      n ? { label: t('ws.copyRelPath'), onClick: () => void copyText(n.path) } : null,
      n ? { label: t('ws.copyName'), onClick: () => void copyText(n.entry.name) } : null,
    ]
  }

  const tabMenuItems = (p: string): CtxItem[] => [
    { label: t('common.close'), onClick: () => closeTab(p) },
    { label: t('tabs.closeOthers'), onClick: () => closeOthers(p) },
    { label: t('tabs.closeLeft'), onClick: () => closeSide(p, 'left') },
    { label: t('tabs.closeRight'), onClick: () => closeSide(p, 'right') },
    { sep: true, label: '' },
    { label: t('ws.copyPath'), onClick: () => void copyText(cwd ? `${cwd}/${p}` : p) },
    { label: t('ws.copyRelPath'), onClick: () => void copyText(p) },
    { label: t('tabs.revealInTree'), onClick: () => { const parts = parentOf(p).split('/'); let acc = ''; setExpanded((x) => { const n = { ...x }; for (const s of parts) { if (!s) continue; acc = acc ? `${acc}/${s}` : s; n[acc] = true } return n }) } },
  ]

  const rawUrl = (p: string) => `/api/admin/session/${id}/file-raw?path=${encodeURIComponent(p)}`
  const dirty = (p: string) => drafts[p] !== undefined

  return (
    <div className="flex h-full min-h-0">
      {/* left: tab strip + breadcrumb + viewer */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div
          ref={stripRef}
          className="flex h-[36px] shrink-0 items-stretch gap-0 overflow-x-auto overflow-y-hidden border-b border-border bg-transparent [scrollbar-width:thin]"
          onWheel={(e) => { if (stripRef.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) stripRef.current.scrollLeft += e.deltaY }}
          onDragOver={(e) => { if (dragTab) { e.preventDefault(); e.dataTransfer.dropEffect = 'move' } }}
          onDrop={(e) => { e.preventDefault(); if (dragTab) { setTabs((t) => t.filter((x) => x !== dragTab).concat(dragTab)); setDragTab(null) } }}
        >
          {tabs.map((p) => {
            const isActive = active === p
            return (
              <div
                key={p}
                role="tab"
                aria-selected={isActive}
                draggable
                onDragStart={(e) => { setDragTab(p); e.dataTransfer.effectAllowed = 'move' }}
                onDragOver={(e) => { e.preventDefault(); if (dragTab && dragTab !== p) e.dataTransfer.dropEffect = 'move' }}
                onDrop={(e) => { e.preventDefault(); if (dragTab && dragTab !== p) setTabs((t) => { const a = t.indexOf(dragTab), b = t.indexOf(p); const n = t.filter((x) => x !== dragTab); n.splice(b > a ? b - 1 : b, 0, dragTab); return n }) }}
                onDragEnd={() => setDragTab(null)}
                onClick={() => setActive(p)}
                onAuxClick={(e) => { if (e.button === 1) closeTab(p) }}
                onContextMenu={(e) => { e.preventDefault(); setTabMenu({ pos: { x: e.clientX, y: e.clientY }, path: p }) }}
                className={cn(
                  'group relative flex max-w-[180px] shrink-0 cursor-pointer select-none items-center gap-1.5 border-r border-border px-3 text-[12px]',
                  isActive ? 'bg-background text-foreground shadow-[inset_0_2px_0_0_var(--color-accent-primary,#317cff)]' : 'text-muted-foreground hover:bg-tint-secondary',
                  dragTab === p && 'opacity-50',
                )}
                title={p}
              >
                {/* icon: file glyph normally; × on hover or when active (official rule) */}
                <span className={cn('relative flex size-4 items-center justify-center', isActive && 'hidden')}>
                  <TypeIcon path={p} size={13} />
                  <span
                    role="button" aria-label={t('common.close')}
                    className="absolute inset-0 hidden items-center justify-center rounded-[3px] bg-transparent group-hover:flex hover:bg-border/60"
                    onClick={(e) => { e.stopPropagation(); closeTab(p) }}
                  ><OX size={11} /></span>
                </span>
                {isActive && (
                  <span
                    role="button" aria-label={t('common.close')}
                    className="flex size-4 items-center justify-center rounded-[3px] hover:bg-border/60"
                    onClick={(e) => { e.stopPropagation(); closeTab(p) }}
                  >{dirty(p) ? <span className="size-2 rounded-full bg-amber-500" /> : <OX size={12} />}</span>
                )}
                <span className="min-w-0 truncate">{base(p)}{dirty(p) && !isActive ? ' ●' : ''}</span>
              </div>
            )
          })}
        </div>
        {active && (
          <div className="flex h-6 shrink-0 items-center gap-1 border-b border-border bg-transparent px-3 text-[11px] text-muted-foreground">
            <TypeIcon path={active} size={11} />
            {active.split('/').map((seg, i, arr) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <OChevronRight size={9} className="opacity-60" />}
                <button
                  className="cursor-pointer rounded px-0.5 hover:bg-tint-secondary hover:text-foreground"
                  title={arr.slice(0, i + 1).join('/')}
                  onClick={() => void copyText(arr.slice(0, i + 1).join('/'))}
                >{seg}</button>
              </span>
            ))}
            {dirty(active) && <span className="ml-1 text-amber-600">● {t('ws.unsaved')}</span>}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto bg-background">
          {active ? (
            <Viewer
              key={active}
              id={id}
              path={active}
              file={files[active]}
              rawUrl={rawUrl}
              draft={drafts[active]}
              onDraft={(t) => setDrafts((d) => ({ ...d, [active]: t }))}
              onDiscard={() => setDrafts((d) => { const n = { ...d }; delete n[active]; return n })}
              onSaveText={saveFile}
              onSaveBinary={saveBinary}
              onRetry={() => void openFile(active, true)}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
              <FileCode size={28} className="opacity-40" />
              <div className="text-[13px]">{t('ws.selectFile')}</div>
            </div>
          )}
        </div>
      </div>
      {/* right: REPOS tree — collapsible like VS Code's sidebar */}
      {treeCollapsed ? (
        <button onClick={() => setTreeCollapsed(false)} title={t('ws.showTree')} aria-label={t('ws.showTree')}
          className="flex w-7 shrink-0 cursor-pointer flex-col items-center gap-2 border-l border-border bg-card pt-2 text-muted-foreground hover:text-foreground">
          <ChevronFirst size={13} />
          <span className="text-[10px] tracking-wide [writing-mode:vertical-rl]">{t('ws.repos')}</span>
        </button>
      ) : (
      <div className="flex w-[240px] shrink-0 flex-col border-l border-border bg-card">
        <div className="flex h-[36px] shrink-0 items-center justify-between border-b border-border px-2.5">
          <span className="text-[11px] font-medium tracking-wide text-muted-foreground">{t('ws.repos')}</span>
          <div className="flex items-center">
            <button className="flex size-6 cursor-pointer items-center justify-center rounded-[4px] text-muted-foreground hover:bg-tint-secondary" aria-label={t('common.refresh')} title={t('common.refresh')}
              onClick={() => { setDirs({}); void loadDir('', true) }}><RefreshCw size={12} /></button>
            <button className="flex size-6 cursor-pointer items-center justify-center rounded-[4px] text-muted-foreground hover:bg-tint-secondary" aria-label={t('ws.hideTree')} title={t('ws.hideTree')}
              onClick={() => setTreeCollapsed(true)}><ChevronLast size={13} /></button>
          </div>
        </div>
        <div className="shrink-0 border-b border-border p-2">
          <div className="flex h-7 items-center gap-1.5 rounded-[6px] border border-border bg-background px-2">
            <OSearch size={13} className="shrink-0 text-muted-foreground" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('ws.filterFiles')}
              className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>
        <div
          className="min-h-0 flex-1 overflow-auto p-1"
          onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ pos: { x: e.clientX, y: e.clientY }, node: null }) }}
          onDragOver={(e) => { if (dragNode) { e.preventDefault(); e.dataTransfer.dropEffect = 'move' } }}
          onDrop={(e) => {
            e.preventDefault()
            const src = dragNode
            setDragNode(null); setDropDir(null)
            if (src && parentOf(src)) void op('move', src, '.')
          }}
        >
          <div className="flex h-[26px] items-center gap-1 px-1.5 text-[13px] font-medium">
            <TypeIcon path="" dir size={14} />
            <span className="min-w-0 flex-1 truncate">{cwd ? cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : 'workspace'}</span>
          </div>
          {dirs[''] === 'loading' && <div className="px-2 py-1 text-[12px] text-muted-foreground">{t('common.loading')}</div>}
          {dirs[''] === 'error' && <div className="px-2 py-1 text-[12px] text-red-500">{t('ws.loadFail')}</div>}
          {dirs[''] !== 'loading' && dirs[''] !== 'error' && dirs[''] && buildNodes('').map((n) => renderNode(n, 0))}
        </div>
      </div>
      )}
      {ctxMenu && <CtxMenu pos={ctxMenu.pos} items={nodeMenuItems(ctxMenu.node)} onClose={() => setCtxMenu(null)} />}
      {tabMenu && <CtxMenu pos={tabMenu.pos} items={tabMenuItems(tabMenu.path)} onClose={() => setTabMenu(null)} />}
    </div>
  )
}

export { EditorPanel, type WsEntry, WorkspacePanel, CtxMenu, type CtxItem, type MenuPos };
export { CodeEditor } from './WorkspaceViewers'
