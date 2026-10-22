import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '@/i18n'
import { Link } from 'react-router-dom'
import { ChevronDown, Settings2, Globe, RotateCcw, RefreshCw, Rows3, Zap, Shield, GitPullRequest, BookOpen } from 'lucide-react'
import { OBell, OCollapse, OCompose, OSearch } from '../../components/officialIcons'
import { adminFetch, type AdminSession } from '@/lib/api'
import { StatusDot } from '@/components/ui'
import LocalDock from '@/components/LocalDock'
import { cn } from '@/lib/utils'
import { type MirrorTreeSession } from './treeCache'
import { type TreePrefs, SessionTree } from './SessionTree'

/** Left session-nav rail: org menu + search/notifications/collapse header,
 *  nav rows, the SessionTree (or legacy registry list), and the LocalDock.
 *  Includes the mobile backdrop + collapsed-edge hover strip — the whole
 *  "left: session list" region of the mirror layout. */
function SidebarRail({ isVisitor, sidebar, peek, setSidebar, setPeek, isDraft, nav, onOpenPalette, waitForRestart, unreadSessions, tree, archTree, activeDevinId, onOpen, onPrefetch, onRefresh, prefs, onPrefs, folderOrder, folderTotals, onLoadMore, loadingMore, sessions, id }: {
  isVisitor: boolean
  sidebar: boolean
  peek: boolean
  setSidebar: (v: boolean | ((p: boolean) => boolean)) => void
  setPeek: (v: boolean) => void
  isDraft: boolean
  nav: (path: string) => void
  onOpenPalette: () => void
  waitForRestart: () => void
  unreadSessions: MirrorTreeSession[]
  tree: MirrorTreeSession[]
  archTree: MirrorTreeSession[]
  activeDevinId: string
  onOpen: (s: MirrorTreeSession) => void
  onPrefetch: (s: MirrorTreeSession) => void
  onRefresh: () => void
  prefs: TreePrefs
  onPrefs: (p: Partial<TreePrefs>) => void
  folderOrder: string[]
  folderTotals: Record<string, number>
  onLoadMore?: () => void
  loadingMore: boolean
  sessions: AdminSession[]
  id: string
}) {
  const { t } = useTranslation()
  const [orgMenu, setOrgMenu] = useState(false)
  const [notifOpen, setNotifOpen] = useState(false)
  const unreadCount = unreadSessions.length
  // Session-list scroll memory + the dock overlay height. The scroll region
  // runs to the page bottom; the dock floats over it (padding keeps the last
  // rows reachable).
  const treeScrollRef = useRef<HTMLDivElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  const [dockH, setDockH] = useState(52)
  useEffect(() => {
    const d = dockRef.current
    if (!d) return
    const ro = new ResizeObserver(() => setDockH(d.offsetHeight))
    ro.observe(d)
    return () => ro.disconnect()
  }, [sidebar, peek])
  useEffect(() => {
    const el = treeScrollRef.current
    if (!el) return
    try { el.scrollTop = Number(localStorage.getItem('dw-tree-scroll') || 0) || 0 } catch { /* unavailable */ }
    let t = 0
    const onScroll = () => {
      window.clearTimeout(t)
      t = window.setTimeout(() => {
        try { localStorage.setItem('dw-tree-scroll', String(Math.round(el.scrollTop))) } catch { /* quota */ }
      }, 150)
    }
    el.addEventListener('scroll', onScroll)
    return () => { window.clearTimeout(t); el.removeEventListener('scroll', onScroll) }
  }, [sidebar, peek])
  return (
    <>
      {!isVisitor && sidebar && window.innerWidth < 768 && (
        <button type="button" aria-label="Close sidebar" className="fixed inset-0 z-40 cursor-default before:absolute before:inset-0 before:bg-black/50 before:content-[''] md:hidden motion-safe:transition-opacity" onClick={() => setSidebar(false)} />
      )}
      {!isVisitor && !sidebar && window.innerWidth >= 768 && (
        <div className="absolute inset-y-0 left-0 z-30 w-2" onMouseEnter={() => setPeek(true)} />
      )}
      {!isVisitor && (sidebar || peek || window.innerWidth < 768) && (
        <aside
          data-slot="sidebar"
          data-state={sidebar ? 'expanded' : 'collapsed'}
          onMouseLeave={() => { if (!sidebar) setPeek(false) }}
          className={cn(
            'group/sidebar relative flex w-[300px] shrink-0 flex-col bg-background max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:duration-150 max-md:ease-out motion-safe:max-md:transition-transform',
            !sidebar && 'max-md:-translate-x-full',
            sidebar
              ? 'border-r border-border'
              : window.innerWidth >= 768
                ? 'absolute bottom-0 left-0 top-11 z-40 overflow-hidden rounded-r-xl border border-border shadow-lg'
                : '',
          )}
        >
          {/* Official rail top (measured live): org-button h-30 + Search /
              Notifications / Collapse 28px icons; then nav rows 274×30
              (New session, More) before the sections list. */}
          <div data-slot="sidebar-header" className="flex items-center gap-0.5 px-2 pt-2">
            <div className="relative">
              <button
                onClick={() => setOrgMenu((v) => !v)}
                className="flex h-[30px] max-w-[200px] cursor-pointer items-center gap-1.5 rounded-[6px] pl-1.5 pr-2 text-[13px] font-medium text-foreground hover:bg-tint-secondary"
              >
                <span className="flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-foreground text-[9px] font-semibold text-background">{t('menu.appInitial')}</span>
                <span className="truncate">{t('menu.appName')}</span>
                <ChevronDown size={12} className="shrink-0 text-muted-foreground" />
              </button>
              {orgMenu && (
                <>
                  <div className="fixed inset-0 z-20" onClick={() => setOrgMenu(false)} />
                  <div role="menu" className="absolute left-0 top-9 z-30 w-[220px] overflow-hidden rounded-[10px] bg-card/95 p-1 shadow-lg ring-1 ring-border backdrop-blur-[8px]">
                    <button role="menuitem" onClick={() => { setOrgMenu(false); nav('/settings') }}
                      className="flex w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] text-foreground outline-none hover:bg-tint-secondary">
                      <Settings2 size={14} className="text-muted-foreground" /> {t('menu.preferences')}
                    </button>
                    <button role="menuitem" onClick={() => void i18n.changeLanguage(i18n.language.startsWith('zh') ? 'en' : 'zh')}
                      className="flex w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] text-foreground outline-none hover:bg-tint-secondary">
                      <Globe size={14} className="text-muted-foreground" /> {i18n.language.startsWith('zh') ? 'English' : '中文'}
                    </button>
                    <div role="separator" className="mx-2 h-[9px] bg-border bg-clip-content py-1" />
                    <button role="menuitem" onClick={async () => { setOrgMenu(false); if (!confirm(t('menu.restartServiceConfirm'))) return; void adminFetch('/api/admin/audit', { method: 'POST', body: JSON.stringify({ action: 'restart-request' }) }).catch(() => null); await adminFetch('/api/admin/restart', { method: 'POST', body: JSON.stringify({}) }).catch(() => null); waitForRestart() }}
                      className="flex w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] text-foreground outline-none hover:bg-tint-secondary">
                      <RotateCcw size={14} className="text-muted-foreground" /> {t('menu.restartService')}
                    </button>
                    <button role="menuitem" onClick={async () => { setOrgMenu(false); if (!confirm(t('menu.redeployConfirm'))) return; void adminFetch('/api/admin/audit', { method: 'POST', body: JSON.stringify({ action: 'redeploy-request' }) }).catch(() => null); await adminFetch('/api/admin/redeploy', { method: 'POST', body: JSON.stringify({}) }).catch(() => null); waitForRestart() }}
                      className="flex w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] text-foreground outline-none hover:bg-tint-secondary">
                      <RefreshCw size={14} className="text-muted-foreground" /> {t('menu.redeploy')}
                    </button>
                  </div>
                </>
              )}
            </div>
            <button
              onClick={onOpenPalette}
              className="ml-auto flex size-7 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground"
              aria-label="Search"
              title="Search (Ctrl+K)"
            >
              <OSearch size={16} />
            </button>
            {/* official header has a Notifications bell between Search and
                Collapse — locally it lists unread sessions */}
            <button
              onClick={() => setNotifOpen((v) => !v)}
              className="relative flex size-7 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground"
              aria-label="Notifications"
              title="Notifications"
            >
              <OBell size={16} />
              {unreadCount > 0 && <span className="absolute right-1 top-1 size-1.5 rounded-full bg-red-500" />}
            </button>
            {notifOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setNotifOpen(false)} />
                <div className="absolute left-0 right-0 top-10 z-30 mx-2 overflow-hidden rounded-[10px] bg-card/95 p-1 shadow-lg ring-1 ring-border backdrop-blur-[8px]">
                  <div className="px-2 pb-1 pt-2 text-[12px] font-medium text-muted-foreground">{t('menu.unreadSessions')}</div>
                  {unreadSessions.length === 0 && <div className="px-2 pb-2 pt-1 text-[13px] text-muted-foreground">{t('menu.noUnread')}</div>}
                  {unreadSessions.slice(0, 8).map((s) => (
                    <button
                      key={s.devin_id}
                      role="menuitem"
                      onClick={() => { setNotifOpen(false); nav(`/admin/${s.devin_id}`) }}
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
              onClick={() => { setPeek(false); setSidebar(false) }}
              className="flex size-7 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground"
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
            >
              <OCollapse size={16} />
            </button>
          </div>
          {/* Official nav rows: New session + More (274×30) above the sections */}
          <nav className="flex flex-col px-2 pt-1">
            <Link
              to="/admin/new"
              aria-current={isDraft ? 'page' : undefined}
              className={cn('mb-px flex h-[30px] items-center gap-2 rounded-[6px] px-2 text-[13px] leading-[18px] text-foreground hover:bg-tint-secondary', isDraft && 'bg-tint-secondary font-medium')}
            >
              <OCompose size={14} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{t('menu.newSession')}</span>
            </Link>
            <Link
              to="/admin/sessions"
              className="mb-px flex h-[30px] items-center gap-2 rounded-[6px] px-2 text-[13px] leading-[18px] text-foreground hover:bg-tint-secondary"
            >
              <Rows3 size={14} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{t('menu.manageSessions')}</span>
            </Link>
            <Link
              to="/admin/automations"
              className="mb-px flex h-[30px] items-center gap-2 rounded-[6px] px-2 text-[13px] leading-[18px] text-foreground hover:bg-tint-secondary"
            >
              <Zap size={14} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{t('sp.automations')}</span>
            </Link>
            <Link
              to="/admin/security"
              className="mb-px flex h-[30px] items-center gap-2 rounded-[6px] px-2 text-[13px] leading-[18px] text-foreground hover:bg-tint-secondary"
            >
              <Shield size={14} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{t('sp.security')}</span>
            </Link>
            <Link
              to="/admin/review"
              className="mb-px flex h-[30px] items-center gap-2 rounded-[6px] px-2 text-[13px] leading-[18px] text-foreground hover:bg-tint-secondary"
            >
              <GitPullRequest size={14} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{t('rv.back')}</span>
            </Link>
            <Link
              to="/admin/wiki"
              className="mb-px flex h-[30px] items-center gap-2 rounded-[6px] px-2 text-[13px] leading-[18px] text-foreground hover:bg-tint-secondary"
            >
              <BookOpen size={14} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{t('sp.wiki')}</span>
            </Link>
          </nav>
          <div ref={treeScrollRef} className="min-h-0 flex-1 overflow-y-auto py-1" style={{ paddingBottom: dockH }}>
            {tree.length > 0 ? (
              <SessionTree tree={tree} archivedTree={archTree} activeDevinId={activeDevinId} onOpen={onOpen} onPrefetch={onPrefetch} onRefresh={onRefresh} prefs={prefs} onPrefs={onPrefs} folderOrder={folderOrder} folderTotals={folderTotals} onLoadMore={onLoadMore} loadingMore={loadingMore} />
            ) : sessions.map((s) => (
              <Link
                key={s.id}
                to={`/admin/${s.id}`}
                onClick={() => { if (window.innerWidth < 768) setSidebar(false) }}
                className={cn('flex items-center gap-2 px-3 py-2 hover:bg-muted', s.id === id && 'bg-muted')}
              >
                <StatusDot status={s.status} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] leading-[18px] font-medium">{s.title || s.devin_title || s.devin_session_id}</span>
                  <span className="block truncate text-[12px] leading-[16px] text-muted-foreground">{s.last_message}</span>
                </span>
              </Link>
            ))}
          </div>
          {/* Dock overlays the bottom of the scroll region — the scrollbar
              track runs to the page bottom edge. */}
          <div ref={dockRef} className="absolute inset-x-0 bottom-0 z-10 border-t border-border/60 bg-background">
            <LocalDock />
          </div>
        </aside>
      )}
    </>
  )
}


export { SidebarRail };
