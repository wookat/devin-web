import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, FolderOpen, Laptop } from 'lucide-react'
import { OExpand } from '../../components/officialIcons'
import { adminFetch, type AdminSession } from '@/lib/api'
import { type ViewerCaps } from '@/lib/viewer'
import { PrStateIcon } from '@/components/PrCards'
import { PanelHideTabsIcon } from '@/components/panelTabIcons'
import { cn } from '@/lib/utils'
import { type MirrorTreeSession } from './treeCache'
import { type SessionDetail } from './pageBits'
import { SessionMenu } from './SessionMenu'

/* Session header row — title, parent link, PR chip (with its fixed-position
 * portal menu), platform/cwd/work-time chips, the gear menu and the
 * show-panel button. Owns the PR-chip menu state cluster. */
function HeaderBar({ isVisitor, sidebar, setPeek, setSidebar, detail, isDraft, current, caps, openPr, workSecs, id, isSub, isDevinSession, treeNode, folderOrder, userMsgCount, reloadDetail, loadTree, onControlMsg, effShowPanel, setShowPanel }: {
  isVisitor: boolean
  sidebar: boolean
  setPeek: (v: boolean) => void
  setSidebar: (v: boolean | ((p: boolean) => boolean)) => void
  detail: SessionDetail | null
  isDraft: boolean
  current: AdminSession | undefined
  caps: ViewerCaps
  openPr: (prUrl: string) => void
  workSecs: number
  id: string
  isSub: boolean
  isDevinSession: boolean
  treeNode: MirrorTreeSession | null
  folderOrder: string[]
  userMsgCount: number
  reloadDetail: () => void
  loadTree: () => void
  onControlMsg: (msg: string) => void
  effShowPanel: boolean
  setShowPanel: (v: boolean | ((p: boolean) => boolean)) => void
}) {
  const { t } = useTranslation()
  const nav = useNavigate()
  const [prMenuOpen, setPrMenuOpen] = useState(false)
  const prChipRef = useRef<HTMLButtonElement>(null)
  const [prMenuPos, setPrMenuPos] = useState({ left: 5, top: 0, width: 320 })
  const headerPrs = detail?.session.pull_requests || []
  const latestHeaderPr = headerPrs[headerPrs.length - 1]
  const updatePrMenuPosition = useCallback(() => {
    const chip = prChipRef.current
    if (!chip) return
    const rect = chip.getBoundingClientRect()
    const width = Math.min(320, window.innerWidth * 0.9)
    const left = Math.max(5, Math.min(rect.left, window.innerWidth - 5 - width))
    setPrMenuPos({ left, top: rect.bottom + 2, width })
  }, [])
  const closePrMenu = useCallback(() => {
    setPrMenuOpen(false)
    requestAnimationFrame(() => prChipRef.current?.focus())
  }, [])
  useEffect(() => {
    if (!prMenuOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closePrMenu()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closePrMenu, prMenuOpen])
  useLayoutEffect(() => {
    if (!prMenuOpen) return
    updatePrMenuPosition()
    window.addEventListener('resize', updatePrMenuPosition)
    window.addEventListener('scroll', updatePrMenuPosition, true)
    return () => {
      window.removeEventListener('resize', updatePrMenuPosition)
      window.removeEventListener('scroll', updatePrMenuPosition, true)
    }
  }, [prMenuOpen, updatePrMenuPosition])
  const platformLabel = useMemo(() => {
    const platform = detail?.session.platform?.toLowerCase()
    if (platform === 'macos' || platform === 'mac') return 'macOS'
    if (platform === 'windows' || platform === 'win') return 'Windows'
    return null
  }, [detail?.session.platform])
  return (
    <header className="flex h-11 flex-shrink-0 items-center justify-between overflow-hidden border-b border-transparent p-2 pr-[7px]">
      <div className="flex min-w-0 flex-1 items-center gap-2">
      {!isVisitor && !sidebar && (
        <button
          data-slot="sidebar-trigger"
          onClick={() => { setPeek(false); setSidebar(true) }}
          className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground"
          aria-label={t('sp.expandSb')}
        >
          <OExpand size={16} />
        </button>
      )}
      {detail?.session.parent_devin_id && (
        <button
          onClick={() => nav(`/admin/${detail.session.parent_devin_id}`)}
          title={detail.session.parent_title ?? detail.session.parent_devin_id}
          className="flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft size={13} />
          <span className="max-w-[160px] truncate max-md:max-w-[80px]">{detail.session.parent_title ?? t('ag.parent')}</span>
        </button>
      )}
      <TitleDropdown
        isDraft={isDraft}
        title={current?.title || current?.devin_title || detail?.session.title || detail?.session.devin_title || '…'}
        parentId={detail?.session.parent_devin_id}
        parentTitle={detail?.session.parent_title}
        kids={treeNode?.children || []}
        onNav={(sid) => nav(`/admin/${sid}`)}
      />
      {headerPrs.length > 0 && (!isVisitor || caps.showChanges) && (
        <div className="relative min-w-0 shrink-0">
          <button
            ref={prChipRef}
            type="button"
            aria-label={t('menu.prCount', { n: headerPrs.length })}
            aria-expanded={prMenuOpen}
            onClick={() => setPrMenuOpen((open) => !open)}
            className={cn(
              'flex h-[26px] shrink-0 cursor-pointer items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-full border px-1.5 text-[12px] font-medium leading-4 text-foreground/80',
              prMenuOpen
                ? 'border-border bg-accent text-foreground'
                : 'border-transparent hover:border-border hover:bg-accent hover:text-foreground',
            )}
          >
            {latestHeaderPr && <PrStateIcon state={latestHeaderPr.state} draft={latestHeaderPr.draft} size={16} />} {headerPrs.length}
          </button>
          {prMenuOpen && createPortal(
            <>
              <div className="fixed inset-0 z-50" onClick={closePrMenu} />
              <div
                role="menu"
                tabIndex={-1}
                onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); closePrMenu() } }}
                style={{ left: prMenuPos.left, top: prMenuPos.top, width: prMenuPos.width }}
                className="fixed z-[60] flex max-h-[70vh] min-w-[220px] flex-col overflow-y-auto overflow-x-hidden rounded-[10px] border border-border bg-popover p-1 shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)]"
              >
                {headerPrs.map((pr) => {
                  const num = pr.number || Number(pr.pr_url.match(/\/(?:pull|merge_requests)\/(\d+)/)?.[1] || 0)
                  const repo = pr.pr_url.replace(/^https?:\/\//, '').replace(/\/(?:pull|merge_requests)\/\d+.*$/, '')
                  return (
                    <button
                      key={pr.pr_url}
                      type="button"
                      role="menuitem"
                      onClick={() => { closePrMenu(); openPr(pr.pr_url) }}
                      className="flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-accent"
                    >
                      <span className="w-full truncate text-[13px] font-medium leading-[18px]">{pr.title || `PR #${num || '?'}`}</span>
                      <span className="flex min-w-0 w-full items-center gap-1 text-[12px] leading-4 text-muted-foreground">
                        <PrStateIcon state={pr.state} draft={pr.draft} size={12} />
                        <span dir="rtl" className="min-w-0 truncate text-left">{repo}#{num || '?'}</span>
                        <span className="shrink-0">·</span>
                        <span className="shrink-0 text-text-green">+{pr.additions ?? 0}</span>
                        <span className="shrink-0 text-text-red">−{pr.deletions ?? 0}</span>
                        {pr.authorLogin && <><span className="shrink-0">·</span><span className="min-w-0 truncate">{pr.authorLogin}</span></>}
                      </span>
                    </button>
                  )
                })}
              </div>
            </>,
            document.body,
          )}
        </div>
      )}
      {platformLabel && (
        <span className="flex h-5 min-w-0 max-md:max-w-[44px] items-center gap-1 overflow-hidden truncate whitespace-nowrap rounded-[6px] px-1.5 text-[12px] font-medium leading-4 text-[#337df4] [background:rgba(51,125,244,0.1)]">
          <Laptop size={12} /> {platformLabel}
        </span>
      )}
      {!isVisitor && detail?.session.cwd && (
        <span
          title={detail.session.cwd}
          className="flex h-5 min-w-0 max-w-[280px] items-center gap-1 overflow-hidden truncate whitespace-nowrap rounded-[6px] px-1.5 font-mono text-[11px] leading-4 text-muted-foreground [background:var(--muted)] max-md:hidden"
        >
          <FolderOpen size={11} className="shrink-0" />
          <span className="min-w-0 truncate" style={{ direction: 'rtl', textAlign: 'left' }}>{detail.session.cwd}</span>
        </span>
      )}
      </div>
      <div className="flex shrink-0 items-center gap-px pl-1">
      {!isVisitor && (
      <SessionMenu detail={detail} id={id} isSub={isSub} isDevinSession={isDevinSession} current={current} treeNode={treeNode} folderOrder={folderOrder} userMsgCount={userMsgCount} reloadDetail={reloadDetail} loadTree={loadTree} onControlMsg={onControlMsg} workSecs={workSecs} />
      )}
      {!effShowPanel && !isDraft && (
        <button
          onClick={() => setShowPanel(true)}
          aria-label={t('tabs.showPanel')}
          title={t('tabs.showPanel')}
          className="flex size-7 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <PanelHideTabsIcon size={18} />
        </button>
      )}
      </div>
    </header>
  )
}

/** Mount-time select-all — stable identity so it can't re-fire per render
 *  (an inline ref re-selects the draft on every keystroke, and the next
 *  char replaces the previous one). */
const selectAllOnMount = (el: HTMLInputElement | null) => el?.select()

/* Title dropdown — official-style header affordance: clicking the title
 * opens a compact popover with parent navigation (child sessions), child
 * session links (parents), and an inline rename entry. The title itself
 * swaps to a borderless input for editing (same model as the tree row). */
function TitleDropdown({ isDraft, title, parentId, parentTitle, kids, onNav }: {
  isDraft: boolean
  title: string
  parentId?: string | null
  parentTitle?: string | null
  kids: MirrorTreeSession[]
  onNav: (sid: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const btnRef = useRef<HTMLButtonElement>(null)
  const hasLinks = !!parentId || kids.length > 0
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false) } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  const commit = async (v: string) => {
    setEditing(false)
    const title2 = v.trim()
    if (!title2 || title2 === title) return
    // Route id is needed for the rename endpoint — derive from location.
    const sid = decodeURIComponent(location.pathname.split('/admin/')[1] || '').split('?')[0]
    if (!sid) return
    await adminFetch('/api/admin/mirror/session-title', { method: 'POST', body: JSON.stringify({ devin_id: sid, title: title2 }) }).catch(() => null)
  }
  if (editing) {
    return (
      <input
        autoFocus
        ref={selectAllOnMount}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit(draft)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { setEditing(false); setDraft(title) }
          if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
        }}
        className="h-auto min-w-0 flex-1 select-text rounded-none border-none bg-transparent p-0 text-[13px] leading-[18px] text-foreground shadow-none outline-none"
      />
    )
  }
  return (
    <div className="relative min-w-0 flex-1">
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open || undefined}
        onClick={() => !isDraft && setOpen((v) => !v)}
        onDoubleClick={() => { if (!isDraft) { setDraft(title); setEditing(true) } }}
        title={isDraft ? undefined : t('menu.titleNavHint')}
        className={cn('block min-w-0 max-w-full truncate text-left text-[13px] leading-[18px]', !isDraft && 'cursor-pointer rounded px-0.5 hover:bg-accent')}
      >
        {isDraft ? t('menu.newSession') : title}
      </button>
      {open && createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            role="menu"
            style={{ left: Math.max(5, (btnRef.current?.getBoundingClientRect().left ?? 5)), top: (btnRef.current?.getBoundingClientRect().bottom ?? 0) + 4 }}
            className="menu-in fixed z-[60] w-[260px] max-w-[calc(100vw-10px)] rounded-[10px] bg-[rgba(255,255,255,0.94)] p-1 text-[13px] leading-[18px] outline outline-1 outline-black/[.06] shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)] backdrop-blur-[8px] dark:bg-[#1f1f1f]/[.94]"
          >
            {parentId && (
              <button role="menuitem" onClick={() => { setOpen(false); onNav(parentId) }} className="flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-left hover:bg-accent">
                <ArrowLeft size={13} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{t('menu.parentSession')}</span>
                <span className="min-w-0 max-w-[120px] truncate">{parentTitle ?? parentId}</span>
              </button>
            )}
            {kids.length > 0 && (
              <>
                <div className="px-2 pb-0.5 pt-1.5 text-[11px] text-muted-foreground">{t('menu.childSessions')}</div>
                {kids.slice(0, 12).map((k) => (
                  <button key={k.devin_id} role="menuitem" onClick={() => { setOpen(false); onNav(k.devin_id) }} className="flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-left hover:bg-accent">
                    <span className="min-w-0 flex-1 truncate">{k.title || k.devin_id}</span>
                  </button>
                ))}
              </>
            )}
            <button role="menuitem" onClick={() => { setOpen(false); setDraft(title); setEditing(true) }} className="flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-muted-foreground hover:bg-accent hover:text-foreground">
              {t('menu.renameSession')}
            </button>
          </div>
        </>,
        document.body,
      )}
    </div>
  )
}

export { HeaderBar }
