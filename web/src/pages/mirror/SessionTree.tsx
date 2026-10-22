import { memo, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { Clock, Folder as FolderIcon, Pencil, Plus } from 'lucide-react'
import { OArchive, OPin, OX } from '../../components/officialIcons'
import { adminFetch } from '@/lib/api'
import { cn } from '@/lib/utils'
import { type MirrorTreeSession } from './treeCache'
import { PROP_NAMES, type TreePrefs, TREE_PREFS_KEY, DEFAULT_TREE_PREFS, RANGE_LABELS, RANGE_DAYS, dateFrom, buildFilterQ, filterCount, menuItemCls, type FolderMenuState } from './treePrefs'
import { TreeRow } from './TreeRow'
import { MenuCalendar, TreeHeaderMenus } from './TreeMenus'
import { TreeSection } from './TreeSection'

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
    return { pinned, folders, rest, projects }
  }, [tree, folderOrder, prefs.groupBy])
  const folderNames = useMemo(() => [...groups.folders.keys()], [groups])
  const [folderMenu, setFolderMenu] = useState<FolderMenuState | null>(null)
  const [folderDraft, setFolderDraft] = useState('')
  const [searchIn, setSearchIn] = useState<string | null>(null)
  const [searchQ, setSearchQ] = useState('')
  const [dragFolder, setDragFolder] = useState<string | null>(null)
  const [previewOrder, setPreviewOrder] = useState<string[] | null>(null)
  const folderAction = async (path: string, payload: Record<string, unknown>) => {
    try { await adminFetch(path, { method: 'POST', body: JSON.stringify(payload) }) } catch { /* refresh reflects state */ }
    onRefresh?.()
  }
  // Closure state every section shares — section search/collapse, folder
  // drag-reorder preview, folder menu trigger, and the row callbacks.
  const sectionShared = { searchIn, searchQ, setSearchIn, setSearchQ, closed, setClosed, dragFolder, setDragFolder, previewOrder, setPreviewOrder, folderNames, folderTotals, folderAction, setFolderMenu, setFolderDraft, activeDevinId, onOpen, onPrefetch, onRefresh, compact: prefs.compact, propHidden: prefs.propHidden }
  return (
    <div className="px-2 py-1">
      <TreeHeaderMenus prefs={prefs} onPrefs={onPrefs} tree={tree} folderNames={folderNames} folderAction={folderAction} />
      {(previewOrder ?? folderNames).filter((name) => !prefs.hidden[name]).map((name) => <TreeSection key={name} name={name} items={groups.folders.get(name) ?? []} isFolder dropFolder={name} {...sectionShared} />)}
      {groups.pinned.length > 0 && !prefs.hidden['Pinned'] && <TreeSection name={t('tree.gPinned')} items={groups.pinned} icon={<OPin size={14} />} showCount {...sectionShared} />}
      {groups.rest.length > 0 && !prefs.hidden['Recent'] && <TreeSection name={t('tree.gRecent')} items={groups.rest} icon={<Clock size={14} />} dropFolder={null} {...sectionShared} />}
      {[...groups.projects.entries()].map(([cwd, items]) => (
        <TreeSection
          key={`proj:${cwd}`}
          name={cwd === t('tree.noDir') ? cwd : (cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd)}
          items={items}
          icon={<FolderIcon size={14} />}
          showCount
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
          {loadingMore ? 'Loading...' : 'Load more...'}
        </button>
      )}
      {prefs.showArchived && <TreeSection name={t('menu.archived')} items={archivedTree ?? []} icon={<OArchive size={14} />} archived {...sectionShared} />}
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
                      folderAction('/api/admin/mirror/session-archive', { devin_ids: ids, archive: true })
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
