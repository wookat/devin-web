import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, TouchSensor, useSensor, useSensors, type DragEndEvent, type DragOverEvent, type DragStartEvent, type Over } from '@dnd-kit/core'
import { Clock, Folder as FolderIcon, Pencil, Plus } from 'lucide-react'
import { OArchive, OPin, OX } from '../../components/officialIcons'
import { adminFetch } from '@/lib/api'
import { cn } from '@/lib/utils'
import { type MirrorTreeSession } from './treeCache'
import { PROP_NAMES, type TreePrefs, TREE_PREFS_KEY, DEFAULT_TREE_PREFS, RANGE_LABELS, RANGE_DAYS, dateFrom, buildFilterQ, filterCount, menuItemCls, type FolderMenuState } from './treePrefs'
import { TreeRow, TreeRowGhost, type TreeAccept } from './TreeRow'
import { MenuCalendar, TreeHeaderMenus } from './TreeMenus'
import { TreeSection } from './TreeSection'

/** Droppable `data` shapes seen on the wire: rows carry `session-target`,
 *  folder headers carry `folder` (drop-assign + reorder target), Pinned and
 *  Recent headers carry `section`. */
type DropTargetData = { type?: string; name?: string; sessionId?: string; hasKids?: boolean; accept?: TreeAccept; items?: string[] }
type ResolvedDrop = { accept: TreeAccept; after: string | null; markId: string | null; before: boolean } | null

/** Pointer client-Y across sensor types (PointerEvent + TouchEvent). */
const eventClientY = (e: Event) =>
  typeof TouchEvent !== 'undefined' && e instanceof TouchEvent
    ? (e.touches[0]?.clientY ?? e.changedTouches[0]?.clientY ?? 0)
    : (e as PointerEvent).clientY ?? 0

/** Pointer-Y used for drop resolution: KeyboardEvent activators have no
 *  clientY — take the translated ghost rect's midline instead. */
const dragY = (ev: DragOverEvent | DragEndEvent) =>
  ev.activatorEvent instanceof KeyboardEvent
    ? (ev.active.rect.current.translated?.top ?? 0) + (ev.active.rect.current.translated?.height ?? 0) / 2
    : eventClientY(ev.activatorEvent) + ev.delta.y

/** Keyboard drag steps by one tree row per arrow press. */
const keyboardCoordinates = (_event: KeyboardEvent, { currentCoordinates }: { currentCoordinates: { x: number; y: number } }) => {
  const dy = _event.code === 'ArrowDown' ? 30 : _event.code === 'ArrowUp' ? -30 : undefined
  return dy === undefined ? undefined : { x: currentCoordinates.x, y: currentCoordinates.y + dy }
}

/** Resolve `over` + pointer-Y to the drop a session drag would commit:
 *  row targets give a positional `after` (before/after by row midline);
 *  section/folder headers give after:null (lands on top). */
function resolveDrop(over: Over | null, y: number, draggedId: string): ResolvedDrop {
  const d = over?.data.current as DropTargetData | undefined
  if (!over || !d) return null
  if (d.type === 'session-target' && d.accept && d.sessionId && d.sessionId !== draggedId) {
    const before = y < over.rect.top + over.rect.height / 2
    const list = (d.items ?? []).filter((x) => x !== draggedId)
    const i = list.indexOf(d.sessionId)
    const after = before ? (i > 0 ? list[i - 1] : null) : (i >= 0 ? d.sessionId : null)
    return { accept: d.accept, after, markId: d.sessionId, before }
  }
  if ((d.type === 'folder' || d.type === 'section') && d.accept) {
    return { accept: d.accept, after: null, markId: null, before: false }
  }
  return null
}

/** Official-style session tree: folders, Pinned, Recent, then the optional Archived group. */
const SessionTree = memo(function SessionTree({ tree, archivedTree, activeDevinId, onOpen, onPrefetch, onRefresh, prefs, onPrefs, folderOrder, folderTotals, onLoadMore, loadingMore }: { tree: MirrorTreeSession[]; archivedTree?: MirrorTreeSession[]; activeDevinId: string; onOpen: (s: MirrorTreeSession) => void; onPrefetch?: (s: MirrorTreeSession) => void; onRefresh?: () => void; prefs: TreePrefs; onPrefs: (p: Partial<TreePrefs>) => void; folderOrder?: string[]; folderTotals?: Record<string, number>; onLoadMore?: () => void; loadingMore?: boolean }) {
  const { t } = useTranslation()
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
        const k = s.cwd || t('tree.noDir')
        if (!projects.has(k)) projects.set(k, [])
        projects.get(k)!.push(s)
      }
    }
    // Manual order (sessionOrder / forder): positioned rows keep their stored
    // index; never-ordered rows float to the top keeping updated-desc —
    // a fresh session lands first, a dropped one lands exactly where put.
    const byOrder = (a: MirrorTreeSession, b: MirrorTreeSession) => {
      const ao = a.forder ?? -1, bo = b.forder ?? -1
      if (ao >= 0 && bo >= 0) return ao - bo
      if (ao >= 0) return 1
      if (bo >= 0) return -1
      return 0
    }
    pinned.sort(byOrder); rest.sort(byOrder)
    for (const arr of folders.values()) arr.sort(byOrder)
    return { pinned, folders, rest, projects }
  }, [tree, folderOrder, prefs.groupBy])
  const folderNames = useMemo(() => [...groups.folders.keys()], [groups])
  const [folderMenu, setFolderMenu] = useState<FolderMenuState | null>(null)
  const [folderDraft, setFolderDraft] = useState('')
  const [searchIn, setSearchIn] = useState<string | null>(null)
  const [searchQ, setSearchQ] = useState('')
  const [dragFolder, setDragFolder] = useState<string | null>(null)
  const [previewOrder, setPreviewOrder] = useState<string[] | null>(null)
  // dnd-kit drag state: the live DragOverlay item, the insertion marker node
  // (dw-drop-a/b classes toggled at DOM level so dragover never re-renders),
  // the ~600ms parent-peek dwell timer, and a post-drop click guard.
  const [dragItem, setDragItem] = useState<{ kind: 'session'; s: MirrorTreeSession; width: number } | { kind: 'folder'; name: string; width: number } | null>(null)
  const [dwellId, setDwellId] = useState<string | null>(null)
  const markRef = useRef<HTMLElement | null>(null)
  const peekRef = useRef<{ key: string; timer: number } | null>(null)
  const navGuard = useRef(0)
  const folderAction = async (path: string, payload: Record<string, unknown>) => {
    try { await adminFetch(path, { method: 'POST', body: JSON.stringify(payload) }) } catch { /* refresh reflects state */ }
    onRefresh?.()
  }
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinates }),
  )
  const markRow = (sid: string | null, before: boolean) => {
    const el = sid ? document.querySelector<HTMLElement>(`[data-dw-sid="${CSS.escape(sid)}"]`) : null
    if (markRef.current !== el) markRef.current?.classList.remove('dw-drop-a', 'dw-drop-b')
    if (el) { el.classList.toggle('dw-drop-b', before); el.classList.toggle('dw-drop-a', !before) }
    markRef.current = el
  }
  const clearPeek = () => { if (peekRef.current) { window.clearTimeout(peekRef.current.timer); peekRef.current = null } }
  const armPeek = (key: string, fn: () => void) => {
    if (peekRef.current?.key === key) return
    clearPeek()
    peekRef.current = { key, timer: window.setTimeout(() => { peekRef.current = null; fn() }, 600) }
  }
  useEffect(() => () => { clearPeek(); markRef.current?.classList.remove('dw-drop-a', 'dw-drop-b') }, [])
  const findRow = (id: string): MirrorTreeSession | null => {
    const walk = (list: MirrorTreeSession[]): MirrorTreeSession | null => {
      for (const s of list) { if (s.devin_id === id) return s; const k = walk(s.children); if (k) return k }
      return null
    }
    return walk(tree)
  }
  const onDragStart = (ev: DragStartEvent) => {
    const d = ev.active.data.current as { type?: string; sessionId?: string; name?: string } | undefined
    const width = ev.active.rect.current.initial?.width ?? 0
    if (d?.type === 'folder' && d.name) {
      setDragFolder(d.name)
      setPreviewOrder(folderNames)
      setDragItem({ kind: 'folder', name: d.name, width })
    } else if (d?.type === 'session' && d.sessionId) {
      const s = findRow(d.sessionId)
      if (s) setDragItem({ kind: 'session', s, width })
    }
  }
  const onDragOver = (ev: DragOverEvent) => {
    const { over } = ev
    if (dragItem?.kind === 'folder') {
      // Folder reorder: live-shuffle the preview order (same splice rule the
      // old native handler used — insert after the target when moving down).
      const od = over?.data.current as DropTargetData | undefined
      if (od?.type === 'folder' && od.name && od.name !== dragItem.name) {
        const target = od.name
        setPreviewOrder((prev) => {
          const cur = prev ?? folderNames
          const order = cur.filter((f) => f !== dragItem.name)
          order.splice(order.indexOf(target) + (cur.indexOf(dragItem.name) < cur.indexOf(target) ? 1 : 0), 0, dragItem.name)
          return order
        })
      }
      return
    }
    if (dragItem?.kind !== 'session') return
    const sid = dragItem.s.devin_id
    const od = over?.data.current as DropTargetData | undefined
    const res = resolveDrop(over, dragY(ev), sid)
    markRow(res?.markId ?? null, res?.before ?? false)
    if (od?.type === 'folder' && od.name && closed[od.name]) {
      const nm = od.name
      armPeek(`folder:${nm}`, () => setClosed((m) => ({ ...m, [nm]: false })))
    } else if (od?.type === 'session-target' && od.hasKids && od.sessionId && od.sessionId !== sid) {
      const tid = od.sessionId
      armPeek(`row:${tid}`, () => setDwellId(tid))
    } else {
      clearPeek()
      setDwellId(null)
    }
  }
  const endDrag = () => {
    navGuard.current = Date.now()
    markRow(null, false)
    clearPeek()
    setDwellId(null)
    setDragItem(null)
    setDragFolder(null)
    setPreviewOrder(null)
  }
  const onDragEnd = (ev: DragEndEvent) => {
    if (dragItem?.kind === 'folder') {
      if (previewOrder && previewOrder.join('\n') !== folderNames.join('\n')) {
        void folderAction('/api/admin/mirror/folder-reorder', { order: previewOrder })
      }
    } else if (dragItem?.kind === 'session' && ev.over) {
      const res = resolveDrop(ev.over, dragY(ev), dragItem.s.devin_id)
      if (res) {
        if ('pin' in res.accept) void folderAction('/api/admin/mirror/session-pin', { devin_id: dragItem.s.devin_id, pinned: true, after: res.after })
        else void folderAction('/api/admin/mirror/session-folder', { devin_id: dragItem.s.devin_id, folder: res.accept.folder ?? null, after: res.after })
      }
    }
    endDrag()
  }
  const onDragCancel = () => endDrag()
  // Closure state every section shares — section search/collapse, folder
  // menu trigger, the drag affordances, and the row callbacks.
  const sectionShared = { searchIn, searchQ, setSearchIn, setSearchQ, closed, setClosed, dragFolder, folderNames, folderTotals, folderAction, setFolderMenu, setFolderDraft, activeDevinId, onOpen, onPrefetch, onRefresh, compact: prefs.compact, propHidden: prefs.propHidden, dwellId, navGuard }
  return (
    <div className="px-2 py-1">
      <DndContext sensors={sensors} autoScroll={false} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={onDragCancel}>
      <TreeHeaderMenus prefs={prefs} onPrefs={onPrefs} tree={tree} folderNames={folderNames} folderAction={folderAction} />
      {(previewOrder ?? folderNames).filter((name) => !prefs.hidden[name]).map((name) => <TreeSection key={name} name={name} items={groups.folders.get(name) ?? []} isFolder dropFolder={name} {...sectionShared} />)}
      {groups.pinned.length > 0 && !prefs.hidden['Pinned'] && <TreeSection name={t('tree.gPinned')} items={groups.pinned} icon={<OPin size={14} />} showCount dropPin sectionId="pinned" {...sectionShared} />}
      {groups.rest.length > 0 && !prefs.hidden['Recent'] && <TreeSection name={t('tree.gRecent')} items={groups.rest} icon={<Clock size={14} />} dropFolder={null} sectionId="recent" {...sectionShared} />}
      {[...groups.projects.entries()].map(([cwd, items]) => (
        <TreeSection
          key={`proj:${cwd}`}
          name={cwd === t('tree.noDir') ? cwd : (cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd)}
          items={items}
          icon={<FolderIcon size={14} />}
          showCount
          sectionId={`proj:${cwd}`}
          {...sectionShared}
        />
      ))}
      {onLoadMore && (
        <button
          aria-label={t('tree.loadMore')}
          disabled={loadingMore}
          onClick={onLoadMore}
          className="flex h-[30px] w-full cursor-pointer items-center rounded-md px-2 pl-[26px] text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          {loadingMore ? t('common.loading') : t('tree.loadMore')}
        </button>
      )}
      {prefs.showArchived && <TreeSection name={t('menu.archived')} items={archivedTree ?? []} icon={<OArchive size={14} />} archived sectionId="archived" {...sectionShared} />}
      <DragOverlay dropAnimation={null}>
        {dragItem?.kind === 'session' ? (
          <div className="dw-drag-ghost" style={dragItem.width ? { width: dragItem.width } : undefined}>
            <TreeRowGhost s={dragItem.s} activeDevinId={activeDevinId} compact={prefs.compact} propHidden={prefs.propHidden} />
          </div>
        ) : dragItem?.kind === 'folder' ? (
          <div className="dw-drag-pill"><FolderIcon size={13} className="shrink-0" /><span className="truncate">{dragItem.name}</span></div>
        ) : null}
      </DragOverlay>
      </DndContext>
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
                placeholder={t('tree.folderName')}
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
                      folderAction('/api/admin/mirror/session-archive', { devin_ids: ids, archived: true })
                    }}
                    className={menuItemCls}
                  >
                    <OArchive size={13} className="text-muted-foreground" /> Empty folder
                  </button>
                )}
                <button
                  role="menuitem"
                  onClick={(e) => { e.stopPropagation(); const n = folderMenu.name; setFolderMenu(null); folderAction('/api/admin/mirror/folder-delete', { name: n }) }}
                  className={cn(menuItemCls, 'text-red-500 hover:text-red-500')}
                >
                  <OX size={13} /> Delete folder
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
