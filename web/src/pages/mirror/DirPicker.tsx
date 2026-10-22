import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ChevronDown, FileText, Folder, FolderOpen, FolderPlus, Pencil, Trash2 } from 'lucide-react'
import { adminFetch } from '@/lib/api'
import { cn } from '@/lib/utils'
import { FileIcon } from '@/lib/fileIcon'

interface DirList {
  cwd: string
  parent: string | null
  dirs: { name: string; path: string }[]
}

interface SshEntry {
  name: string
  path: string
  dir: boolean
  size: number
  mtime: number
}

const base = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
const joinPath = (dir: string, name: string) =>
  `${dir.replace(/[\\/]+$/, '')}${dir.includes('\\') ? '\\' : '/'}${name}`

/** New-session workspace picker — desktop parity. Quick list (default /
 * recent session dirs / configured workspaces) plus a real filesystem
 * browser backed by GET /api/admin/fs/dirs. With `ssh` set it browses the
 * REMOTE host via /api/admin/ssh/fs (dirs + files, mkdir/rename/delete/edit)
 * and /api/admin/ssh/dirs. Empty value = server default. */
export default function DirPicker({ value, onChange, repos, recents, primaryCwd, ssh }: {
  value: string
  onChange: (v: string) => void
  repos: { name: string; org: string }[]
  recents: string[]
  primaryCwd?: string
  ssh?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [browse, setBrowse] = useState<string | null>(null)
  const [listing, setListing] = useState<DirList | null>(null)
  const [sshFiles, setSshFiles] = useState<SshEntry[]>([])
  const [pathInput, setPathInput] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null)
  const [renaming, setRenaming] = useState<{ path: string; name: string } | null>(null)
  const [editing, setEditing] = useState<{ path: string; content: string } | null>(null)
  const [mkdirInput, setMkdirInput] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node) && !menuRef.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  useEffect(() => {
    if (browse == null) return
    setErr(null)
    if (ssh) {
      void adminFetch<{ cwd: string; entries: SshEntry[] }>('/api/admin/ssh/fs', {
        method: 'POST',
        body: JSON.stringify({ target: ssh, op: 'list', path: browse }),
      })
        .then((r) => {
          const dirs = r.entries.filter((e) => e.dir).map((e) => ({ name: e.name, path: e.path }))
          setListing({ cwd: r.cwd, parent: r.cwd === '/' ? null : (r.cwd.replace(/\/[^/]+$/, '') || '/') , dirs })
          setSshFiles(r.entries.filter((e) => !e.dir))
          setPathInput(r.cwd)
        })
        .catch((e) => setErr((e as Error)?.message || 'ssh')
        )
      return
    }
    void adminFetch<DirList>(`/api/admin/fs/dirs?path=${encodeURIComponent(browse)}`)
      .then((r) => { setListing(r); setSshFiles([]); setPathInput(r.cwd) })
      .catch(() => setErr('bad_path'))
  }, [browse, ssh])

  const pick = (v: string) => { onChange(v); setOpen(false); setBrowse(null) }
  const sshOp = async (body: Record<string, unknown>) => {
    if (!ssh || busy) return
    setBusy(true)
    try {
      await adminFetch('/api/admin/ssh/fs', { method: 'POST', body: JSON.stringify({ target: ssh, ...body }) })
      // force re-list by nudging browse through a fresh value
      const b = browse
      setBrowse(null)
      setTimeout(() => setBrowse(b), 0)
    } catch (e) {
      setErr((e as Error)?.message || 'ssh_fs_failed')
    } finally {
      setBusy(false)
    }
  }

  const itemCls = 'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] leading-[18px] hover:bg-accent'
  // Dedupe across sections, seeded with the default so it never double-lists.
  const lists = (() => {
    const seen = new Set<string>(primaryCwd ? [primaryCwd] : [])
    const take = (p: string) => !!p && !seen.has(p) && (seen.add(p), true)
    return { recents: recents.filter(take), repos: repos.filter((r) => take(r.org)) }
  })()

  const dirRow = (d: { name: string; path: string }) => (
    <div key={d.path} className="group flex items-center">
      {renaming?.path === d.path ? (
        <input
          autoFocus
          defaultValue={d.name}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const v = (e.target as HTMLInputElement).value.trim()
              if (v && v !== d.name) void sshOp({ op: 'rename', path: d.path, to: joinPath(listing?.cwd ?? '', v) })
              setRenaming(null)
            }
            if (e.key === 'Escape') setRenaming(null)
          }}
          spellCheck={false}
          className="mx-1 h-7 min-w-0 flex-1 rounded-md bg-accent px-2 text-[13px] outline-none"
        />
      ) : (
        <button className={cn(itemCls, 'min-w-0 flex-1')} onClick={() => setBrowse(d.path)} title={d.path}>
          <Folder size={13} className="shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-left">{d.name}</span>
        </button>
      )}
      {ssh && renaming?.path !== d.path && (
        <span className="flex shrink-0 items-center opacity-0 group-hover:opacity-100">
          <button aria-label={t('dir.rename')} onClick={() => setRenaming({ path: d.path, name: d.name })}
            className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
            <Pencil size={12} />
          </button>
          <button aria-label={t('dir.delete')} disabled={busy}
            onClick={() => { if (confirm(t('dir.delConfirm', { name: d.name }))) void sshOp({ op: 'delete', path: d.path }) }}
            className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-red-500">
            <Trash2 size={12} />
          </button>
        </span>
      )}
    </div>
  )

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
        className={cn('flex h-7 max-w-[360px] cursor-pointer items-center gap-[3px] overflow-hidden whitespace-nowrap rounded-full px-[6px] text-[13px] leading-[18px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground', open && 'bg-tint-secondary text-foreground')}
        title={value || primaryCwd}
      >
        <Folder size={14} className="shrink-0" />
        <span className="min-w-0 truncate">{value ? base(value) : t('dir.default')}</span>
        <ChevronDown size={11} className="shrink-0 opacity-60" />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
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
                <span className="min-w-0 flex-1 truncate text-left">{t('dir.defaultParen', { cwd: primaryCwd || t('dir.serverDir') })}</span>
              </button>
              {!ssh && lists.recents.length > 0 && (
                <p className="px-2 pb-0.5 pt-1.5 text-[11px] leading-[16px] text-muted-foreground">{t('dir.recents')}</p>
              )}
              {!ssh && lists.recents.map((p) => (
                <button key={p} className={itemCls} onClick={() => pick(p)} title={p}>
                  <Folder size={13} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-left">{p}</span>
                </button>
              ))}
              {!ssh && lists.repos.length > 0 && (
                <p className="px-2 pb-0.5 pt-1.5 text-[11px] leading-[16px] text-muted-foreground">{t('dir.projects')}</p>
              )}
              {!ssh && lists.repos.map((r) => (
                <button key={r.org} className={itemCls} onClick={() => pick(r.org)} title={r.org}>
                  <Folder size={13} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-left">{r.name} — {r.org}</span>
                </button>
              ))}
              <div className="my-1 h-px bg-border" />
              <button className={itemCls} onClick={() => setBrowse(value || primaryCwd || (ssh ? '~' : 'roots'))}>
                <FolderOpen size={13} className="shrink-0 text-muted-foreground" />
                <span className="flex-1 text-left">{t('dir.browse')}</span>
              </button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-1 px-1 pb-1">
                <button
                  aria-label={t('dir.back')}
                  onClick={() => setBrowse(null)}
                  className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <ArrowLeft size={14} />
                </button>
                <input
                  value={pathInput}
                  onChange={(e) => setPathInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && pathInput.trim()) setBrowse(pathInput.trim()) }}
                  placeholder={t('dir.pathPh')}
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
                {(listing?.dirs ?? []).map(dirRow)}
                {ssh && sshFiles.map((f) => (
                  <div key={f.path} className="group flex items-center">
                    {renaming?.path === f.path ? (
                      <input
                        autoFocus
                        defaultValue={f.name}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            const v = (e.target as HTMLInputElement).value.trim()
                            if (v && v !== f.name) void sshOp({ op: 'rename', path: f.path, to: joinPath(listing?.cwd ?? '', v) })
                            setRenaming(null)
                          }
                          if (e.key === 'Escape') setRenaming(null)
                        }}
                        spellCheck={false}
                        className="mx-1 h-7 min-w-0 flex-1 rounded-md bg-accent px-2 text-[13px] outline-none"
                      />
                    ) : (
                      <span className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-[13px] leading-[18px] text-muted-foreground" title={f.path}>
                        <FileIcon path={f.name} size={13} className="shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{f.name}</span>
                        <span className="shrink-0 text-[11px]">{f.size > 1048576 ? `${(f.size / 1048576).toFixed(1)}M` : f.size > 1024 ? `${Math.round(f.size / 1024)}K` : `${f.size}B`}</span>
                      </span>
                    )}
                    {renaming?.path !== f.path && (
                      <span className="flex shrink-0 items-center opacity-0 group-hover:opacity-100">
                        <button aria-label={t('dir.edit')} disabled={busy}
                          onClick={() => {
                            void adminFetch<{ content: string }>('/api/admin/ssh/fs', {
                              method: 'POST',
                              body: JSON.stringify({ target: ssh, op: 'read', path: f.path }),
                            }).then((r) => setEditing({ path: f.path, content: r.content }))
                              .catch((e) => setErr((e as Error)?.message || 'read_failed'))
                          }}
                          className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
                          <FileText size={12} />
                        </button>
                        <button aria-label={t('dir.rename')} onClick={() => setRenaming({ path: f.path, name: f.name })}
                          className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
                          <Pencil size={12} />
                        </button>
                        <button aria-label={t('dir.delete')} disabled={busy}
                          onClick={() => { if (confirm(t('dir.delConfirm', { name: f.name }))) void sshOp({ op: 'delete', path: f.path }) }}
                          className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-red-500">
                          <Trash2 size={12} />
                        </button>
                      </span>
                    )}
                  </div>
                ))}
                {err && <p className="px-2 py-1.5 text-[12px] leading-[16px] text-red-500">{err === 'bad_path' ? t('dir.unreadable') : err}</p>}
                {!err && listing && !listing.dirs.length && !sshFiles.length && (
                  <p className="px-2 py-1.5 text-[12px] leading-[16px] text-muted-foreground">{t('dir.noSub')}</p>
                )}
              </div>
              {ssh && (
                <div className="px-1 pt-1">
                  {mkdirInput != null ? (
                    <div className="flex items-center gap-1">
                      <FolderPlus size={13} className="ml-1 shrink-0 text-muted-foreground" />
                      <input
                        autoFocus
                        defaultValue={mkdirInput}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            const v = (e.target as HTMLInputElement).value.trim()
                            if (v) void sshOp({ op: 'mkdir', path: joinPath(listing?.cwd ?? '', v) })
                            setMkdirInput(null)
                          }
                          if (e.key === 'Escape') setMkdirInput(null)
                        }}
                        placeholder={t('dir.newFolderPh')}
                        spellCheck={false}
                        className="h-7 min-w-0 flex-1 rounded-md bg-accent px-2 text-[12px] outline-none"
                      />
                    </div>
                  ) : (
                    <button className={itemCls} onClick={() => setMkdirInput('')}>
                      <FolderPlus size={13} className="shrink-0 text-muted-foreground" />
                      <span className="flex-1 text-left">{t('dir.newFolder')}</span>
                    </button>
                  )}
                </div>
              )}
              <div className="mt-1 flex items-center justify-between gap-2 border-t border-border px-2 py-1.5">
                <span className="min-w-0 flex-1 truncate text-[11px] leading-[16px] text-muted-foreground" title={listing?.cwd}>{listing?.cwd || '…'}</span>
                <button
                  disabled={!listing?.cwd}
                  onClick={() => listing?.cwd && pick(listing.cwd)}
                  className="shrink-0 cursor-pointer rounded-md bg-primary px-2 py-1 text-[12px] leading-[16px] text-primary-foreground hover:opacity-90 disabled:opacity-40"
                >
                  {t('dir.use')}
                </button>
              </div>
            </>
          )}
        </div>,
        document.body,
      )}
      {editing && createPortal(
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={() => setEditing(null)}>
          <div className="flex w-[560px] max-w-full flex-col overflow-hidden rounded-[12px] border border-border bg-card shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <span className="min-w-0 truncate text-[13px] text-muted-foreground" title={editing.path}>{editing.path}</span>
            </div>
            <textarea
              value={editing.content}
              onChange={(e) => setEditing({ ...editing, content: e.target.value })}
              spellCheck={false}
              className="h-[360px] w-full resize-none bg-transparent p-3 font-mono text-[12px] leading-[18px] outline-none"
            />
            <div className="flex items-center justify-end gap-1.5 border-t border-border px-3 py-2">
              <button onClick={() => setEditing(null)} className="cursor-pointer rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-accent">
                {t('common.cancel')}
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  const p = editing.path
                  void adminFetch('/api/admin/ssh/fs', {
                    method: 'POST',
                    body: JSON.stringify({ target: ssh, op: 'write', path: p, content: editing.content }),
                  }).then(() => setEditing(null)).catch((e) => setErr((e as Error)?.message || 'write_failed'))
                }}
                className="cursor-pointer rounded-md bg-primary px-2 py-1 text-[12px] text-primary-foreground hover:opacity-90 disabled:opacity-40"
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
