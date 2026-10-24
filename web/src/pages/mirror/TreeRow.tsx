import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { Expand, Folder as FolderIcon, GitPullRequest, Link2, Lock, Pencil, Plus } from 'lucide-react'
import { useDraggable, useDroppable, type DraggableAttributes, type DraggableSyntheticListeners } from '@dnd-kit/core'
import { OArchive, OChevronRight, ODots, OPin, OPinSlash, OX } from '../../components/officialIcons'
import { adminFetch } from '@/lib/api'
import { StatusDot } from '@/components/ui'
import { cn } from '@/lib/utils'
import { sessionMirrorPath } from '@/lib/mirrorLinks'
import { type MirrorTreeSession, relTime } from './treeCache'
import { mapEnum, actionCls } from './statusReduce'
import { copyText } from '../../lib/clipboard'

/** What a section accepts for session drops — `pin` = pin + position,
 *  `folder` = assign folder name (null = unfile into Recent). Carried in the
 *  droppable data so SessionTree's drop resolver fires the right endpoint. */
type TreeAccept = { pin: true } | { folder: string | null }
/** Section context every row droppable carries: the accept action + the
 *  section's shown row ids in order (drop position resolves against it). */
type RowDrop = { accept: TreeAccept; items: string[] }

type RowProps = { s: MirrorTreeSession; depth: number; activeDevinId: string; folders: string[]; onOpen: (s: MirrorTreeSession) => void; onPrefetch?: (s: MirrorTreeSession) => void; onRefresh?: () => void; archivedView?: boolean; compact?: boolean; propHidden?: Record<string, boolean>; /** Section drop context — absent = rows aren't drop targets (project buckets, archived). */ dndSection?: RowDrop; /** Session id the drag dwell wants expanded (parent-peek). */ dwellId?: string | null; /** True while a folder/group is dragged — rows go inert like the official v||m rule. */ suppressHover?: boolean; /** Shared ms timestamp of the last drag end/cancel — the row anchor suppresses the click a drop leaves behind. */ navGuard?: { current: number } }

type ImplProps = RowProps & { ghost?: boolean; dndRef?: (el: HTMLElement | null) => void; dndListeners?: DraggableSyntheticListeners; dndAttrs?: DraggableAttributes; dragging?: boolean; dropHighlight?: boolean }

/** DraggableSidebarSessionRow: one node is both the `session:` drag source and
 *  the `session-target:` droppable (positional insert / parent-peek dwell). */
function TreeRow({ dndSection, dwellId, suppressHover, navGuard, ...props }: RowProps) {
  const s = props.s
  const drag = useDraggable({
    id: `session:${s.devin_id}`,
    data: { type: 'session', sessionId: s.devin_id },
    disabled: !!props.archivedView,
  })
  const drop = useDroppable({
    id: `session-target:${s.devin_id}`,
    data: { type: 'session-target', sessionId: s.devin_id, hasKids: s.children.length > 0 || s.total_children > 0, accept: dndSection?.accept, items: dndSection?.items ?? [] },
    disabled: !dndSection || !!props.archivedView || !!suppressHover,
  })
  const setRefs = useCallback((el: HTMLElement | null) => { drag.setNodeRef(el); drop.setNodeRef(el) }, [drag.setNodeRef, drop.setNodeRef])
  return <TreeRowImpl {...props} dndSection={dndSection} dwellId={dwellId} suppressHover={suppressHover} navGuard={navGuard} dndRef={setRefs} dndListeners={drag.listeners} dndAttrs={drag.attributes} dragging={drag.isDragging} dropHighlight={drop.isOver} />
}

/** DragOverlay ghost — a LIVE clone of the row face (official renders
 *  SidebarSessionRow itself inside an inert wrapper; ours reuses TreeRowImpl
 *  with no dnd wiring, and the overlay's pointer-events-none keeps it inert). */
function TreeRowGhost({ s, activeDevinId, compact, propHidden }: { s: MirrorTreeSession; activeDevinId?: string; compact?: boolean; propHidden?: Record<string, boolean> }) {
  return <TreeRowImpl s={s} depth={0} activeDevinId={activeDevinId ?? ''} folders={[]} onOpen={() => {}} compact={compact} propHidden={propHidden} ghost />
}

function TreeRowImpl({ s, depth, activeDevinId, folders, onOpen, onPrefetch, onRefresh, archivedView, compact, propHidden, dndSection, dwellId, suppressHover, navGuard, ghost, dndRef, dndListeners, dndAttrs, dragging, dropHighlight }: ImplProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [allKids, setAllKids] = useState<MirrorTreeSession[] | null>(null)
  const [kidsBusy, setKidsBusy] = useState(false)
  const kids = allKids ?? s.children
  const [menu, setMenu] = useState<'closed' | 'main' | 'folder' | 'newfolder'>('closed')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [copiedAt, setCopiedAt] = useState(0)
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
  // Parent-peek: SessionTree arms a ~600ms dwell when a dragged session hovers
  // a collapsed parent row — expands it so the child rows become visible.
  useEffect(() => {
    if (dwellId === s.devin_id && hasKids && !open) setOpen(true)
  }, [dwellId, s.devin_id, hasKids, open])
  const active = s.devin_id === activeDevinId
  const enu = mapEnum(s.status_enum || s.activity_status)
  // Official rows are 30px one-line; rows with a subtitle line render 44px
  // two-line. Official line-2 shows status AND time ("Working · 2m ago"),
  // not either/or.
  const subtitle = !compact && !propHidden?.['Status'] && enu === 'working' ? t('tree.working') : null
  const subTime = !compact && !propHidden?.['Last updated'] ? relTime(s.updated_at) : ''
  const allPrs = !propHidden?.['Pull requests'] ? (s.pull_requests || []) : []
  const prs = compact ? [] : allPrs
  const showArchivedIcon = !compact && !!archivedView && !propHidden?.['Archived']
  const awakeMs = s.keep_alive_until ? new Date(s.keep_alive_until).getTime() - Date.now() : 0
  const awakeLabel = awakeMs > 0 ? t('tree.awakeFor', { h: Math.floor(awakeMs / 36e5), m: Math.floor((awakeMs % 36e5) / 6e4) }) : ''
  const hasSub = !!(subtitle || subTime || prs.length || showArchivedIcon || (!compact && awakeLabel))
  const compactPr = compact && !propHidden?.['Pull requests'] ? allPrs[0] : undefined
  const prColor = (st: string, draft: boolean) => draft ? 'text-muted-foreground' : st === 'closed' ? 'text-[#f53b3a]' : st === 'merged' ? 'text-[rgb(149,108,222)]' : 'text-green-600'
  return (
    <>
      <div
        data-slot="sidebar-menu-item"
        data-dw-sid={ghost ? undefined : s.devin_id}
        ref={dndRef}
        // dnd-kit activator semantics minus `role` — the row nests real
        // buttons/links, and role=button would hide them from screen readers.
        {...(dndAttrs ? { tabIndex: dndAttrs.tabIndex, 'aria-roledescription': dndAttrs['aria-roledescription'], 'aria-pressed': dndAttrs['aria-pressed'], 'aria-disabled': dndAttrs['aria-disabled'] } : {})}
        {...dndListeners}
        onPointerDown={(e) => {
          // Only the main button arms the drag — right/middle clicks keep
          // their context-menu semantics and can never start a drag.
          if (e.button === 0) (dndListeners?.onPointerDown as ((ev: React.PointerEvent) => void) | undefined)?.(e)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenuPos({ left: Math.max(4, Math.min(e.clientX, window.innerWidth - 230)), top: Math.min(e.clientY, window.innerHeight - 244) })
          setMenu('main')
        }}
        onPointerEnter={() => onPrefetch?.(s)}
        onTouchStart={() => onPrefetch?.(s)}
        className={cn('group/row relative isolate mb-px mt-px flex items-center gap-1 rounded-md pr-0.5 hover:bg-tint-secondary has-[:focus-visible]:bg-tint-secondary [content-visibility:auto]', hasSub ? 'h-11 [contain-intrinsic-block-size:44px]' : 'h-[30px] [contain-intrinsic-block-size:30px]', (active || menu !== 'closed' || dropHighlight) && 'bg-tint-secondary', (dragging || ghost) && 'pointer-events-none select-none', dragging && 'opacity-40', suppressHover && 'pointer-events-none')}
        style={{ paddingLeft: 4 + depth * 14 }}
      >
        <a
          data-slot="sidebar-menu-button"
          href={`/admin/${s.devin_id}`}
          aria-current={active ? 'page' : undefined}
          aria-label={s.title || s.devin_id}
          onClick={(e) => {
            e.preventDefault()
            // A session dropped back onto its own row lets a click through —
            // swallow it instead of navigating mid-gesture.
            if (navGuard && Date.now() - navGuard.current < 250) return
            if (!editing) onOpen(s)
          }}
          onDoubleClick={(e) => {
            // Official: double-click on the ACTIVE row starts inline rename.
            if (!active || editing || archivedView) return
            e.preventDefault()
            setDraft(s.title || '')
            setEditing(true)
          }}
          className="absolute inset-0 cursor-pointer rounded-md"
        />
        {hasKids && (
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}
            className="relative z-10 flex size-4 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent"
            aria-label={open ? t('common.collapse') : t('common.expand')}
            aria-expanded={open}
          >
            <OChevronRight size={12} className={cn('transition-transform duration-150', open && 'rotate-90')} />
          </button>
        )}
        {/* official left icon cell: w-6 h-[18px], 16px status glyph; aligns to
            line-1 in two-line rows (self-start+mt-1), centered in 30px rows */}
        <span className={cn('flex h-[18px] w-6 shrink-0 items-center justify-center text-muted-foreground', hasSub && 'self-start mt-1')}>
          {enu === 'working' ? (
            <svg aria-hidden="true" className="motion-safe:animate-spin text-text-green" width={16} height={16} viewBox="0 0 24 24" fill="none"><path d="M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2" /><path d="M20.9451 13C20.4839 17.1716 17.1716 20.4839 13 20.9451" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          ) : s.status_enum === 'archived' ? (
            <OArchive size={16} className="text-text-orange" />
          ) : (
            <StatusDot status={enu} className="!h-2 !w-2" />
          )}
        </span>
        {s.is_locked && !s.loaded_here && (
          <span
            aria-label={t('tree.lockedAria')}
            title={t('tree.lockedTip')}
            className="relative z-10 flex size-4 shrink-0 items-center justify-center text-amber-500"
          >
            <Lock size={12} />
          </span>
        )}
        {/* Non-devin ownership — the draft picker's chosen agent follows the
            session; devin rows stay unmarked (the default). */}
        {s.agent && s.agent !== 'devin' && (
          <span
            title={t('draft.agentPick')}
            className="relative z-10 flex h-4 shrink-0 items-center rounded-[4px] border border-border/60 px-1 text-[10px] leading-none text-muted-foreground"
          >
            {s.agent}
          </span>
        )}
        {/* Working spinner lives in the left w-6 icon cell above — the old
            second spinner here (compact mode) duplicated it. */}
        {compactPr ? (
          compactPr.pr_url ? (
            <a href={compactPr.pr_url} target="_blank" rel="noreferrer" aria-label={t('tree.openPr')} title={t('tree.openPr')} onClick={(e) => e.stopPropagation()} className={cn('relative z-10 flex size-[18px] shrink-0 items-center justify-center rounded-[4px] group-hover/sidebar:invisible group-has-[:focus-visible]/row:invisible', menu !== 'closed' && 'invisible', prColor(compactPr.state, compactPr.draft))}>
              <GitPullRequest size={14} />
            </a>
          ) : (
            <span className={cn('flex size-[18px] shrink-0 items-center justify-center group-hover/sidebar:invisible group-has-[:focus-visible]/row:invisible', menu !== 'closed' && 'invisible', prColor(compactPr.state, compactPr.draft))}><GitPullRequest size={14} /></span>
          )
        ) : null}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 overflow-hidden">
          {editing ? (
            <input
              autoFocus
              ref={(el) => el?.select()}
              value={draft}
              placeholder={t('tree.sessionTitle')}
              onChange={(e) => setDraft(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onBlur={() => {
                const v = draft.trim()
                setEditing(false)
                if (v && v !== s.title) rowAction('/api/admin/mirror/session-title', { devin_id: s.devin_id, title: v })
              }}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Escape') { setEditing(false); setDraft(s.title || '') }
                if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
              }}
              className="relative z-10 h-auto min-w-0 w-full select-text rounded-none border-none bg-transparent p-0 text-[13px] leading-[18px] text-foreground shadow-none outline-none placeholder:text-muted-foreground"
            />
          ) : (
            <span className={cn('min-w-0 truncate text-[13px] leading-[18px]', s.is_unread ? 'font-semibold text-foreground' : 'text-foreground/90', s.resumable === false && 'text-muted-foreground')}>
              {s.title || s.devin_id}
            </span>
          )}
          {hasSub && (
            <span className="flex min-w-0 items-center whitespace-nowrap text-[12px] leading-[16px] text-muted-foreground">
              {s.resumable === false && (
                <>
                  <span className="mr-1 shrink-0 rounded bg-muted px-1 text-[10px] leading-[15px]" title={t('tree.invalidTip')}>{t('tree.invalid')}</span>
                </>
              )}
              <span className="truncate">{[subtitle, subTime].filter(Boolean).join(' · ')}</span>
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
                  <span aria-label={t('menu.archived')} title={t('menu.archived')} className="flex size-4 shrink-0 items-center justify-center text-orange-500"><OArchive size={14} /></span>
                </>
              )}
              {hasKids && !open && (
                <>
                  <span className="mx-1 text-muted-foreground/60">·</span>
                  <span className="tabular-nums">{s.total_children || s.children.length}</span>
                </>
              )}
            </span>
          )}
        </span>
        {s.is_unread && <span className="size-1.5 shrink-0 rounded-full bg-blue-500 group-hover/row:hidden" />}
        <span data-slot="sidebar-menu-actions" onPointerDown={(e) => e.stopPropagation()} className="pointer-events-auto relative z-10 flex shrink-0 flex-row items-center gap-px">
          {compact && awakeLabel && (
            <span aria-label={awakeLabel} title={awakeLabel} className="flex size-4 shrink-0 items-center justify-center text-blue-500">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" aria-hidden="true" width={14} height={14}><path d="M7.3 5.9c-.8-1 .8-1.8 0-2.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><path d="M10.5 5.7c-.9-1.3.9-2.4 0-3.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><path d="M13.7 5.9c-.8-1 .8-1.8 0-2.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><ellipse cx="10.5" cy="9.9" rx="9" ry="3.6" stroke="currentColor" strokeWidth="1.5" /><ellipse cx="10.5" cy="9.9" rx="6.8" ry="2.2" fill="currentColor" /><path d="M1.5 9.9c.4 7.5 3.9 12 9 12s8.6-4.5 9-12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><path d="M19.4 12.2c2.2-.45 3.4.55 3.15 2-.3 1.5-2 2.2-3.8 1.95" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            </span>
          )}
          <button
            data-slot="sidebar-menu-action"
            aria-label={s.is_pinned ? t('common.unpin') : t('common.pin')}
            aria-pressed={!!s.is_pinned}
            title={s.is_pinned ? t('common.unpin') : t('common.pin')}
            disabled={busy}
            onClick={(e) => { e.stopPropagation(); rowAction('/api/admin/mirror/session-pin', { devin_id: s.devin_id, pinned: !s.is_pinned }) }}
            className={actionCls(menu !== 'closed' || !!s.is_pinned)}
          >
            {s.is_pinned
              ? <OPinSlash size={16} className="text-foreground" />
              : <OPin size={16} />}
          </button>
          <button
            data-slot="sidebar-menu-action"
            aria-label={archivedView ? t('tree.unarchive') : t('menu.archive')}
            aria-pressed={!!archivedView}
            title={archivedView ? t('tree.unarchive') : t('menu.archive')}
            disabled={busy}
            onClick={(e) => { e.stopPropagation(); rowAction('/api/admin/mirror/session-archive', { devin_id: s.devin_id, archived: !archivedView }) }}
            className={actionCls(menu !== 'closed' || !!archivedView)}
          >
            <OArchive size={16} className={cn('transition-all duration-150', archivedView && 'scale-110 text-text-orange')} />
          </button>
          <button
            data-slot="sidebar-menu-action"
            aria-label={t('common.more')}
            title={t('common.more')}
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
            <ODots size={16} />
          </button>
        </span>
        {menu !== 'closed' && createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); setMenu('closed') }} />
            <div
              role="menu"
              ref={(el) => { if (menu === 'main') el?.querySelector('button')?.focus() }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.stopPropagation(); setMenu('closed'); return }
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
              {(
                <>
                  <button role="menuitem" aria-haspopup="menu" onMouseEnter={(e) => openFolderSub(e)} onClick={(e) => { e.stopPropagation(); openFolderSub(e) }} className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[13px] hover:bg-accent">
                    <FolderIcon size={13} className="text-muted-foreground" /> {t('menu.folder')} <OChevronRight size={12} className="ml-auto text-muted-foreground" />
                  </button>
                  <button
                    role="menuitem"
                    onMouseEnter={() => { if (menu !== 'main') setMenu('main') }}
                    onClick={(e) => {
                      e.stopPropagation(); setDraft(s.title || ''); setMenu('closed'); setEditing(true)
                    }}
                    className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[13px] hover:bg-accent"
                  >
                    <Pencil size={13} className="text-muted-foreground" /> {t('menu.renameSession')}
                  </button>
                  <button
                    role="menuitem"
                    onMouseEnter={() => { if (menu !== 'main') setMenu('main') }}
                    onClick={(e) => {
                      e.stopPropagation()
                      copyText(`${window.location.origin}${sessionMirrorPath(s.devin_id)}`)
                      setCopiedAt(Date.now())
                      window.setTimeout(() => setCopiedAt(0), 1600)
                      setMenu('closed')
                    }}
                    className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[13px] hover:bg-accent"
                  >
                    <Link2 size={13} className="text-muted-foreground" /> {t('menu.copyLink')}
                  </button>
                  <button
                    role="menuitem"
                    onMouseEnter={() => { if (menu !== 'main') setMenu('main') }}
                    onClick={(e) => { e.stopPropagation(); setMenu('closed'); window.open(sessionMirrorPath(s.devin_id), '_blank', 'noopener') }}
                    className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[13px] hover:bg-accent"
                  >
                    <Expand size={13} className="text-muted-foreground" /> {t('menu.openInNew')}
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
                    placeholder={t('tree.folderName')}
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
                      <Plus size={13} className="text-muted-foreground" /> {t('menu.newFolder')}
                    </button>
                    {s.folder && (
                      <button role="menuitem" onClick={(e) => { e.stopPropagation(); setMenu('closed'); rowAction('/api/admin/mirror/session-folder', { devin_id: s.devin_id, folder: null }) }} className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[13px] hover:bg-accent">
                        <OX size={13} className="text-muted-foreground" /> {t('tree.removeFromFolder')}
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </>,
          document.body,
        )}
      {copiedAt > 0 && createPortal(
        <div
          role="status"
          style={{ left: menuPos.left + 8, top: menuPos.top + 4 }}
          className="menu-in pointer-events-none fixed z-[70] flex items-center gap-1.5 rounded-md bg-foreground px-2 py-1 text-[12px] leading-[16px] text-background shadow-md"
        >
          <Link2 size={12} /> {t('menu.linkCopied')}
        </div>,
        document.body,
      )}
      </div>
      {open && kids.map((c) => <TreeRow key={c.devin_id} s={c} depth={depth + 1} activeDevinId={activeDevinId} folders={folders} onOpen={onOpen} onPrefetch={onPrefetch} onRefresh={onRefresh} archivedView={archivedView} compact={compact} propHidden={propHidden} dwellId={dwellId} suppressHover={suppressHover} navGuard={navGuard} />)}
      {open && !allKids && s.total_children > s.children.length && (
        <div data-slot="sidebar-menu-item" className="group/row relative" style={{ paddingLeft: (depth + 1) * 14 }}>
          <button
            aria-label={t('tree.showMore', { n: s.total_children - s.children.length })}
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
            {t('tree.loadMore')}
          </button>
        </div>
      )}
    </>
  )
}

export { TreeRow, TreeRowGhost };
export type { TreeAccept, RowDrop };
