import { useRef, type Dispatch, type DragEvent, type ReactNode, type SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import { Folder as FolderIcon } from 'lucide-react'
import { ODots, OSearch } from '../../components/officialIcons'
import { type MirrorTreeSession } from './treeCache'
import { type FolderMenuState } from './treePrefs'
import { TreeRow } from './TreeRow'

/** One tree section (a folder, Pinned, Recent, a project bucket, or Archived):
 *  sticky label row — collapse toggle, per-folder search input, folder ⋯ menu
 *  trigger, drag-to-reorder — then its TreeRow list. Search/collapse/drag and
 *  the folder menu state live in SessionTree (shared across sections). */
function TreeSection({ name, items, isFolder, icon, showCount, archived, searchIn, searchQ, setSearchIn, setSearchQ, closed, setClosed, dragFolder, setDragFolder, previewOrder, setPreviewOrder, folderNames, folderTotals, folderAction, setFolderMenu, setFolderDraft, activeDevinId, onOpen, onPrefetch, onRefresh, compact, propHidden, dropFolder, dropPin }: { name: string; items: MirrorTreeSession[]; isFolder?: boolean; icon?: ReactNode; showCount?: boolean; archived?: boolean; searchIn: string | null; searchQ: string; setSearchIn: Dispatch<SetStateAction<string | null>>; setSearchQ: Dispatch<SetStateAction<string>>; closed: Record<string, boolean>; setClosed: Dispatch<SetStateAction<Record<string, boolean>>>; dragFolder: string | null; setDragFolder: Dispatch<SetStateAction<string | null>>; previewOrder: string[] | null; setPreviewOrder: Dispatch<SetStateAction<string[] | null>>; folderNames: string[]; folderTotals?: Record<string, number>; folderAction: (path: string, payload: Record<string, unknown>) => Promise<void>; setFolderMenu: Dispatch<SetStateAction<FolderMenuState | null>>; setFolderDraft: Dispatch<SetStateAction<string>>; activeDevinId: string; onOpen: (s: MirrorTreeSession) => void; onPrefetch?: (s: MirrorTreeSession) => void; onRefresh?: () => void; compact?: boolean; propHidden?: Record<string, boolean>; /** Defined = this section accepts session drops; the value is the folder to assign (null = unfile). */ dropFolder?: string | null; /** Pinned section — a session dropped here gets pinned (and can be positioned). */ dropPin?: boolean }) {
  const { t } = useTranslation()
  const searching = searchIn === name
  const shown = searching && searchQ.trim()
    ? items.filter((s) => (s.title || s.devin_id).toLowerCase().includes(searchQ.trim().toLowerCase()))
    : items
  // Session drops: `accepts` gates the whole section; row-level drops land at
  // an exact position (`after` = the previous row's id). The insertion marker
  // is a DOM class on the target row — no React state churn during dragover.
  const accepts = dropFolder !== undefined || !!dropPin
  const markRef = useRef<HTMLElement | null>(null)
  const markRow = (el: HTMLElement | null, before: boolean) => {
    if (markRef.current !== el) markRef.current?.classList.remove('dw-drop-a', 'dw-drop-b')
    if (el) { el.classList.toggle('dw-drop-b', before); el.classList.toggle('dw-drop-a', !before) }
    markRef.current = el
  }
  const rowDropPos = (e: DragEvent, sid: string) => {
    const list = shown.filter((x) => x.devin_id !== sid)
    const rowEl = (e.target as HTMLElement).closest<HTMLElement>('[data-dw-sid]')
    let pos = list.length
    if (rowEl?.dataset.dwSid) {
      const ti = list.findIndex((x) => x.devin_id === rowEl.dataset.dwSid)
      if (ti >= 0) {
        const r = rowEl.getBoundingClientRect()
        pos = ti + (e.clientY < r.top + r.height / 2 ? 0 : 1)
      }
    }
    return { pos, after: pos <= 0 ? null : list[pos - 1].devin_id }
  }
  const onRowDragOver = (e: DragEvent) => {
    if (!accepts || searching || !e.dataTransfer.types.includes('text/x-dw-session')) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    const rowEl = (e.target as HTMLElement).closest<HTMLElement>('[data-dw-sid]')
    if (rowEl) {
      const r = rowEl.getBoundingClientRect()
      markRow(rowEl, e.clientY < r.top + r.height / 2)
    }
  }
  const onRowDrop = (e: DragEvent) => {
    markRow(null, false)
    const sid = e.dataTransfer.getData('text/x-dw-session')
    if (!sid || !accepts || searching) return
    e.preventDefault()
    e.stopPropagation()
    const { after } = rowDropPos(e, sid)
    if (dropPin) void folderAction('/api/admin/mirror/session-pin', { devin_id: sid, pinned: true, after })
    else void folderAction('/api/admin/mirror/session-folder', { devin_id: sid, folder: dropFolder ?? null, after })
  }
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
        onDragOver={(e) => {
          // Session rows dropped on the header assign without a position
          // (land at the section top via after:null on the actual drop).
          if (accepts && e.dataTransfer.types.includes('text/x-dw-session')) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            return
          }
          if (!isFolder || !dragFolder || dragFolder === name) return
          e.preventDefault()
          setPreviewOrder((prev) => {
            const cur = prev ?? folderNames
            const order = cur.filter((f) => f !== dragFolder)
            order.splice(order.indexOf(name) + (cur.indexOf(dragFolder) < cur.indexOf(name) ? 1 : 0), 0, dragFolder)
            return order
          })
        }}
        onDrop={(e) => {
          const sid = e.dataTransfer.getData('text/x-dw-session')
          if (sid && accepts) {
            e.preventDefault()
            if (dropPin) void folderAction('/api/admin/mirror/session-pin', { devin_id: sid, pinned: true, after: null })
            else void folderAction('/api/admin/mirror/session-folder', { devin_id: sid, folder: dropFolder ?? null, after: null })
            return
          }
          if (isFolder) e.preventDefault()
        }}
        className="group/label sticky top-0 z-20 flex h-8 w-full shrink-0 items-center justify-between gap-px bg-background pl-1 pr-1 text-[12px] font-medium text-muted-foreground"
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
            aria-label={t('common.search')}
            title={t('common.search')}
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
      <div
        onDragOver={onRowDragOver}
        onDrop={onRowDrop}
        onDragLeave={(e) => { if (!(e.relatedTarget as HTMLElement | null)?.closest?.('[data-dw-sid]')) markRow(null, false) }}
      >
        {!closed[name] && shown.map((s) => <TreeRow key={s.devin_id} s={s} depth={0} activeDevinId={activeDevinId} folders={folderNames} onOpen={onOpen} onPrefetch={onPrefetch} onRefresh={onRefresh} archivedView={archived} compact={compact} propHidden={propHidden} />)}
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
