import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type DragEvent as ReactDragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { ChevronRight } from 'lucide-react'
import { attachmentUrl, type ViewerCaps } from '@/lib/viewer'
import { type TimelineItem } from '@/components/Timeline'
import { filePillSvg } from '@/components/filePillIcons'
import { PanelAddTabIcon, PanelAttachmentsIcon, PanelCloseTabIcon, PanelFullWidthIcon, PanelHideTabsIcon, PanelPullRequestIcon } from '@/components/panelTabIcons'
import { cn } from '@/lib/utils'
import { type MirrorTreeSession } from './treeCache'
import { visitorTabs, type SessionDetail } from './pageBits'
import { type PanelKey, PANELS, ADD_TAB_ORDER } from './panelTabs'
import { CtxMenu } from './WorkspacePanel'

type FileTab = { href: string; name: string; raw?: boolean }
type PrTab = { url: string; num: string; state: string; draft: boolean }

/* Right-panel tab strip — the dnd-sortable panel/file/PR tab row plus the
 * "Add tab" menu (attachments + pull-requests submenus), the tab context
 * menu and the full-width/hide buttons. Owns the whole add-menu state
 * cluster, drag reordering and closeTab; `addOpen` itself stays in the page
 * because openTab clears it. */
function TabStrip({ isVisitor, caps, allItems, detail, treeNode, id, mediaTok, panel, setPanel, setTabs, setFileTabs, setClosedTabIds, setHiddenPrs, setUserPickedActiveTab, setPermSide, setTabOrder, tabSyncBlocked, displayedPanelKeys, prTabs, fileTabs, closedTabIds, attachFiles, openTab, openFileTab, addOpen, setAddOpen, fullWidth, setFullWidth, setShowPanel }: {
  isVisitor: boolean
  caps: ViewerCaps
  allItems: TimelineItem[]
  detail: SessionDetail | null
  treeNode: MirrorTreeSession | null
  id: string
  mediaTok: string
  panel: PanelKey | string
  setPanel: Dispatch<SetStateAction<PanelKey | string>>
  setTabs: Dispatch<SetStateAction<PanelKey[]>>
  setFileTabs: Dispatch<SetStateAction<FileTab[]>>
  setClosedTabIds: Dispatch<SetStateAction<Set<string>>>
  setHiddenPrs: Dispatch<SetStateAction<Set<string>>>
  setUserPickedActiveTab: (v: boolean) => void
  setPermSide: (v: TimelineItem | null) => void
  setTabOrder: Dispatch<SetStateAction<string[]>>
  tabSyncBlocked: MutableRefObject<boolean>
  displayedPanelKeys: string[]
  prTabs: PrTab[]
  fileTabs: FileTab[]
  closedTabIds: Set<string>
  attachFiles: { url: string; name: string }[]
  openTab: (key: PanelKey) => void
  openFileTab: (href: string, name: string, raw?: boolean) => void
  addOpen: boolean
  setAddOpen: Dispatch<SetStateAction<boolean>>
  fullWidth: boolean
  setFullWidth: Dispatch<SetStateAction<boolean>>
  setShowPanel: (v: boolean) => void
}) {
  const { t } = useTranslation()
  const dragTab = useRef<string | null>(null)
  const moveTab = useCallback((from: string, before: string | null, displayed: string[]) => {
    setTabOrder(() => {
      const next = displayed.filter((k) => k !== from)
      next.splice(before === null ? next.length : next.indexOf(before), 0, from)
      return next
    })
  }, [setTabOrder])
  const [addAnchor, setAddAnchor] = useState<{ left: number; top: number } | null>(null)
  const [panelTabMenu, setPanelTabMenu] = useState<{ x: number; y: number; close: () => void } | null>(null)
  const addBtnRef = useRef<HTMLButtonElement | null>(null)
  // The fixed-position menu doesn't track its anchor, so re-anchor it when the viewport changes
  // (e.g. the mobile keyboard opening for the search field).
  useEffect(() => {
    if (!addOpen) return
    const reanchor = () => {
      const r = addBtnRef.current?.getBoundingClientRect()
      if (r) setAddAnchor({ left: Math.max(5, Math.min(r.left, window.innerWidth - 5 - 226)), top: r.bottom + 2 })
    }
    window.addEventListener('resize', reanchor)
    return () => window.removeEventListener('resize', reanchor)
  }, [addOpen])
  useEffect(() => {
    if (!addOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setAddOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [addOpen, setAddOpen])
  const [addQ, setAddQ] = useState('')
  const [addSub, setAddSub] = useState(false)
  const [addPrSub, setAddPrSub] = useState(false)
  const [addSubPos, setAddSubPos] = useState<{ left: number; top: number } | null>(null)
  const addSubTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const openAddSub = (which: 'files' | 'pr', el: HTMLElement) => {
    if (addSubTimer.current) { clearTimeout(addSubTimer.current); addSubTimer.current = null }
    const r = el.getBoundingClientRect()
    const w = which === 'files' ? 224 : 160
    setAddSubPos({ left: Math.max(8, r.left - w - 4), top: Math.min(r.top, Math.max(8, window.innerHeight - 264)) })
    setAddSub(which === 'files')
    setAddPrSub(which === 'pr')
  }
  const closeAddSub = () => {
    if (addSubTimer.current) clearTimeout(addSubTimer.current)
    addSubTimer.current = setTimeout(() => { setAddSub(false); setAddPrSub(false); setAddSubPos(null) }, 140)
  }
  const cancelAddSubClose = () => { if (addSubTimer.current) { clearTimeout(addSubTimer.current); addSubTimer.current = null } }
  const closeTab = useCallback((key: PanelKey) => {
    setClosedTabIds((prev) => new Set(prev).add(key))
    setTabs((prev) => {
      const next = prev.filter((k) => k !== key)
      if (!next.length) setShowPanel(false)
      setPanel((cur) => (cur === key ? next[next.length - 1] ?? cur : cur))
      return next
    })
  }, [setClosedTabIds, setTabs, setShowPanel, setPanel])
  return (
    <div className="flex h-11 items-center gap-1 overflow-hidden p-2">
      <div role="tablist" className="relative min-w-0 flex-1 flex items-center gap-1 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onDragOver={(e) => { if (dragTab.current) e.preventDefault() }}
        onDrop={(e) => { e.preventDefault(); if (dragTab.current) { moveTab(dragTab.current, null, displayedPanelKeys); dragTab.current = null } }}>
        {(() => {
          const displayed = displayedPanelKeys
          const tabProps = (key: string, close?: () => void) => ({
            key,
            role: 'tab' as const,
            tabIndex: 0,
            'aria-selected': panel === key,
            draggable: true,
            'data-sortable-tab': '',
            'data-flash-key': key,
            onContextMenu: (e: ReactMouseEvent) => { e.preventDefault(); if (close) setPanelTabMenu({ x: e.clientX, y: e.clientY, close }) },
            onClick: () => { tabSyncBlocked.current = false; setPanel(key); setUserPickedActiveTab(true); setPermSide(null) },
            onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                tabSyncBlocked.current = false
                setPanel(key)
                setUserPickedActiveTab(true)
                setPermSide(null)
              }
            },
            onDragStart: () => { dragTab.current = key },
            onDragEnd: () => { dragTab.current = null },
            onDragOver: (e: ReactDragEvent<HTMLDivElement>) => {
              if (dragTab.current && dragTab.current !== key) {
                e.preventDefault()
                moveTab(dragTab.current, key, displayed)
              }
            },
            className: cn(
              'group flex h-7 shrink-0 select-none items-center gap-0.5 rounded-[6px] py-[3px] pl-[3px] pr-[6px] text-[13px] font-normal leading-[18px] whitespace-nowrap',
              panel === key ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent',
            ),
          })
          const closeButton = (onClose: () => void, active: boolean) => (
            <button
              type="button"
              aria-label="Close tab"
              title="Close tab"
              onClick={(e) => { e.stopPropagation(); onClose() }}
              className={cn('absolute inset-0 flex size-[22px] cursor-pointer items-center justify-center rounded-[4px] hover:bg-accent',
                active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}
            >
              <PanelCloseTabIcon size={16} />
            </button>
          )
          return displayed.map((dk) => {
            if (!dk.startsWith('file:') && !dk.startsWith('pr:')) {
              const key = dk as PanelKey
              const { Icon } = PANELS[key]
              const label = t('panels.' + key)
              const isActive = panel === key
              return (
                <div {...tabProps(key, () => closeTab(key))} key={key}>
                  <span className="relative size-[22px] shrink-0">
                    <span className={cn('absolute inset-0 flex items-center justify-center', isActive ? 'opacity-0' : 'opacity-100 group-hover:opacity-0')}>
                      <Icon size={16} />
                    </span>
                    {closeButton(() => closeTab(key), isActive)}
                  </span>
                  <span className="max-w-[120px] truncate">{label}</span>
                </div>
              )
            }
            if (dk.startsWith('pr:')) {
              const pr = prTabs.find((p) => `pr:${p.url}` === dk)
              if (!pr) return null
              const key = dk
              const isActive = panel === key
              const doClose = () => {
                setHiddenPrs((prev) => new Set(prev).add(pr.url))
                setClosedTabIds((prev) => new Set(prev).add(key))
                if (panel === key) setPanel('progress')
              }
              return (
                <div {...tabProps(key, doClose)} key={key}>
                  <span className="relative size-[22px] shrink-0">
                    <span className={cn('absolute inset-0 flex items-center justify-center', isActive ? 'opacity-0' : 'opacity-100 group-hover:opacity-0')}>
                      <PanelPullRequestIcon size={16} className={pr.draft ? 'text-muted-foreground' : pr.state === 'closed' ? 'text-[#f53b3a]' : pr.state === 'merged' ? 'text-[rgb(149,108,222)]' : 'text-green-600'} />
                    </span>
                    {closeButton(doClose, isActive)}
                  </span>
                  <span className="max-w-[120px] truncate">PR #{pr.num}</span>
                </div>
              )
            }
            const f = fileTabs.find((t) => `file:${t.href}` === dk)
            if (!f) return null
            const key = dk
            const isActive = panel === key
            const doClose = () => {
              setFileTabs((prev) => prev.filter((t) => t.href !== f.href))
              setClosedTabIds((prev) => new Set(prev).add(key))
              if (panel === key) setPanel('progress')
            }
            return (
              <div {...tabProps(key, doClose)} key={key} ref={(el) => { if (panel === key) el?.scrollIntoView({ inline: 'nearest', block: 'nearest' }) }}>
                <span className="relative size-[22px] shrink-0">
                  <span className={cn('absolute inset-0 flex items-center justify-center [&_svg]:size-4', isActive ? 'opacity-0' : 'opacity-100 group-hover:opacity-0')} dangerouslySetInnerHTML={{ __html: filePillSvg(f.name) }} />
                  {closeButton(doClose, isActive)}
                </span>
                <span className="max-w-[120px] truncate">{f.name}</span>
              </div>
            )
          })
        })()}
        <div className="sticky right-0 z-10 flex h-7 shrink-0 items-center self-center bg-card pl-1">
          <button
            ref={addBtnRef}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setAddAnchor({ left: Math.max(5, Math.min(r.left, window.innerWidth - 5 - 226)), top: r.bottom + 2 })
              setAddOpen(!addOpen)
            }}
            aria-label="Add tab"
            title="Add tab"
            className="flex size-7 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-accent"
          >
            <PanelAddTabIcon size={18} />
          </button>
        </div>
      </div>
      <div className="relative shrink-0">
        {addOpen && <div className="fixed inset-0 z-10" onClick={() => { setAddOpen(false); setAddQ(''); setAddSub(false); setAddPrSub(false) }} />}
        {addOpen && (
          <div role="menu" style={addAnchor ? { left: addAnchor.left, top: addAnchor.top } : undefined} className="fixed z-20 w-[226px] rounded-lg border border-border bg-card p-1 shadow-lg">
            <input
              value={addQ}
              onChange={(e) => setAddQ(e.target.value)}
              placeholder="Search"
              autoFocus={!window.matchMedia('(any-pointer: coarse)').matches}
              className="mb-1 w-full border-b border-border bg-transparent px-2 py-1.5 text-[13px] leading-[18px] outline-none placeholder:text-muted-foreground"
            />
            {ADD_TAB_ORDER
              .filter((k) => k !== 'files' && (!isVisitor || visitorTabs(caps, allItems).includes(k)))
              .filter((k) => !addQ || t('panels.' + k).toLowerCase().includes(addQ.toLowerCase()))
              .map((k) => (
              <button
                key={k}
                role="menuitem"
                onClick={() => { openTab(k); setAddQ('') }}
                className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
              >
                {(() => { const { MenuIcon } = PANELS[k]; return <MenuIcon size={16} className="shrink-0 text-muted-foreground" /> })()}
                <span className="min-w-0 truncate text-[13px] leading-[18px]">{t('panels.' + k)}</span>
              </button>
            ))}
            {(!isVisitor || visitorTabs(caps, allItems).includes('files')) && (!addQ || 'attachments'.includes(addQ.toLowerCase())) && (
              <div className="relative" onMouseEnter={(e) => openAddSub('files', e.currentTarget)} onMouseLeave={closeAddSub}>
                <button
                  role="menuitem"
                  aria-haspopup="menu"
                  aria-expanded={addSub}
                  onClick={() => { openTab('files'); setAddQ('') }}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
                >
                  <PanelAttachmentsIcon size={16} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-[13px] leading-[18px]">{t('panels.attachments.label')}</span>
                  <ChevronRight size={12} className="shrink-0 text-muted-foreground" />
                </button>
                {addSub && addSubPos && attachFiles.length > 0 && createPortal(
                  <div role="menu" onMouseEnter={cancelAddSubClose} onMouseLeave={closeAddSub} style={{ left: addSubPos.left, top: addSubPos.top }} className="fixed z-50 max-h-64 w-56 overflow-y-auto rounded-lg border border-border bg-card p-1 shadow-lg">
                    {attachFiles.filter((f) => !closedTabIds.has(`file:${attachmentUrl(id, f.url, mediaTok)}`)).map((f) => (
                      <button
                        key={f.url}
                        role="menuitem"
                        onClick={() => { openFileTab(attachmentUrl(id, f.url, mediaTok), f.name); setAddOpen(false); setAddSub(false); setAddQ('') }}
                        className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
                      >
                        <span className="flex size-[14px] shrink-0 items-center" dangerouslySetInnerHTML={{ __html: filePillSvg(f.name) }} />
                        <span className="min-w-0 truncate text-[13px] leading-[18px]">{f.name}</span>
                      </button>
                    ))}
                  </div>,
                  document.body,
                )}
              </div>
            )}
            {!isVisitor && (detail?.session.pull_requests?.length || treeNode?.pull_requests?.length) && (!addQ || 'pull requests'.includes(addQ.toLowerCase())) ? (
              <div className="relative" onMouseEnter={(e) => openAddSub('pr', e.currentTarget)} onMouseLeave={closeAddSub}>
                <button
                  role="menuitem"
                  aria-haspopup="menu"
                  aria-expanded={addPrSub}
                  onClick={() => {
                    tabSyncBlocked.current = false
                    setHiddenPrs(new Set())
                    const first = (detail?.session.pull_requests || treeNode?.pull_requests || []).find((p) => p.pr_url)
                    if (first) {
                      setClosedTabIds((prev) => { const next = new Set(prev); next.delete(`pr:${first.pr_url}`); return next })
                      setPanel(`pr:${first.pr_url}`)
                    }
                    setAddOpen(false); setAddQ('')
                  }}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
                >
                  <PanelPullRequestIcon size={16} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-[13px] leading-[18px]">{t('panels.prs.label')}</span>
                  <ChevronRight size={12} className="shrink-0 text-muted-foreground" />
                </button>
                {addPrSub && addSubPos && createPortal(
                  <div role="menu" onMouseEnter={cancelAddSubClose} onMouseLeave={closeAddSub} style={{ left: addSubPos.left, top: addSubPos.top }} className="fixed z-50 max-h-64 w-40 overflow-y-auto rounded-lg border border-border bg-card p-1 shadow-lg">
                    {(detail?.session.pull_requests || treeNode?.pull_requests || []).filter((p) => p.pr_url).map((p) => (
                      <button
                        key={p.pr_url}
                        role="menuitem"
                        onClick={() => {
                          tabSyncBlocked.current = false
                          setHiddenPrs((h) => { const n = new Set(h); n.delete(p.pr_url!); return n })
                          setClosedTabIds((h) => { const n = new Set(h); n.delete(`pr:${p.pr_url}`); return n })
                          setPanel(`pr:${p.pr_url}`)
                          setAddOpen(false); setAddPrSub(false); setAddQ('')
                        }}
                        className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
                      >
                        <PanelPullRequestIcon size={16} className="shrink-0 text-muted-foreground" />
                        <span className="min-w-0 truncate text-[13px] leading-[18px]">PR #{(p.pr_url!.match(/\/pull\/(\d+)/) || [])[1] || '?'}</span>
                      </button>
                    ))}
                  </div>,
                  document.body,
                )}
              </div>
            ) : null}
          </div>
        )}
        {panelTabMenu && (
          <CtxMenu
            pos={{ x: panelTabMenu.x, y: panelTabMenu.y }}
            items={[{ label: 'Close', onClick: panelTabMenu.close }]}
            onClose={() => setPanelTabMenu(null)}
          />
        )}
      </div>
      <button
        onClick={() => setFullWidth(!fullWidth)}
        aria-label={fullWidth ? 'Exit full width' : 'Full width'}
        title={fullWidth ? 'Exit full width' : 'Full width'}
        className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-accent max-md:hidden"
      >
        <PanelFullWidthIcon size={18} />
      </button>
      <button
        type="button"
        onClick={() => setShowPanel(false)}
        aria-label="Hide tabs panel"
        title="Hide tabs panel"
        className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-accent"
      >
        <PanelHideTabsIcon size={18} />
      </button>
    </div>
  )
}

export { TabStrip }
