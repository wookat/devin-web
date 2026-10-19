import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ChevronDown, Folder, FolderOpen } from 'lucide-react'
import { adminFetch } from '@/lib/api'
import { cn } from '@/lib/utils'

interface DirList {
  cwd: string
  parent: string | null
  dirs: { name: string; path: string }[]
}

const base = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

/** New-session workspace picker — desktop parity. Quick list (default /
 * recent session dirs / configured workspaces) plus a real filesystem
 * browser backed by GET /api/admin/fs/dirs. Empty value = server default. */
export default function DirPicker({ value, onChange, repos, recents, primaryCwd }: {
  value: string
  onChange: (v: string) => void
  repos: { name: string; org: string }[]
  recents: string[]
  primaryCwd?: string
}) {
  const [open, setOpen] = useState(false)
  const [browse, setBrowse] = useState<string | null>(null)
  const [listing, setListing] = useState<DirList | null>(null)
  const [pathInput, setPathInput] = useState('')
  const [err, setErr] = useState(false)
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  useEffect(() => {
    if (browse == null) return
    setErr(false)
    void adminFetch<DirList>(`/api/admin/fs/dirs?path=${encodeURIComponent(browse)}`)
      .then((r) => { setListing(r); setPathInput(r.cwd) })
      .catch(() => setErr(true))
  }, [browse])

  const pick = (v: string) => { onChange(v); setOpen(false); setBrowse(null) }
  const itemCls = 'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] leading-[18px] hover:bg-accent'
  // Dedupe across sections, seeded with the default so it never double-lists.
  const lists = (() => {
    const seen = new Set<string>(primaryCwd ? [primaryCwd] : [])
    const take = (p: string) => !!p && !seen.has(p) && (seen.add(p), true)
    return { recents: recents.filter(take), repos: repos.filter((r) => take(r.org)) }
  })()

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        ref={btnRef}
        onClick={() => {
          if (!open && btnRef.current) {
            const r = btnRef.current.getBoundingClientRect()
            const w = Math.min(340, window.innerWidth - 16)
            setAnchor({ left: Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8)), top: r.bottom + 4 })
          }
          setOpen((v) => !v)
        }}
        className="flex max-w-[360px] cursor-pointer items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-[12px] leading-[16px] text-foreground hover:bg-accent"
        title={value || primaryCwd}
      >
        <Folder size={12} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{value ? base(value) : '默认目录'}</span>
        <ChevronDown size={12} className="shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <div
          className="menu-in fixed z-50 overflow-y-auto rounded-[10px] bg-white/[.94] p-1 text-popover-foreground shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)] outline outline-1 outline-black/[.08] backdrop-blur-[8px] dark:bg-[#1f1f1f]/[.94] dark:outline-white/[.04] dark:-outline-offset-1"
          style={{
            left: anchor?.left ?? 8,
            top: anchor?.top ?? 8,
            width: Math.min(340, window.innerWidth - 16),
            maxHeight: anchor ? window.innerHeight - anchor.top - 8 : '70vh',
          }}
        >
          {browse == null ? (
            <>
              <button className={itemCls} onClick={() => pick('')}>
                <Folder size={13} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-left">默认（{primaryCwd || '服务目录'}）</span>
              </button>
              {lists.recents.length > 0 && (
                <p className="px-2 pb-0.5 pt-1.5 text-[11px] leading-[16px] text-muted-foreground">最近使用</p>
              )}
              {lists.recents.map((p) => (
                <button key={p} className={itemCls} onClick={() => pick(p)} title={p}>
                  <Folder size={13} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-left">{p}</span>
                </button>
              ))}
              {lists.repos.length > 0 && (
                <p className="px-2 pb-0.5 pt-1.5 text-[11px] leading-[16px] text-muted-foreground">项目</p>
              )}
              {lists.repos.map((r) => (
                <button key={r.org} className={itemCls} onClick={() => pick(r.org)} title={r.org}>
                  <Folder size={13} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-left">{r.name} — {r.org}</span>
                </button>
              ))}
              <div className="my-1 h-px bg-border" />
              <button className={itemCls} onClick={() => setBrowse(value || primaryCwd || 'roots')}>
                <FolderOpen size={13} className="shrink-0 text-muted-foreground" />
                <span className="flex-1 text-left">浏览文件夹…</span>
              </button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-1 px-1 pb-1">
                <button
                  aria-label="Back"
                  onClick={() => setBrowse(null)}
                  className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <ArrowLeft size={14} />
                </button>
                <input
                  value={pathInput}
                  onChange={(e) => setPathInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && pathInput.trim()) setBrowse(pathInput.trim()) }}
                  placeholder="输入或粘贴路径…"
                  spellCheck={false}
                  className="h-7 min-w-0 flex-1 rounded-md bg-transparent px-2 text-[12px] leading-[16px] outline-none placeholder:text-muted-foreground focus:bg-accent"
                />
              </div>
              <div className="max-h-[280px] overflow-y-auto">
                {listing?.parent != null && (
                  <button className={itemCls} onClick={() => setBrowse(listing.parent)}>
                    <span className="flex w-[13px] shrink-0 justify-center text-muted-foreground">↩</span>
                    <span className="flex-1 text-left text-muted-foreground">..</span>
                  </button>
                )}
                {(listing?.dirs ?? []).map((d) => (
                  <button key={d.path} className={itemCls} onClick={() => setBrowse(d.path)} title={d.path}>
                    <Folder size={13} className="shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-left">{d.name}</span>
                  </button>
                ))}
                {err && <p className="px-2 py-1.5 text-[12px] leading-[16px] text-red-500">目录不可读</p>}
                {!err && listing && !listing.dirs.length && (
                  <p className="px-2 py-1.5 text-[12px] leading-[16px] text-muted-foreground">没有子目录</p>
                )}
              </div>
              <div className="mt-1 flex items-center justify-between gap-2 border-t border-border px-2 py-1.5">
                <span className="min-w-0 flex-1 truncate text-[11px] leading-[16px] text-muted-foreground" title={listing?.cwd}>{listing?.cwd || '…'}</span>
                <button
                  disabled={!listing?.cwd}
                  onClick={() => listing?.cwd && pick(listing.cwd)}
                  className="shrink-0 cursor-pointer rounded-md bg-primary px-2 py-1 text-[12px] leading-[16px] text-primary-foreground hover:opacity-90 disabled:opacity-40"
                >
                  使用此目录
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
