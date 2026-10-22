import { useCallback, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import { Folder as FolderIcon } from 'lucide-react'
import { ODots, OSearch } from '../../components/officialIcons'
import { type MirrorTreeSession } from './treeCache'
import { type FolderMenuState } from './treePrefs'
import { TreeRow, type TreeAccept } from './TreeRow'

/** One tree section (a folder, Pinned, Recent, a project bucket, or Archived):
 *  sticky label row — collapse toggle, per-folder search input, folder ⋯ menu
 *  trigger — then its TreeRow list. The label row is the section's droppable
 *  (`folder:` headers double as the folder-reorder source/target; Pinned and
 *  Recent are `section:` drop targets). Drag state, insertion markers and the
 *  folder menu state live in SessionTree (shared across sections). */
function TreeSection({ name, items, isFolder, icon, showCount, archived, searchIn, searchQ, setSearchIn, setSearchQ, closed, setClosed, dragFolder, folderNames, folderTotals, folderAction, setFolderMenu, setFolderDraft, activeDevinId, onOpen, onPrefetch, onRefresh, compact, propHidden, dropFolder, dropPin, dwellId, navGuard, sectionId }: { name: string; items: MirrorTreeSession[]; isFolder?: boolean; icon?: ReactNode; showCount?: boolean; archived?: boolean; searchIn: string | null; searchQ: string; setSearchIn: Dispatch<SetStateAction<string | null>>; setSearchQ: Dispatch<SetStateAction<string>>; closed: Record<string, boolean>; setClosed: Dispatch<SetStateAction<Record<string, boolean>>>; dragFolder: string | null; folderNames: string[]; folderTotals?: Record<string, number>; folderAction: (path: string, payload: Record<string, unknown>) => Promise<void>; setFolderMenu: Dispatch<SetStateAction<FolderMenuState | null>>; setFolderDraft: Dispatch<SetStateAction<string>>; activeDevinId: string; onOpen: (s: MirrorTreeSession) => void; onPrefetch?: (s: MirrorTreeSession) => void; onRefresh?: () => void; compact?: boolean; propHidden?: Record<string, boolean>; /** Defined = this section accepts session drops; the value is the folder to assign (null = unfile). */ dropFolder?: string | null; /** Pinned section — a session dropped here gets pinned (and can be positioned). */ dropPin?: boolean; /** Session id the drag dwell wants expanded (parent-peek). */ dwellId?: string | null; /** Shared ms timestamp of the last drag end/cancel — suppresses the click a drop on this label leaves behind. */ navGuard?: { current: number }; /** Unique droppable key for non-folder sections (project buckets share basenames). */ sectionId?: string }) {
  const { t } = useTranslation()
  const searching = searchIn === name
  const shown = searching && searchQ.trim()
    ? items.filter((s) => (s.title || s.devin_id).toLowerCase().includes(searchQ.trim().toLowerCase()))
    : items
  // Session drops: `accepts` gates the whole section; the label header accepts
  // without a position (lands on top via after:null) and each row is a
  // positional `session-target:` insert via `dndSection.items`.
  const accepts = dropFolder !== undefined || !!dropPin
  const accept: TreeAccept | undefined = dropPin ? { pin: true } : accepts ? { folder: dropFolder ?? null } : undefined
  const drop = useDroppable({
    id: isFolder ? `folder:${name}` : `section:${sectionId ?? name}`,
    data: { type: isFolder ? 'folder' : 'section', name, accept },
    disabled: !accepts && !isFolder,
  })
  const fdrag = useDraggable({
    id: isFolder ? `folder-drag:${name}` : `section-drag:${sectionId ?? name}`,
    data: { type: 'folder', name },
    disabled: !isFolder || searching,
  })
  const setLabelRef = useCallback((el: HTMLElement | null) => { fdrag.setNodeRef(el); drop.setNodeRef(el) }, [fdrag.setNodeRef, drop.setNodeRef])
  return (
    <div className={`mb-1 ${isFolder && dragFolder === name ? 'opacity-50' : ''}`}>
      <div
        data-slot="sidebar-label-row"
        ref={setLabelRef}
        {...fdrag.listeners}
        onPointerDown={(e) => { if (e.button === 0) (fdrag.listeners?.onPointerDown as ((ev: React.PointerEvent) => void) | undefined)?.(e) }}
        className={`group/label sticky top-0 z-20 flex h-8 w-full shrink-0 items-center justify-between gap-px bg-background pl-1 pr-1 text-[12px] font-medium text-muted-foreground ${drop.isOver ? 'rounded-md bg-tint-secondary' : ''}`}
      >
        {searching ? (
          <input
            autoFocus
            value={searchQ}
            placeholder={t('tree.searchSessions')}
            onChange={(e) => setSearchQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setSearchIn(null); setSearchQ('') } }}
            className="h-7 w-full min-w-0 flex-1 rounded-[6px] border border-border bg-transparent px-2 text-[13px] font-normal text-foreground outline-none placeholder:text-muted-foreground"
          />
        ) : (
        <button
          onClick={() => {
            // A folder dropped back onto its own label lets a click through —
            // swallow it instead of toggling the section mid-gesture.
            if (navGuard && Date.now() - navGuard.current < 250) return
            setClosed((m) => ({ ...m, [name]: !m[name] }))
          }}
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
            aria-label={t('common.search')}
            title={t('common.search')}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setSearchQ(''); setSearchIn(name) }}
            className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md opacity-0 transition-all hover:text-foreground focus:opacity-100 group-hover/label:opacity-100"
          >
            <OSearch size={13} />
          </button>
        )}
        {isFolder && !searching && (
          <button
            aria-label={t('tree.folderOptions')}
            title={t('tree.folderOptions')}
            onPointerDown={(e) => e.stopPropagation()}
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
            <ODots size={14} />
          </button>
        )}
      </div>
      <div>
        {!closed[name] && shown.map((s) => <TreeRow key={s.devin_id} s={s} depth={0} activeDevinId={activeDevinId} folders={folderNames} onOpen={onOpen} onPrefetch={onPrefetch} onRefresh={onRefresh} archivedView={archived} compact={compact} propHidden={propHidden} dndSection={accepts && !searching ? { accept: accept!, items: shown.map((x) => x.devin_id) } : undefined} dwellId={dwellId} suppressHover={!!dragFolder} navGuard={navGuard} />)}
      </div>
      {!closed[name] && searching && shown.length === 0 && (
        <div className="px-2 py-1.5 text-[12px] text-muted-foreground">{t('common.noResults')}</div>
      )}
      {!closed[name] && archived && !searching && items.length === 0 && (
        <div className="px-2 py-1.5 text-[12px] text-muted-foreground">{t('tree.noSessions')}</div>
      )}
    </div>
    )
}

export { TreeSection };
