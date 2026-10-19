import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, ChevronRight, RefreshCw, Folder as FolderIcon, FolderOpen, File as FileIcon } from 'lucide-react'
import { adminFetch } from '@/lib/api'
import { preview } from './timelineUtil'

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

interface WsEntry { name: string; dir: boolean; size: number; mtime: string }

/** Workspace file browser: maps the session's project directory into the panel.
 *  Server-confined to the session cwd; read-only text/binary preview. */
function WorkspacePanel({ id }: { id: string }) {
  const [rel, setRel] = useState('')
  const [cwd, setCwd] = useState('')
  const [entries, setEntries] = useState<WsEntry[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [file, setFile] = useState<{ path: string; text: string | null; binary?: boolean; tooLarge?: boolean; truncated?: boolean; error?: string } | null>(null)
  const [loading, setLoading] = useState(false)

  const openDir = useCallback(async (p: string) => {
    setLoading(true)
    try {
      const r = await adminFetch<{ cwd: string; path: string; entries: WsEntry[]; error: string | null }>(
        `/api/admin/session/${id}/files?path=${encodeURIComponent(p)}&all=1`)
      setCwd(r.cwd)
      setRel(r.path ?? p)
      setEntries(r.entries ?? [])
      setErr(r.error)
      setFile(null)
    } catch (e) { setErr((e as Error).message) } finally { setLoading(false) }
  }, [id])

  const openFile = useCallback(async (p: string) => {
    setLoading(true)
    try {
      const r = await adminFetch<{ path: string; text: string | null; binary?: boolean; tooLarge?: boolean; size?: number; error?: string }>(
        `/api/admin/session/${id}/file?path=${encodeURIComponent(p)}`)
      setFile(r)
    } catch (e) { setFile({ path: p, text: null, error: (e as Error).message }) } finally { setLoading(false) }
  }, [id])

  useEffect(() => { void openDir('') }, [openDir])

  const crumbs = rel ? rel.split('/').filter(Boolean) : []
  const fmtSize = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5 text-[12px] text-muted-foreground">
        <FolderOpen size={13} className="shrink-0" />
        <button className="cursor-pointer rounded px-1 hover:bg-accent hover:text-foreground" onClick={() => void openDir('')} title={cwd}>
          {cwd ? (cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? cwd) : 'workspace'}
        </button>
        {crumbs.map((c, i) => {
          const p = crumbs.slice(0, i + 1).join('/')
          return (
            <span key={p} className="flex items-center gap-1">
              <ChevronRight size={11} />
              <button className="cursor-pointer rounded px-1 hover:bg-accent hover:text-foreground" onClick={() => void openDir(p)}>{c}</button>
            </span>
          )
        })}
        <button
          className="ml-auto flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Refresh" title="Refresh"
          onClick={() => void (file ? openFile(file.path) : openDir(rel))}
        >
          <RefreshCw size={12} />
        </button>
      </div>
      {file ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
            <button className="flex cursor-pointer items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground" onClick={() => setFile(null)}>
              <ArrowLeft size={12} /> Back
            </button>
            <span className="min-w-0 truncate font-mono text-[12px]">{file.path}</span>
          </div>
          {file.error ? <div className="p-3 text-[13px] text-red-500">{file.error}</div>
            : file.tooLarge ? <div className="p-3 text-[13px] text-muted-foreground">File too large to preview (over 2 MB)</div>
            : file.binary || file.text == null ? <div className="p-3 text-[13px] text-muted-foreground">Binary file — preview not supported</div>
            : <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[12px] leading-[18px] whitespace-pre-wrap break-all">{file.truncated ? `${file.text}\n… (truncated)` : file.text}</pre>}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-1">
          {err && <div className="p-3 text-[13px] text-red-500">{err}</div>}
          {loading && <div className="p-3 text-[13px] text-muted-foreground">Loading…</div>}
          {!loading && !err && entries.length === 0 && <div className="p-3 text-[13px] text-muted-foreground">Empty directory</div>}
          {entries.map((e) => (
            <button
              key={e.name}
              onClick={() => void (e.dir ? openDir(rel ? `${rel}/${e.name}` : e.name) : openFile(rel ? `${rel}/${e.name}` : e.name))}
              className="flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 py-[5px] text-left text-[13px] hover:bg-accent"
            >
              {e.dir ? <FolderIcon size={15} className="shrink-0 text-muted-foreground" /> : <FileIcon size={15} className="shrink-0 text-muted-foreground" />}
              <span className="min-w-0 flex-1 truncate">{e.name}</span>
              {!e.dir && <span className="shrink-0 text-[11px] text-muted-foreground">{fmtSize(e.size)}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Interactive workspace shell — moved to web/src/components/TermPanel.tsx so
 * LocalDock's SSH/forward tools can reuse it without a circular import. */


export { EditorPanel, type WsEntry, WorkspacePanel };
