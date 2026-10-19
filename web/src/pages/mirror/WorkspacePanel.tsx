import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, Folder as FolderIcon, File as FileIcon, FileCode, FileText, FileSpreadsheet, FileImage, FileVideo, FileAudio, FileArchive, FileWarning } from 'lucide-react'
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
// Official-style editor: tabs + viewer on the left, REPOS file tree on the right
// ---------------------------------------------------------------------------

interface WsEntry { name: string; dir: boolean; size: number; mtime: string }
interface FileResp { path: string; text: string | null; binary?: boolean; tooLarge?: boolean; size?: number; truncated?: boolean; error?: string }

const ext = (p: string) => (p.split('/').pop() ?? '').split('.').pop()?.toLowerCase() ?? ''
type Kind = 'image' | 'pdf' | 'av' | 'md' | 'docx' | 'xlsx' | 'csv' | 'code' | 'text' | 'bin'
const KINDS: Record<string, Kind> = {}
for (const e of 'png jpg jpeg gif webp svg ico bmp avif'.split(' ')) KINDS[e] = 'image'
for (const e of 'mp4 webm mov mkv avi mp3 wav ogg m4a flac aac'.split(' ')) KINDS[e] = 'av'
for (const e of 'md markdown mdx'.split(' ')) KINDS[e] = 'md'
KINDS.pdf = 'pdf'
KINDS.docx = 'docx'
for (const e of 'xlsx xls'.split(' ')) KINDS[e] = 'xlsx'
KINDS.csv = 'csv'
KINDS.txt = 'text'
KINDS.log = 'text'
const CODE_EXTS = new Set('js jsx mjs cjs ts tsx py json html htm css scss less sass sh bash zsh ps1 bat cmd yml yaml toml ini cfg conf env sql go rs java c h cc cpp cxx hpp cs rb php swift kt kts lua r pl pm scala clj ex exs erl hs ml fs vb dockerfile makefile mk cmake gradle xml xsl svg vue svelte diff patch properties gitignore lock thrift proto graphql prismatic tf hcl dart zig nim sol asm'.split(' '))
const kindOf = (p: string): Kind => KINDS[ext(p)] ?? (CODE_EXTS.has(ext(p)) ? 'code' : 'bin')

/** Colored file-type glyph — matches official REPOS tree icons. */
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
  if (e === 'md' || e === 'markdown' || e === 'txt') return <FileText size={size} className={cn(cls, 'text-muted-foreground')} />
  if (CODE_EXTS.has(e)) return <FileCode size={size} className={cn(cls, e === 'html' || e === 'htm' ? 'text-orange-500' : e === 'css' ? 'text-sky-500' : e === 'js' || e === 'jsx' ? 'text-yellow-500' : e === 'ts' || e === 'tsx' ? 'text-blue-500' : e === 'json' ? 'text-slate-500' : 'text-teal-600')} />
  return <FileIcon size={size} className={cn(cls, 'text-muted-foreground')} />
}

/* Persist open tabs + tree expansion across panel-tab switches. */
const mem = new Map<string, { tabs: string[]; active: string | null; expanded: Record<string, boolean>; filter: string }>()

interface Node { entry: WsEntry; path: string; kids: Node[] | null; loading: boolean }

function WorkspacePanel({ id }: { id: string }) {
  const saved = mem.get(id)
  const [tabs, setTabs] = useState<string[]>(saved?.tabs ?? [])
  const [active, setActive] = useState<string | null>(saved?.active ?? null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>(saved?.expanded ?? {})
  const [filter, setFilter] = useState(saved?.filter ?? '')
  const [dirs, setDirs] = useState<Record<string, { entries: WsEntry[] } | 'loading' | 'error'>>({})
  const [cwd, setCwd] = useState('')
  const [files, setFiles] = useState<Record<string, FileResp>>({})
  const treeRef = useRef<HTMLDivElement>(null)

  useEffect(() => { mem.set(id, { tabs, active, expanded, filter }) }, [id, tabs, active, expanded, filter])

  const loadDir = useCallback(async (p: string) => {
    setDirs((d) => ({ ...d, [p]: 'loading' }))
    try {
      const r = await adminFetch<{ cwd: string; path: string; entries: WsEntry[]; error: string | null }>(
        `/api/admin/session/${id}/files?path=${encodeURIComponent(p)}&all=1`)
      setCwd(r.cwd)
      const entries = [...(r.entries ?? [])].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
      setDirs((d) => ({ ...d, [p]: { entries } }))
    } catch { setDirs((d) => ({ ...d, [p]: 'error' })) }
  }, [id])

  useEffect(() => { if (!dirs['']) void loadDir('') }, [dirs, loadDir])

  const openFile = useCallback(async (p: string) => {
    setFiles((f) => ({ ...f, [p]: { path: p, text: null } }))
    try {
      const r = await adminFetch<FileResp>(`/api/admin/session/${id}/file?path=${encodeURIComponent(p)}`)
      setFiles((f) => ({ ...f, [p]: r }))
    } catch (e) { setFiles((f) => ({ ...f, [p]: { path: p, text: null, error: (e as Error).message } })) }
  }, [id])

  const open = useCallback((p: string) => {
    setTabs((t) => (t.includes(p) ? t : [...t, p]))
    setActive(p)
    const k = kindOf(p)
    if (k === 'code' || k === 'text' || k === 'md' || k === 'csv') void openFile(p)
  }, [openFile])

  const toggleDir = useCallback((p: string) => {
    setExpanded((x) => {
      const open = !x[p]
      if (open && !dirs[p]) void loadDir(p)
      return { ...x, [p]: open }
    })
  }, [dirs, loadDir])

  const closeTab = useCallback((p: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    setTabs((t) => {
      const i = t.indexOf(p)
      const next = t.filter((x) => x !== p)
      setActive((a) => (a === p ? next[Math.min(i, next.length - 1)] ?? null : a))
      return next
    })
  }, [])

  /* -------- tree render (lazy, recursive) -------- */
  const matches = useCallback((n: Node, q: string): boolean => {
    if (n.entry.name.toLowerCase().includes(q)) return true
    if (!n.entry.dir || !n.kids) return false
    return n.kids.some((k) => matches(k, q))
  }, [])
  const buildNodes = useCallback((p: string): Node[] => {
    const d = dirs[p]
    if (!d || d === 'loading' || d === 'error') return []
    return d.entries.map((e) => {
      const cp = p ? `${p}/${e.name}` : e.name
      return { entry: e, path: cp, kids: e.dir && expanded[cp] ? buildNodes(cp) : null, loading: dirs[cp] === 'loading' }
    })
  }, [dirs, expanded])

  const q = filter.trim().toLowerCase()
  const renderNode = (n: Node, depth: number): React.ReactNode => {
    if (q && !matches(n, q)) return null
    const isOpen = !!expanded[n.path]
    return (
      <div key={n.path}>
        <button
          onClick={() => (n.entry.dir ? toggleDir(n.path) : open(n.path))}
          className={cn(
            'flex h-[26px] w-full cursor-pointer items-center gap-1 rounded-[4px] pr-1 text-left text-[13px] leading-[18px] hover:bg-tint-secondary',
            active === n.path && 'bg-tint-secondary text-foreground',
          )}
          style={{ paddingLeft: 6 + depth * 14 }}
        >
          {n.entry.dir
            ? <span className="flex size-4 items-center justify-center text-muted-foreground">{isOpen ? <OChevronDown size={12} /> : <OChevronRight size={12} />}</span>
            : <span className="size-4 shrink-0" />}
          <TypeIcon path={n.path} dir={n.entry.dir} />
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{n.entry.name}</span>
        </button>
        {n.entry.dir && isOpen && (
          <div>
            {n.loading && <div className="py-0.5 text-[12px] text-muted-foreground" style={{ paddingLeft: 6 + (depth + 1) * 14 }}>Loading…</div>}
            {(n.kids ?? []).map((k) => renderNode(k, depth + 1))}
          </div>
        )}
      </div>
    )
  }

  /* -------- viewer -------- */
  const rawUrl = (p: string) => `/api/admin/session/${id}/file-raw?path=${encodeURIComponent(p)}`
  const name = (p: string) => p.split('/').pop() ?? p

  return (
    <div className="flex h-full min-h-0">
      {/* left: tabs + viewer */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-[36px] shrink-0 items-stretch gap-0 border-b border-border bg-card">
          {tabs.map((p) => (
            <button
              key={p}
              onClick={() => setActive(p)}
              className={cn(
                'group relative flex max-w-[180px] cursor-pointer items-center gap-1.5 border-r border-border px-3 text-[12px]',
                active === p ? 'bg-background text-foreground shadow-[inset_0_2px_0_0_var(--color-accent-primary,#317cff)]' : 'text-muted-foreground hover:bg-tint-secondary',
              )}
              title={p}
            >
              <TypeIcon path={p} size={13} />
              <span className="min-w-0 truncate">{name(p)}</span>
              <span role="button" aria-label="Close" className="flex size-4 items-center justify-center rounded-[3px] opacity-0 hover:bg-tint-secondary group-hover:opacity-100" onClick={(e) => closeTab(p, e)}><OX size={11} /></span>
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-background">
          {active ? <Viewer id={id} path={active} file={files[active]} rawUrl={rawUrl} onRetry={() => void openFile(active)} /> : (
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
            onClick={() => { setDirs({}); void loadDir('') }}><RefreshCw size={12} /></button>
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
        <div ref={treeRef} className="min-h-0 flex-1 overflow-auto p-1">
          <div className="flex h-[26px] items-center gap-1 px-1.5 text-[13px] font-medium">
            <TypeIcon path="" dir size={14} />
            <span className="min-w-0 flex-1 truncate">{cwd ? cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : 'workspace'}</span>
          </div>
          {dirs[''] === 'loading' && <div className="px-2 py-1 text-[12px] text-muted-foreground">Loading…</div>}
          {dirs[''] === 'error' && <div className="px-2 py-1 text-[12px] text-red-500">Failed to load</div>}
          {dirs[''] !== 'loading' && dirs[''] !== 'error' && dirs[''] && buildNodes('').map((n) => renderNode(n, 0))}
        </div>
      </div>
    </div>
  )
}

/* ---------------- viewers ---------------- */

function Viewer({ id, path, file, rawUrl, onRetry }: {
  id: string; path: string; file?: FileResp; rawUrl: (p: string) => string; onRetry: () => void
}) {
  const k = kindOf(path)
  const e = ext(path)
  const src = rawUrl(path)

  if (k === 'image') {
    return (
      <div className="flex h-full items-center justify-center overflow-auto bg-[repeating-conic-gradient(#00000008_0_25%,transparent_0_50%)] bg-[size:20px_20px] p-4">
        <img src={src} alt={path} className="max-h-full max-w-full object-contain shadow-md" />
      </div>
    )
  }
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
  if (k === 'xlsx') return <XlsxView src={src} name={path} />

  // text-based kinds need the file payload
  if (!file || (!file.text && !file.error && !file.binary && !file.tooLarge)) {
    return <div className="p-3 text-[13px] text-muted-foreground">Loading…</div>
  }
  if (file.error) return <ErrBox msg={file.error} onRetry={onRetry} />
  if (file.tooLarge) return <Fallback path={path} src={src} msg="File too large to preview (over 2 MB)" />
  if (file.binary || file.text == null) {
    if (e === 'doc') return <Fallback path={path} src={src} msg=".doc is a legacy binary format — download to open it" />
    return <Fallback path={path} src={src} msg="Binary file — preview not supported" />
  }
  if (k === 'md') return <MdView text={file.text} name={path} />
  if (k === 'csv') return <CsvView text={file.text} />
  return (
    <div className="min-h-full">
      <CodeView text={file.truncated ? `${file.text}\n… (truncated)` : file.text} name={path} />
    </div>
  )
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
      <div className="text-[13px] font-medium text-foreground">{path.split('/').pop()}</div>
      <div className="text-[12px]">{msg}</div>
      <a href={src} download className="mt-1 rounded-[6px] border border-border px-3 py-1.5 text-[12px] text-foreground hover:bg-tint-secondary">Download</a>
    </div>
  )
}

/* Markdown: rendered + source toggle */
function MdView({ text, name }: { text: string; name: string }) {
  const [src, setSrc] = useState(false)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center justify-end gap-0.5 border-b border-border px-2">
        {(['Preview', 'Source'] as const).map((m, i) => (
          <button key={m} onClick={() => setSrc(i === 1)}
            className={cn('h-6 cursor-pointer rounded-[5px] px-2 text-[12px]', (src ? i === 1 : i === 0) ? 'bg-tint-secondary font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}>{m}</button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {src ? <CodeView text={text} name={name} /> : <div className="mx-auto max-w-[760px] p-4"><Markdown text={text} /></div>}
      </div>
    </div>
  )
}

/* CSV → simple table */
function CsvView({ text }: { text: string }) {
  const rows = useMemo(() => {
    const out: string[][] = []
    let cur: string[] = [], cell = '', q = false
    for (let i = 0; i < text.length && out.length < 2000; i++) {
      const c = text[i]
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ } else if (c === '"') q = false
        else cell += c
      } else if (c === '"') q = true
      else if (c === ',') { cur.push(cell); cell = '' }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++
        cur.push(cell); cell = ''; out.push(cur); cur = []
      } else cell += c
    }
    if (cell || cur.length) { cur.push(cell); out.push(cur) }
    return out.filter((r) => r.length > 1 || r[0] !== '')
  }, [text])
  return (
    <div className="p-0">
      <table className="w-full border-collapse text-[12px]">
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={i === 0 ? 'sticky top-0 bg-card font-medium' : 'hover:bg-tint-secondary/50'}>
              {r.map((c, j) => <td key={j} className="whitespace-nowrap border-b border-r border-border px-2 py-1 align-top last:border-r-0">{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* DOCX → mammoth HTML */
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

/* XLSX → sheet tabs + table */
function XlsxView({ src, name }: { src: string; name: string }) {
  const [wb, setWb] = useState<{ sheets: string[]; data: Record<string, string[][]> } | null>(null)
  const [sheet, setSheet] = useState(0)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let dead = false
    setWb(null); setErr(null)
    void (async () => {
      try {
        const buf = await (await fetch(src)).arrayBuffer()
        const XLSX = await import('xlsx')
        const book = XLSX.read(buf, { type: 'array' })
        const data: Record<string, string[][]> = {}
        for (const s of book.SheetNames) {
          const rows = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[s], { header: 1, defval: '' }).slice(0, 2000)
          data[s] = rows.map((r) => (Array.isArray(r) ? r : [r]).map((c) => (c == null ? '' : String(c))))
        }
        if (!dead) setWb({ sheets: book.SheetNames, data })
      } catch (e) { if (!dead) setErr((e as Error).message) }
    })()
    return () => { dead = true }
  }, [src])
  if (err) return <Fallback path={name} src={src} msg={`Spreadsheet preview failed: ${err}`} />
  if (!wb) return <div className="p-3 text-[13px] text-muted-foreground">Loading spreadsheet…</div>
  const cur = wb.sheets[Math.min(sheet, wb.sheets.length - 1)]
  const rows = wb.data[cur] ?? []
  return (
    <div className="flex h-full min-h-0 flex-col">
      {wb.sheets.length > 1 && (
        <div className="flex h-8 shrink-0 items-end gap-0.5 border-b border-border px-2 pt-1">
          {wb.sheets.map((s, i) => (
            <button key={s} onClick={() => setSheet(i)}
              className={cn('h-7 cursor-pointer rounded-t-[5px] border border-b-0 border-border px-2.5 text-[12px]', i === sheet ? 'bg-background font-medium text-foreground' : 'bg-card text-muted-foreground hover:text-foreground')}>{s}</button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="border-collapse text-[12px]">
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={i === 0 ? 'sticky top-0 z-[1] bg-card font-medium' : 'hover:bg-tint-secondary/50'}>
                <td className="sticky left-0 border-b border-r border-border bg-card px-1.5 py-1 text-right text-[10px] text-muted-foreground">{i + 1}</td>
                {r.map((c, j) => <td key={j} className="whitespace-nowrap border-b border-r border-border px-2 py-1 align-top">{c}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export { EditorPanel, type WsEntry, WorkspacePanel };
