import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, Folder as FolderIcon, FileCode, FileText, FileSpreadsheet, FileImage, FileVideo, FileAudio, FileArchive, FileWarning, Save, ZoomIn, ZoomOut, Maximize, Crop as CropIcon, Square, Type, Undo2 } from 'lucide-react'
import { adminFetch } from '@/lib/api'
import CodeView from '@/components/CodeView'
import Markdown from '@/components/Markdown'
import { OChevronDown, OChevronRight, OSearch, OX } from '@/components/officialIcons'
import { cn } from '@/lib/utils'

function EditorPanel({ id }: { id: string }) {
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
  if (!link) return <div className="p-3 text-[13px] text-muted-foreground">Loading editor…</div>
  return <iframe src={link} title="Editor" className="h-full w-full border-0" allow="clipboard-read; clipboard-write" />
}

// ---------------------------------------------------------------------------
// Official-style editor: tabs + editable viewers on the left, REPOS tree right
// ---------------------------------------------------------------------------

interface WsEntry { name: string; dir: boolean; size: number; mtime: string }
interface FileResp { path: string; text: string | null; binary?: boolean; tooLarge?: boolean; size?: number; truncated?: boolean; error?: string }

const ext = (p: string) => (p.split('/').pop() ?? '').split('.').pop()?.toLowerCase() ?? ''
const base = (p: string) => p.split('/').pop() ?? p
const parentOf = (p: string) => p.split('/').slice(0, -1).join('/')
type Kind = 'image' | 'pdf' | 'av' | 'md' | 'html' | 'docx' | 'xlsx' | 'csv' | 'text' | 'bin'
const KINDS: Record<string, Kind> = {}
for (const e of 'png jpg jpeg gif webp ico bmp avif'.split(' ')) KINDS[e] = 'image'
for (const e of 'mp4 webm mov mkv avi mp3 wav ogg m4a flac aac'.split(' ')) KINDS[e] = 'av'
for (const e of 'md markdown mdx'.split(' ')) KINDS[e] = 'md'
for (const e of 'html htm svg'.split(' ')) KINDS[e] = 'html'
KINDS.pdf = 'pdf'
KINDS.docx = 'docx'
for (const e of 'xlsx xls'.split(' ')) KINDS[e] = 'xlsx'
KINDS.csv = 'csv'
const TEXT_EXTS = new Set('txt log js jsx mjs cjs ts tsx py json css scss less sass sh bash zsh ps1 bat cmd yml yaml toml ini cfg conf env sql go rs java c h cc cpp cxx hpp cs rb php swift kt kts lua r pl pm scala clj ex exs erl hs ml fs vb dockerfile makefile mk cmake gradle xml xsl vue svelte diff patch properties gitignore lock thrift proto graphql tf hcl dart zig nim sol asm tex bib'.split(' '))
const kindOf = (p: string): Kind => KINDS[ext(p)] ?? (TEXT_EXTS.has(ext(p)) ? 'text' : 'bin')
/** kinds backed by a text payload and therefore editable */
const EDITABLE: Record<Kind, boolean> = { image: false, pdf: false, av: false, md: true, html: true, docx: false, xlsx: true, csv: true, text: true, bin: false }

/* git status letter → VSCode-ish tint */
function gitCls(s?: string) {
  if (!s) return 'text-muted-foreground'
  if (s === 'M') return 'text-[#b58900]'
  if (s === 'U' || s === 'A') return 'text-[#28a745]'
  if (s === 'D') return 'text-red-500'
  return 'text-blue-500'
}
function gitTitle(s?: string) {
  return ({ M: '已修改', U: '未跟踪', A: '已暂存', D: '已删除', R: '已重命名', C: '已复制' } as Record<string, string>)[s ?? ''] ?? s
}

function TypeIcon({ path, dir, size = 14, className }: { path: string; dir?: boolean; size?: number; className?: string }) {
  const cls = cn('shrink-0', className)
  if (dir) return <FolderIcon size={size} className={cn(cls, 'text-muted-foreground')} />
  const e = ext(path)
  if (KINDS[e] === 'image') return <FileImage size={size} className={cn(cls, 'text-purple-500')} />
  if (e === 'pdf') return <FileText size={size} className={cn(cls, 'text-red-500')} />
  if (e === 'docx' || e === 'doc') return <FileText size={size} className={cn(cls, 'text-blue-500')} />
  if (KINDS[e] === 'xlsx' || e === 'csv') return <FileSpreadsheet size={size} className={cn(cls, 'text-green-600')} />
  if (KINDS[e] === 'av') return e.match(/mp3|wav|ogg|m4a|flac|aac/) ? <FileAudio size={size} className={cn(cls, 'text-pink-500')} /> : <FileVideo size={size} className={cn(cls, 'text-pink-500')} />
  if (e === 'zip' || e === 'tar' || e === 'gz' || e === '7z' || e === 'rar') return <FileArchive size={size} className={cn(cls, 'text-amber-600')} />
  if (e === 'md' || e === 'markdown' || e === 'txt' || e === 'log') return <FileText size={size} className={cn(cls, 'text-muted-foreground')} />
  return <FileCode size={size} className={cn(cls, e === 'html' || e === 'htm' ? 'text-orange-500' : e === 'css' ? 'text-sky-500' : e === 'js' || e === 'jsx' ? 'text-yellow-500' : e === 'ts' || e === 'tsx' ? 'text-blue-500' : e === 'json' ? 'text-slate-500' : 'text-teal-600')} />
}

/* Persist tabs/tree across panel switches; also draft edits so a tab switch
   never loses unsaved text. */
interface Sess { tabs: string[]; active: string | null; expanded: Record<string, boolean>; filter: string; drafts: Record<string, string> }
const mem = new Map<string, Sess>()

interface MenuPos { x: number; y: number }
interface CtxItem { label: string; danger?: boolean; sep?: boolean; onClick?: () => void }

function CtxMenu({ pos, items, onClose }: { pos: MenuPos; items: (CtxItem | null)[]; onClose: () => void }) {
  useEffect(() => {
    const h = () => onClose()
    window.addEventListener('mousedown', h)
    window.addEventListener('blur', h)
    return () => { window.removeEventListener('mousedown', h); window.removeEventListener('blur', h) }
  }, [onClose])
  const x = Math.min(pos.x, window.innerWidth - 190)
  const y = Math.min(pos.y, window.innerHeight - items.length * 32 - 12)
  return (
    <div
      className="fixed z-[80] min-w-[176px] rounded-[10px] border border-border/60 bg-white/95 p-1 shadow-lg backdrop-blur-md"
      style={{ left: x, top: y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.filter(Boolean).map((it, i) => it!.sep ? (
        <div key={i} className="mx-2 my-1 h-px bg-border/60" />
      ) : (
        <button key={i} onClick={() => { it!.onClick?.(); onClose() }}
          className={cn('flex h-[30px] w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] outline-none hover:bg-tint-secondary',
            it!.danger ? 'text-red-500' : 'text-foreground')}>
          {it!.label}
        </button>
      ))}
    </div>
  )
}

function WorkspacePanel({ id }: { id: string }) {
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
  const [ctxMenu, setCtxMenu] = useState<{ pos: MenuPos; node: Node | null } | null>(null)
  const [tabMenu, setTabMenu] = useState<{ pos: MenuPos; path: string } | null>(null)
  const [dragTab, setDragTab] = useState<string | null>(null)
  const [dropDir, setDropDir] = useState<string | null>(null)
  const [gitMap, setGitMap] = useState<Record<string, string>>({})
  const stripRef = useRef<HTMLDivElement>(null)

  useEffect(() => { mem.set(id, { tabs, active, expanded, filter, drafts }) }, [id, tabs, active, expanded, filter, drafts])

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
      window.alert(`操作失败: ${(e as Error).message}`)
      return (e as Error).message
    }
    if (r.error) { window.alert(`操作失败: ${r.error}`); return r.error }
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
      window.alert(`保存失败: ${r.error}`)
      return r.error
    } catch (e) { window.alert(`保存失败: ${(e as Error).message}`); return (e as Error).message }
  }, [id, openFile])

  const saveBinary = useCallback(async (p: string, buf: ArrayBuffer | Blob) => {
    try {
      const b = buf instanceof Blob ? await buf.arrayBuffer() : buf
      let bin = ''
      const bytes = new Uint8Array(b)
      for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192))
      const r = await adminFetch<{ ok?: boolean; error?: string }>(`/api/admin/session/${id}/file-write`, { method: 'POST', body: JSON.stringify({ path: p, base64: btoa(bin) }) })
      if (r.error) window.alert(`保存失败: ${r.error}`)
      return r.error ?? null
    } catch (e) { window.alert(`保存失败: ${(e as Error).message}`); return (e as Error).message }
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
          onDragStart={(e) => { setDragNode(n.path); e.dataTransfer.effectAllowed = 'move' }}
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
            dropDir === n.path && 'bg-accent-primary/15 outline-1 outline-accent-primary',
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
            <span className={cn('ml-1 shrink-0 text-[10px] font-medium', gitCls(gitMap[n.path]))} title={gitTitle(gitMap[n.path])}>{gitMap[n.path]}</span>
          )}
        </div>
        {n.entry.dir && isOpen && (
          <div>
            {dirs[n.path] === 'loading' && <div className="py-0.5 text-[12px] text-muted-foreground" style={{ paddingLeft: 6 + (depth + 1) * 14 }}>Loading…</div>}
            {kids.map((k) => renderNode(k, depth + 1))}
          </div>
        )}
      </div>
    )
  }

  const nodeMenuItems = (n: Node | null): (CtxItem | null)[] => {
    const dirPath = n ? (n.entry.dir ? n.path : parentOf(n.path)) : ''
    return [
      { label: '新建文件', onClick: () => { const v = window.prompt('文件名', 'new-file.txt'); if (v) void op('newfile', dirPath ? `${dirPath}/${v}` : v).then(() => open(dirPath ? `${dirPath}/${v}` : v)) } },
      { label: '新建文件夹', onClick: () => { const v = window.prompt('文件夹名', 'new-folder'); if (v) void op('mkdir', dirPath ? `${dirPath}/${v}` : v) } },
      n ? { sep: true, label: '' } : null,
      n ? { label: '重命名', onClick: () => setRenaming(n.path) } : null,
      n ? { label: '复制', onClick: () => { const v = window.prompt('复制到', `${n.path}.copy`); if (v) void op('copy', n.path, v) } } : null,
      n ? { label: '删除', danger: true, onClick: () => { if (window.confirm(`删除 ${n.entry.name}?`)) void op('delete', n.path) } } : null,
      n ? { sep: true, label: '' } : null,
      n ? { label: '复制路径', onClick: () => void navigator.clipboard.writeText(cwd ? `${cwd}/${n.path}` : n.path) } : null,
      n ? { label: '复制相对路径', onClick: () => void navigator.clipboard.writeText(n.path) } : null,
      n ? { label: '复制文件名', onClick: () => void navigator.clipboard.writeText(n.entry.name) } : null,
    ]
  }

  const tabMenuItems = (p: string): CtxItem[] => [
    { label: 'Close', onClick: () => closeTab(p) },
    { label: 'Close Others', onClick: () => closeOthers(p) },
    { label: 'Close All to the Left', onClick: () => closeSide(p, 'left') },
    { label: 'Close All to the Right', onClick: () => closeSide(p, 'right') },
    { sep: true, label: '' },
    { label: 'Copy Path', onClick: () => void navigator.clipboard.writeText(cwd ? `${cwd}/${p}` : p) },
    { label: 'Copy Relative Path', onClick: () => void navigator.clipboard.writeText(p) },
    { label: 'Reveal in Tree', onClick: () => { const parts = parentOf(p).split('/'); let acc = ''; setExpanded((x) => { const n = { ...x }; for (const s of parts) { if (!s) continue; acc = acc ? `${acc}/${s}` : s; n[acc] = true } return n }) } },
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
                    role="button" aria-label="Close"
                    className="absolute inset-0 hidden items-center justify-center rounded-[3px] bg-transparent group-hover:flex hover:bg-border/60"
                    onClick={(e) => { e.stopPropagation(); closeTab(p) }}
                  ><OX size={11} /></span>
                </span>
                {isActive && (
                  <span
                    role="button" aria-label="Close"
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
                  onClick={() => void navigator.clipboard.writeText(arr.slice(0, i + 1).join('/'))}
                >{seg}</button>
              </span>
            ))}
            {dirty(active) && <span className="ml-1 text-amber-600">● 未保存</span>}
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
              <div className="text-[13px]">Select a file to open</div>
            </div>
          )}
        </div>
      </div>
      {/* right: REPOS tree */}
      <div className="flex w-[240px] shrink-0 flex-col border-l border-border bg-card">
        <div className="flex h-[36px] shrink-0 items-center justify-between border-b border-border px-2.5">
          <span className="text-[11px] font-medium tracking-wide text-muted-foreground">REPOS</span>
          <button className="flex size-6 cursor-pointer items-center justify-center rounded-[4px] text-muted-foreground hover:bg-tint-secondary" aria-label="Refresh" title="Refresh"
            onClick={() => { setDirs({}); void loadDir('', true) }}><RefreshCw size={12} /></button>
        </div>
        <div className="shrink-0 border-b border-border p-2">
          <div className="flex h-7 items-center gap-1.5 rounded-[6px] border border-border bg-background px-2">
            <OSearch size={13} className="shrink-0 text-muted-foreground" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter files"
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
          {dirs[''] === 'loading' && <div className="px-2 py-1 text-[12px] text-muted-foreground">Loading…</div>}
          {dirs[''] === 'error' && <div className="px-2 py-1 text-[12px] text-red-500">Failed to load</div>}
          {dirs[''] !== 'loading' && dirs[''] !== 'error' && dirs[''] && buildNodes('').map((n) => renderNode(n, 0))}
        </div>
      </div>
      {ctxMenu && <CtxMenu pos={ctxMenu.pos} items={nodeMenuItems(ctxMenu.node)} onClose={() => setCtxMenu(null)} />}
      {tabMenu && <CtxMenu pos={tabMenu.pos} items={tabMenuItems(tabMenu.path)} onClose={() => setTabMenu(null)} />}
    </div>
  )
}

/* ---------------- viewers / editors ---------------- */

function Viewer({ id, path, file, rawUrl, draft, onDraft, onDiscard, onSaveText, onSaveBinary, onRetry }: {
  id: string; path: string; file?: FileResp; rawUrl: (p: string) => string
  draft?: string; onDraft: (t: string) => void; onDiscard: () => void
  onSaveText: (p: string, text: string) => Promise<string | null>
  onSaveBinary: (p: string, buf: ArrayBuffer | Blob) => Promise<string | null>
  onRetry: () => void
}) {
  const k = kindOf(path)
  const e = ext(path)
  const src = rawUrl(path)

  if (k === 'image') return <ImageEditor src={src} name={path} onSave={(blob) => onSaveBinary(path, blob)} />
  if (k === 'pdf') return <iframe src={src} title={path} className="h-full w-full border-0 bg-[#525659]" />
  if (k === 'av') {
    const isAudio = /mp3|wav|ogg|m4a|flac|aac/.test(e)
    return (
      <div className="flex h-full items-center justify-center bg-black/90 p-4">
        {isAudio ? <audio controls src={src} className="w-[420px] max-w-full" /> : <video controls src={src} className="max-h-full max-w-full" />}
      </div>
    )
  }
  if (k === 'docx') return <DocxView src={src} name={path} />
  if (k === 'xlsx') return <XlsxView src={src} name={path} onSave={(buf) => onSaveBinary(path, buf)} />

  if (!file || (!file.text && !file.error && !file.binary && !file.tooLarge)) {
    return <div className="p-3 text-[13px] text-muted-foreground">Loading…</div>
  }
  if (file.error) return <ErrBox msg={file.error} onRetry={onRetry} />
  if (file.tooLarge) return <Fallback path={path} src={src} msg="File too large to preview (over 2 MB)" />
  if (file.binary || file.text == null) {
    if (e === 'doc') return <Fallback path={path} src={src} msg=".doc is a legacy binary format — download to open it" />
    return <Fallback path={path} src={src} msg="Binary file — preview not supported" />
  }
  const text = draft ?? file.text
  if (k === 'md') return <MdView text={text} savedText={file.text} name={path} onChange={onDraft} onSave={() => void onSaveText(path, text)} onDiscard={onDiscard} />
  if (k === 'html') return <HtmlView text={text} savedText={file.text} name={path} onChange={onDraft} onSave={() => void onSaveText(path, text)} onDiscard={onDiscard} />
  if (k === 'csv') return <CsvView text={text} savedText={file.text} onChange={onDraft} onSave={() => void onSaveText(path, text)} onDiscard={onDiscard} />
  return <PlainEditor text={text} savedText={file.text} name={path} onChange={onDraft} onSave={() => void onSaveText(path, text)} onDiscard={onDiscard}
    preview={<div className="overflow-auto"><CodeView text={text} name={path} /></div>} />
}

function ErrBox({ msg, onRetry }: { msg: string; onRetry: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4">
      <FileWarning size={24} className="text-red-500" />
      <div className="text-[13px] text-red-500">{msg}</div>
      <button onClick={onRetry} className="rounded-[6px] border border-border px-2.5 py-1 text-[12px] hover:bg-tint-secondary">Retry</button>
    </div>
  )
}

function Fallback({ path, src, msg }: { path: string; src: string; msg: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-muted-foreground">
      <TypeIcon path={path} size={28} />
      <div className="text-[13px] font-medium text-foreground">{base(path)}</div>
      <div className="text-[12px]">{msg}</div>
      <a href={src} download className="mt-1 rounded-[6px] border border-border px-3 py-1.5 text-[12px] text-foreground hover:bg-tint-secondary">Download</a>
    </div>
  )
}

/** Toolbar for editable text kinds: Edit/Preview toggle + save state. */
function EditBar({ mode, setMode, modes, dirty, saving, onSave, onDiscard }: {
  mode: string; setMode: (m: string) => void; modes: string[]
  dirty: boolean; saving: boolean; onSave: () => void; onDiscard: () => void
}) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-border px-2">
      <div className="flex items-center gap-0.5">
        {modes.map((m) => (
          <button key={m} onClick={() => setMode(m)}
            className={cn('h-6 cursor-pointer rounded-[5px] px-2 text-[12px]', mode === m ? 'bg-tint-secondary font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}>{m}</button>
        ))}
      </div>
      <div className="ml-auto flex items-center gap-1.5">
        {dirty && <span className="text-[11px] text-amber-600">未保存</span>}
        {dirty && <button onClick={onDiscard} className="h-6 cursor-pointer rounded-[5px] px-2 text-[12px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground">还原</button>}
        <button onClick={onSave} disabled={!dirty || saving}
          className={cn('flex h-6 cursor-pointer items-center gap-1 rounded-[5px] px-2 text-[12px]', dirty ? 'bg-accent-primary text-white hover:opacity-90' : 'text-muted-foreground opacity-50')}>
          <Save size={12} /> {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  )
}

function useSaver(dirty: boolean, onSave: () => void) {
  const [saving, setSaving] = useState(false)
  const doSave = useCallback(() => {
    if (!dirty || saving) return
    setSaving(true); void Promise.resolve(onSave()).finally(() => setSaving(false))
  }, [dirty, saving, onSave])
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); doSave() }
    }
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [doSave])
  return { saving, doSave }
}

/** Text/code editor: mono textarea + synced line-number gutter + Ctrl+S. */
function PlainEditor({ text, savedText, name, onChange, onSave, onDiscard, preview }: {
  text: string; savedText: string; name: string; onChange: (t: string) => void; onSave: () => void; onDiscard: () => void; preview?: React.ReactNode
}) {
  const gutRef = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState(preview ? 'Preview' : 'Edit')
  const dirty = text !== savedText
  const { saving, doSave } = useSaver(dirty, onSave)
  const lines = useMemo(() => text.split('\n').length, [text])
  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditBar mode={mode} setMode={setMode} modes={preview ? ['Preview', 'Edit'] : ['Edit']} dirty={dirty} saving={saving} onSave={doSave} onDiscard={onDiscard} />
      {mode === 'Preview' && preview ? (
        <div className="min-h-0 flex-1 overflow-auto">{preview}</div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div ref={gutRef} className="shrink-0 select-none overflow-hidden border-r border-border bg-card px-[1ch] pt-3 text-right font-mono text-[11px] leading-[20px] text-muted-foreground" aria-hidden>
            {Array.from({ length: lines }, (_, i) => <div key={i}>{i + 1}</div>)}
          </div>
          <textarea
            value={text}
            spellCheck={false}
            onChange={(e) => onChange(e.target.value)}
            onScroll={(e) => { if (gutRef.current) gutRef.current.scrollTop = (e.target as HTMLTextAreaElement).scrollTop }}
            className="min-w-0 flex-1 resize-none whitespace-pre bg-background p-3 pl-2 font-mono text-[12px] leading-[20px] text-foreground outline-none"
          />
        </div>
      )}
    </div>
  )
}

/* Markdown: Preview / Edit */
function MdView({ text, savedText, name, onChange, onSave, onDiscard }: {
  text: string; savedText: string; name: string; onChange: (t: string) => void; onSave: () => void; onDiscard: () => void
}) {
  return <PlainEditor text={text} savedText={savedText} name={name} onChange={onChange} onSave={onSave} onDiscard={onDiscard}
    preview={<div className="mx-auto max-w-[760px] p-4"><Markdown text={text} /></div>} />
}

/* HTML: Preview (sandboxed iframe) / Edit */
function HtmlView({ text, savedText, name, onChange, onSave, onDiscard }: {
  text: string; savedText: string; name: string; onChange: (t: string) => void; onSave: () => void; onDiscard: () => void
}) {
  return <PlainEditor text={text} savedText={savedText} name={name} onChange={onChange} onSave={onSave} onDiscard={onDiscard}
    preview={<iframe title={name} sandbox="allow-scripts allow-same-origin" srcDoc={text} className="h-full w-full border-0 bg-white" />} />
}

/* CSV: editable table */
function CsvView({ text, savedText, onChange, onSave, onDiscard }: {
  text: string; savedText: string; onChange: (t: string) => void; onSave: () => void; onDiscard: () => void
}) {
  const rows = useMemo(() => {
    const out: string[][] = []
    let cur: string[] = [], cell = '', qq = false
    for (let i = 0; i < text.length && out.length < 2000; i++) {
      const c = text[i]
      if (qq) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ } else if (c === '"') qq = false
        else cell += c
      } else if (c === '"') qq = true
      else if (c === ',') { cur.push(cell); cell = '' }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++
        cur.push(cell); cell = ''; out.push(cur); cur = []
      } else cell += c
    }
    if (cell || cur.length) { cur.push(cell); out.push(cur) }
    return out.filter((r) => r.length > 1 || r[0] !== '')
  }, [text])
  const setCell = (r: number, c: number, v: string) => {
    const n = rows.map((row, i) => i === r ? row.map((x, j) => (j === c ? v : x)) : row)
    onChange(n.map((row) => row.map((c) => /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join(',')).join('\n'))
  }
  const [mode, setMode] = useState('Table')
  const dirty = text !== savedText
  const { saving, doSave } = useSaver(dirty, onSave)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditBar mode={mode} setMode={setMode} modes={['Table', 'Source']} dirty={dirty} saving={saving} onSave={doSave} onDiscard={onDiscard} />
      {mode === 'Source' ? (
        <textarea value={text} spellCheck={false} onChange={(e) => onChange(e.target.value)}
          className="min-h-0 flex-1 resize-none whitespace-pre bg-background p-3 font-mono text-[12px] leading-[20px] outline-none" />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="border-collapse text-[12px]">
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className={i === 0 ? 'sticky top-0 bg-card font-medium' : 'hover:bg-tint-secondary/50'}>
                  <td className="sticky left-0 border-b border-r border-border bg-card px-1.5 py-1 text-right text-[10px] text-muted-foreground">{i + 1}</td>
                  {r.map((c, j) => (
                    <td key={j} className="whitespace-nowrap border-b border-r border-border px-2 py-1 align-top outline-none focus:bg-accent-primary/10"
                      contentEditable suppressContentEditableWarning
                      onBlur={(e) => setCell(i, j, e.currentTarget.textContent ?? '')}>{c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/* XLSX: editable cells + sheet tabs → write back binary */
function XlsxView({ src, name, onSave }: { src: string; name: string; onSave: (buf: ArrayBuffer) => Promise<string | null> }) {
  const [wb, setWb] = useState<{ book: import('xlsx').WorkBook; sheets: string[]; data: Record<string, unknown[][]> } | null>(null)
  const [sheet, setSheet] = useState(0)
  const [err, setErr] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const load = useCallback(async () => {
    try {
      const buf = await (await fetch(src)).arrayBuffer()
      const XLSX = await import('xlsx')
      const book = XLSX.read(buf, { type: 'array', cellFormula: false })
      const data: Record<string, unknown[][]> = {}
      for (const s of book.SheetNames) {
        data[s] = (XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[s], { header: 1, defval: '' }).slice(0, 2000) as unknown[][])
          .map((r) => (Array.isArray(r) ? r : [r]).map((c) => (c == null ? '' : c)))
      }
      setWb({ book, sheets: book.SheetNames, data })
    } catch (e) { setErr((e as Error).message) }
  }, [src])
  useEffect(() => { setWb(null); setErr(null); setDirty(false); void load() }, [load])
  const doSave = useCallback(() => {
    if (!wb || !dirty || saving) return
    setSaving(true)
    void (async () => {
      const XLSX = await import('xlsx')
      for (const s of wb.sheets) wb.book.Sheets[s] = XLSX.utils.aoa_to_sheet(wb.data[s])
      const out = XLSX.write(wb.book, { type: 'array', bookType: ext(name) === 'xls' ? 'biff8' : 'xlsx' }) as ArrayBuffer
      const e2 = await onSave(out)
      if (!e2) setDirty(false)
    })().finally(() => setSaving(false))
  }, [wb, dirty, saving, name, onSave])
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); doSave() } }
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [doSave])
  if (err) return <Fallback path={name} src={src} msg={`Spreadsheet preview failed: ${err}`} />
  if (!wb) return <div className="p-3 text-[13px] text-muted-foreground">Loading spreadsheet…</div>
  const cur = wb.sheets[Math.min(sheet, wb.sheets.length - 1)]
  const rows = wb.data[cur] ?? []
  const setCell = (r: number, c: number, v: string) => {
    wb.data[cur][r] = [...(wb.data[cur][r] ?? [])]
    const num = v !== '' && !isNaN(Number(v)) ? Number(v) : v
    wb.data[cur][r][c] = num
    setWb({ ...wb })
    setDirty(true)
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-end gap-0.5 border-b border-border px-2 pt-1">
        {wb.sheets.map((s, i) => (
          <button key={s} onClick={() => setSheet(i)}
            className={cn('h-7 cursor-pointer rounded-t-[5px] border border-b-0 border-border px-2.5 text-[12px]', i === sheet ? 'bg-background font-medium text-foreground' : 'bg-card text-muted-foreground hover:text-foreground')}>{s}</button>
        ))}
        <div className="ml-auto flex h-full items-center gap-1.5 pb-1">
          {dirty && <span className="text-[11px] text-amber-600">未保存</span>}
          <button onClick={doSave} disabled={!dirty || saving}
            className={cn('flex h-6 cursor-pointer items-center gap-1 rounded-[5px] px-2 text-[12px]', dirty ? 'bg-accent-primary text-white' : 'text-muted-foreground opacity-50')}>
            <Save size={12} /> {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="border-collapse text-[12px]">
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={i === 0 ? 'sticky top-0 z-[1] bg-card font-medium' : 'hover:bg-tint-secondary/50'}>
                <td className="sticky left-0 border-b border-r border-border bg-card px-1.5 py-1 text-right text-[10px] text-muted-foreground">{i + 1}</td>
                {r.map((c, j) => (
                  <td key={j} className="whitespace-nowrap border-b border-r border-border px-2 py-1 align-top outline-none focus:bg-accent-primary/10"
                    contentEditable suppressContentEditableWarning
                    onBlur={(e) => setCell(i, j, e.currentTarget.textContent ?? '')}>{String(c)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* DOCX → mammoth HTML (read-only) */
function DocxView({ src, name }: { src: string; name: string }) {
  const [html, setHtml] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let dead = false
    setHtml(null); setErr(null)
    void (async () => {
      try {
        const buf = await (await fetch(src)).arrayBuffer()
        const { convertToHtml } = await import('mammoth')
        const r = await convertToHtml({ arrayBuffer: buf })
        if (!dead) setHtml(r.value)
      } catch (e) { if (!dead) setErr((e as Error).message) }
    })()
    return () => { dead = true }
  }, [src])
  if (err) return <Fallback path={name} src={src} msg={`DOCX preview failed: ${err}`} />
  if (html == null) return <div className="p-3 text-[13px] text-muted-foreground">Loading document…</div>
  return (
    <div className="mx-auto max-w-[760px] p-6">
      <style>{`.docx-view h1,.docx-view h2,.docx-view h3{font-weight:600;margin:.8em 0 .4em}.docx-view h1{font-size:20px}.docx-view h2{font-size:17px}.docx-view h3{font-size:15px}.docx-view p{margin:.5em 0;font-size:13px;line-height:1.6}.docx-view table{border-collapse:collapse;margin:.6em 0}.docx-view td,.docx-view th{border:1px solid var(--color-border);padding:3px 8px;font-size:12px}.docx-view ul,.docx-view ol{padding-left:1.4em}.docx-view img{max-width:100%}`}</style>
      <div className="docx-view text-foreground" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}

/* Image viewer/editor: zoom, pan, crop, red-rect annotate, text annotate, save */
function ImageEditor({ src, name, onSave }: { src: string; name: string; onSave: (blob: Blob) => Promise<string | null> }) {
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [tool, setTool] = useState<'none' | 'crop' | 'rect' | 'text'>('none')
  const [rects, setRects] = useState<{ x: number; y: number; w: number; h: number }[]>([])
  const [texts, setTexts] = useState<{ x: number; y: number; t: string }[]>([])
  const [dragging, setDragging] = useState<{ sx: number; sy: number; ex: number; ey: number } | null>(null)
  const [panning, setPanning] = useState<{ sx: number; sy: number; px: number; py: number } | null>(null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const im = new Image()
    im.crossOrigin = 'same-origin'
    im.onload = () => setImg(im)
    im.onerror = () => setErr('image load failed')
    im.src = src + (nonce ? `${src.includes('?') ? '&' : '?'}r=${nonce}` : '')
    setRects([]); setTexts([]); setTool('none'); setZoom(1); setPan({ x: 0, y: 0 }); setErr(null)
  }, [src, nonce])
  const dirty = rects.length > 0 || texts.length > 0

  const toImg = (clientX: number, clientY: number) => {
    const wrap = wrapRef.current!.getBoundingClientRect()
    // image is centered + scaled by zoom, offset by pan
    const iw = img!.naturalWidth * zoom, ih = img!.naturalHeight * zoom
    const ox = wrap.left + (wrap.width - iw) / 2 + pan.x
    const oy = wrap.top + (wrap.height - ih) / 2 + pan.y
    return { x: (clientX - ox) / zoom, y: (clientY - oy) / zoom }
  }

  const applyCrop = () => {
    if (!dragging || !img) return
    const r = normRect(dragging)
    if (r.w < 8 || r.h < 8) return
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(r.w)); c.height = Math.max(1, Math.round(r.h))
    c.getContext('2d')!.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h)
    const im = new Image()
    im.onload = () => { setImg(im); setDragging(null); setRects([]); setTexts([]); setTool('none'); setPan({ x: 0, y: 0 }) }
    im.src = c.toDataURL('image/png')
  }

  const doSave = async () => {
    if (!img || saving) return
    setSaving(true)
    try {
      const c = document.createElement('canvas')
      c.width = img.naturalWidth; c.height = img.naturalHeight
      const g = c.getContext('2d')!
      g.drawImage(img, 0, 0)
      g.strokeStyle = '#ef4444'; g.lineWidth = Math.max(2, img.naturalWidth / 400)
      for (const r of rects) g.strokeRect(r.x, r.y, r.w, r.h)
      g.fillStyle = '#ef4444'
      g.font = `${Math.max(14, img.naturalWidth / 45)}px sans-serif`
      for (const t of texts) g.fillText(t.t, t.x, t.y)
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, ext(name) === 'jpg' || ext(name) === 'jpeg' ? 'image/jpeg' : 'image/png'))
      if (blob) {
        const e2 = await onSave(blob)
        if (!e2) { setRects([]); setTexts([]) } else setErr(e2)
      }
    } finally { setSaving(false) }
  }

  const normRect = (d: { sx: number; sy: number; ex: number; ey: number }) => ({
    x: Math.min(d.sx, d.ex), y: Math.min(d.sy, d.ey), w: Math.abs(d.ex - d.sx), h: Math.abs(d.ey - d.sy),
  })

  const onDown = (e: React.MouseEvent) => {
    if (!img) return
    if (tool === 'crop' || tool === 'rect') { const p = toImg(e.clientX, e.clientY); setDragging({ sx: p.x, sy: p.y, ex: p.x, ey: p.y }) }
    else if (tool === 'text') {
      const p = toImg(e.clientX, e.clientY)
      const v = window.prompt('标注文字', '')
      if (v) setTexts((t) => [...t, { x: p.x, y: p.y, t: v }])
    } else setPanning({ sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y })
  }
  const onMove = (e: React.MouseEvent) => {
    if (dragging) { const p = toImg(e.clientX, e.clientY); setDragging({ ...dragging, ex: p.x, ey: p.y }) }
    else if (panning) setPan({ x: panning.px + (e.clientX - panning.sx), y: panning.py + (e.clientY - panning.sy) })
  }
  const onUp = () => {
    if (dragging) {
      const r = normRect(dragging)
      if (tool === 'rect' && r.w > 4 && r.h > 4) setRects((x) => [...x, r])
      else if (tool === 'crop') applyCrop()
      setDragging(null)
    }
    setPanning(null)
  }

  if (err) return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-muted-foreground">
      <FileWarning size={24} className="text-red-500" />
      <div className="text-[13px] text-red-500">{err}</div>
      <button onClick={() => setNonce((n) => n + 1)} className="rounded-[6px] border border-border px-2.5 py-1 text-[12px] text-foreground hover:bg-tint-secondary">Retry</button>
    </div>
  )
  if (!img) return <div className="p-3 text-[13px] text-muted-foreground">Loading image…</div>
  const sel = dragging ? normRect(dragging) : null
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-border px-2">
        <button title="缩小" className="flex size-6 cursor-pointer items-center justify-center rounded-[4px] text-muted-foreground hover:bg-tint-secondary" onClick={() => setZoom((z) => Math.max(0.05, z / 1.25))}><ZoomOut size={13} /></button>
        <span className="w-12 text-center text-[11px] text-muted-foreground">{Math.round(zoom * 100)}%</span>
        <button title="放大" className="flex size-6 cursor-pointer items-center justify-center rounded-[4px] text-muted-foreground hover:bg-tint-secondary" onClick={() => setZoom((z) => Math.min(16, z * 1.25))}><ZoomIn size={13} /></button>
        <button title="适应窗口" className="flex size-6 cursor-pointer items-center justify-center rounded-[4px] text-muted-foreground hover:bg-tint-secondary" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }}><Maximize size={13} /></button>
        <span className="mx-1 h-4 w-px bg-border" />
        {([['crop', '裁剪', CropIcon], ['rect', '红框', Square], ['text', '文字', Type]] as const).map(([k, l, IconC]) => (
          <button key={k} title={l} onClick={() => setTool((t) => (t === k ? 'none' : k))}
            className={cn('flex h-6 cursor-pointer items-center gap-1 rounded-[4px] px-1.5 text-[12px]', tool === k ? 'bg-tint-secondary font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}>
            <IconC size={13} />{l}
          </button>
        ))}
        {dirty && <button title="清除标注" className="flex h-6 cursor-pointer items-center gap-1 rounded-[4px] px-1.5 text-[12px] text-muted-foreground hover:text-foreground" onClick={() => { setRects([]); setTexts([]) }}><Undo2 size={13} />清除标注</button>}
        <div className="ml-auto flex items-center gap-1.5">
          <a href={src} download className="h-6 cursor-pointer rounded-[5px] px-2 text-[12px] leading-6 text-muted-foreground hover:bg-tint-secondary hover:text-foreground">下载</a>
          <button onClick={() => void doSave()} disabled={saving}
            className={cn('flex h-6 cursor-pointer items-center gap-1 rounded-[5px] px-2 text-[12px]', dirty ? 'bg-accent-primary text-white' : 'text-muted-foreground opacity-60')}>
            <Save size={12} /> {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
      <div
        ref={wrapRef}
        className={cn('relative min-h-0 flex-1 select-none overflow-hidden bg-[repeating-conic-gradient(#00000008_0_25%,transparent_0_50%)] bg-[size:20px_20px]', tool === 'none' ? 'cursor-grab active:cursor-grabbing' : 'cursor-crosshair')}
        onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}
        onWheel={(e) => setZoom((z) => Math.min(16, Math.max(0.05, z * (e.deltaY < 0 ? 1.1 : 0.9))))}
      >
        <div
          className="absolute left-1/2 top-1/2"
          style={{ transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px)) scale(${zoom})`, transformOrigin: 'center' }}
        >
          <div className="relative" style={{ width: img.naturalWidth, height: img.naturalHeight }}>
            <img src={img.src} alt={name} draggable={false} className="block h-full w-full shadow-md" />
            {rects.map((r, i) => (
              <div key={i} className="pointer-events-none absolute border-2 border-red-500" style={{ left: r.x, top: r.y, width: r.w, height: r.h }} />
            ))}
            {texts.map((t, i) => (
              <div key={i} className="pointer-events-none absolute font-sans font-medium text-red-500" style={{ left: t.x, top: t.y, fontSize: Math.max(14, img.naturalWidth / 45) }}>{t.t}</div>
            ))}
            {sel && (tool === 'crop' || tool === 'rect') && (
              <div className={cn('pointer-events-none absolute border-2', tool === 'crop' ? 'border-accent-primary bg-accent-primary/10' : 'border-red-500')}
                style={{ left: sel.x, top: sel.y, width: sel.w, height: sel.h }} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export { EditorPanel, type WsEntry, WorkspacePanel, CtxMenu, type CtxItem, type MenuPos };
