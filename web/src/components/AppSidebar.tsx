import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'
import { GitPullRequest, RefreshCw, RotateCcw, Rows3, Settings2 } from 'lucide-react'
import { OChevronDown, OCollapse, OCompose, OSearch, OBell } from './officialIcons'
import { adminFetch } from '@/lib/api'
import LocalDock from './LocalDock'
import { type TreePrefs, TREE_PREFS_KEY, DEFAULT_TREE_PREFS, SessionTree } from '../pages/mirror/SessionTree'
import type { MirrorTreeSession } from '../pages/mirror/treeCache'

const menuItem = 'flex w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] text-foreground outline-none hover:bg-tint-secondary [&>svg]:size-4 [&>svg]:shrink-0'

function readTreePrefs(): TreePrefs {
  try { return { ...DEFAULT_TREE_PREFS, ...JSON.parse(localStorage.getItem(TREE_PREFS_KEY) || '{}') } } catch { return DEFAULT_TREE_PREFS }
}

/**
 * The shared app sidebar — official 300px shell: org menu, search, unread bell,
 * collapse, nav rows (New session / Sessions / Review), live SessionTree,
 * LocalDock. Used by SessionsPage and the standalone review page.
 * `open` is controlled so the page header can render the expand trigger.
 */
export default function AppSidebar({ open, onToggle, active, tree, archivedTree, activeDevinId = '', onOpen, onRefresh, onLoadMore, loadingMore, folderOrder, folderTotals, onSearch }: {
  open: boolean
  onToggle: (open: boolean) => void
  active: 'new' | 'sessions' | 'review'
  tree: MirrorTreeSession[]
  archivedTree?: MirrorTreeSession[]
  activeDevinId?: string
  onOpen?: (s: MirrorTreeSession) => void
  onRefresh?: () => void
  onLoadMore?: () => void
  loadingMore?: boolean
  folderOrder?: string[]
  folderTotals?: Record<string, number>
  onSearch?: () => void
}) {
  const { t } = useTranslation()
  const nav = useNavigate()
  const [orgMenu, setOrgMenu] = useState(false)
  const [notifOpen, setNotifOpen] = useState(false)
  const [treePrefs, setTreePrefs] = useState<TreePrefs>(readTreePrefs)
  const updateTreePrefs = (p: Partial<TreePrefs>) => setTreePrefs((prev) => {
    const n = { ...prev, ...p }
    try { localStorage.setItem(TREE_PREFS_KEY, JSON.stringify(n)) } catch { /* unavailable */ }
    return n
  })
  const unreadSessions = useMemo(() => tree.filter((s) => s.is_unread), [tree])
  const openSession = onOpen ?? ((s: MirrorTreeSession) => nav(`/admin/${s.devin_id}`))
  const navCls = (key: string) =>
    `mb-px flex h-[30px] items-center gap-2 rounded-[6px] px-2 text-[13px] leading-[18px] text-foreground hover:bg-tint-secondary${active === key ? ' bg-tint-secondary font-medium' : ''}`
  return (
    <>
      {open && <div className="fixed inset-0 z-40 bg-scrim md:hidden" onClick={() => onToggle(false)} />}
      {open && (
        <aside data-slot="sidebar" className="flex w-[300px] shrink-0 flex-col border-r border-border bg-background max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:shadow-xl">
          <div data-slot="sidebar-header" className="flex items-center gap-0.5 px-2 pt-2">
            <div className="relative">
              <button
                onClick={() => setOrgMenu((v) => !v)}
                className="flex h-[30px] max-w-[200px] cursor-pointer items-center gap-1.5 rounded-[6px] pl-1.5 pr-2 text-[13px] font-medium text-foreground hover:bg-tint-secondary"
              >
                <span className="flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-foreground text-[9px] font-semibold text-background">{t('sp.localBadge')}</span>
                <span className="truncate">{t('sp.appName')}</span>
                <OChevronDown size={12} className="shrink-0 text-muted-foreground" />
              </button>
              {orgMenu && (
                <>
                  <div className="fixed inset-0 z-20" onClick={() => setOrgMenu(false)} />
                  <div role="menu" className="absolute left-0 top-9 z-30 w-[220px] overflow-hidden rounded-[10px] bg-card/95 p-1 shadow-lg ring-1 ring-border backdrop-blur-[8px]">
                    <button role="menuitem" onClick={() => { setOrgMenu(false); nav('/settings') }} className={menuItem}>
                      <Settings2 size={14} className="text-muted-foreground" /> {t('sp.prefs')}
                    </button>
                    <div role="separator" className="mx-2 h-[9px] bg-border bg-clip-content py-1" />
                    <button role="menuitem" onClick={async () => { setOrgMenu(false); if (!confirm(t('sp.restartConfirm'))) return; await adminFetch('/api/admin/restart', { method: 'POST', body: JSON.stringify({}) }).catch(() => null) }} className={menuItem}>
                      <RotateCcw size={14} className="text-muted-foreground" /> {t('sp.restart')}
                    </button>
                    <button role="menuitem" onClick={async () => { setOrgMenu(false); if (!confirm(t('sp.rebuildConfirm'))) return; await adminFetch('/api/admin/redeploy', { method: 'POST', body: JSON.stringify({}) }).catch(() => null) }} className={menuItem}>
                      <RefreshCw size={14} className="text-muted-foreground" /> {t('sp.rebuild')}
                    </button>
                  </div>
                </>
              )}
            </div>
            <button
              onClick={onSearch}
              className="ml-auto flex size-7 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground disabled:opacity-50"
              aria-label={t('common.search')}
              title={t('common.search')}
              disabled={!onSearch}
            >
              <OSearch size={16} />
            </button>
            <button
              onClick={() => setNotifOpen((v) => !v)}
              className="relative flex size-7 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground"
              aria-label={t('sp.notif')}
              title={t('sp.notif')}
            >
              <OBell size={16} />
              {unreadSessions.length > 0 && <span className="absolute right-1 top-1 size-1.5 rounded-full bg-red-500" />}
            </button>
            {notifOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setNotifOpen(false)} />
                <div className="absolute left-0 right-0 top-10 z-30 mx-2 overflow-hidden rounded-[10px] bg-card/95 p-1 shadow-lg ring-1 ring-border backdrop-blur-[8px]">
                  <div className="px-2 pb-1 pt-2 text-[12px] font-medium text-muted-foreground">{t('sp.unreadSessions')}</div>
                  {unreadSessions.length === 0 && <div className="px-2 pb-2 pt-1 text-[13px] text-muted-foreground">{t('sp.noUnread')}</div>}
                  {unreadSessions.slice(0, 8).map((s) => (
                    <button
                      key={s.devin_id}
                      role="menuitem"
                      onClick={() => { setNotifOpen(false); openSession(s) }}
                      className="flex w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] text-foreground hover:bg-tint-secondary"
                    >
                      <span className="size-1.5 shrink-0 rounded-full bg-blue-500" />
                      <span className="min-w-0 flex-1 truncate">{s.title || s.devin_id}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
            <button
              onClick={() => onToggle(false)}
              className="flex size-7 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground"
              aria-label={t('sp.collapseSb')}
              title={t('sp.collapseSb')}
            >
              <OCollapse size={16} />
            </button>
          </div>
          <nav className="flex flex-col px-2 pt-1">
            <Link to="/admin/new" aria-current={active === 'new' ? 'page' : undefined} className={navCls('new')}>
              <OCompose size={14} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{t('sp.newSession')}</span>
            </Link>
            <Link to="/admin/sessions" aria-current={active === 'sessions' ? 'page' : undefined} className={navCls('sessions')}>
              <Rows3 size={14} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{t('sp.sessionsMgmt')}</span>
            </Link>
            <Link to="/admin/review" aria-current={active === 'review' ? 'page' : undefined} className={navCls('review')}>
              <GitPullRequest size={14} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{t('rv.back')}</span>
            </Link>
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            <SessionTree
              tree={tree}
              archivedTree={archivedTree}
              activeDevinId={activeDevinId}
              onOpen={openSession}
              onRefresh={onRefresh}
              prefs={treePrefs}
              onPrefs={updateTreePrefs}
              folderOrder={folderOrder}
              folderTotals={folderTotals}
              onLoadMore={onLoadMore}
              loadingMore={loadingMore}
            />
          </div>
          <LocalDock />
        </aside>
      )}
    </>
  )
}
