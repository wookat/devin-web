import { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, ChevronRight, ChevronDown, ChevronLeft, Settings2, Copy, Check, RotateCcw, Archive, ArchiveRestore, Plus, CircleDot, ArrowUp, Link2, List, X, Expand, ChevronsUpDown, Pin, PinOff, MoreHorizontal, Folder as FolderIcon, Pencil, Search, Clock, ListFilter, GitPullRequest, Lock } from 'lucide-react'
import { adminFetch } from '@/lib/api'
import { StatusDot } from '@/components/ui'
import { cn } from '@/lib/utils'
import { sessionMirrorPath } from '@/lib/mirrorLinks'
import { type MirrorTreeSession, relTime } from './treeCache'
import { mapEnum, actionCls } from './statusReduce'
import { type Group } from './composerMeta'
import { time } from './timelineUtil'

function TreeRow({ s, depth, activeDevinId, folders, onOpen, onPrefetch, onRefresh, archivedView, compact, propHidden }: { s: MirrorTreeSession; depth: number; activeDevinId: string; folders: string[]; onOpen: (s: MirrorTreeSession) => void; onPrefetch?: (s: MirrorTreeSession) => void; onRefresh?: () => void; archivedView?: boolean; compact?: boolean; propHidden?: Record<string, boolean> }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [allKids, setAllKids] = useState<MirrorTreeSession[] | null>(null)
  const [kidsBusy, setKidsBusy] = useState(false)
  const kids = allKids ?? s.children
  const [menu, setMenu] = useState<'closed' | 'main' | 'folder' | 'rename' | 'newfolder'>('closed')
  const [draft, setDraft] = useState('')
  const [menuPos, setMenuPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 })
  const [subPos, setSubPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 })
  const openFolderSub = (e: React.MouseEvent) => {
    const item = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const panel = (e.currentTarget as HTMLElement).closest('[role="menu"]')?.getBoundingClientRect()
    setSubPos({ left: Math.min((panel?.right ?? item.right) - 2, window.innerWidth - 244), top: Math.min(item.top - 4, window.innerHeight - 244) })
    setMenu('folder')
  }
  const rowAction = async (path: string, body: Record<string, unknown>) => {
    if (busy) return
    setBusy(true)
    try {
      await adminFetch<{ ok: boolean }>(path, { method: 'POST', body: JSON.stringify(body) })
      onRefresh?.()
    } finally {
      setBusy(false)
    }
  }
  const hasKids = s.children.length > 0 || s.total_children > 0
  const active = s.devin_id === activeDevinId
  const enu = mapEnum(s.status_enum || s.activity_status)
  // Official rows are 30px one-line; rows with a subtitle line (Working status / Last updated / PR count) render 44px two-line.
  const subtitle = !compact && !propHidden?.['Status'] && enu === 'working' ? 'Working' : null
  const subTime = !compact && !subtitle && !propHidden?.['Last updated'] ? relTime(s.updated_at) : ''
  const allPrs = !propHidden?.['Pull requests'] ? (s.pull_requests || []) : []
  const prs = compact ? [] : allPrs
  const showArchivedIcon = !compact && !!archivedView && !propHidden?.['Archived']
  const awakeMs = s.keep_alive_until ? new Date(s.keep_alive_until).getTime() - Date.now() : 0
  const awakeLabel = awakeMs > 0 ? `Awake for ${Math.floor(awakeMs / 36e5)}h ${Math.floor((awakeMs % 36e5) / 6e4)}m` : ''
  const hasSub = !!(subtitle || subTime || prs.length || showArchivedIcon || (!compact && awakeLabel))
  const compactPr = compact && !propHidden?.['Pull requests'] ? allPrs[0] : undefined
  const prColor = (st: string, draft: boolean) => draft ? 'text-muted-foreground' : st === 'closed' ? 'text-[#f53b3a]' : st === 'merged' ? 'text-[rgb(149,108,222)]' : 'text-green-600'
  return (
    <>
      <div
        data-slot="sidebar-menu-item"
        onContextMenu={(e) => {
          e.preventDefault()
          setMenuPos({ left: Math.max(4, Math.min(e.clientX, window.innerWidth - 230)), top: Math.min(e.clientY, window.innerHeight - 244) })
          setMenu('main')
        }}
        onPointerEnter={() => onPrefetch?.(s)}
        onTouchStart={() => onPrefetch?.(s)}
        className={cn('group/row relative mb-px mt-px flex items-center gap-1.5 rounded-md pr-2 hover:bg-tint-secondary has-[:focus-visible]:bg-tint-secondary [content-visibility:auto]', hasSub ? 'h-11 [contain-intrinsic-block-size:44px]' : 'h-[30px] [contain-intrinsic-block-size:30px]', (active || menu !== 'closed') && 'bg-tint-secondary')}
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        <a
          data-slot="sidebar-menu-button"
          href={`/admin/d/${s.devin_id.replace(/^devin-/, '')}`}
          aria-current={active ? 'page' : undefined}
          aria-label={s.title || s.devin_id}
          onClick={(e) => { e.preventDefault(); onOpen(s) }}
          className="absolute inset-0 cursor-pointer rounded-md"
        />
        {hasKids && (
          <button
            onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}
            className="relative z-10 flex size-4 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent"
            aria-label={open ? 'Collapse' : 'Expand'}
          >
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        )}
        <StatusDot status={enu} className="!h-2 !w-2 shrink-0" />
        {s.is_locked && !s.loaded_here && (
          <span
            aria-label="Locked by another process"
            title={`占用中 — 该会话正被另一个进程（桌面端/CLI/其他工作台）持有\n加载可能被拒绝`}
            className="relative z-10 flex size-4 shrink-0 items-center justify-center text-amber-500"
          >
            <Lock size={12} />
          </span>
        )}
        {compact && !propHidden?.['Status'] && enu === 'working' ? (
          <span aria-label="Working" title="Working" className={cn('relative z-10 flex size-4 shrink-0 items-center justify-center text-muted-foreground group-hover/sidebar:invisible group-has-[:focus-visible]/row:invisible', menu !== 'closed' && 'invisible')}>
            <svg aria-hidden="true" className="motion-safe:animate-spin" width={16} height={16} viewBox="0 0 24 24" fill="none"><path d="M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2" /><path d="M20.9451 13C20.4839 17.1716 17.1716 20.4839 13 20.9451" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          </span>
        ) : compactPr ? (
          compactPr.pr_url ? (
            <a href={compactPr.pr_url} target="_blank" rel="noreferrer" aria-label="Open pull request" title="Open pull request" onClick={(e) => e.stopPropagation()} className={cn('relative z-10 flex size-[18px] shrink-0 items-center justify-center rounded-[4px] group-hover/sidebar:invisible group-has-[:focus-visible]/row:invisible', menu !== 'closed' && 'invisible', prColor(compactPr.state, compactPr.draft))}>
              <GitPullRequest size={14} />
            </a>
          ) : (
            <span className={cn('flex size-[18px] shrink-0 items-center justify-center group-hover/sidebar:invisible group-has-[:focus-visible]/row:invisible', menu !== 'closed' && 'invisible', prColor(compactPr.state, compactPr.draft))}><GitPullRequest size={14} /></span>
          )
        ) : null}
        <span className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <span className={cn('min-w-0 truncate text-[13px] leading-[18px]', s.is_unread ? 'font-semibold text-foreground' : 'text-foreground/90', s.resumable === false && 'text-muted-foreground')}>
            {s.title || s.devin_id}
          </span>
          {hasSub && (
            <span className="flex min-w-0 items-center whitespace-nowrap text-[12px] leading-[16px] text-muted-foreground">
              {s.resumable === false && (
                <>
                  <span className="mr-1 shrink-0 rounded bg-muted px-1 text-[10px] leading-[15px]" title="句柄已失效（宿主进程已重启/重放），不能续聊">已失效</span>
                </>
              )}
              <span className="truncate">{subtitle || subTime}</span>
              {prs.length > 0 && (
                <>
                  <span className="mx-1 text-muted-foreground/60">·</span>
                  {prs[0].pr_url ? (
                    <a
                      href={prs[0].pr_url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="relative z-10 -mx-0.5 flex items-center gap-0.5 rounded px-0.5 hover:text-foreground"
                    >
                      <GitPullRequest size={12} />
                      <span>{prs.length}</span>
                    </a>
                  ) : (
                    <span className="flex items-center gap-0.5"><GitPullRequest size={12} /><span>{prs.length}</span></span>
                  )}
                </>
              )}
              {awakeLabel && (
                <>
                  <span className="mx-1 text-muted-foreground/60">·</span>
                  <span aria-label={awakeLabel} title={awakeLabel} className="flex size-4 shrink-0 items-center justify-center text-blue-500">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" aria-hidden="true" width={14} height={14}><path d="M7.3 5.9c-.8-1 .8-1.8 0-2.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><path d="M10.5 5.7c-.9-1.3.9-2.4 0-3.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><path d="M13.7 5.9c-.8-1 .8-1.8 0-2.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><ellipse cx="10.5" cy="9.9" rx="9" ry="3.6" stroke="currentColor" strokeWidth="1.5" /><ellipse cx="10.5" cy="9.9" rx="6.8" ry="2.2" fill="currentColor" /><path d="M1.5 9.9c.4 7.5 3.9 12 9 12s8.6-4.5 9-12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><path d="M19.4 12.2c2.2-.45 3.4.55 3.15 2-.3 1.5-2 2.2-3.8 1.95" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                  </span>
                </>
              )}
              {showArchivedIcon && (
                <>
                  <span className="mx-1 text-muted-foreground/60">·</span>
                  <span aria-label="Archived" title="Archived" className="flex size-4 shrink-0 items-center justify-center text-orange-500"><Archive size={14} /></span>
                </>
              )}
            </span>
          )}
        </span>
        {s.is_unread && <span className="size-1.5 shrink-0 rounded-full bg-blue-500 group-hover/row:hidden" />}
        {hasKids && !open && <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground group-hover/row:hidden">{s.total_children || s.children.length}</span>}
        <span data-slot="sidebar-menu-actions" className="pointer-events-auto relative z-10 flex shrink-0 flex-row items-center gap-px">
          {compact && awakeLabel && (
            <span aria-label={awakeLabel} title={awakeLabel} className="flex size-4 shrink-0 items-center justify-center text-blue-500">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" aria-hidden="true" width={14} height={14}><path d="M7.3 5.9c-.8-1 .8-1.8 0-2.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><path d="M10.5 5.7c-.9-1.3.9-2.4 0-3.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><path d="M13.7 5.9c-.8-1 .8-1.8 0-2.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><ellipse cx="10.5" cy="9.9" rx="9" ry="3.6" stroke="currentColor" strokeWidth="1.5" /><ellipse cx="10.5" cy="9.9" rx="6.8" ry="2.2" fill="currentColor" /><path d="M1.5 9.9c.4 7.5 3.9 12 9 12s8.6-4.5 9-12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><path d="M19.4 12.2c2.2-.45 3.4.55 3.15 2-.3 1.5-2 2.2-3.8 1.95" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            </span>
          )}
          <button
            data-slot="sidebar-menu-action"
            aria-label={s.is_pinned ? 'Unpin' : 'Pin'}
            title={s.is_pinned ? 'Unpin' : 'Pin'}
            disabled={busy}
            onClick={(e) => { e.stopPropagation(); rowAction('/api/admin/mirror/session-pin', { devin_id: s.devin_id, pinned: !s.is_pinned }) }}
            className={actionCls(menu !== 'closed')}
          >
            {s.is_pinned ? <PinOff size={16} /> : <Pin size={16} />}
          </button>
          <button
            data-slot="sidebar-menu-action"
            aria-label={archivedView ? 'Unarchive' : 'Archive'}
            title={archivedView ? 'Unarchive' : 'Archive'}
            disabled={busy}
            onClick={(e) => { e.stopPropagation(); rowAction('/api/admin/mirror/session-archive', { devin_id: s.devin_id, archive: !archivedView }) }}
            className={actionCls(menu !== 'closed')}
          >
            {archivedView ? <ArchiveRestore size={16} /> : <Archive size={16} />}
          </button>
          <button
            data-slot="sidebar-menu-action"
            aria-label="More"
            title="More"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation()
              const r = e.currentTarget.getBoundingClientRect()
              setMenuPos({
                left: Math.max(4, Math.min(r.right - 220, window.innerWidth - 230)),
                top: Math.min(r.bottom + 4, window.innerHeight - 244),
              })
              setMenu((m) => (m === 'closed' ? 'main' : 'closed'))
            }}
            className={actionCls(menu !== 'closed')}
          >
            <MoreHorizontal size={16} />
          </button>
        </span>
        {menu !== 'closed' && createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); setMenu('closed') }} />
            <div
              role="menu"
              ref={(el) => { if (menu === 'main') el?.querySelector('button')?.focus() }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.stopPropagation(); setMenu(menu === 'rename' ? 'main' : 'closed'); return }
                if (e.key === 'ArrowRight' && menu === 'main' && (document.activeElement as HTMLElement)?.getAttribute('aria-haspopup') === 'menu') { e.stopPropagation(); openFolderSub({ currentTarget: document.activeElement } as unknown as React.MouseEvent); return }
                if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
                e.preventDefault()
                e.stopPropagation()
                const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
                const i = items.indexOf(document.activeElement as HTMLButtonElement)
                const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length
                items[next]?.focus()
              }}
              style={{ left: menuPos.left, top: menuPos.top }}
              className="menu-in fixed z-50 min-w-[220px] rounded-[10px] bg-white/[.94] dark:bg-[#1f1f1f]/[.94] p-1 text-popover-foreground shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)] outline outline-1 outline-black/[.08] backdrop-blur-[8px] dark:outline-white/[.04] dark:-outline-offset-1"
            >
              {menu === 'rename' ? (
                <input
                  autoFocus
                  value={draft}
                  placeholder="Session title"
                  onChange={(e) => setDraft(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Escape') setMenu('main')
                    if (e.key === 'Enter') {
                      const v = draft.trim()
                      setMenu('closed')
                      if (!v) return
                      if (v !== s.title) rowAction('/api/admin/mirror/session-title', { devin_id: s.devin_id, title: v })
                    }
                  }}
                  className="w-full rounded bg-transparent px-2 py-1.5 text-[13px] outline-none placeholder:text-muted-foreground"
                />
              ) : (
                <>
                  <button role="menuitem" aria-haspopup="menu" onMouseEnter={(e) => openFolderSub(e)} onClick={(e) => { e.stopPropagation(); openFolderSub(e) }} className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[13px] hover:bg-accent">
                    <FolderIcon size={13} className="text-muted-foreground" /> Folder <ChevronRight size={12} className="ml-auto text-muted-foreground" />
                  </button>
                  <button
                    role="menuitem"
                    onMouseEnter={() => { if (menu !== 'main') setMenu('main') }}
                    onClick={(e) => {
                      e.stopPropagation(); setDraft(s.title || ''); setMenu('rename')
                    }}
                    className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[13px] hover:bg-accent"
                  >
                    <Pencil size={13} className="text-muted-foreground" /> Rename
                  </button>
                  <button
                    role="menuitem"
                    onMouseEnter={() => { if (menu !== 'main') setMenu('main') }}
                    onClick={(e) => { e.stopPropagation(); setMenu('closed'); navigator.clipboard.writeText(`${window.location.origin}${sessionMirrorPath(s.devin_id)}`) }}
                    className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[13px] hover:bg-accent"
                  >
                    <Link2 size={13} className="text-muted-foreground" /> Copy session link
                  </button>
                  <button
                    role="menuitem"
                    onMouseEnter={() => { if (menu !== 'main') setMenu('main') }}
                    onClick={(e) => { e.stopPropagation(); setMenu('closed'); window.open(sessionMirrorPath(s.devin_id), '_blank', 'noopener') }}
                    className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[13px] hover:bg-accent"
                  >
                    <Expand size={13} className="text-muted-foreground" /> Open in new window
                  </button>
                </>
              )}
            </div>
            {(menu === 'folder' || menu === 'newfolder') && (
              <div
                role="menu"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') { e.stopPropagation(); setMenu(menu === 'newfolder' ? 'folder' : 'main'); return }
                  if (e.key === 'ArrowLeft' && menu === 'folder') { e.stopPropagation(); setMenu('main'); return }
                  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
                  e.preventDefault()
                  e.stopPropagation()
                  const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
                  const i = items.indexOf(document.activeElement as HTMLButtonElement)
                  const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length
                  items[next]?.focus()
                }}
                style={{ left: subPos.left, top: subPos.top }}
                className="menu-in fixed z-50 min-w-[220px] rounded-[10px] bg-white/[.94] dark:bg-[#1f1f1f]/[.94] p-1 text-popover-foreground shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)] outline outline-1 outline-black/[.08] backdrop-blur-[8px] dark:outline-white/[.04] dark:-outline-offset-1"
              >
                {menu === 'newfolder' ? (
                  <input
                    autoFocus
                    value={draft}
                    placeholder="Folder name"
                    onChange={(e) => setDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Escape') setMenu('folder')
                      if (e.key === 'Enter') {
                        const v = draft.trim()
                        setMenu('closed')
                        if (v) rowAction('/api/admin/mirror/session-folder', { devin_id: s.devin_id, folder: v })
                      }
                    }}
                    className="w-full rounded bg-transparent px-2 py-1.5 text-[13px] outline-none placeholder:text-muted-foreground"
                  />
                ) : (
                  <>
                    {folders.map((f) => (
                      <button key={f} role="menuitem" onClick={(e) => { e.stopPropagation(); setMenu('closed'); rowAction('/api/admin/mirror/session-folder', { devin_id: s.devin_id, folder: f }) }} className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[13px] hover:bg-accent">
                        <FolderIcon size={13} className="text-muted-foreground" /> <span className="truncate">{f}</span>
                      </button>
                    ))}
                    <button role="menuitem" onClick={(e) => {
                      e.stopPropagation(); setDraft(''); setMenu('newfolder')
                    }} className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[13px] hover:bg-accent">
                      <Plus size={13} className="text-muted-foreground" /> New folder
                    </button>
                    {s.folder && (
                      <button role="menuitem" onClick={(e) => { e.stopPropagation(); setMenu('closed'); rowAction('/api/admin/mirror/session-folder', { devin_id: s.devin_id, folder: null }) }} className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[13px] hover:bg-accent">
                        <X size={13} className="text-muted-foreground" /> Remove from folder
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </>,
          document.body,
        )}
      </div>
      {open && kids.map((c) => <TreeRow key={c.devin_id} s={c} depth={depth + 1} activeDevinId={activeDevinId} folders={folders} onOpen={onOpen} onPrefetch={onPrefetch} onRefresh={onRefresh} archivedView={archivedView} compact={compact} propHidden={propHidden} />)}
      {open && !allKids && s.total_children > s.children.length && (
        <div data-slot="sidebar-menu-item" className="group/row relative" style={{ paddingLeft: (depth + 1) * 14 }}>
          <button
            aria-label={`Show ${s.total_children - s.children.length} more session${s.total_children - s.children.length === 1 ? '' : 's'}`}
            disabled={kidsBusy}
            onClick={() => {
              setKidsBusy(true)
              adminFetch<{ children: MirrorTreeSession[] }>(`/api/admin/mirror/session-children?root=${s.devin_id}`)
                .then((r) => setAllKids(r.children || []))
                .catch(() => {})
                .finally(() => setKidsBusy(false))
            }}
            className="flex h-[30px] w-full items-center rounded-md px-2 text-[13px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground disabled:opacity-50"
          >
            Load more...
          </button>
        </div>
      )}
    </>
  )
}

/** Official-style inline month calendar for the Filter Custom… date range. */
function MenuCalendar({ title, range, onPick, onReset }: { title: string; range: [string, string]; onPick: (d: string) => void; onReset: () => void }) {
  const [month, setMonth] = useState(() => { const n = new Date(); return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1)) })
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  const label = (s: string) => s ? new Date(s + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—'
  const first = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1))
  const start = new Date(first); start.setUTCDate(1 - first.getUTCDay())
  const days: Date[] = Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setUTCDate(start.getUTCDate() + i); return d })
  return (
    <div className="px-2 pb-2" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between py-[5px]">
        <span className="text-[12px] font-medium text-muted-foreground">{title}</span>
        <button role="menuitem" onClick={onReset} className="cursor-pointer text-[12px] font-medium text-primary hover:underline">Reset</button>
      </div>
      <div className="flex items-center gap-2 pb-1 text-[12px] text-muted-foreground">
        <span>{label(range[0])}</span><span>{label(range[1])}</span>
      </div>
      <div className="flex items-center justify-between py-1">
        <button aria-label="Previous month" onClick={() => setMonth(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 1, 1)))} className="flex size-6 items-center justify-center rounded-md hover:bg-muted"><ChevronLeft size={13} /></button>
        <span className="text-[13px] font-medium">{month.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</span>
        <button aria-label="Next month" onClick={() => setMonth(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1)))} className="flex size-6 items-center justify-center rounded-md hover:bg-muted"><ChevronRight size={13} /></button>
      </div>
      <div className="grid grid-cols-7 text-center text-[12px] text-muted-foreground">{['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => <span key={d} className="p-px leading-4">{d}</span>)}</div>
      <div className="grid grid-cols-7">
        {days.map((d) => {
          const ds = fmt(d)
          const inMonth = d.getUTCMonth() === month.getUTCMonth()
          const sel = ds === range[0] || ds === range[1]
          const inRange = range[0] && range[1] && ds > range[0] && ds < range[1]
          return (
            <button key={ds} onClick={() => onPick(ds)} className={`size-[30px] rounded-[6px] text-center text-[13px] ${sel ? 'bg-primary text-primary-foreground' : inRange ? 'bg-muted' : 'hover:bg-muted'} ${inMonth ? '' : 'text-muted-foreground/50'}`}>
              {d.getUTCDate()}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Row properties toggleable via the official Property visibility submenu. */
const PROP_NAMES = ['Last updated', 'Status', 'Pull requests', 'Archived', 'Automation'] as const

/** Sidebar view preferences mirroring the official Sessions Properties menu. */
type TreePrefs = { sort: 'updated_at' | 'created_at'; hidden: Record<string, boolean>; compact: boolean; showArchived: boolean; statuses: string[]; propHidden: Record<string, boolean>; sessionTypes: string[]; platforms: string[]; automation: string[]; prStates: string[]; createdRange: string; updatedRange: string; createdCustom: [string, string]; updatedCustom: [string, string]; createdBy: 'self' | 'annotated'; tags: string[]; groupBy?: 'folders' | 'project' }

/** Official persists sidebar filters per-org in localStorage (sidebar-all-sessions-filters-<org> + session-sort-config). */
const TREE_PREFS_KEY = 'sidebar-sessions-prefs'

const DEFAULT_TREE_PREFS: TreePrefs = { sort: 'updated_at', hidden: {}, compact: false, showArchived: false, statuses: [], propHidden: {}, sessionTypes: ['devin', 'ada'], platforms: ['linux', 'windows', 'macos'], automation: ['automations', 'not_automations'], prStates: [], createdRange: '', updatedRange: 'month', createdCustom: ['', ''], updatedCustom: ['', ''], createdBy: 'self', tags: [], groupBy: 'folders' }

const RANGE_LABELS: [string, string][] = [['today', 'Today'], ['week', 'Last week'], ['2weeks', 'Last 2 weeks'], ['month', 'Last month']]
const RANGE_DAYS: Record<string, number> = { today: 0, week: 7, '2weeks': 14, month: 30 }
const dateFrom = (days: number) => new Date(Date.now() - days * 864e5).toISOString().slice(0, 10) + 'T00:00:00.000Z'

/** Builds the sidebar sessions filter query string from prefs (official v2sessions params). */
function buildFilterQ(p: TreePrefs): string {
  let q = p.statuses.map((s) => `&status=${s}`).join('')
  if (p.createdBy === 'annotated') q += '&created_by=annotated'
  q += p.tags.map((t) => `&tags=${encodeURIComponent(t)}`).join('')
  if (p.sessionTypes.length === 1) q += `&session_type=${p.sessionTypes[0]}`
  if (p.platforms.length < 3) q += p.platforms.map((s) => `&platforms=${s}`).join('')
  if (p.automation.length === 1) q += `&automation_filter=${p.automation[0]}`
  q += p.prStates.map((s) => `&pr_state=${s}`).join('')
  if (p.createdRange === 'custom') {
    if (p.createdCustom[0]) q += `&created_date_from=${encodeURIComponent(p.createdCustom[0] + 'T00:00:00.000Z')}`
    if (p.createdCustom[1]) q += `&created_date_to=${encodeURIComponent(p.createdCustom[1] + 'T23:59:59.999Z')}`
  } else if (p.createdRange) q += `&created_date_from=${encodeURIComponent(dateFrom(RANGE_DAYS[p.createdRange] ?? 30))}`
  if (p.updatedRange === 'custom') {
    if (p.updatedCustom[0]) q += `&updated_date_from=${encodeURIComponent(p.updatedCustom[0] + 'T00:00:00.000Z')}`
    if (p.updatedCustom[1]) q += `&updated_date_to=${encodeURIComponent(p.updatedCustom[1] + 'T23:59:59.999Z')}`
  } else if (p.updatedRange && p.updatedRange !== 'month') q += `&updated_date_from=${encodeURIComponent(dateFrom(RANGE_DAYS[p.updatedRange] ?? 30))}`
  return q
}

const filterCount = (p: TreePrefs) => (p.createdBy !== 'self' ? 1 : 0) + (p.tags.length ? 1 : 0) + (p.statuses.length ? 1 : 0) + (p.sessionTypes.length === 1 ? 1 : 0) + (p.platforms.length < 3 ? 1 : 0) + (p.automation.length === 1 ? 1 : 0) + (p.prStates.length ? 1 : 0) + (p.createdRange ? 1 : 0) + (p.updatedRange !== 'month' ? 1 : 0)

/** Official-style session tree: folders, Pinned, Recent, then the optional Archived group. */
const SessionTree = memo(function SessionTree({ tree, archivedTree, activeDevinId, onOpen, onPrefetch, onRefresh, prefs, onPrefs, folderOrder, folderTotals, onLoadMore, loadingMore }: { tree: MirrorTreeSession[]; archivedTree?: MirrorTreeSession[]; activeDevinId: string; onOpen: (s: MirrorTreeSession) => void; onPrefetch?: (s: MirrorTreeSession) => void; onRefresh?: () => void; prefs: TreePrefs; onPrefs: (p: Partial<TreePrefs>) => void; folderOrder?: string[]; folderTotals?: Record<string, number>; onLoadMore?: () => void; loadingMore?: boolean }) {
  const [closed, setClosed] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('sidebar-collapsed-folders') || '{}') as Record<string, boolean> } catch { return {} }
  })
  useEffect(() => {
    try { localStorage.setItem('sidebar-collapsed-folders', JSON.stringify(closed)) } catch { /* quota */ }
  }, [closed])
  const groups = useMemo(() => {
    const pinned = tree.filter((s) => s.is_pinned)
    const folders = new Map<string, MirrorTreeSession[]>()
    for (const f of folderOrder ?? []) folders.set(f, [])
    const rest: MirrorTreeSession[] = []
    for (const s of tree) {
      if (s.is_pinned) continue
      if (s.folder) {
        if (!folders.has(s.folder)) folders.set(s.folder, [])
        folders.get(s.folder)!.push(s)
      } else rest.push(s)
    }
    // Project grouping: ungrouped sessions bucketed by working directory,
    // keyed by full cwd, displayed as its last path segment.
    const projects = new Map<string, MirrorTreeSession[]>()
    if (prefs.groupBy === 'project') {
      for (const s of rest.splice(0)) {
        const k = s.cwd || '(无目录)'
        if (!projects.has(k)) projects.set(k, [])
        projects.get(k)!.push(s)
      }
    }
    return { pinned, folders, rest, projects }
  }, [tree, folderOrder, prefs.groupBy])
  const folderNames = useMemo(() => [...groups.folders.keys()], [groups])
  const [folderMenu, setFolderMenu] = useState<{ name: string; mode: 'menu' | 'rename'; left: number; top: number } | null>(null)
  const [folderDraft, setFolderDraft] = useState('')
  const [searchIn, setSearchIn] = useState<string | null>(null)
  const [searchQ, setSearchQ] = useState('')
  const [dragFolder, setDragFolder] = useState<string | null>(null)
  const [previewOrder, setPreviewOrder] = useState<string[] | null>(null)
  const folderAction = async (path: string, payload: Record<string, unknown>) => {
    try { await adminFetch(path, { method: 'POST', body: JSON.stringify(payload) }) } catch { /* refresh reflects state */ }
    onRefresh?.()
  }
  type HeaderMenuMode = 'main' | 'sort' | 'filter' | 'group' | 'propvis' | 'more' | 'moreactions' | 'newfolder' | 'flt_stype' | 'flt_machine' | 'flt_auto' | 'flt_status' | 'flt_pr' | 'flt_created' | 'flt_updated' | 'flt_created_cal' | 'flt_updated_cal' | 'flt_createdby' | 'flt_tags'
  const [propsMenu, setPropsMenu] = useState<{ mode: HeaderMenuMode; left: number; top: number; stack?: { mode: HeaderMenuMode; left: number; top: number }[] } | null>(null)
  const [fltSearch, setFltSearch] = useState('')
  const [meName, setMeName] = useState('')
  useEffect(() => { adminFetch<{ members: { user_id: string; name: string }[] }>('/api/admin/mirror/members').then((r) => setMeName(r.members?.[0]?.name || '')).catch(() => {}) }, [])
  const [tagSearch, setTagSearch] = useState('')
  // Official builds the Tags submenu from tags on the loaded sessions (no directory call); agent:-namespaced tags are not shown.
  const orgTags = useMemo(() => {
    const set = new Set<string>()
    const walk = (list: MirrorTreeSession[]) => { for (const s of list) { for (const t of s.tags || []) if (!t.includes(':')) set.add(t); walk(s.children) } }
    walk(tree)
    return [...set].sort()
  }, [tree])
  const [newFolderDraft, setNewFolderDraft] = useState('')
  const Section = ({ name, items, isFolder, icon, showCount, archived }: { name: string; items: MirrorTreeSession[]; isFolder?: boolean; icon?: ReactNode; showCount?: boolean; archived?: boolean }) => {
    const searching = searchIn === name
    const shown = searching && searchQ.trim()
      ? items.filter((s) => (s.title || s.devin_id).toLowerCase().includes(searchQ.trim().toLowerCase()))
      : items
    return (
    <div className={`mb-1 ${isFolder && dragFolder === name ? 'opacity-50' : ''}`}>
      <div
        data-slot="sidebar-label-row"
        draggable={isFolder && !searching}
        onDragStart={isFolder ? () => { setDragFolder(name); setPreviewOrder(folderNames) } : undefined}
        onDragEnd={isFolder ? () => {
          if (dragFolder && previewOrder && previewOrder.join('\n') !== folderNames.join('\n')) folderAction('/api/admin/mirror/folder-reorder', { names: previewOrder })
          setDragFolder(null); setPreviewOrder(null)
        } : undefined}
        onDragOver={isFolder ? (e) => {
          if (!dragFolder || dragFolder === name) return
          e.preventDefault()
          setPreviewOrder((prev) => {
            const cur = prev ?? folderNames
            const order = cur.filter((f) => f !== dragFolder)
            order.splice(order.indexOf(name) + (cur.indexOf(dragFolder) < cur.indexOf(name) ? 1 : 0), 0, dragFolder)
            return order
          })
        } : undefined}
        onDrop={isFolder ? (e) => e.preventDefault() : undefined}
        className="group/label sticky top-0 z-20 flex h-8 w-full shrink-0 items-center gap-1 bg-background px-1 text-[12px] font-medium text-muted-foreground"
      >
        {searching ? (
          <input
            autoFocus
            value={searchQ}
            placeholder="Search sessions..."
            onChange={(e) => setSearchQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setSearchIn(null); setSearchQ('') } }}
            className="h-7 w-full min-w-0 flex-1 rounded-[6px] border border-border bg-transparent px-2 text-[13px] font-normal text-foreground outline-none placeholder:text-muted-foreground"
          />
        ) : (
        <button
          onClick={() => setClosed((m) => ({ ...m, [name]: !m[name] }))}
          aria-expanded={!closed[name]}
          className="flex min-w-0 flex-1 cursor-pointer items-center hover:text-foreground"
        >
          <span className="mr-1 flex w-6 shrink-0 items-center justify-center">{isFolder ? <FolderIcon size={14} /> : icon}</span>
          <span data-slot="sidebar-group-label" className="truncate">{name}</span>
          {(isFolder || showCount) && (
            <span className="ml-1.5 shrink-0 tabular-nums">
              {items.length}
              {isFolder && (folderTotals?.[name] ?? 0) > items.reduce((n, s) => n + 1 + s.children.length, 0) ? '+' : ''}
            </span>
          )}
        </button>
        )}
        {isFolder && !searching && (
          <button
            aria-label="Search"
            title="Search"
            onClick={(e) => { e.stopPropagation(); setSearchQ(''); setSearchIn(name) }}
            className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md opacity-0 transition-all hover:text-foreground focus:opacity-100 group-hover/label:opacity-100"
          >
            <Search size={13} />
          </button>
        )}
        {isFolder && !searching && (
          <button
            aria-label="Folder options"
            title="Folder options"
            onClick={(e) => {
              e.stopPropagation()
              const r = e.currentTarget.getBoundingClientRect()
              setFolderDraft(name)
              setFolderMenu((m) => (m?.name === name ? null : {
                name,
                mode: 'menu',
                left: Math.max(4, Math.min(r.right - 220, window.innerWidth - 230)),
                top: Math.min(r.bottom + 4, window.innerHeight - 180),
              }))
            }}
            className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md opacity-0 transition-all hover:text-foreground focus:opacity-100 group-hover/label:opacity-100"
          >
            <MoreHorizontal size={14} />
          </button>
        )}
      </div>
      {!closed[name] && shown.map((s) => <TreeRow key={s.devin_id} s={s} depth={0} activeDevinId={activeDevinId} folders={folderNames} onOpen={onOpen} onPrefetch={onPrefetch} onRefresh={onRefresh} archivedView={archived} compact={prefs.compact} propHidden={prefs.propHidden} />)}
      {!closed[name] && searching && shown.length === 0 && (
        <div className="px-2 py-1.5 text-[12px] text-muted-foreground">No results found</div>
      )}
      {!closed[name] && archived && !searching && items.length === 0 && (
        <div className="px-2 py-1.5 text-[12px] text-muted-foreground">No sessions</div>
      )}
    </div>
    )
  }
  const menuItemCls = 'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] leading-[18px] hover:bg-accent'
  const openHeaderMenu = (e: React.MouseEvent<HTMLButtonElement>, mode: 'main' | 'more') => {
    e.stopPropagation()
    const r = e.currentTarget.getBoundingClientRect()
    setPropsMenu((m) => (m?.mode === mode ? null : {
      mode,
      left: Math.max(4, Math.min(r.left, window.innerWidth - 250)),
      top: Math.min(r.bottom + 4, window.innerHeight - 260),
    }))
  }
  const pushMenu = (e: React.MouseEvent, mode: HeaderMenuMode) => {
    e.stopPropagation()
    const item = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const panel = (e.currentTarget as HTMLElement).closest('[role="menu"]')?.getBoundingClientRect()
    const left = Math.min((panel?.right ?? item.right) - 2, window.innerWidth - 224)
    const top = Math.min(item.top - 4, window.innerHeight - 260)
    setPropsMenu((m) => m && { ...m, stack: [...(m.stack ?? []), { mode, left, top }] })
  }
  const replaceMenu = (mode: HeaderMenuMode) => {
    setPropsMenu((m) => {
      if (!m) return m
      if (m.stack?.length) { const st = [...m.stack]; st[st.length - 1] = { ...st[st.length - 1], mode }; return { ...m, stack: st } }
      return { ...m, mode }
    })
  }
  const popMenu = () => setPropsMenu((m) => (m ? (m.stack?.length ? { ...m, stack: m.stack.slice(0, -1) } : null) : m))
  const trimMenu = (depth: number) => setPropsMenu((m) => (m && (m.stack?.length ?? 0) > depth ? { ...m, stack: (m.stack ?? []).slice(0, depth) } : m))
  const hoverMenu = (e: React.MouseEvent, depth: number, mode: HeaderMenuMode) => {
    const item = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const panel = (e.currentTarget as HTMLElement).closest('[role="menu"]')?.getBoundingClientRect()
    const left = Math.min((panel?.right ?? item.right) - 2, window.innerWidth - 224)
    const top = Math.min(item.top - 4, window.innerHeight - 260)
    setPropsMenu((m) => {
      if (!m) return m
      if (m.stack?.[depth]?.mode === mode) return m
      return { ...m, stack: [...(m.stack ?? []).slice(0, depth), { mode, left, top }] }
    })
  }
  useEffect(() => {
    if (!propsMenu) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') popMenu() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [propsMenu])
  const groupNames = [...folderNames, 'Pinned', 'Recent', 'Archived']
  return (
    <div className="px-1.5 py-1">
      <div data-slot="sidebar-label-row" className="group/label sticky top-0 z-20 flex h-8 w-full shrink-0 items-center gap-1 bg-background px-1 text-[12px] font-medium text-muted-foreground">
        <span data-slot="sidebar-group-label" className="min-w-0 flex-1 truncate pl-1">Sessions</span>
        <button
          aria-label="Properties"
          title="Properties"
          onClick={(e) => openHeaderMenu(e, 'main')}
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md opacity-0 transition-all hover:text-foreground focus:opacity-100 group-hover/label:opacity-100"
        >
          <Settings2 size={13} />
        </button>
        <button
          aria-label="More"
          title="More"
          onClick={(e) => openHeaderMenu(e, 'more')}
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md opacity-0 transition-all hover:text-foreground focus:opacity-100 group-hover/label:opacity-100"
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
      {(previewOrder ?? folderNames).filter((name) => !prefs.hidden[name]).map((name) => <Section key={name} name={name} items={groups.folders.get(name) ?? []} isFolder />)}
      {groups.pinned.length > 0 && !prefs.hidden['Pinned'] && <Section name="Pinned" items={groups.pinned} icon={<Pin size={14} />} showCount />}
      {groups.rest.length > 0 && !prefs.hidden['Recent'] && <Section name="Recent" items={groups.rest} icon={<Clock size={14} />} />}
      {[...groups.projects.entries()].map(([cwd, items]) => (
        <Section
          key={`proj:${cwd}`}
          name={cwd === '(无目录)' ? cwd : (cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd)}
          items={items}
          icon={<FolderIcon size={14} />}
          showCount
        />
      ))}
      {onLoadMore && (
        <button
          aria-label="Load more..."
          disabled={loadingMore}
          onClick={onLoadMore}
          className="flex h-[30px] w-full cursor-pointer items-center rounded-md px-2 pl-[26px] text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          {loadingMore ? 'Loading...' : 'Load more...'}
        </button>
      )}
      {prefs.showArchived && <Section name="Archived" items={archivedTree ?? []} icon={<Archive size={14} />} archived />}
      {propsMenu && createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); setPropsMenu(null) }} />
          {[{ mode: propsMenu.mode, left: propsMenu.left, top: propsMenu.top }, ...(propsMenu.stack ?? [])].map((panel, pi) => (
          <div
            key={pi}
            role="menu"
            style={{ left: panel.left, top: panel.top }}
            className="menu-in fixed z-50 max-h-[70vh] min-w-[220px] overflow-y-auto rounded-[10px] bg-white/[.94] dark:bg-[#1f1f1f]/[.94] p-1 text-popover-foreground shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)] outline outline-1 outline-black/[.08] backdrop-blur-[8px] dark:outline-white/[.04] dark:-outline-offset-1"
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); popMenu() } }}
          >
            {panel.mode === 'main' && (
              <>
                <div className="flex items-center justify-between px-2 py-1">
                  <span className="text-[12px] text-muted-foreground">Properties</span>
                  <button role="menuitem" onClick={(e) => { e.stopPropagation(); onPrefs({ ...DEFAULT_TREE_PREFS }); setPropsMenu(null) }} className="cursor-pointer text-[12px] font-medium leading-4 text-primary hover:underline">Reset</button>
                </div>
                <button role="menuitem" aria-haspopup="menu" onMouseEnter={(e) => hoverMenu(e, pi, 'sort')} onClick={(e) => { pushMenu(e, 'sort') }} className={menuItemCls}>
                  <ChevronsUpDown size={13} className="text-muted-foreground" /> Sort
                  <span className="ml-auto flex items-center gap-1 text-muted-foreground">{prefs.sort === 'created_at' ? 'Last created' : 'Last updated'} <ChevronRight size={12} /></span>
                </button>
                <button role="menuitem" aria-haspopup="menu" onMouseEnter={(e) => hoverMenu(e, pi, 'filter')} onClick={(e) => { pushMenu(e, 'filter') }} className={menuItemCls}>
                  <ListFilter size={13} className="text-muted-foreground" /> Filter
                  <span className="ml-auto flex items-center gap-1 text-muted-foreground">{filterCount(prefs) > 0 ? filterCount(prefs) : ''} <ChevronRight size={12} /></span>
                </button>
                <button role="menuitem" aria-haspopup="menu" onMouseEnter={(e) => hoverMenu(e, pi, 'group')} onClick={(e) => { pushMenu(e, 'group') }} className={menuItemCls}>
                  <FolderIcon size={13} className="text-muted-foreground" /> Group
                  <span className="ml-auto flex items-center gap-1 text-muted-foreground">Folders <ChevronRight size={12} /></span>
                </button>
                <button role="menuitem" aria-haspopup="menu" onMouseEnter={(e) => hoverMenu(e, pi, 'propvis')} onClick={(e) => { pushMenu(e, 'propvis') }} className={menuItemCls}>
                  <CircleDot size={13} className="text-muted-foreground" /> Property visibility
                  <span className="ml-auto flex items-center gap-1 text-muted-foreground">{PROP_NAMES.filter((n) => !prefs.propHidden[n]).length} <ChevronRight size={12} /></span>
                </button>
                <button
                  role="menuitemcheckbox"
                  aria-checked={prefs.compact}
                  onMouseEnter={() => trimMenu(pi)}
                  onClick={(e) => { e.stopPropagation(); onPrefs({ compact: !prefs.compact }) }}
                  className={menuItemCls}
                >
                  <List size={13} className="text-muted-foreground" /> Compact view
                  <span className={`ml-auto flex h-4 w-7 items-center rounded-full p-0.5 transition-colors ${prefs.compact ? 'justify-end bg-blue-500' : 'bg-muted-foreground/30'}`}><span className="size-3 rounded-full bg-white" /></span>
                </button>
              </>
            )}
            {panel.mode === 'sort' && (['updated_at', 'created_at'] as const).map((k) => (
              <button
                key={k}
                role="menuitemradio"
                aria-checked={prefs.sort === k}
                onClick={(e) => { e.stopPropagation(); onPrefs({ sort: k }); setPropsMenu(null) }}
                className={menuItemCls}
              >
                <span className="flex w-4 justify-center">{prefs.sort === k && <Check size={13} />}</span>
                {k === 'updated_at' ? 'Last updated' : 'Last created'}
              </button>
            ))}
            {panel.mode === 'filter' && (
              <>
                <div className="mb-1 flex items-center gap-2 border-b border-border px-2 pb-1.5 pt-1">
                  <Search size={13} className="shrink-0 text-muted-foreground" />
                  <input
                    autoFocus
                    value={fltSearch}
                    onChange={(e) => setFltSearch(e.target.value)}
                    placeholder="Search filters"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setFltSearch(''); popMenu() } }}
                    className="w-full min-w-0 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
                  />
                </div>
                {([['flt_stype', 'Session type'], ['flt_createdby', 'Created by'], ['flt_machine', 'Machine type'], ['flt_auto', 'Automation'], ['flt_status', 'Status'], ['flt_pr', 'Pull requests'], ['flt_tags', 'Tags'], ['flt_archived', 'Archived'], ['flt_created', 'Created time'], ['flt_updated', 'Updated time']] as const).filter(([, label]) => !fltSearch || label.toLowerCase().includes(fltSearch.toLowerCase())).map(([m, label]) =>
                  m === 'flt_archived' ? (
                    <div key={m} role="menuitem" aria-disabled="true" className={`${menuItemCls} cursor-default opacity-50`}>Archived</div>
                  ) : (
                  <button key={m} role="menuitem" aria-haspopup="menu" onMouseEnter={(e) => hoverMenu(e, pi, m)} onClick={(e) => { e.stopPropagation(); setFltSearch(''); pushMenu(e, m) }} className={menuItemCls}>
                    {label}
                    <span className="ml-auto flex items-center gap-1 text-muted-foreground"><ChevronRight size={12} /></span>
                  </button>
                  ))}
                {filterCount(prefs) > 0 ? (
                  <button role="menuitem" onClick={(e) => { e.stopPropagation(); onPrefs({ statuses: [], sessionTypes: ['devin', 'ada'], platforms: ['linux', 'windows', 'macos'], automation: ['automations', 'not_automations'], prStates: [], createdRange: '', updatedRange: 'month', createdCustom: ['', ''], updatedCustom: ['', ''], createdBy: 'self', tags: [] }) }} className={menuItemCls}>
                    <RotateCcw size={13} className="text-muted-foreground" /> Reset to default
                  </button>
                ) : (
                  <div role="menuitem" aria-disabled="true" className={`${menuItemCls} cursor-default opacity-50`}>
                    <RotateCcw size={13} className="text-muted-foreground" /> Reset to default
                  </div>
                )}
              </>
            )}
            {panel.mode === 'flt_createdby' && (
              <>
                <div className="flex items-center justify-between gap-2 px-2">
                  <div className="py-[5px] text-[12px] font-medium text-muted-foreground">Created by</div>
                  <button role="menuitem" onClick={(e) => { e.stopPropagation(); onPrefs({ createdBy: 'self' }) }} className="cursor-pointer text-[12px] font-medium text-primary hover:underline">Reset</button>
                </div>
                <button role="menuitemcheckbox" aria-checked={prefs.createdBy === 'self'} onClick={(e) => { e.stopPropagation(); onPrefs({ createdBy: prefs.createdBy === 'self' ? 'annotated' : 'self' }) }} className={menuItemCls}>
                  <span className="flex w-4 justify-center">{prefs.createdBy === 'self' && <Check size={13} />}</span>
                  {meName || 'Me'}
                </button>
              </>
            )}
            {panel.mode === 'flt_tags' && (
              <>
                <div className="flex items-center justify-between gap-2 px-2">
                  <div className="py-[5px] text-[12px] font-medium text-muted-foreground">Tags</div>
                  <button role="menuitem" onClick={(e) => { e.stopPropagation(); onPrefs({ tags: [] }) }} className="cursor-pointer text-[12px] font-medium text-primary hover:underline">Reset</button>
                </div>
                <div className="mb-1 flex items-center gap-2 border-b border-border px-2 pb-1.5">
                  <Search size={13} className="shrink-0 text-muted-foreground" />
                  <input autoFocus value={tagSearch} onChange={(e) => setTagSearch(e.target.value)} placeholder="Search tags" onClick={(e) => e.stopPropagation()} className="w-full min-w-0 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground" />
                </div>
                {orgTags.filter((t) => !tagSearch || t.toLowerCase().includes(tagSearch.toLowerCase())).map((t) => {
                  const on = prefs.tags.includes(t)
                  return (
                    <button key={t} role="menuitemcheckbox" aria-checked={on} onClick={(e) => { e.stopPropagation(); onPrefs({ tags: on ? prefs.tags.filter((x) => x !== t) : [...prefs.tags, t] }) }} className={menuItemCls}>
                      <span className="flex w-4 justify-center">{on && <Check size={13} />}</span>
                      {t}
                    </button>
                  )
                })}
                {orgTags.length === 0 && <div className="px-2 py-1.5 text-[13px] text-muted-foreground">No tags</div>}
              </>
            )}
            {panel.mode === 'flt_status' && (['running', 'inactive'] as const).map((s) => {
              const on = prefs.statuses.includes(s)
              return (
                <button key={s} role="menuitemcheckbox" aria-checked={on} onClick={(e) => { e.stopPropagation(); onPrefs({ statuses: on ? prefs.statuses.filter((x) => x !== s) : [...prefs.statuses, s] }) }} className={menuItemCls}>
                  <span className="flex w-4 justify-center">{on && <Check size={13} />}</span>
                  {s === 'running' ? 'Running' : 'Inactive'}
                </button>
              )
            })}
            {panel.mode === 'flt_stype' && ([['devin', 'Agent'], ['ada', 'Ask']] as const).map(([v, label]) => {
              const on = prefs.sessionTypes.includes(v)
              return (
                <button key={v} role="menuitemcheckbox" aria-checked={on} onClick={(e) => { e.stopPropagation(); onPrefs({ sessionTypes: on ? prefs.sessionTypes.filter((x) => x !== v) : [...prefs.sessionTypes, v] }) }} className={menuItemCls}>
                  <span className="flex w-4 justify-center">{on && <Check size={13} />}</span>
                  {label}
                </button>
              )
            })}
            {panel.mode === 'flt_machine' && ([['linux', 'Linux'], ['windows', 'Windows'], ['macos', 'macOS']] as const).map(([v, label]) => {
              const on = prefs.platforms.includes(v)
              return (
                <button key={v} role="menuitemcheckbox" aria-checked={on} onClick={(e) => { e.stopPropagation(); onPrefs({ platforms: on ? prefs.platforms.filter((x) => x !== v) : [...prefs.platforms, v] }) }} className={menuItemCls}>
                  <span className="flex w-4 justify-center">{on && <Check size={13} />}</span>
                  {label}
                </button>
              )
            })}
            {panel.mode === 'flt_auto' && ([['automations', 'Automation'], ['not_automations', 'Not automation']] as const).map(([v, label]) => {
              const on = prefs.automation.includes(v)
              return (
                <button key={v} role="menuitemcheckbox" aria-checked={on} onClick={(e) => { e.stopPropagation(); onPrefs({ automation: on ? prefs.automation.filter((x) => x !== v) : [...prefs.automation, v] }) }} className={menuItemCls}>
                  <span className="flex w-4 justify-center">{on && <Check size={13} />}</span>
                  {label}
                </button>
              )
            })}
            {panel.mode === 'flt_pr' && ([['open', 'Open'], ['draft', 'Draft'], ['merged', 'Merged'], ['closed', 'Closed'], ['no_pr', 'No PR']] as const).map(([v, label]) => {
              const on = prefs.prStates.includes(v)
              return (
                <button key={v} role="menuitemcheckbox" aria-checked={on} onClick={(e) => { e.stopPropagation(); onPrefs({ prStates: on ? prefs.prStates.filter((x) => x !== v) : [...prefs.prStates, v] }) }} className={menuItemCls}>
                  <span className="flex w-4 justify-center">{on && <Check size={13} />}</span>
                  {label}
                </button>
              )
            })}
            {(panel.mode === 'flt_created' || panel.mode === 'flt_updated') && RANGE_LABELS.map(([v, label]) => {
              const created = panel.mode === 'flt_created'
              const cur = created ? prefs.createdRange : prefs.updatedRange
              const on = cur === v
              return (
                <button key={v} role="menuitemcheckbox" aria-checked={on} onClick={(e) => { e.stopPropagation(); onPrefs(created ? { createdRange: on ? '' : v } : { updatedRange: on ? 'month' : v }) }} className={menuItemCls}>
                  <span className="flex w-4 justify-center">{on && <Check size={13} />}</span>
                  {label}
                </button>
              )
            })}
            {(panel.mode === 'flt_created' || panel.mode === 'flt_updated') && (
              <button role="menuitem" onClick={(e) => { e.stopPropagation(); replaceMenu(panel.mode === 'flt_created' ? 'flt_created_cal' : 'flt_updated_cal') }} className={menuItemCls}>
                <span className="flex w-4 justify-center" />
                Custom…
              </button>
            )}
            {(panel.mode === 'flt_created_cal' || panel.mode === 'flt_updated_cal') && (() => {
              const created = panel.mode === 'flt_created_cal'
              const range = created ? prefs.createdCustom : prefs.updatedCustom
              const set = (r: [string, string]) => onPrefs(created ? { createdRange: 'custom', createdCustom: r } : { updatedRange: 'custom', updatedCustom: r })
              return (
                <MenuCalendar
                  title={created ? 'Created time' : 'Updated time'}
                  range={range}
                  onPick={(d) => {
                    // Official: first pick = single-day range (from=to); a pick while from===to extends it; a pick after a wider range starts a new single-day range.
                    if (!range[0] || range[0] !== range[1]) set([d, d])
                    else set(d < range[0] ? [d, range[0]] : [range[0], d])
                  }}
                  onReset={() => onPrefs(created ? { createdRange: '', createdCustom: ['', ''] } : { updatedRange: 'month', updatedCustom: ['', ''] })}
                />
              )
            })()}
            {panel.mode === 'propvis' && (
              <>
                <div className="flex items-center justify-between gap-2 px-2">
                  <div className="py-[5px] text-[12px] font-medium text-muted-foreground">Properties</div>
                  <button role="menuitem" onClick={(e) => { e.stopPropagation(); onPrefs({ propHidden: Object.fromEntries(PROP_NAMES.map((n) => [n, true])) }) }} className="cursor-pointer select-none text-[12px] font-medium text-primary outline-none hover:underline">
                    Hide all
                  </button>
                </div>
                {PROP_NAMES.map((n) => {
                  const on = !prefs.propHidden[n]
                  return (
                    <button
                      key={n}
                      role="menuitemcheckbox"
                      aria-checked={on}
                      onClick={(e) => { e.stopPropagation(); onPrefs({ propHidden: { ...prefs.propHidden, [n]: on } }) }}
                      className={menuItemCls}
                    >
                      <span className="flex w-4 justify-center">{on && <Check size={13} />}</span>
                      {n}
                    </button>
                  )
                })}
              </>
            )}
            {panel.mode === 'group' && (
              <>
                {(['folders', 'project'] as const).map((gb) => (
                  <button
                    key={gb}
                    role="menuitemradio"
                    aria-checked={(prefs.groupBy ?? 'folders') === gb}
                    onClick={(e) => { e.stopPropagation(); onPrefs({ groupBy: gb }) }}
                    className={menuItemCls}
                  >
                    <span className="flex w-4 justify-center">{(prefs.groupBy ?? 'folders') === gb && <Check size={13} />}</span>
                    <span className="truncate">{gb === 'folders' ? 'Group by Folders' : '按项目目录分组'}</span>
                  </button>
                ))}
                <div role="separator" className="mx-2 my-1 h-px bg-border" />
                {groupNames.map((g) => {
                  const visible = g === 'Archived' ? prefs.showArchived : !prefs.hidden[g]
                  return (
                    <button
                      key={g}
                      role="menuitemcheckbox"
                      aria-checked={visible}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (g === 'Archived') onPrefs({ showArchived: !prefs.showArchived })
                        else onPrefs({ hidden: { ...prefs.hidden, [g]: visible } })
                      }}
                      className={menuItemCls}
                    >
                      <span className="flex w-4 justify-center">{visible && <Check size={13} />}</span>
                      <span className="truncate">{g}</span>
                    </button>
                  )
                })}
                <button role="menuitem" onClick={(e) => { e.stopPropagation(); setNewFolderDraft(''); pushMenu(e, 'newfolder') }} className={menuItemCls}>
                  <Plus size={13} className="text-muted-foreground" /> Create new folder
                </button>
              </>
            )}
            {panel.mode === 'more' && (
              <>
                <button role="menuitem" onClick={(e) => { e.stopPropagation(); setNewFolderDraft(''); pushMenu(e, 'newfolder') }} className={menuItemCls}>
                  <Plus size={13} className="text-muted-foreground" /> New folder
                </button>
                <button role="menuitem" onMouseEnter={() => trimMenu(pi)} onClick={(e) => { e.stopPropagation(); window.location.href = '/' }} className={menuItemCls}>
                  <List size={13} className="text-muted-foreground" /> View all sessions
                </button>
                <button role="menuitem" aria-haspopup="menu" onMouseEnter={(e) => hoverMenu(e, pi, 'moreactions')} onClick={(e) => { pushMenu(e, 'moreactions') }} className={menuItemCls}>
                  <MoreHorizontal size={13} className="text-muted-foreground" /> More actions
                  <span className="ml-auto flex items-center gap-1 text-muted-foreground"><ChevronRight size={12} /></span>
                </button>
              </>
            )}
            {panel.mode === 'moreactions' && (
              <div role="menuitem" aria-disabled="true" title="组织级破坏性操作，镜像不接线" className={`${menuItemCls} cursor-default opacity-50`}>
                <Archive size={13} className="text-muted-foreground" /> Archive all sessions
              </div>
            )}
            {panel.mode === 'newfolder' && (
              <input
                autoFocus
                value={newFolderDraft}
                placeholder="Folder name"
                onChange={(e) => setNewFolderDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') { e.stopPropagation(); popMenu() }
                  if (e.key === 'Enter' && newFolderDraft.trim()) {
                    e.stopPropagation()
                    folderAction('/api/admin/mirror/folder-create', { name: newFolderDraft.trim() })
                    setPropsMenu(null)
                  }
                }}
                className="h-7 w-full min-w-0 rounded-[6px] border border-border bg-transparent px-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
              />
            )}
          </div>
          ))}
        </>,
        document.body,
      )}
      {folderMenu && createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); setFolderMenu(null) }} />
          <div
            role="menu"
            style={{ left: folderMenu.left, top: folderMenu.top }}
            className="menu-in fixed z-50 min-w-[220px] rounded-[10px] bg-white/[.94] dark:bg-[#1f1f1f]/[.94] p-1 text-popover-foreground shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)] outline outline-1 outline-black/[.08] backdrop-blur-[8px] dark:outline-white/[.04] dark:-outline-offset-1"
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setFolderMenu(null) } }}
          >
            {folderMenu.mode === 'rename' ? (
              <input
                autoFocus
                value={folderDraft}
                placeholder="Folder name"
                onChange={(e) => setFolderDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Escape') setFolderMenu((m) => m && { ...m, mode: 'menu' })
                  if (e.key === 'Enter') {
                    const v = folderDraft.trim()
                    const old = folderMenu.name
                    setFolderMenu(null)
                    if (v && v !== old) folderAction('/api/admin/mirror/folder-rename', { old_name: old, new_name: v })
                  }
                }}
                className="w-full rounded bg-transparent px-2 py-1.5 text-[13px] outline-none placeholder:text-muted-foreground"
              />
            ) : (
              <>
                <button
                  role="menuitem"
                  onClick={(e) => {
                    e.stopPropagation()
                    const n = folderMenu.name
                    setFolderMenu(null)
                    window.location.assign(`/admin/new?folder=${encodeURIComponent(n)}`)
                  }}
                  className={menuItemCls}
                >
                  <Plus size={13} className="text-muted-foreground" /> New session
                </button>
                <button role="menuitem" onClick={(e) => { e.stopPropagation(); setFolderMenu((m) => m && { ...m, mode: 'rename' }) }} className={menuItemCls}>
                  <Pencil size={13} className="text-muted-foreground" /> Rename folder
                </button>
                {(groups.folders.get(folderMenu.name)?.length ?? 0) > 0 && (
                  <button
                    role="menuitem"
                    onClick={(e) => {
                      e.stopPropagation()
                      const ids = (groups.folders.get(folderMenu.name) ?? []).map((s) => s.devin_id)
                      setFolderMenu(null)
                      folderAction('/api/admin/mirror/session-archive', { devin_ids: ids, archive: true })
                    }}
                    className={menuItemCls}
                  >
                    <Archive size={13} className="text-muted-foreground" /> Empty folder
                  </button>
                )}
                <button
                  role="menuitem"
                  onClick={(e) => { e.stopPropagation(); const n = folderMenu.name; setFolderMenu(null); folderAction('/api/admin/mirror/folder-delete', { name: n }) }}
                  className={cn(menuItemCls, 'text-red-500 hover:text-red-500')}
                >
                  <X size={13} /> Delete folder
                </button>
              </>
            )}
          </div>
        </>,
        document.body,
      )}
    </div>
  )
})

/** Official-style command palette (Cmd/Ctrl+K): search sessions, theme, layout actions. */

export { TreeRow, MenuCalendar, PROP_NAMES, type TreePrefs, TREE_PREFS_KEY, DEFAULT_TREE_PREFS, RANGE_LABELS, RANGE_DAYS, dateFrom, buildFilterQ, filterCount, SessionTree };
