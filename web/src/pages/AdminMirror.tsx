/**
 * AdminMirror — cloud-parity session view.
 * Extracted modules live in ./mirror/ (components, panels, tree, utils).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Loader2, ChevronRight, ChevronDown, ChevronUp, Settings2, Copy, Check, RotateCcw, Archive, ArchiveRestore, Plus, FileText, Circle, ArrowUp, ArrowUpRight, Square, Link2, X, Expand, Code, Workflow as WorkflowIcon, BookOpen, UploadCloud, Folder as FolderIcon, Pencil, Clock, Lightbulb, Info, Laptop, FolderOpen, Image as ImageIcon, Share2, RefreshCw, AlertTriangle, Rows3 } from 'lucide-react'
import { OArchive, OBell, OCollapse, OCompose, OExpand, OSearch } from '../components/officialIcons'
import { adminFetch, adminFetchSwr, shareFetchSwr, type AdminSession, type PublicMessage, type DashboardData } from '@/lib/api'
import { adminViewer, visitorViewer, setViewer, sessionFetch, sessionFetchSwr, attachmentUrl, type Viewer, type SharePermission } from '@/lib/viewer'
import { visibleInterval } from '@/lib/poll'
import { subscribeWs } from '@/lib/ws'
import Dashboard from '@/components/Dashboard'
import { getTheme, setTheme, type Theme } from '@/lib/theme'
import AttachmentCard from '@/components/AttachmentCard'
import CollapsibleBody from '@/components/CollapsibleBody'
import { type TimelineItem, fmtWorkedDur, STANDALONE_GIT_TYPES, workSeconds, CalloutCard, envSupersededMap } from '@/components/Timeline'
import { SecretRequestCard, PrCreatedCard, PrStateIcon, StandaloneGitRow, mergeLivePr } from '@/components/StructuredCards'
import Markdown from '@/components/Markdown'
import QuestionPanel from '@/components/QuestionPanel'
import { StatusDot, Combo } from '@/components/ui'
import ComposerEditor, { type ComposerEditorHandle } from '@/components/ComposerEditor'
import LocalDock from '@/components/LocalDock'
import DevinMark from '@/components/DevinMark'
import TermPanel from '@/components/TermPanel'
import BeardBand, { BandItem } from '@/components/BeardBand'
import { filePillSvg } from '@/components/filePillIcons'
import WakePersona from '@/components/WakePersona'
import ThinkingPersona from '@/components/ThinkingPersona'
import UserAttachments, { IMAGE_RE } from '@/components/UserAttachments'
import { extractRepos } from '@/lib/repos'
import { type QuoteAttachment } from '../../shared/quotes'
import { cn } from '@/lib/utils'
import { ATTACH_MENU_ICONS, MODE_INFO_ICON, MODE_CHECK_ICON, MENU_CHEVRON_ICON } from '@/lib/officialMenuIcons'
import { PanelAddTabIcon, PanelAttachmentsIcon, PanelCloseTabIcon, PanelFullWidthIcon, PanelHideTabsIcon, PanelPullRequestIcon } from '@/components/panelTabIcons'
import { readTreeCache, type MirrorTreeSession, type TreeCachePayload, writeTreeCache } from './mirror/treeCache'
import { prefetchSession, visitorTabs, type SessionDetail, tlSnapshots, messagesFromItems, type LocalCfg, type LocalCfgOption, EFFORT_SUFFIX_RE, modeOfVersion, speedOfVersion, type ShareMeta, defaultTabs, CommandPalette, TimelineSkeleton, LOCAL_MODE_ICONS, VERSION_LABEL, versionOf } from './mirror/pageBits'
import { type PanelKey, PANELS, findItemText, parseOfficialTab, serializeOfficialTab, useUrlParamSync, ADD_TAB_ORDER, prNumber, type PanelIcon } from './mirror/panelTabs'
import { type TimelinePage, preview, mergeItems, groupItems, time, rowClock, clock, COACH_RECOMMENDATIONS, COACH_ACTIONS } from './mirror/timelineUtil'
import { reduceStatus } from './mirror/statusReduce'
import { type ComposerMetaT, type SuggestItem, AT_CATEGORIES, QUEUE_DASHED_SVG, QUEUE_DRAG_SVG, QUEUE_PLACEHOLDER } from './mirror/composerMeta'
import { type TreePrefs, TREE_PREFS_KEY, DEFAULT_TREE_PREFS, buildFilterQ, SessionTree } from './mirror/SessionTree'
import DirPicker from './mirror/DirPicker'
import { type WfAgentEventState, AgentsPanel } from './mirror/AgentsPanel'
import { SessionSettingsGlyph, HeaderMenuPortal, AwaitingInstructionsGlyph, ApiOriginGlyph, OfficialGlyph } from './mirror/glyphs'
import { PermissionCard, PermissionSidebarPanel } from './mirror/Permission'
import { EventRow, WorkGroup } from './mirror/TimelineRows'
import { splitAttachments, isOwnUserMessage, indexPreview } from './mirror/attachments'
import { ParticipantHeader, FileViewerPanel, ShellPanel, AttachmentsPanel } from './mirror/ViewerPanels'
import { MessageToolbar, SidechatPanel } from './mirror/Sidechat'
import { VoiceButton } from './mirror/VoiceButton'
import { PrPanel } from './mirror/PrPanel'
import { ProgressPanel, WorklogPanel } from './mirror/ProgressPanels'
import { ChangesPanel } from './mirror/ChangesPanel'
import { ComputerPanel } from './mirror/ComputerPanel'
import { WorkspacePanel, CtxMenu } from './mirror/WorkspacePanel'
import { ResourcesPanel, SubagentsPanel } from './mirror/ResourcePanels'

let lastSeenLocalCfg: LocalCfg | null = null

export default function AdminMirrorPage() {
  const { id = '' } = useParams()
  const routerLoc = useLocation()
  // Same component for both viewers: /admin/:id is the administrator, /s/:shareId?t=… a visitor
  // whose capability profile comes from /meta. Only the capability gates differ.
  const isVisitor = routerLoc.pathname.startsWith('/s/')
  const shareTok = isVisitor ? new URLSearchParams(routerLoc.search).get('t') || '' : ''
  // /admin/new matches /admin/:id — `new` is the draft sentinel: the page shows
  // an empty session view and the first send creates the session (desktop-parity
  // new-session flow — no dialog, no separate page).
  const isDraft = !isVisitor && id === 'new'
  // sub:<root>:<aid> — a subagent rendered as a first-class child session.
  const isSub = id.startsWith('sub:')
  const draftFolder = isDraft ? new URLSearchParams(routerLoc.search).get('folder') || '' : ''
  // Draft workspace pick (desktop parity: new session lets you choose the repo).
  const [draftCwd, setDraftCwd] = useState('')
  const sessionSearch = useMemo(() => routerLoc.search, [id])
  const [visitorPerm, setVisitorPerm] = useState<SharePermission | null>(null)
  const vw = useMemo<Viewer>(
    () => (isVisitor ? visitorViewer(id, shareTok, visitorPerm ?? 'readonly') : adminViewer(id)),
    [isVisitor, id, shareTok, visitorPerm],
  )
  setViewer(vw)
  const caps = vw.caps
  const cachedTree = useMemo(() => readTreeCache(), [])
  const [sessions, setSessions] = useState<AdminSession[]>([])
  const [tree, setTree] = useState<MirrorTreeSession[]>(() => cachedTree?.sessions || [])
  const [notifOpen, setNotifOpen] = useState(false)
  const unreadSessions = useMemo(() => tree.filter((s) => s.is_unread), [tree])
  const unreadCount = unreadSessions.length
  // "Recent" dirs for the draft workspace picker = cwds of existing sessions
  // (tree order is already most-recently-updated first).
  const recentCwds = useMemo(() => [...new Set(tree.map((s) => s.cwd).filter((c): c is string => !!c))].slice(0, 8), [tree])
  const [folderOrder, setFolderOrder] = useState<string[]>(() => cachedTree?.folder_order || [])
  const [folderTotals, setFolderTotals] = useState<Record<string, number>>(() => cachedTree?.folder_totals || {})
  const nav = useNavigate()
  const registering = useRef(false)
  const openTreeSession = useCallback(async (s: MirrorTreeSession) => {
    if (window.innerWidth < 768) setSidebar(false)
    // sub:<root>:<aid> child sessions are already local — open directly.
    if (s.devin_id.startsWith('sub:')) { nav(`/admin/${s.devin_id}`); return }
    const reg = sessions.find((x) => x.devin_session_id === s.devin_id)
    if (reg) { nav(`/admin/${reg.id}`); return }
    if (registering.current) return
    registering.current = true
    try {
      const r = await adminFetch<{ id: string }>('/api/admin/sessions', {
        method: 'POST',
        body: JSON.stringify({ devin_session_id: s.devin_id, title: s.title }),
      })
      nav(`/admin/${r.id}`)
    } catch { /* upstream errors surface in the timeline */ } finally { registering.current = false }
  }, [sessions, nav])
  const prefetchRegisteredSession = useCallback((s: MirrorTreeSession) => {
    if (isVisitor) return
    const reg = sessions.find((x) => x.devin_session_id === s.devin_id)
    if (reg) prefetchSession(reg.id)
  }, [isVisitor, sessions])
  const [items, setItems] = useState<TimelineItem[]>([])
  const [interrupted, setInterrupted] = useState<{ text: string; ts: number; kind?: 'continue' | 'resend'; attachments?: { url: string; name?: string; size?: number; mime?: string }[] } | null>(null)
  const [activity, setActivity] = useState<{ text: string } | null>(null)
  const reloadTl = useRef<(() => Promise<void>) | null>(null)
  /** Peek→real graduation: browsing starts in lazy-peek mode (no session/load,
   * no updatedAt bump); dwell/interaction flips to the real loading fetch. */
  const graduateTl = useRef<(() => void) | null>(null)
  const [envBannerGone, setEnvBannerGone] = useState(false)
  const [envSaveState, setEnvSaveState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle')
  const dismissEnvBanner = useCallback((eid: string) => {
    setEnvBannerGone(true)
    try { localStorage.setItem(`env-banner-dismissed:${eid}`, '1') } catch { /* quota */ }
  }, [])
  const [older, setOlder] = useState<TimelineItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const olderBusy = useRef(false)
  const [tlError, setTlError] = useState<string | null>(null)
  const [connLost, setConnLost] = useState(false)
  const failCount = useRef(0)
  const [loaded, setLoaded] = useState(false)
  const itemsRef = useRef(items)
  const olderRef = useRef(older)
  const cursorRef = useRef(cursor)
  itemsRef.current = items
  olderRef.current = older
  cursorRef.current = cursor
  // Tabs persist per session like the official client's `session-tabs:<devin_id>`
  // localStorage entry ({tabs:[{type,data}], activeTabId, ...}).
  const tabsSaved = useMemo(() => {
    if (isVisitor) return null
    try {
      const raw = localStorage.getItem(`session-tabs:${id}`)
      if (!raw) return null
      const saved = JSON.parse(raw) as {
        tabs?: PanelKey[]
        fileTabs?: { href: string; name: string }[]
        order?: string[]
        activeTabId?: string
        userPickedActiveTab?: boolean
        closedTabIds?: string[]
        lastUpdated?: number
      }
      if (saved.lastUpdated && Date.now() - saved.lastUpdated > 7 * 864e5) return null
      return saved
    } catch { return null }
  }, [id, isVisitor])
  const [tabs, setTabs] = useState<PanelKey[]>(() => {
    if (isVisitor) return visitorTabs(caps)
    const valid = (tabsSaved?.tabs || []).filter((k): k is PanelKey => k in PANELS)
    return valid
  })
  const [closedTabIds, setClosedTabIds] = useState<Set<string>>(() => new Set(tabsSaved?.closedTabIds || []))
  const [userPickedActiveTab, setUserPickedActiveTab] = useState(() => !!tabsSaved?.userPickedActiveTab)
  // `?pr=<github url>` remains supported as a legacy equivalent of `?tab=pr:<number>`.
  const initialParams = useMemo(() => new URLSearchParams(sessionSearch), [sessionSearch])
  const tabParam = initialParams.get('tab')
  const wantPr = isVisitor ? null : initialParams.get('pr')
  const [panel, setPanel] = useState<PanelKey | string>(() => (isVisitor ? visitorTabs(caps)[0] : wantPr ? `pr:${wantPr}` : tabsSaved?.activeTabId || 'dashboard'))
  const tabSyncBlocked = useRef(false)
  useEffect(() => {
    if (!wantPr) return
    setHiddenPrs(new Set())
    setPanel(`pr:${wantPr}`)
    setShowPanel(true)
  }, [wantPr])
  // Visitor tabs follow the capability profile (no persistence, no admin defaults).
  useEffect(() => {
    if (!isVisitor) return
    const allowed = visitorTabs(caps)
    setTabs(allowed)
    setPanel((p) => (typeof p === 'string' && (p.startsWith('file:') || p.startsWith('pr:') || (allowed as string[]).includes(p)) ? p : allowed[0]))
  }, [isVisitor, caps])
  const [fileTabs, setFileTabs] = useState<{ href: string; name: string; raw?: boolean }[]>(() => tabsSaved?.fileTabs || [])
  const dragTab = useRef<string | null>(null)
  // Official tab bar is one dnd-kit sortable list mixing panel + file tabs (cross-group order).
  const [tabOrder, setTabOrder] = useState<string[]>(() => tabsSaved?.order || [])
  const tabsHydratedFor = useRef(id)
  const tabsDefaultsFor = useRef<string | null>(null)
  const pendingTabsHydrate = useRef<string | null>(null)
  useEffect(() => {
    if (tabsHydratedFor.current === id || isVisitor) return
    tabsHydratedFor.current = id
    // Same-commit setState hasn't applied yet — the persist effect must skip
    // this commit or the PREVIOUS session's tabs land under this id's key.
    pendingTabsHydrate.current = id
    const valid = (tabsSaved?.tabs || []).filter((k): k is PanelKey => k in PANELS)
    setTabs(valid)
    setPanel(wantPr ? `pr:${wantPr}` : tabsSaved?.activeTabId || 'dashboard')
    setFileTabs(tabsSaved?.fileTabs || [])
    setTabOrder(tabsSaved?.order || [])
    setClosedTabIds(new Set(tabsSaved?.closedTabIds || []))
    setUserPickedActiveTab(!!tabsSaved?.userPickedActiveTab)
  }, [id, tabsSaved, isVisitor, wantPr])
  useEffect(() => {
    if (pendingTabsHydrate.current === id) { pendingTabsHydrate.current = null; return }
    if (tabsHydratedFor.current !== id || isVisitor || !loaded || (!tabsSaved && tabsDefaultsFor.current !== id)) return
    try {
      localStorage.setItem(`session-tabs:${id}`, JSON.stringify({ tabs, fileTabs, order: tabOrder, activeTabId: panel, userPickedActiveTab, closedTabIds: [...closedTabIds], lastUpdated: Date.now() }))
    } catch { /* storage full/unavailable */ }
  }, [id, tabs, fileTabs, tabOrder, panel, userPickedActiveTab, closedTabIds, isVisitor])
  const moveTab = useCallback((from: string, before: string | null, displayed: string[]) => {
    setTabOrder(() => {
      const next = displayed.filter((k) => k !== from)
      next.splice(before === null ? next.length : next.indexOf(before), 0, from)
      return next
    })
  }, [])
  /** Official semantics: opening a tab that is already active pulses an inset accent outline on it. */
  const flashTab = useCallback((key: string) => {
    const el = document.querySelector(`[data-flash-key="${CSS.escape(key)}"]`)
    if (!(el instanceof HTMLElement)) return
    el.classList.remove('animate-flash-inset')
    void el.offsetWidth
    el.classList.add('animate-flash-inset')
    el.addEventListener('animationend', () => el.classList.remove('animate-flash-inset'), { once: true })
  }, [])
  const panelFlashRef = useRef('')
  const openFileTab = useCallback((href: string, name: string, raw?: boolean) => {
    tabSyncBlocked.current = false
    setClosedTabIds((prev) => { if (!prev.has(`file:${href}`)) return prev; const next = new Set(prev); next.delete(`file:${href}`); return next })
    setFileTabs((prev) => (prev.some((f) => f.href === href) ? prev : [...prev, { href, name, raw }]))
    if (panelFlashRef.current === `file:${href}`) flashTab(`file:${href}`)
    setPanel(`file:${href}`)
    setShowPanel(true)
  }, [flashTab])
  useEffect(() => { panelFlashRef.current = panel }, [panel])
  const [addOpen, setAddOpen] = useState(false)
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
  }, [addOpen])
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
  const [folderSubPos, setFolderSubPos] = useState<{ left: number; top: number } | null>(null)
  const [wfRunId, setWfRunId] = useState<string | null>(null)

  const [fullWidth, setFullWidth] = useState(false)
  const [rightPct, setRightPct] = useState(60)
  const rootRef = useRef<HTMLDivElement>(null)
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const root = rootRef.current
    if (!root) return
    const onMove = (ev: MouseEvent) => {
      const rect = root.getBoundingClientRect()
      const sideW = window.innerWidth >= 768 ? 300 : 0
      const avail = rect.width - sideW
      if (avail <= 0) return
      setRightPct(Math.min(75, Math.max(25, ((rect.right - ev.clientX) / avail) * 100)))
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'col-resize'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const detailRef = useRef(detail)
  detailRef.current = detail
  const idRef = useRef(id)
  idRef.current = id
  const olderPrefetch = useRef<{ id: string; cursor: string; promise: Promise<TimelinePage> } | null>(null)
  const storeSnapshot = useCallback((snapshotId: string) => {
    if (isVisitor) return
    tlSnapshots.set(snapshotId, {
      items: itemsRef.current,
      older: olderRef.current,
      cursor: cursorRef.current,
      detail: detailRef.current,
      at: Date.now(),
    })
    while (tlSnapshots.size > 12) {
      const oldest = [...tlSnapshots.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (!oldest) break
      tlSnapshots.delete(oldest[0])
    }
  }, [isVisitor])
  // Admin detail carries the full message list; visitors derive it from the
  // normalized timeline (their only message source, already share-projected).
  const detailMsgs = useMemo<PublicMessage[]>(
    () => (isVisitor ? messagesFromItems([...older, ...items]) : detail?.messages || []),
    [isVisitor, older, items, detail],
  )
  // Files listed in the official Add tab → Attachments submenu.
  const attachFiles = useMemo(() => {
    const seen = new Set<string>()
    const out: { url: string; name: string }[] = []
    for (const m of detailMsgs) {
      for (const a of m.attachments || []) {
        if (seen.has(a.url)) continue
        seen.add(a.url)
        out.push({ url: a.url, name: a.name })
      }
    }
    return out.reverse()
  }, [detailMsgs])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSub, setSettingsSub] = useState<'none' | 'folder' | 'rename' | 'send'>('none')
  // Desktop parity: composer send shortcut (Settings → "Send messages with").
  const [sendWith, setSendWith] = useState<'enter' | 'ctrlenter'>(() =>
    (localStorage.getItem('wb-send-with') === 'ctrlenter' ? 'ctrlenter' : 'enter'))
  const [renameDraft, setRenameDraft] = useState('')
  const settingsButtonRef = useRef<HTMLButtonElement>(null)
  const headerMenuAnchorRef = useRef<HTMLButtonElement | null>(null)
  const [headerMenuPos, setHeaderMenuPos] = useState({ left: 5, top: 0, width: 280 })
  const [sendOptOpen, setSendOptOpen] = useState(false)
  const [modeOpen, setModeOpen] = useState(false)
  const [sModeOpen, setSModeOpen] = useState(false)
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null)
  const [optimisticVersion, setOptimisticVersion] = useState<string | null>(null)
  const [modeSub, setModeSub] = useState<string | null>(null)
  // Flyout anchor for the local-config cascading menu — the dropdown's
  // overflow-y-auto clips absolute children, so submenus render in a body
  // portal at fixed coordinates.
  const [modeSubPos, setModeSubPos] = useState<{ left: number; top: number } | null>(null)
  const modeSubTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const openModeSub = (id: string, el: HTMLElement) => {
    if (modeSubTimer.current) { clearTimeout(modeSubTimer.current); modeSubTimer.current = null }
    const r = el.getBoundingClientRect()
    setModeSub(id)
    setModeSubPos({ left: Math.min(r.right + 2, window.innerWidth - 246), top: Math.min(r.top, window.innerHeight - 260) })
  }
  const closeModeSub = () => {
    if (modeSubTimer.current) clearTimeout(modeSubTimer.current)
    modeSubTimer.current = setTimeout(() => { setModeSub(null); setModeSubPos(null) }, 140)
  }
  // Local ACP config: real model/mode options exposed by `devin acp` (when set,
  // the cloud version pill swaps to a local config menu).
  const [localCfg, setLocalCfg] = useState<LocalCfg | null>(() => lastSeenLocalCfg)
  const [cfgReady, setCfgReady] = useState<boolean>(() => lastSeenLocalCfg != null)
  const [cfgTick, setCfgTick] = useState(0)
  useEffect(() => {
    let alive = true
    if (isVisitor || !id) { setLocalCfg(null); setCfgReady(false); return }
    // Draft mode: show the carried-forward pick — the server applies lastConfig
    // at creation, and draft picks are POSTed right after the session exists.
    if (isDraft) { setLocalCfg(lastSeenLocalCfg); setCfgReady(true); return }
    if (lastSeenLocalCfg) { setLocalCfg(lastSeenLocalCfg); setCfgReady(true) } else setCfgReady(false)
    // GET /config never starts a session/load server-side — it only waits for
    // one already in flight. So this is free on a peeked session and picks up
    // the real config once the timeline graduates (cfgTick bump).
    sessionFetch<LocalCfg>('/config')
      .then((c) => { if (alive) { lastSeenLocalCfg = c; setLocalCfg(c); setCfgReady(true) } })
      .catch(() => { if (alive) setCfgReady(true) })
    return () => { alive = false }
  }, [id, isVisitor, cfgTick])
  // Draft mode: pull agent-level cfg + wb.json lastConfig via composer-meta so
  // the mode/model pills show real values before any session exists (official
  // home shows the same pills on its new-session composer).
  useEffect(() => {
    if (!isDraft || isVisitor || lastSeenLocalCfg) return
    void adminFetch<ComposerMetaT>('/api/admin/composer-meta')
      .then((m) => {
        setComposerMeta((prev) => prev ?? m)
        if (!m.cfg || lastSeenLocalCfg) return
        const cfg: LocalCfg = { ...m.cfg }
        const lc = m.last_config ?? {}
        if (lc.mode ?? lc._mode) cfg.mode = lc.mode ?? lc._mode ?? cfg.mode
        if (Object.keys(lc).length) {
          cfg.options = (cfg.options ?? []).map((o) => (o.id && lc[o.id] ? { ...o, currentValue: lc[o.id] } : o))
          if (cfg.model && lc[cfg.model.id]) {
            const v = lc[cfg.model.id]
            cfg.model = { ...cfg.model, current: v, currentName: cfg.model.options.find((o) => o.value === v)?.name ?? v }
          }
        }
        lastSeenLocalCfg = cfg
        setLocalCfg(cfg)
        setCfgReady(true)
      })
      .catch(() => {})
  }, [isDraft, isVisitor])
  // Config picks made in draft mode — replayed onto the session right after
  // creation (the server also applies wb.json lastConfig on its own).
  const draftPicks = useRef<{ configId: string; value: string }[]>([])
  const chooseLocalOptions = (pairs: { configId: string; value: string }[]) => {
    setModeOpen(false); setModeSub(null); setModeSubPos(null); setSModeOpen(false)
    graduateTl.current?.() // config write is a real op — graduate first
    // Optimistic: repaint the pills now; POSTs run in parallel and the
    // refetch reconciles the authoritative values.
    setLocalCfg((prev) => {
      if (!prev) return prev
      const options = (prev.options ?? []).map((o) => {
        const hit = pairs.find((p) => p.configId === o.id)
        return hit ? { ...o, currentValue: hit.value } : o
      })
      const modeHit = pairs.find((p) => p.configId === 'mode' || p.configId === '_mode')
      const modelHit = prev.model ? pairs.find((p) => p.configId === prev.model!.id) : undefined
      const model = prev.model && modelHit
        ? { ...prev.model, current: modelHit.value, currentName: prev.model.options.find((o) => o.value === modelHit.value)?.name ?? modelHit.value }
        : prev.model
      const next = { ...prev, options, model, ...(modeHit ? { mode: modeHit.value } : {}) }
      if (isDraft) lastSeenLocalCfg = next
      return next
    })
    if (isDraft) {
      draftPicks.current = [...draftPicks.current.filter((p) => !pairs.some((q) => q.configId === p.configId)), ...pairs]
      return
    }
    void Promise.all(pairs.map((p) => sessionFetch('/config', { method: 'POST', body: JSON.stringify(p) }).catch(() => null)))
      .then(() => sessionFetch<LocalCfg>('/config'))
      .then((c) => { lastSeenLocalCfg = c; setLocalCfg(c) })
      .catch(() => {})
  }
  const chooseLocalOption = (configId: string, value: string) => chooseLocalOptions([{ configId, value }])
  // Desktop-style capability data: `model` is the family column, `mode` its own
  // pill, `thought_level`/`speed` live inside the per-model effort submenu.
  const localGroups = localCfg?.options ?? []
  const localModeGroup = localGroups.find((o) => o.id === 'mode' || o.id === '_mode' || o.category === 'mode')
  const effortGroup = localGroups.find((o) => o.id === 'thought_level')
  const speedGroup = localGroups.find((o) => o.id === 'speed' || o.category === 'model_config')
  const extraGroups = localGroups.filter((o) => o !== localModeGroup && o !== effortGroup && o !== speedGroup && o.id !== 'model' && (o.options?.length ?? 0) > 0)
  const localModeCurrent = localCfg?.mode ?? localModeGroup?.currentValue
  const localModeOpt = localModeGroup?.options?.find((o) => o.value === localModeCurrent)
  const effortCurName = effortGroup?.options?.find((o) => o.value === effortGroup.currentValue)?.name
  const speedCurName = speedGroup?.options?.find((o) => o.value === speedGroup.currentValue)?.name
  const fusionModels = localCfg?.model?.options.filter((o) => o.value.startsWith('fusion-')) ?? []
  const plainModels = localCfg?.model?.options.filter((o) => !o.value.startsWith('fusion-')) ?? []
  // Desktop groups variants of one family into a single row — glm-5-2 +
  // glm-5-2-1m are one "GLM-5.2" row whose flyout carries the extra toggles.
  const familyRows = useMemo(() => {
    const byFam = new Map<string, LocalCfgOption[]>()
    for (const m of plainModels) {
      const f = m.family ?? m.value
      const arr = byFam.get(f) ?? []
      arr.push(m)
      byFam.set(f, arr)
    }
    const stripName = (n: string) => n.replace(/(\s+(none|min|minimal|low|medium|high|xhigh|max|thinking|fast|1m|priority|lightning))+$/i, '').trim()
    return [...byFam.entries()].map(([f, ms]) => {
      ms.sort((a, b) => a.value.length - b.value.length)
      const base = ms[0]
      const label = stripName(base.name ?? base.value) || base.name || base.value
      return { key: f, label, base, siblings: ms.slice(1), known: ms.some((m) => m.family !== undefined) }
    })
  }, [plainModels])
  const modelPillLabel = localCfg?.model
    ? (localCfg.model.currentName || 'Model')
      + (EFFORT_SUFFIX_RE.test(localCfg.model.current) && effortCurName ? ` · ${effortCurName}` : '')
      + (speedCurName && speedCurName !== 'Standard' ? ` · ${speedCurName}` : '')
    : null
  const currentVersion = detail?.session.current_devin_version ?? null
  const pillVersion = selectedVersion ?? optimisticVersion ?? currentVersion ?? 'devin-ultra'
  const mode = modeOfVersion(pillVersion)
  const speed = speedOfVersion(pillVersion)
  useEffect(() => {
    if (optimisticVersion && currentVersion === optimisticVersion) setOptimisticVersion(null)
  }, [currentVersion, optimisticVersion])
  const [theme, setThemeState] = useState<Theme>(getTheme)
  // Current session's tree node (tags / keep_alive_until come from the v2sessions mirror).
  const treeNode = useMemo(() => {
    const devinId = detail?.session.devin_session_id || ''
    if (!devinId) return null
    const walk = (list: MirrorTreeSession[]): MirrorTreeSession | null => {
      for (const s of list) {
        if (s.devin_id === devinId || s.devin_id === `devin-${devinId}` || `devin-${s.devin_id}` === devinId) return s
        const hit = walk(s.children)
        if (hit) return hit
      }
      return null
    }
    return walk(tree)
  }, [tree, detail])

  const headerStatus = detail?.session.status_enum_raw || detail?.session.status || sessions.find((session) => session.id === id)?.status || ''
  const headerState = reduceStatus({ status: headerStatus, statusEnumRaw: headerStatus, sleepReason: detail?.session.sleep_reason })
  const updateHeaderMenuPosition = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return
    const rect = button.getBoundingClientRect()
    const width = Math.min(280, window.innerWidth - 10)
    setHeaderMenuPos({
      left: Math.max(5, Math.min(rect.right - width, window.innerWidth - 5 - width)),
      top: rect.bottom + 2,
      width,
    })
  }, [])
  const closeHeaderMenus = useCallback(() => {
    setSettingsOpen(false)
    setSettingsSub('none')
    requestAnimationFrame(() => headerMenuAnchorRef.current?.focus())
  }, [])
  const toggleHeaderMenu = useCallback(() => {
    const button = settingsButtonRef.current
    headerMenuAnchorRef.current = button
    if (settingsOpen) {
      closeHeaderMenus()
      return
    }
    setSettingsOpen(true)
    setSettingsSub('none')
    updateHeaderMenuPosition(button)
  }, [closeHeaderMenus, settingsOpen, updateHeaderMenuPosition])
  useEffect(() => {
    if (!settingsOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      closeHeaderMenus()
    }
    const reposition = () => updateHeaderMenuPosition(headerMenuAnchorRef.current)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [closeHeaderMenus, settingsOpen, updateHeaderMenuPosition])
  // Official session-index entries: user messages plus PR rows ("#N" with a PR icon) in timeline order.
  // Official builds this from a full-history skeleton (`historySkeleton` in the bundle), so entries
  // exist for events not yet backfilled; the mirror gets the same coverage from detail.messages.
  const indexEntries = useMemo(() => {
    const loadedEntries = [...older, ...items].filter(
      (it) => (it.kind === 'message' && it.role === 'user') || (it.kind === 'git' && it.raw_type === 'pr_created'),
    )
    const seen = new Set(loadedEntries.map((it) => it.id))
    const oldest = older[0] ?? items[0]
    const oldestTs = oldest ? new Date(oldest.ts).getTime() : Infinity
    const hist: TimelineItem[] = (isVisitor ? [] : detail?.messages || [])
      .filter((m) => m.role !== 'devin' && !seen.has(m.id) && new Date(m.timestamp).getTime() < oldestTs)
      .map((m) => ({ id: m.id, ts: m.timestamp, kind: 'message', role: 'user', body: m.message, raw_type: 'user_message' }))
    return [...hist, ...loadedEntries]
  }, [older, items, detail, isVisitor])
  const userMsgs = useMemo(() => indexEntries.filter((it) => it.kind === 'message'), [indexEntries])
  const userMsgCount = userMsgs.length
  const [copied, setCopied] = useState(false)
  const [dashboard, setDashboard] = useState<{ data: DashboardData | null; updatedAt?: string }>({ data: null })
  const [sidebar, setSidebar] = useState(window.innerWidth >= 1024)
  const [orgMenu, setOrgMenu] = useState(false)
  const settingsRowCls = 'text-foreground text-[13px] leading-[18px] flex w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 outline-none [&>svg]:mx-px [&>svg]:size-4 [&>svg]:shrink-0 hover:bg-tint-secondary'
  const settingsSeparatorCls = 'mx-2 h-[9px] bg-border bg-clip-content py-1'
  // Official collapsed-sidebar behavior: hovering the left edge shows the sidebar as a floating flyout.
  const [peek, setPeek] = useState(false)
  const [showPanel, setShowPanel] = useState(window.innerWidth >= 900 || !!wantPr)
  // Draft mode has no right-hand tabs — session panels would fetch /new.
  const effShowPanel = showPanel && !isDraft
  const [permSide, setPermSide] = useState<TimelineItem | null>(null)
  // Official PR tabs ("PR #N") appear automatically for the session's pull requests; "Hide tab" removes one.
  const [hiddenPrs, setHiddenPrs] = useState<Set<string>>(new Set())
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
  // PR panel data only exists on the admin API; visitors keep the header PR chip + PR cards.
  const panelPrs = useMemo(() => (isVisitor ? [] : detail?.session.pull_requests || treeNode?.pull_requests || [])
    .filter((p) => p.pr_url), [detail, treeNode, isVisitor])
  const prTabs = useMemo(() => panelPrs
    .filter((p) => !hiddenPrs.has(p.pr_url) && !closedTabIds.has(`pr:${p.pr_url}`))
    .map((p) => ({ url: p.pr_url, num: p.pr_url.match(/(\d+)$/)?.[1] || '', state: p.state, draft: p.draft })), [panelPrs, hiddenPrs, closedTabIds])
  const visiblePanelFiles = useMemo(() => fileTabs.filter((f) => !closedTabIds.has(`file:${f.href}`)), [fileTabs, closedTabIds])
  const panelKeys = useMemo(() => [...tabs, ...prTabs.map((p) => `pr:${p.url}`), ...visiblePanelFiles.map((f) => `file:${f.href}`)], [tabs, prTabs, visiblePanelFiles])
  const displayedPanelKeys = useMemo(
    () => [...tabOrder.filter((k) => panelKeys.includes(k)), ...panelKeys.filter((k) => !tabOrder.includes(k))],
    [panelKeys, tabOrder],
  )
  const platformLabel = useMemo(() => {
    const platform = detail?.session.platform?.toLowerCase()
    if (platform === 'macos' || platform === 'mac') return 'macOS'
    if (platform === 'windows' || platform === 'win') return 'Windows'
    return null
  }, [detail?.session.platform])
  // Crossing into a narrow viewport auto-hides the sidebar/right panel (official responsive behavior).
  useEffect(() => {
    let prevW = window.innerWidth
    const onResize = () => {
      const w = window.innerWidth
      if (w < 1024 && prevW >= 1024) setSidebar(false)
      if (w < 900 && prevW >= 900) setShowPanel(false)
      if (w >= 1024 && prevW < 1024) setSidebar(true)
      if (w >= 900 && prevW < 900) setShowPanel(true)
      prevW = w
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  useEffect(() => {
    if (isVisitor || !sidebar || window.innerWidth >= 768) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setSidebar(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isVisitor, sidebar])
  const [input, setInput] = useState(() => {
    if (id !== 'new') return ''
    try {
      const draft = localStorage.getItem('wb2-new-session-draft') || ''
      localStorage.removeItem('wb2-new-session-draft')
      return draft
    } catch { return '' }
  })
  // Per-session composer drafts (desktop keeps unsent text when switching
  // sessions). localStorage so drafts survive closing the tab/browser —
  // reopening restores the last page AND its composer state. inputForId
  // guards the id-switch render so the old session's text is never written
  // under the new session's key; the wb2-new-session-draft handoff
  // (cross-page nav) takes priority on 'new'.
  const inputForId = useRef(id)
  useEffect(() => {
    if (inputForId.current !== id) {
      inputForId.current = id
      let draft = ''
      try {
        if (id === 'new') {
          draft = localStorage.getItem('wb2-new-session-draft') || ''
          if (draft) localStorage.removeItem('wb2-new-session-draft')
          else draft = localStorage.getItem('wb2-input-draft:new') || ''
        } else {
          draft = localStorage.getItem(`wb2-input-draft:${id}`) || ''
        }
      } catch { /* storage unavailable */ }
      setInput(draft)
      return
    }
    try {
      const k = `wb2-input-draft:${id}`
      if (input) localStorage.setItem(k, input)
      else localStorage.removeItem(k)
    } catch { /* storage unavailable */ }
  }, [input, id])
  const [voiceRecording, setVoiceRecording] = useState(false)
  const [sending, setSending] = useState(false)
  const [uploading, setUploading] = useState(false)
  const uploadsInFlight = useRef(0)
  const [attachOpen, setAttachOpen] = useState(false)
  const attachMenuRef = useRef<HTMLDivElement | null>(null)
  const attachBtnRef = useRef<HTMLButtonElement | null>(null)

  // Official keyboard semantics (sampled live): menu container takes focus on
  // open; Up/Down cycle menuitems; Right on "Actions" opens the submenu and
  // focuses its first item; Left returns to "Actions"; Escape closes the whole
  // menu and refocuses the trigger button.
  const attachMenuKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    const root = attachMenuRef.current
    if (!root) return
    const sub = root.querySelector<HTMLElement>('[data-submenu]')
    const active = document.activeElement as HTMLElement | null
    const inSub = !!(sub && active && sub.contains(active))
    const items = [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].filter(
      (b) => !b.disabled && (sub ? sub.contains(b) === inSub : true),
    )
    const idx = active ? items.indexOf(active as HTMLButtonElement) : -1
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      items[(idx + 1) % items.length]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      items[(idx - 1 + items.length) % items.length]?.focus()
    } else if (e.key === 'Home') {
      e.preventDefault()
      items[0]?.focus()
    } else if (e.key === 'End') {
      e.preventDefault()
      items[items.length - 1]?.focus()
    } else if (e.key === 'Tab') {
      // Official: Tab closes the menu and moves focus to the next control after
      // the trigger; Shift+Tab closes and refocuses the trigger itself.
      setAttachOpen(false)
      attachBtnRef.current?.focus()
      if (e.shiftKey) e.preventDefault()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setAttachOpen(false)
      attachBtnRef.current?.focus()
    } else if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Official: letter typeahead focuses the next matching menuitem.
      const ch = e.key.toLowerCase()
      const matches = items.filter((b) => (b.textContent || '').trim().toLowerCase().startsWith(ch))
      if (matches.length) {
        e.preventDefault()
        const cur = active ? matches.indexOf(active as HTMLButtonElement) : -1
        matches[(cur + 1) % matches.length]?.focus()
      }
    }
  }, [])
  const [showJump, setShowJump] = useState(false)
  const [dragOver, setDragOver] = useState(0)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [queued, setQueued] = useState<{ id: string; text: string }[]>([])
  const [editingQ, setEditingQ] = useState<string | null>(null)
  const editingQRef = useRef<string | null>(null)
  useEffect(() => { editingQRef.current = editingQ }, [editingQ])
  const dragQ = useRef<string | null>(null)
  const [composerMeta, setComposerMeta] = useState<ComposerMetaT | null>(null)
  // Official draft precheck (POST /api/devin-coach/precheck, debounced on composer
  // changes with a stable per-mount draft_id); findings drive the coach hint row.
  const draftIdRef = useRef<string>(crypto.randomUUID())
  const [findings, setFindings] = useState<{ finding_type: string; explanation: string }[]>([])
  const [scanState, setScanState] = useState<'idle' | 'busy' | 'sent' | 'error'>('idle')
  /* Official coach_precheck_mode org setting (bundle-sampled): 'off' | 'warning_only'
     (default) | 'warning_and_modal'. Only warning_and_modal opens the "Confirm to send
     message" dialog: findings present >=400ms and the exact draft not previously
     confirmed. Mirror reads the mode from localStorage (default warning_only). */
  const coachMode = localStorage.getItem('wb2-coach-precheck-mode') || 'warning_only'
  const [confirmSendOpen, setConfirmSendOpen] = useState(false)
  const findingsSinceRef = useRef<number | null>(null)
  const confirmedDraftRef = useRef<string | null>(null)
  const hasFindings = findings.length > 0
  useEffect(() => { findingsSinceRef.current = hasFindings ? Date.now() : null }, [hasFindings])
  const autoSendRef = useRef<string | null>(null)
  const [autoSendTick, setAutoSendTick] = useState(0)
  // applyAndSend confirm behavior: after the action mutates the draft (or other
  // composer state), send it once the state has settled (official confirmWithAction
  // semantics). The tick covers actions that leave the draft text unchanged.
  useEffect(() => {
    if (autoSendRef.current !== null && autoSendRef.current === input) {
      autoSendRef.current = null
      void send()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, autoSendTick])
  useEffect(() => {
    if (!input.trim() || isVisitor) { setFindings([]); return }
    const text = input
    const t = window.setTimeout(() => {
      void adminFetch<{ findings: { finding_type: string; explanation: string }[] }>('/api/admin/mirror/precheck', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: text,
          draft_id: draftIdRef.current,
          devin_mode: mode === 'SWE-1.7' ? 'swe' : mode.toLowerCase().startsWith('fusion') ? 'fusion' : mode.toLowerCase(),
          session_id: id,
        }),
      }).then((r) => setFindings(r.findings || [])).catch(() => {})
    }, 2500)
    return () => window.clearTimeout(t)
  }, [input, mode, id, isVisitor])
  const [sugIdx, setSugIdx] = useState(0)
  const [atCat, setAtCat] = useState<string | null>(null)
  // Official Files mention listbox: one-shot org index fetch (indexed_paths_for_org_v2),
  // filtered client-side like the official composer.
  const [indexedPaths, setIndexedPaths] = useState<string[] | null>(null)
  useEffect(() => setIndexedPaths(null), [id])
  useEffect(() => {
    if (atCat !== 'files' || indexedPaths || isVisitor || isDraft) return
    void adminFetch<{ paths: string[] }>(`/api/admin/mirror/indexed-paths?session=${encodeURIComponent(id)}`)
      .then((r) => setIndexedPaths(r.paths || []))
      .catch(() => setIndexedPaths([]))
  }, [atCat, indexedPaths, isVisitor, isDraft, id])
  const editorRef = useRef<ComposerEditorHandle>(null)
  const [bandH, setBandH] = useState(0)

  // Composer trigger token at end of input: `/` = commands+skills, `@` =
  // mention categories. `!`/`$` (playbooks/secrets) have no local data source,
  // so they don't trigger an always-empty listbox.
  const trigger = useMemo(() => {
    const m = /(^|\s)([/@])([\w\u4e00-\u9fff./-]*)$/.exec(input)
    return m ? { char: m[2] as '/' | '@', query: m[3].toLowerCase() } : null
  }, [input])

  useEffect(() => {
    if (!trigger || trigger.char !== '@') setAtCat(null)
  }, [trigger])

  useEffect(() => {
    if ((!trigger && !isDraft) || composerMeta || isVisitor) return
    void adminFetch<ComposerMetaT>('/api/admin/composer-meta').then(setComposerMeta).catch(() => {})
  }, [trigger, composerMeta, isVisitor, isDraft])

  const suggestions = useMemo((): SuggestItem[] => {
    if (!trigger || !composerMeta) return []
    const q = trigger.query
    if (trigger.char === '/') {
      // Per-session commands win when the agent has advertised them (localCfg),
      // else the org-level composer-meta list.
      const src = (localCfg?.commands?.length
        ? localCfg.commands.map((c) => ({ command: c.name, description: c.description ?? '', hint: c.input?.hint }))
        : composerMeta.commands)
      const cmds = src
        .filter((c) => c.command !== 'btw' && c.command.toLowerCase().includes(q))
        .map((c) => ({ key: `cmd-${c.command}`, title: `/${c.command}${c.hint ? ` ${c.hint}` : ''}`, sub: c.description, insert: `/${c.command} ` }))
      // The agent's command list already includes skills — only append
      // composer-meta skills it doesn't advertise (dedupe by name).
      const cmdNames = new Set(src.map((c) => c.command))
      const skills = composerMeta.skills
        .filter((s) => !cmdNames.has(s.name) && (s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)))
        .slice(0, 8)
        .map((s) => ({ key: `skill-${s.repo}-${s.name}`, title: s.name, sub: s.description, insert: `${s.name} ` }))
      return [...cmds, ...skills]
    }
    if (trigger.char === '@') {
      if (!atCat) {
        return AT_CATEGORIES.filter((c) => c.title.toLowerCase().includes(q)).map((c) => ({
          key: `cat-${c.cat}`,
          title: c.title,
          sub: c.sub,
          insert: '',
          cat: c.cat,
        }))
      }
      if (atCat === 'skills') {
        return composerMeta.skills
          .filter((s) => s.name.toLowerCase().includes(q))
          .slice(0, 10)
          .map((s) => ({ key: `skill-${s.repo}-${s.name}`, title: s.name, sub: s.description, insert: `${s.name} ` }))
      }
      if (atCat === 'files') {
        if (!q) return []
        return (indexedPaths || [])
          .filter((p) => p.toLowerCase().includes(q))
          .slice(0, 10)
          .map((p) => {
            const i = p.lastIndexOf('/')
            return { key: `file-${p}`, title: i >= 0 ? p.slice(i + 1) : p, sub: i >= 0 ? p.slice(0, i) : '', insert: `${p} ` }
          })
      }
      if (atCat === 'repos') {
        return composerMeta.repos
          .filter((r) => r.name.toLowerCase().includes(q))
          .slice(0, 10)
          // `org` carries the full local workspace path — that's the token
          // the agent needs, not a cloud-style "org/name" fragment.
          .map((r) => ({ key: `repo-${r.org}`, title: r.name, sub: r.org, insert: `${r.org} ` }))
      }
      if (atCat === 'sessions') {
        return composerMeta.sessions
          .filter((s) => s.title.toLowerCase().includes(q))
          .slice(0, 10)
          .map((s) => ({ key: `ses-${s.id}`, title: s.title, sub: s.snippet, insert: `${s.id} ` }))
      }
    }
    return []
  }, [trigger, composerMeta, atCat, indexedPaths, localCfg])

  useEffect(() => { setSugIdx(0) }, [input, atCat])

  const openMention = useCallback((cat: string) => {
    setAtCat(cat)
    setInput((v) => (v && !/\s$/.test(v) ? `${v} @` : `${v}@`))
    editorRef.current?.focus()
    if (!composerMeta && !isVisitor) void adminFetch<ComposerMetaT>('/api/admin/composer-meta').then(setComposerMeta).catch(() => {})
  }, [composerMeta, isVisitor])

  const applySuggestion = useCallback((s: SuggestItem) => {
    if (s.cat) {
      setAtCat(s.cat)
      setInput((v) => v.replace(/(^|\s)@[\w\u4e00-\u9fff./-]*$/, '$1@'))
      return
    }
    // Secrets/repos/files/sessions render as official-style inline void pills
    // (Slate-sampled DOM: leading icon + label, bg-tint 19px pill).
    if (editorRef.current) {
      const icon = s.key.startsWith('sec-') ? 'lock'
        : s.key.startsWith('repo-') ? 'repo'
          : s.key.startsWith('file-') ? 'file'
            : s.key.startsWith('ses-') ? 'session'
              : null
      if (icon) {
        // Official pill tooltips (sampled per type): repo = "<owner> (repo)",
        // file = full path, session = snippet, secret = description.
        const tooltip = icon === 'repo'
          ? (s.sub ? `${s.sub} (repo)` : '(repo)')
          : icon === 'file'
            ? (s.sub ? `${s.sub}/${s.title}` : s.title)
            : s.sub || s.title
        editorRef.current.insertPill(s.insert.trimEnd(), s.title, icon, tooltip)
        return
      }
    }
    setInput((v) => v.replace(/(^|\s)([/!@$])[\w\u4e00-\u9fff./-]*$/, `$1${s.insert}`))
  }, [])

  const queueOpReq = useCallback(async (payload: { op: string; id?: string; ids?: string[]; held?: boolean; message?: string }) => {
    if (isVisitor) return false
    const r = await adminFetch<{ ok: boolean }>(`/api/admin/session/${id}/queue-op`, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'content-type': 'application/json' },
    }).catch(() => null)
    return r?.ok === true
  }, [id, isVisitor])

  const queueOp = useCallback(async (op: 'remove' | 'send_now', qid: string) => {
    if (await queueOpReq({ op, id: qid })) setQueued((q) => q.filter((m) => m.id !== qid))
  }, [queueOpReq])

  const queueEditStart = useCallback(async (qid: string, text: string) => {
    setEditingQ(qid)
    setInput(text)
    void queueOpReq({ op: 'hold', id: qid, held: true })
  }, [queueOpReq])

  const queueEditSubmit = useCallback(async (qid: string, text: string) => {
    // official edit flow: edit (new content) -> send_now -> hold released
    const ok = await queueOpReq({ op: 'edit', id: qid, message: text })
    if (ok) {
      await queueOpReq({ op: 'send_now', id: qid })
      void queueOpReq({ op: 'hold', id: qid, held: false })
      setQueued((q) => q.filter((m) => m.id !== qid))
    }
    setEditingQ(null)
  }, [queueOpReq])

  const queueReorder = useCallback(async (fromId: string, toId: string) => {
    setQueued((q) => {
      const from = q.findIndex((m) => m.id === fromId)
      const to = q.findIndex((m) => m.id === toId)
      if (from < 0 || to < 0 || from === to) return q
      const next = [...q]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      void queueOpReq({ op: 'reorder', ids: next.map((m) => m.id) })
      return next
    })
  }, [queueOpReq])

  const queueSend = useCallback(async (text: string) => {
    if (isVisitor) return
    const r = await adminFetch<{ ok: boolean; id?: string }>(`/api/admin/session/${id}/queue`, {
      method: 'POST',
      body: JSON.stringify({ message: text }),
      headers: { 'content-type': 'application/json' },
    }).catch(() => null)
    if (r?.ok && r.id) {
      const qid = r.id
      setQueued((q) => [...q, { id: qid, text }])
    }
  }, [id, isVisitor])

  useEffect(() => {
    if (isVisitor) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isVisitor])
  const anyRef = useRef<HTMLInputElement>(null)
  const imgRef = useRef<HTMLInputElement>(null)
  const [dismissedQ, setDismissedQ] = useState('')
  const [controlling, setControlling] = useState(false)
  const [controlMsg, setControlMsg] = useState<string | null>(null)
  const [sendErr, setSendErr] = useState<string | null>(null)
  const [staged, setStaged] = useState<{ url: string; name: string; size: number; preview?: string }[]>([])
  const stagedRef = useRef(staged)
  stagedRef.current = staged
  const pendingPreviewRef = useRef<{ url: string; name: string; size: number; preview?: string }[]>([])
  const revokePreviews = (files: { preview?: string }[]) => {
    for (const file of files) if (file.preview) URL.revokeObjectURL(file.preview)
  }
  const clearPendingPreview = (preview?: string) => {
    if (!preview) return
    pendingPreviewRef.current = pendingPreviewRef.current.filter((file) => file.preview !== preview)
  }
  useEffect(() => () => {
    revokePreviews([...stagedRef.current, ...pendingPreviewRef.current])
  }, [])
  const [stepChanges, setStepChanges] = useState<TimelineItem | null>(null)
  const [focusFile, setFocusFile] = useState<{ path: string; n: number } | null>(null)
  const [worklogJump, setWorklogJump] = useState<string | null>(null)
  const [indexOpen, setIndexOpen] = useState(false)
  // Official minimap: the tick nearest the current scroll position is highlighted (text-primary);
  // PR ticks are purple (bg-text-purple).
  // Official minimap is a vertically centred stack of the last 20 entries (gap-2, 1.5px bars),
  // not bars positioned at each row's on-screen height.
  const [idxActive, setIdxActive] = useState<string | null>(null)
  const [idxTip, setIdxTip] = useState<{ id: string; top: number; right: number } | null>(null)
  const idxTicks = useMemo(() => indexEntries.slice(-20), [indexEntries])
  const updateIdxActive = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const box = el.getBoundingClientRect()
    let act: string | null = null
    for (const it of indexEntries) {
      const node = el.querySelector(`[data-eid="${CSS.escape(it.id)}"]`)
      if (!node) continue
      const r = node.getBoundingClientRect()
      if (r.top - box.top <= el.clientHeight / 2) act = it.id
    }
    setIdxActive(act)
  }, [indexEntries])
  useEffect(() => { updateIdxActive() }, [updateIdxActive, loaded])
  const [scAnchor, setScAnchor] = useState<{ id: string; ts: string } | null>(null)
  const [translations, setTranslations] = useState<Record<string, string>>({})
  const mediaTok = detail?.media_token || ''
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickBottom = useRef(true)
  const anchor = useRef<{ id: string; offset: number } | null>(null)

  // Ctrl+F in-transcript find (desktop parity): search item text, jump via data-eid.
  const [findOpen, setFindOpen] = useState(false)
  const [findQ, setFindQ] = useState('')
  const [findPos, setFindPos] = useState(0)
  const findInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setFindOpen(true)
        requestAnimationFrame(() => findInputRef.current?.select())
      } else if (e.key === 'Escape' && findOpen) setFindOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [findOpen])

  /** Remember the top-most visible event so a background refresh doesn't shift the view. */
  const captureAnchor = useCallback(() => {
    const el = scrollRef.current
    anchor.current = null
    if (!el || stickBottom.current) return
    const top = el.getBoundingClientRect().top
    for (const node of el.querySelectorAll<HTMLElement>('[data-eid]')) {
      const offset = node.getBoundingClientRect().top - top
      if (offset >= 0) { anchor.current = { id: node.dataset.eid!, offset }; break }
    }
  }, [])

  // Registry + sidebar tree only start once the first timeline page has landed, so
  // the large tree payload never competes with the conversation for the first paint.
  const [booted, setBooted] = useState(false)
  useEffect(() => { if (loaded) setBooted(true) }, [loaded])
  useEffect(() => {
    if (!booted || isVisitor) return
    const load = () => adminFetch<{ sessions: AdminSession[] }>('/api/admin/sessions').then((r) => setSessions(r.sessions)).catch(() => {})
    load()
    return visibleInterval(load, 30_000)
  }, [booted, isVisitor])

  const [treePrefs, setTreePrefs] = useState<TreePrefs>(() => {
    try {
      const raw = localStorage.getItem(TREE_PREFS_KEY)
      return raw ? { ...DEFAULT_TREE_PREFS, ...(JSON.parse(raw) as Partial<TreePrefs>) } : DEFAULT_TREE_PREFS
    } catch {
      return DEFAULT_TREE_PREFS
    }
  })
  const updateTreePrefs = useCallback((p: Partial<TreePrefs>) => setTreePrefs((prev) => {
    const next = { ...prev, ...p }
    try { localStorage.setItem(TREE_PREFS_KEY, JSON.stringify(next)) } catch { /* quota */ }
    return next
  }), [])
  const [archTree, setArchTree] = useState<MirrorTreeSession[]>([])
  const loadTree = useCallback(() => {
    const filterQ = buildFilterQ(treePrefs)
    adminFetch<{ sessions: MirrorTreeSession[]; folder_order?: string[]; folder_totals?: Record<string, number>; next_cursor?: string | null }>(`/api/admin/mirror/sessions?limit=60&order_by=${treePrefs.sort}${filterQ}`).then((r) => {
      const payload: TreeCachePayload = {
        sessions: r.sessions || [],
        folder_order: r.folder_order || [],
        folder_totals: r.folder_totals || {},
        next_cursor: r.next_cursor || null,
      }
      setTree(payload.sessions)
      setFolderOrder(payload.folder_order)
      setFolderTotals(payload.folder_totals)
      setTreeCursor(payload.next_cursor || '')
      writeTreeCache(payload)
    }).catch(() => {})
    if (treePrefs.showArchived) adminFetch<{ sessions: MirrorTreeSession[] }>(`/api/admin/mirror/sessions?limit=10&archived=true&order_by=${treePrefs.sort}${filterQ}`).then((r) => setArchTree(r.sessions || [])).catch(() => {})
  }, [treePrefs])
  const [treeCursor, setTreeCursor] = useState(() => cachedTree?.next_cursor || '')
  const [loadingMore, setLoadingMore] = useState(false)
  const loadMoreTree = useCallback(() => {
    if (!treeCursor || loadingMore) return
    setLoadingMore(true)
    adminFetch<{ sessions: MirrorTreeSession[]; next_cursor?: string | null }>(`/api/admin/mirror/sessions?limit=60&order_by=${treePrefs.sort}${buildFilterQ(treePrefs)}&cursor=${encodeURIComponent(treeCursor)}`)
      .then((r) => {
        setTree((prev) => {
          const seen = new Set(prev.map((s) => s.devin_id))
          return [...prev, ...(r.sessions || []).filter((s) => !seen.has(s.devin_id))]
        })
        setTreeCursor(r.next_cursor || '')
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false))
  }, [treeCursor, loadingMore, treePrefs])

  useEffect(() => {
    if (!booted || isVisitor) return
    loadTree()
    return visibleInterval(loadTree, 60_000)
  }, [loadTree, booted, isVisitor])

  useEffect(() => {
    let alive = true
    if (isDraft) { setDetail(null); return }
    const snapshot = !isVisitor ? tlSnapshots.get(id) : null
    const canRestore = !!snapshot && Date.now() - snapshot.at < 30 * 60_000
    if (canRestore) setDetail(snapshot!.detail)
    else setDetail(null)
    let first = true
    let followUp: number | null = null
    // Visitors boot from the share-scoped /meta projection (title / status / PRs /
    // permission tier); it is shaped into the same SessionDetail the admin reads.
    const fetchDetail = (): Promise<{ data: SessionDetail; stale: boolean }> => isVisitor
      ? shareFetchSwr<ShareMeta>(id, shareTok, '/meta').then(({ data: m, stale }) => {
          return {
            stale,
            data: {
              session: {
                id,
                devin_session_id: '',
                title: m.title,
                devin_title: m.title,
                permission: m.permission,
                archived: 0,
                status: m.status,
                status_message: m.status_message,
                status_enum_raw: m.status_enum_raw,
                status_short_message: m.status_short_message,
                queue_position: m.queue_position,
                pull_request: m.pull_request,
                pull_requests: m.pull_requests,
                platform: m.platform,
              },
              messages: [],
              share_url: '',
              dashboard_url: '',
            },
          }
        })
      : adminFetchSwr<SessionDetail>(`/api/admin/session/${id}?slim=1${first ? '&boot=1' : ''}`)
    const load = () => fetchDetail()
      .then(({ data: r, stale }) => {
        if (!alive) return
        if (first && stale && followUp == null) followUp = window.setTimeout(() => { if (!alive) return; followUp = null; load() }, 800)
        first = false
        if (isVisitor && ['readonly', 'chat', 'basic', 'detailed', 'full'].includes(r.session.permission)) {
          setVisitorPerm(r.session.permission as SharePermission)
        }
        setDetail(r)
      })
      .catch(() => {})
    load()
    const stop = visibleInterval(load, 3_000)
    return () => {
      alive = false
      stop()
      if (followUp != null) clearTimeout(followUp)
      storeSnapshot(id)
    }
  }, [id, isVisitor, shareTok, storeSnapshot])

  useEffect(() => {
    if (isDraft) { setItems([]); setOlder([]); setCursor(null); setActivity(null); setTlError(null); setInterrupted(null); setLoaded(true); return }
    let alive = true
    const snapshot = !isVisitor ? tlSnapshots.get(id) : null
    const canRestore = !!snapshot && Date.now() - snapshot.at < 30 * 60_000
    if (canRestore) {
      setItems(snapshot!.items)
      setOlder(snapshot!.older)
      setCursor(snapshot!.cursor)
      setLoaded(true)
    } else {
      setItems([]); setOlder([]); setCursor(null); setLoaded(false)
    }
    setActivity(null)
    setTlError(null)
    let first = true
    let followUp: number | null = null
    let olderPrefetchTimer: number | null = null
    const scheduleOlderPrefetch = (nextCursor: string | null) => {
      if (!nextCursor || isVisitor) return
      if (olderPrefetchTimer != null) clearTimeout(olderPrefetchTimer)
      const prefetchPromise = new Promise<TimelinePage>((resolve, reject) => {
        olderPrefetchTimer = window.setTimeout(() => {
          if (idRef.current !== id) {
            reject(new Error('session changed'))
            return
          }
          sessionFetch<TimelinePage>(`/timeline?limit=300&cursor=${encodeURIComponent(nextCursor)}`).then(resolve, reject)
        }, 1500)
      })
      olderPrefetch.current = { id, cursor: nextCursor, promise: prefetchPromise }
      void prefetchPromise.catch(() => {})
    }
    // Bound the displayed window: streamed sessions would otherwise grow
    // `items` without limit (mergeItems never evicts) until the DOM chokes.
    // Drop the OLDEST excess — `cursor` is the index (into the server items
    // array) of the oldest item on screen, so sliding it forward by the drop
    // keeps scroll-up refetches contiguous: the trimmed range comes back as
    // ordinary older pages. (`eidx` is the LOG index, not the items index —
    // using it as the cursor landed back-pages misaligned.)
    const boundWindow = () => {
      const cid = idRef.current
      window.setTimeout(() => {
        if (idRef.current !== cid) return
        const cut = olderRef.current.length + itemsRef.current.length - 600
        if (cut <= 0) return
        if (!isVisitor) setCursor((prev) => String((parseInt(prev ?? '0', 10) || 0) + cut))
        const dropO = Math.min(olderRef.current.length, cut)
        if (dropO) setOlder((prev) => prev.slice(dropO))
        if (cut - dropO > 0) setItems((prev) => prev.slice(cut - dropO))
      }, 0)
    }
    // Lazy peek: opening the session only reads the server-side snapshot —
    // no session/load, so devin never sees "activity" and the timestamp stays
    // put. Staying >8s or interacting graduates to the real loading path.
    let peek = !isVisitor
    const windowGen = { current: 0 }
    const graduateNow = () => {
      if (!peek || !alive) return
      peek = false
      windowGen.current = 0
      setCfgTick((t) => t + 1) // model/mode pill refetches real config
      void load()
    }
    graduateTl.current = graduateNow
    const graduateTimer = peek ? window.setTimeout(graduateNow, 8000) : null
    const load = (fresh = false) => {
      captureAnchor()
      return sessionFetchSwr<TimelinePage>(`/timeline?limit=300${peek ? '&peek=1' : ''}${first ? '&boot=1' : fresh ? '&fresh=1' : ''}`)
        .then(({ data: r, stale }) => {
          if (!alive) return
          // A stale boot copy paints instantly; pull the revalidated page right after.
          if (first && stale && followUp == null) followUp = window.setTimeout(() => { if (!alive) return; followUp = null; load() }, 800)
          if (first || r.reset) {
            // First fetch replaces the restored client snapshot wholesale
            // (it is stale by definition); `reset` means the server log was
            // rebuilt — ids collided, merge is unsafe. Either way: swap the
            // whole window and restart the older-page cursor chain.
            setItems(r.items)
            setOlder([])
            setCursor(r.next_cursor)
            scheduleOlderPrefetch(r.next_cursor)
            first = false
          } else {
            setItems((prev) => mergeItems(prev, r.items))
            // Peek/mid-replay pages carry next_cursor=null — the first real
            // merge must seed the back-page cursor or scrolling to the top
            // can never fetch older history. (older[] non-empty + a null
            // cursor = an exhausted chain — don't revive it.)
            if (r.next_cursor && cursorRef.current == null && olderRef.current.length === 0) {
              setCursor(r.next_cursor)
              scheduleOlderPrefetch(r.next_cursor)
            }
          }
          boundWindow()
          if (r.activity !== undefined) setActivity(r.activity ?? null)
          if (r.interrupted) {
            // Dismissed banners stay down until a NEW interrupted turn
            // (different ts) appears — keyed per session.
            let gone = false
            try { gone = localStorage.getItem(`wb2-intd:${id}`) === String(r.interrupted.ts) } catch { /* unavailable */ }
            setInterrupted(gone ? null : r.interrupted)
          } else setInterrupted(null)
          setTlError(r.error)
          setLoaded(true)
          failCount.current = 0
          setConnLost(false)
          // Generation of what the window now shows — deltas from another
          // generation are dropped (they'd merge-collide on `e${i}` ids).
          if (windowGen.current === 0 && (r.gen ?? 0) > 0) setCfgTick((t) => t + 1)
          windowGen.current = r.gen ?? 0
          // Server queue snapshot (latest messages_in_queued event) is authoritative,
          // matching the official client's fetch_only hydration; skip while editing.
          if (r.queue) setQueued((prev) => (editingQRef.current ? prev : r.queue!))
          // History replay in progress: repoll quickly so the window fills as
          // soon as the real generation lands, instead of the 3s fallback.
          if (r.activity && resyncTimer == null) {
            resyncTimer = window.setTimeout(() => { resyncTimer = null; if (alive) void load() }, 800)
          }
        })
        .catch((e) => {
          if (!alive) return
          setTlError((e as Error).message)
          setLoaded(true)
          failCount.current += 1
          if (failCount.current >= 2) setConnLost(true)
        })
    }
    reloadTl.current = () => load(true)
    load()
    // Real-time stream: the server pushes per-update timeline deltas over /ws
    // (built items, not raw ACP), so replies paint as they generate instead of
    // in 3-second polling jumps. The interval stays as a consistency fallback.
    let resyncTimer: number | null = null
    // A delta from a newer log generation can't merge into a snapshot/stale
    // window — resync immediately instead of dropping it and going blind for
    // up to a full poll interval (the "updates take forever" bug).
    let wantGen = 0
    const resync = (gen: number) => {
      if (!alive) return
      wantGen = Math.max(wantGen, gen)
      if (peek) { graduateNow(); return }
      if (resyncTimer != null) return
      resyncTimer = window.setTimeout(() => {
        resyncTimer = null
        void load().then(() => {
          // Replay still in flight — the page came back as a gen-0 snapshot;
          // poll quickly until the real generation lands and deltas fit.
          if (alive && windowGen.current < wantGen) resync(wantGen)
        }).catch(() => {})
      }, 300)
    }
    const offWs = subscribeWs((ev) => {
      if (!alive || ev.sessionId !== id) return
      if (ev.type === 'timeline_delta' && Array.isArray(ev.items)) {
        // Drop deltas whose log generation doesn't match the window's —
        // a snapshot window (gen 0) or a previous rebuild would merge-collide
        // on `e${i}` ids; resync pulls the real page right away.
        if (typeof ev.gen === 'number' && ev.gen !== windowGen.current) { resync(ev.gen); return }
        const inc = ev.items as TimelineItem[]
        setItems((prev) => {
          const gone = new Set(inc.filter((i) => i._gone).map((i) => i.id))
          const base = gone.size ? prev.filter((i) => !gone.has(i.id)) : prev
          return mergeItems(base, inc.filter((i) => !i._gone))
        })
        boundWindow()
        setLoaded(true)
      } else if (ev.type === 'prompt_done' || ev.type === 'account_limited' || ev.type === 'account_rotated') {
        void load()
      }
    })
    const stop = visibleInterval(() => load(), 3_000)
    return () => {
      alive = false
      stop()
      offWs()
      reloadTl.current = null
      graduateTl.current = null
      if (graduateTimer != null) clearTimeout(graduateTimer)
      if (resyncTimer != null) clearTimeout(resyncTimer)
      if (followUp != null) clearTimeout(followUp)
      if (olderPrefetchTimer != null) clearTimeout(olderPrefetchTimer)
      if (olderPrefetch.current?.id === id) olderPrefetch.current = null
      storeSnapshot(id)
    }
  }, [id, captureAnchor, isVisitor, storeSnapshot])

  // dashboard tab reads the same per-session share endpoint for both viewers
  useEffect(() => {
    if (panel !== 'dashboard' || !detail || !detail.share_url) return
    const token = isVisitor ? shareTok : new URL(detail.share_url, window.location.origin).searchParams.get('t') || ''
    const fetchDash = () =>
      fetch(`/api/share/${detail.session.id}/dashboard?t=${encodeURIComponent(token)}`)
        .then((r) => r.json())
        .then((r: { dashboard: DashboardData | null; updated_at?: string }) => setDashboard({ data: r.dashboard, updatedAt: r.updated_at }))
        .catch(() => {})
    fetchDash()
    return visibleInterval(fetchDash, 3000)
  }, [panel, detail, isVisitor, shareTok])

  // Copy link deep links: official ?ts=<epoch ms> (legacy #e-<eventId> still honored)
  useEffect(() => {
    if (!loaded) return
    let node: Element | null = null
    const tsParam = new URLSearchParams(location.search).get('ts')
    if (tsParam) {
      const target = Number(tsParam)
      // nearest event by timestamp that actually has a rendered row
      // (events folded into a collapsed group have no data-eid node)
      const byDist = [...items].sort(
        (a, b) => Math.abs(new Date(a.ts).getTime() - target) - Math.abs(new Date(b.ts).getTime() - target),
      )
      for (const it of byDist) {
        node = scrollRef.current?.querySelector(`[data-eid="${CSS.escape(it.id)}"]`) ?? null
        if (node) break
      }
    } else if (location.hash.startsWith('#e-')) {
      const eid = decodeURIComponent(location.hash.slice(3))
      node = scrollRef.current?.querySelector(`[data-eid="${CSS.escape(eid)}"]`) ?? null
    }
    if (!node) return
    stickBottom.current = false
    node.scrollIntoView({ block: 'center' })
    const cleanUrl = new URL(window.location.href)
    cleanUrl.searchParams.delete('ts')
    if (cleanUrl.hash.startsWith('#e-')) cleanUrl.hash = ''
    if (cleanUrl.toString() !== window.location.href) {
      window.history.replaceState(window.history.state, '', cleanUrl.toString())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded])

  /** Focus a panel tab, opening it (official "Add tab" behavior) when it isn't open yet. */
  const openTab = useCallback((key: PanelKey) => {
    if (isVisitor && !tabs.includes(key)) return
    tabSyncBlocked.current = false
    setTabs((prev) => (prev.includes(key) ? prev : [...prev, key]))
    if (panelFlashRef.current === key) flashTab(key)
    setPanel(key)
    setUserPickedActiveTab(true)
    setShowPanel(true)
    setAddOpen(false)
  }, [flashTab, isVisitor, tabs])
  const onStepChanges = useCallback((it: TimelineItem) => { setStepChanges(it); openTab('changes') }, [openTab])
  /** Official "Analyze" opens Devin Review; the mirror opens the PR's own panel tab instead. */
  const openPr = useCallback((prUrl: string) => {
    if (isVisitor) return
    tabSyncBlocked.current = false
    setClosedTabIds((prev) => { if (!prev.has(`pr:${prUrl}`)) return prev; const next = new Set(prev); next.delete(`pr:${prUrl}`); return next })
    setHiddenPrs((prev) => { if (!prev.has(prUrl)) return prev; const n = new Set(prev); n.delete(prUrl); return n })
    setPanel(`pr:${prUrl}`)
    setUserPickedActiveTab(true)
    setShowPanel(true)
  }, [isVisitor])
  const scrollToRow = useCallback((eventId: string): boolean => {
    const node = scrollRef.current?.querySelector(`[data-eid="${CSS.escape(eventId)}"]`)
    if (!node) return false
    stickBottom.current = false
    node.scrollIntoView({ block: 'center', behavior: 'smooth' })
    return true
  }, [])
  // `<ref_file>` chip click: official opens the file in the editor; the mirror lands on
  // the matching entry of the Changes panel (nothing to open when the file was never edited)
  const onFileRef = useCallback((path: string) => { setStepChanges(null); setFocusFile({ path, n: Date.now() }); openTab('changes') }, [openTab])
  const onOpenProgress = useCallback((it: TimelineItem) => { setWorklogJump(it.id); openTab('worklog') }, [openTab])
  // Cloud parity: clicking a subagent card opens the child session as a full
  // page (own timeline + composer + controls), not a side-panel transcript.
  // `sub:` ids always key off the ROOT session — nested cards keep the root id.
  const onOpenSubagent = useCallback((aid: string) => {
    const root = id.startsWith('sub:') ? id.split(':')[1] : id
    nav(`/admin/sub:${root}:${aid}`)
  }, [id, nav])

  const closeTab = useCallback((key: PanelKey) => {
    setClosedTabIds((prev) => new Set(prev).add(key))
    setTabs((prev) => {
      const next = prev.filter((k) => k !== key)
      if (!next.length) setShowPanel(false)
      setPanel((cur) => (cur === key ? next[next.length - 1] ?? cur : cur))
      return next
    })
  }, [])

  const reloadDetail = useCallback(() => {
    if (isVisitor || isDraft) return
    adminFetch<SessionDetail>(`/api/admin/session/${id}?slim=1`).then(setDetail).catch(() => {})
  }, [id, isVisitor, isDraft])

  const loadOlder = useCallback(async () => {
    if (loadingOlder || olderBusy.current) return
    // Peek mode hands out no cursor — scrolling to the top means the user
    // actually wants older history: graduate to the real loading fetch.
    if (!cursor) { graduateTl.current?.(); return }
    const startId = idRef.current
    olderBusy.current = true
    setLoadingOlder(true)
    const el = scrollRef.current
    const prevHeight = el?.scrollHeight ?? 0
    try {
      const pageCursor = cursor
      const prefetched = olderPrefetch.current
      const request = prefetched?.id === startId && prefetched.cursor === pageCursor
        ? (() => {
            olderPrefetch.current = null
            return prefetched.promise
          })()
        : sessionFetch<TimelinePage>(`/timeline?limit=300&cursor=${encodeURIComponent(pageCursor)}`)
      const r = await request
      if (idRef.current !== startId) return
      setOlder((prev) => [...r.items.map((it) => ({ ...it, pageCursor })), ...prev])
      if (!r.error) setCursor(r.next_cursor)
      // keep the reader anchored on what they were already looking at
      requestAnimationFrame(() => {
        if (el) el.scrollTop += el.scrollHeight - prevHeight
      })
    } catch { /* leave cursor in place so the user can retry */ } finally {
      olderBusy.current = false
      setLoadingOlder(false)
    }
  }, [cursor, loadingOlder])

  // A first page shorter than the viewport never fires onScroll; keep backfilling until it does.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !cursor || loadingOlder || !loaded) return
    if (el.scrollHeight <= el.clientHeight + 1) loadOlder()
  }, [cursor, loadingOlder, loaded, loadOlder])

  // Jump target may be beyond the loaded window: backfill pages until the event
  // (or its timestamp) is covered, mirroring the official index's full-history jumps.
  const loadUntil = useCallback(async (eventId: string, ts: string) => {
    if (loadingOlder || olderBusy.current || !cursor) return
    const startId = idRef.current
    olderBusy.current = true
    setLoadingOlder(true)
    const el = scrollRef.current
    const target = new Date(ts).getTime()
    let cur: string | null = cursor
    try {
      for (let i = 0; i < 40 && cur; i++) {
        const pageCursor = cur
        const prefetched = olderPrefetch.current
        const request = prefetched?.id === startId && prefetched.cursor === pageCursor
          ? (() => {
              olderPrefetch.current = null
              return prefetched.promise
            })()
          : sessionFetch<TimelinePage>(`/timeline?limit=300&cursor=${encodeURIComponent(pageCursor)}`)
        const r: TimelinePage = await request
        if (idRef.current !== startId) break
        if (r.error) break
        const prevHeight = el?.scrollHeight ?? 0
        setOlder((prev) => [...r.items.map((it) => ({ ...it, pageCursor })), ...prev])
        cur = r.next_cursor
        setCursor(r.next_cursor)
        await new Promise((res) => requestAnimationFrame(res))
        if (el) el.scrollTop += el.scrollHeight - prevHeight
        if (r.items.some((it) => it.id === eventId)) break
        if (r.items[0] && new Date(r.items[0].ts).getTime() <= target) break
      }
    } catch { /* cursor stays for retry */ } finally {
      olderBusy.current = false
      setLoadingOlder(false)
    }
  }, [cursor, loadingOlder])

  // Quote pill click (official `useQuoteLink`): a message quote deep-links to `?ts=<timestampMs>`
  // and the transcript backfills until that moment is loaded; worklog / shell / file quotes open
  // the matching tab instead. The mirror scrolls to the row when it is (or becomes) loaded.
  const jumpToQuote = useCallback(async (q: QuoteAttachment) => {
    if (q.kind === 'worklog') {
      if (q.eventId) { setWorklogJump(q.eventId); scrollToRow(q.eventId) }
      openTab('worklog')
      return
    }
    if (q.kind === 'shell') { openTab('shell'); return }
    if (q.path && !q.eventId) { onFileRef(q.path); return }
    if (!q.eventId) return
    if (scrollToRow(q.eventId)) return
    if (!q.tsMs || !cursor) return
    await loadUntil(q.eventId, new Date(q.tsMs).toISOString())
    await new Promise((res) => requestAnimationFrame(res))
    if (scrollToRow(q.eventId)) return
    // target folded into a collapsed work group: land on the nearest rendered row by time
    const target = q.tsMs
    const byDist = [...allItemsRef.current].sort(
      (a, b) => Math.abs(new Date(a.ts).getTime() - target) - Math.abs(new Date(b.ts).getTime() - target),
    )
    for (const cand of byDist) if (scrollToRow(cand.id)) break
  }, [cursor, loadUntil, onFileRef, openTab, scrollToRow])

  const allItems = useMemo(() => {
    const seen = new Set<string>()
    return [...older, ...items].filter((it) => (seen.has(it.id) ? false : (seen.add(it.id), true)))
  }, [older, items])
  const allItemsRef = useRef(allItems)
  allItemsRef.current = allItems

  // Ctrl+F: matching item ids for the current query.
  const findHits = useMemo(() => {
    const q = findQ.trim().toLowerCase()
    if (!q) return [] as string[]
    const hits: string[] = []
    for (const it of allItems) {
      if (findItemText(it).includes(q)) hits.push(it.id)
      if (hits.length >= 500) break
    }
    return hits
  }, [allItems, findQ])
  const findCur = findHits.length ? findHits[Math.min(findPos, findHits.length - 1)] : null
  useEffect(() => { setFindPos(0) }, [findQ])
  useEffect(() => {
    if (!findCur) return
    const node = scrollRef.current?.querySelector<HTMLElement>(`[data-eid="${CSS.escape(findCur)}"]`)
    if (!node) return
    node.scrollIntoView({ block: 'center' })
    node.classList.add('wb-find-hit')
    return () => node.classList.remove('wb-find-hit')
  }, [findCur])

  const workSecs = useMemo(() => (allItems.length ? workSeconds(allItems) : 0), [allItems])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (stickBottom.current) {
      el.scrollTop = el.scrollHeight
      return
    }
    // restore the previously top-most event so refreshes don't shift the view
    const a = anchor.current
    if (!a) return
    const node = el.querySelector<HTMLElement>(`[data-eid="${CSS.escape(a.id)}"]`)
    if (node) {
      el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top - a.offset
    }
    anchor.current = null
  }, [items])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stickBottom.current) el.scrollTop = el.scrollHeight
  }, [bandH])

  // Official grouper wraps even a lone event in the live tail group ("Working
// for …") — needs the working flag, which sidebarStatus derives from these
// enum values; computed here because `status` is declared further down.
const sessionWorking = ['working', 'running', 'resumed', 'restored'].includes(
  detail?.session.status_enum_raw || detail?.session.status || '',
)
const groups = useMemo(() => groupItems(allItems, sessionWorking), [allItems, sessionWorking])
  const messageHeaders = useMemo(() => {
    const out = new Map<string, boolean>()
    let previousAuthor: string | undefined
    for (const group of groups) {
      if (group.type !== 'item' || group.item.kind !== 'message') continue
      const author = group.item.role === 'user' ? (group.item.title || 'User') : 'devin'
      out.set(group.item.id, author !== previousAuthor)
      previousAuthor = author
    }
    return out
  }, [groups])
  useEffect(() => {
    if (!loaded || (!isVisitor && !detail) || tabsDefaultsFor.current === id) return
    tabsDefaultsFor.current = id
    if (isVisitor) {
      const next = visitorTabs(caps, allItems)
      setTabs(next)
      setPanel((current) => wantPr ? `pr:${wantPr}` : next.includes(current as PanelKey) ? current : next[0] || 'dashboard')
      return
    }
    if (tabsSaved) return
    const next = defaultTabs(allItems, groups)
    setTabs(next)
    const allProduced = detailMsgs
      .filter((message) => message.role === 'devin')
      .flatMap((message) => (message.attachments || []).map((attachment) => ({ href: attachmentUrl(id, attachment.url, mediaTok), name: attachment.name })))
      .filter((attachment) => !/\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|mp4|webm|mov|avi|mkv|m4v|ogv|ogg)$/i.test(attachment.name))
      .filter((attachment, index, all) => all.findIndex((candidate) => candidate.href === attachment.href) === index)
    const produced = allProduced.slice(-2)
    setFileTabs(produced)
    setClosedTabIds((prev) => {
      const next = new Set(prev)
      allProduced.slice(0, -2).forEach((file) => next.add(`file:${file.href}`))
      return next
    })
    const prKeys = (detail?.session.pull_requests || []).map((pr) => pr.pr_url).filter(Boolean).map((url) => `pr:${url}`)
    const fileKeys = produced.map((file) => `file:${file.href}`)
    const active = (next.includes('progress') ? 'progress' : null) || prKeys[prKeys.length - 1] || fileKeys[fileKeys.length - 1] || next[0] || 'dashboard'
    setPanel(wantPr ? `pr:${wantPr}` : active)
  }, [allItems, caps, detail, detailMsgs, groups, id, isVisitor, loaded, tabsSaved, wantPr])

  const deepLinkReadFor = useRef<string | null>(null)
  const [urlInitializedId, setUrlInitializedId] = useState<string | null>(null)
  useEffect(() => {
    if (!loaded || (!isVisitor && !detail) || deepLinkReadFor.current === id) return
    const allowed = isVisitor ? visitorTabs(caps, allItems) : null
    const prs = detail?.session.pull_requests || treeNode?.pull_requests || []
    const knownFiles = [...fileTabs, ...attachFiles.map((file) => ({
      href: attachmentUrl(id, file.url, mediaTok),
      name: file.name,
    }))].filter((file, index, all) => all.findIndex((candidate) => candidate.name.toLowerCase() === file.name.toLowerCase()) === index)
    const requested = tabParam ? parseOfficialTab(tabParam, prs, knownFiles) : null
    const requestedKey = requested?.panel || ''
    const requestedAllowed = !!requested && (
      !isVisitor
      || (requestedKey.startsWith('file:') ? allowed?.includes('files') : allowed?.includes(requestedKey as PanelKey))
    )
    tabSyncBlocked.current = !!tabParam && !requestedAllowed
    if (requestedAllowed && requested) {
      if (requestedKey.startsWith('pr:')) {
        const prUrl = requestedKey.slice(3)
        setHiddenPrs(new Set())
        setClosedTabIds((prev) => {
          const next = new Set(prev)
          next.delete(requestedKey)
          return next
        })
        setPanel(`pr:${prUrl}`)
      } else if (requestedKey.startsWith('file:') && requested.file) {
        setClosedTabIds((prev) => {
          const next = new Set(prev)
          next.delete(requestedKey)
          return next
        })
        setFileTabs((prev) => prev.some((file) => file.href === requested.file!.href) ? prev : [...prev, requested.file!])
        setPanel(requestedKey)
      } else {
        setTabs((prev) => prev.includes(requestedKey as PanelKey) ? prev : [...prev, requestedKey as PanelKey])
        setPanel(requestedKey)
      }
      setShowPanel(true)
      setUserPickedActiveTab(true)
    } else if (!tabParam && wantPr && !isVisitor) {
      const legacy = prs.find((pr) => pr.pr_url === wantPr)
      if (legacy?.pr_url) {
        const key = `pr:${legacy.pr_url}`
        setHiddenPrs(new Set())
        setClosedTabIds((prev) => {
          const next = new Set(prev)
          next.delete(key)
          return next
        })
        setPanel(key)
        setShowPanel(true)
        setUserPickedActiveTab(true)
      }
    }
    const fullWidthParam = initialParams.get('fullscreen')
    if (fullWidthParam === 'true' || fullWidthParam === '1') {
      setFullWidth(true)
      setShowPanel(true)
    } else {
      setFullWidth(false)
    }
    deepLinkReadFor.current = id
    requestAnimationFrame(() => {
      if (deepLinkReadFor.current === id) setUrlInitializedId(id)
    })
  }, [allItems, attachFiles, caps, detail, fileTabs, id, initialParams, isVisitor, loaded, mediaTok, tabParam, treeNode, wantPr])

  const urlPrs = useMemo(() => detail?.session.pull_requests || treeNode?.pull_requests || [], [detail, treeNode])
  const urlFiles = useMemo(() => fileTabs, [fileTabs])
  const visitorUrlTabs = useMemo(() => visitorTabs(caps, allItems), [allItems, caps])
  const serializedPanel = useMemo(() => {
    if (isVisitor) {
      const isFile = panel.startsWith('file:')
      if (isFile && !visitorUrlTabs.includes('files')) return null
      if (!isFile && !visitorUrlTabs.includes(panel as PanelKey)) return null
    }
    // 'dashboard' is a fallback value, not an open tab — serializing it would
    // write ?tab=dashboard which deep-links back as a phantom opened tab.
    if (panel in PANELS && !tabs.includes(panel as PanelKey)) return null
    return serializeOfficialTab(panel, urlPrs, urlFiles)
  }, [isVisitor, panel, urlFiles, urlPrs, visitorUrlTabs, tabs])
  const urlInitialized = urlInitializedId === id
  // 'new' is truthy — without !isDraft the draft page writes ?tab=… which
  // then survives the post-create navigate and lands on the fresh session.
  useUrlParamSync('tab', serializedPanel, 'worklog', { enabled: !!id && !isDraft && !tabSyncBlocked.current, initialized: urlInitialized })
  useUrlParamSync('fullscreen', fullWidth && showPanel ? 'true' : null, null, { enabled: !!id && !isDraft, initialized: urlInitialized })

  // Official `Pi`: when the newest transcript item is a thought it is temporarily expanded.
  const tailThoughtId = useMemo(() => {
    const g = groups[groups.length - 1]
    const last = g?.type === 'work' ? g.items[g.items.length - 1] : g?.type === 'row' ? g.item : undefined
    return last?.kind === 'thought' ? last.id : undefined
  }, [groups])
  const envSuperseded = useMemo(() => envSupersededMap(allItems), [allItems])

  // Official blocked footer: the latest status_update carrying user_action_required
  // renders as an orange persona + "Action required: <text>" row.
  const actionRequired = useMemo(() => {
    for (let i = allItems.length - 1; i >= 0; i--) {
      const it = allItems[i]
      if (it.kind !== 'status') continue
      return it.body?.startsWith('Action required:') ? it.body : null
    }
    return null
  }, [allItems])

  // permission_resolved events resolve their request card (official: requestId -> approved/denied)
  const permResolved = useMemo(() => {
    const m = new Map<string, 'approved' | 'denied'>()
    for (const it of allItems) {
      if (it.kind === 'permission' && it.permission?.resolved) m.set(it.permission.requestId, it.permission.resolved)
    }
    return m
  }, [allItems])

  // send_secrets(request_id) marks a request_secret card as provided (official `Bi` reducer)
  const secretProvided = useMemo(() => {
    const s = new Set<string>()
    for (const it of allItems) for (const r of it.secretsSent?.requestIds ?? []) s.add(r)
    return s
  }, [allItems])

  const provideSecret = useCallback(async (requestId: string, value: string) => {
    if (!caps.canProvideSecret) throw new Error('无权限')
    const r = await adminFetch<{ ok: boolean; error?: string | null }>(`/api/admin/session/${id}/secret-response`, {
      method: 'POST',
      body: JSON.stringify({ request_id: requestId, value }),
    })
    if (!r.ok) throw new Error(r.error === 'request_not_found' ? '该请求已不存在' : r.error === 'no_ack' ? '上游未确认，请稍后重试' : '提交失败')
  }, [id, caps.canProvideSecret])

  // Workflow run aggregation (official: agents grouped by run_id, latest status per result_id).
  const wf = useMemo(() => {
    const status = new Map<string, string>()
    const agents = new Map<string, Map<string, string>>()
    const agentEvents = new Map<string, Map<string, WfAgentEventState>>()
    const runs: { runId: string; name?: string }[] = []
    for (const it of allItems) {
      if (it.kind === 'workflow' && it.workflow?.runId) {
        const r = it.workflow.runId
        if (it.raw_type === 'workflow_run_started') {
          if (!runs.some((x) => x.runId === r)) runs.push({ runId: r, name: it.workflow.name })
          if (!status.has(r)) status.set(r, 'running')
        } else {
          status.set(r, it.workflow.status || 'completed')
        }
      } else if (it.kind === 'workflow_agent' && it.agent?.runId && it.agent.resultId) {
        let m = agents.get(it.agent.runId)
        if (!m) { m = new Map(); agents.set(it.agent.runId, m) }
        m.set(it.agent.resultId, it.agent.status)
        let e = agentEvents.get(it.agent.runId)
        if (!e) { e = new Map(); agentEvents.set(it.agent.runId, e) }
        e.set(it.agent.resultId, { status: it.agent.status, phase: it.agent.phase, label: it.agent.label })
      }
    }
    return { status, agents, runs, agentEvents }
  }, [allItems])
  const current = sessions.find((s) => s.id === id)

  async function send(preset?: string) {
    let text = (preset ?? input).trim()
    if (statusState.inputDisabled || (!text && !(preset === undefined && staged.length)) || sending) return
    if (!caps.canSendMessage) { setSendErr('当前分享档位不允许发言'); return }
    if (
      preset === undefined &&
      coachMode === 'warning_and_modal' &&
      findings.length > 0 &&
      confirmedDraftRef.current !== text &&
      findingsSinceRef.current != null &&
      Date.now() - findingsSinceRef.current >= 400
    ) {
      setConfirmSendOpen(true)
      return
    }
    if (preset === undefined && text.startsWith('/queue ')) {
      text = text.slice(7).trim()
      if (text) { setInput(''); void queueSend(text) }
      return
    }
    // Free text typed while an option question is pending answers the
    // question with other_text (official composer semantics).
    if (preset === undefined && pending) {
      if (!caps.canAnswerQuestion) { setSendErr('当前分享档位不允许回答'); return }
      setSending(true)
      setSendErr(null)
      try {
        await sessionFetch('/question-answer', {
          method: 'POST',
          body: JSON.stringify({
            original_event_id: pending.id,
            // Free text answers the first question; the rest of a multi-question
            // card is marked "[skipped by user]" (official composer semantics).
            answers: (pending.questions || [{}]).map((_, i) =>
              i === 0
                ? { question_index: 0, selected_options: [], other_text: text }
                : { question_index: i, selected_options: ['[skipped by user]'] }),
          }),
        })
        setDismissedQ(pending.id)
        setInput('')
      } catch (e) {
        setSendErr(e instanceof Error && e.message ? e.message : 'Failed to send message. Try again.')
      } finally { setSending(false) }
      return
    }
    // Draft (/admin/new): the first send IS the session — create it with the
    // text as the task, replay draft config picks onto it, then swap in place
    // (desktop-parity new-session flow; server also applies lastConfig).
    if (isDraft) {
      setSending(true)
      setSendErr(null)
      try {
        const task = text.startsWith('/queue ') ? text.slice(7).trim() : text
        const r = await adminFetch<{ ok: boolean; id?: string; error?: string }>('/api/admin/sessions/new', {
          method: 'POST',
          body: JSON.stringify({ task, folder: draftFolder || undefined, cwd: draftCwd || undefined }),
        })
        if (!r.ok || !r.id) throw new Error(r.error || 'create failed')
        for (const pick of draftPicks.current) {
          void adminFetch(`/api/admin/session/${r.id}/config`, { method: 'POST', body: JSON.stringify(pick) }).catch(() => null)
        }
        draftPicks.current = []
        setInput(''); setStaged([])
        nav(`/admin/${r.id}`, { replace: true })
      } catch (e) {
        setSendErr(e instanceof Error && e.message ? e.message : '创建会话失败')
      } finally { setSending(false) }
      return
    }
    setSending(true)
    setSendErr(null)
    // Local echo (rendered as a plain user row) until the upstream event replaces it.
    const echo: TimelineItem = {
      id: `local-${Date.now()}`, ts: new Date().toISOString(), kind: 'message', role: 'user',
      body: text, raw_type: 'user_message',
      ...(preset === undefined && staged.length
        ? { attachments: staged.map((f) => ({ url: f.url, name: f.name, size: f.size })) }
        : {}),
    }
    setItems((prev) => [...prev, echo])
    const draft = { input, staged }
    pendingPreviewRef.current = draft.staged
    if (preset === undefined) { setInput(''); setStaged([]) }
    let messageSent = false
    try {
      if (!isVisitor && selectedVersion && selectedVersion !== currentVersion) {
        try {
          await sessionFetch<{ ok: boolean; error?: string }>('/version', {
            method: 'POST',
            body: JSON.stringify({ version: selectedVersion }),
          })
          setOptimisticVersion(selectedVersion)
          setSelectedVersion((pendingVersion) => pendingVersion === selectedVersion ? null : pendingVersion)
        } catch {
          setSendErr('Failed to switch model')
        }
      }
      graduateTl.current?.() // sending is interaction — start the real load now
      await sessionFetch('/message', {
        method: 'POST',
        body: JSON.stringify({
          message: text,
          // Real attachment blocks — the server converts staged uploads into
          // ACP image/resource/resource_link prompt blocks.
          attachments: preset === undefined ? staged.map((f) => ({ url: f.url, name: f.name, size: f.size })) : [],
        }),
      })
      messageSent = true
      revokePreviews(draft.staged)
      pendingPreviewRef.current = []
      await reloadTl.current?.()
      setItems((prev) => {
        const real = prev.some((it) => it.id !== echo.id && it.kind === 'message' && it.role === 'user' && (it.body || '').trim() === (echo.body || '').trim() && it.ts >= new Date(Date.parse(echo.ts) - 120_000).toISOString())
        return real ? prev.filter((it) => it.id !== echo.id) : prev
      })
      // Safety net: never keep a local echo around once the poll has had time to land it.
      window.setTimeout(() => setItems((prev) => prev.filter((it) => it.id !== echo.id)), 15_000)
    } catch (e) {
      // Keep the draft in the composer and surface an inline failure notice.
      pendingPreviewRef.current = []
      setItems((prev) => prev.filter((it) => it.id !== echo.id))
      if (preset === undefined && !messageSent) { setInput((cur) => cur || draft.input); setStaged((cur) => (cur.length ? cur : draft.staged)) }
      setSendErr(e instanceof Error && e.message ? e.message : 'Failed to send message. Try again.')
    } finally { setSending(false) }
  }

  // One-click recovery for a turn that died mid-flight (server restart /
  // killed acp): 'continue' sends a 继续 nudge (the turn reached the agent —
  // its partial work is in context), 'resend' replays the original message
  // (the prompt never even echoed).
  const resumeInterrupted = async () => {
    if (!interrupted || sending || isDraft) return
    const it = interrupted
    setInterrupted(null)
    try {
      await sessionFetch('/message', {
        method: 'POST',
        body: JSON.stringify(it.kind === 'resend'
          ? { message: it.text, attachments: it.attachments ?? [] }
          : { message: '继续', attachments: [] }),
      })
      await reloadTl.current?.()
    } catch (e) {
      setInterrupted(it) // resend failed — put the banner back
      setSendErr(e instanceof Error && e.message ? e.message : 'Failed to send message. Try again.')
    }
  }
  const dismissInterrupted = () => {
    if (!interrupted) return
    try { localStorage.setItem(`wb2-intd:${id}`, String(interrupted.ts)) } catch { /* unavailable */ }
    setInterrupted(null)
  }

  // Dead subagent handle: the registry that held it was emptied by a restart/
  // replay, so resume relays can never land. Respawn sends the text with
  // respawn:1 — the lead spawns a SUCCESSOR carrying this agent's context.
  const subDead = isSub && detail?.session.subagent?.resumable === false
  const respawnSub = async () => {
    if (sending) return
    const msg = input.trim() || '请继续处理之前的任务'
    setSending(true)
    try {
      await sessionFetch('/message', { method: 'POST', body: JSON.stringify({ message: msg, respawn: true }) })
      setInput('')
      setControlMsg('已让主会话派出继任子代理 — 新子会话会出现在侧栏')
    } catch (e) {
      setSendErr(e instanceof Error && e.message ? e.message : 'Failed to send message. Try again.')
    } finally { setSending(false) }
  }

  // Latest unanswered question: any user reply after it clears the pending
  // state (matches the official composer panel behavior). An answered event
  // referencing the question (answeredEventId) also clears it.
  let pendingQuestion: TimelineItem | null = null
  for (let i = allItems.length - 1; i >= 0; i--) {
    const it = allItems[i]
    if (it.kind !== 'message') continue
    if (it.role === 'devin' && it.questions?.length) { pendingQuestion = it; break }
    if (it.role === 'user') break
  }
  if (pendingQuestion && allItems.some((it) => it.answeredEventId === pendingQuestion!.id)) pendingQuestion = null
  const pending = pendingQuestion && dismissedQ !== pendingQuestion.id ? pendingQuestion : null

  async function answerQuestion(answers: string[][]) {
    if (!pending || sending) return
    if (!caps.canAnswerQuestion) { setSendErr('当前分享档位不允许回答'); return }
    setSending(true)
    setSendErr(null)
    try {
      await sessionFetch('/question-answer', {
        method: 'POST',
        body: JSON.stringify({
          original_event_id: pending.id,
          answers: answers.map((sel, i) => ({ question_index: i, selected_options: sel })),
        }),
      })
      setDismissedQ(pending.id)
    } catch (e) {
      setSendErr(e instanceof Error && e.message ? e.message : 'Failed to submit answer. Try again.')
    } finally { setSending(false) }
  }

  const rawStatus = detail?.session.status_enum_raw || detail?.session.status || current?.status_enum_raw || current?.status || ''
  const statusState = reduceStatus({
    status: detail?.session.status,
    statusEnumRaw: rawStatus,
    statusMessage: detail?.session.status_message,
    statusShortMessage: detail?.session.status_short_message,
    queuePosition: detail?.session.queue_position,
    sleepReason: detail?.session.sleep_reason,
    thoughts: activity?.text,
    userActionRequired: actionRequired,
    isError: rawStatus === 'crashed',
    readOnly: !caps.canSendMessage,
    visitor: isVisitor,
  })
  const status = statusState.sidebarStatus
  // The official Wake Devin up row disappears immediately on click (before the
  // status poll catches up); reset once the session is actually running again.
  const [woke, setWoke] = useState(false)
  useEffect(() => { if (statusState.enum === 'working') setWoke(false) }, [statusState.enum])
  // Header work-time chip ticks while the agent is working.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (statusState.enum !== 'working') return
    const t = setInterval(() => setTick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [statusState.enum])

  async function control(action: 'pause' | 'resume') {
    if (controlling || isVisitor) return
    setControlling(true)
    setControlMsg(null)
    try {
      const r = await adminFetch<{ ok: boolean; message?: string | null; error?: string | null }>(
        `/api/admin/session/${id}/${action}`,
        { method: 'POST' },
      )
      if (!r.ok) setControlMsg(r.message || r.error || 'failed')
      else if (action === 'resume') setWoke(true)
      reloadDetail()
    } catch (e) {
      setControlMsg((e as Error).message)
    } finally {
      setControlling(false)
    }
  }

  // Service restart: fixed timers can't know when the old server actually
  // exits (redeploy builds first), so poll /api/accounts — wait for it to go
  // DOWN, then for it to come back UP, then reload. Covers both restart
  // (~4s) and redeploy (~1-3min) without duration guesses.
  function waitForRestart() {
    setControlMsg('等待服务停止…')
    const t0 = Date.now()
    let sawDown = false
    const tick = async () => {
      let up = false
      try { up = (await fetch('/api/accounts', { cache: 'no-store' })).ok } catch { /* down */ }
      if (!up) sawDown = true
      if (sawDown && up) { location.reload(); return }
      if (sawDown) setControlMsg('服务重启中，恢复后自动刷新…')
      if (Date.now() - t0 < 6 * 60 * 1000) setTimeout(tick, 1500)
      else setControlMsg('重启超时——请检查服务后手动刷新')
    }
    setTimeout(tick, 1000)
  }

  async function upload(file: File) {
    if (isDraft) { setSendErr('发出第一条消息后即可传附件'); return }
    if (!caps.canUpload) return
    const preview = URL.createObjectURL(file)
    pendingPreviewRef.current.push({ url: '', name: file.name, size: file.size, preview })
    setUploading(true)
    uploadsInFlight.current += 1
    try {
      const upName = file.name || `upload.${(file.type.split(';')[0].split('/')[1] || 'bin')}`
      const r = await sessionFetch<{ ok: boolean; url?: string; name?: string; size?: number; error?: string }>(`/upload-stage?filename=${encodeURIComponent(upName)}`, { method: 'POST', body: file })
      if (!r.ok || !r.url || !r.name || typeof r.size !== 'number') throw new Error(r.error || 'upload failed')
      clearPendingPreview(preview)
      setStaged((prev) => {
        if (prev.some((f) => f.url === r.url)) {
          URL.revokeObjectURL(preview)
          return prev
        }
        return [...prev, { url: r.url!, name: r.name!, size: r.size!, preview }]
      })
    } catch {
      clearPendingPreview(preview)
      URL.revokeObjectURL(preview)
    } finally {
      uploadsInFlight.current -= 1
      if (uploadsInFlight.current === 0) setUploading(false)
    }
  }
  const isStagedImage = (file: { name: string; url: string }) => {
    if (IMAGE_RE.test(file.name)) return true
    try {
      const basename = new URL(file.url, window.location.origin).pathname.split('/').filter(Boolean).pop() || ''
      return IMAGE_RE.test(basename)
    } catch {
      return false
    }
  }
  const removeStaged = (url: string) => {
    setStaged((files) => {
      const removed = files.find((file) => file.url === url)
      if (removed) revokePreviews([removed])
      return files.filter((file) => file.url !== url)
    })
  }

  return (
    <div ref={rootRef} className="relative flex h-dvh overflow-hidden bg-background">

      {/* left: session list (administrator only; visitors have no session tree) */}
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
            'group/sidebar flex w-[300px] shrink-0 flex-col bg-background max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:duration-150 max-md:ease-out motion-safe:max-md:transition-transform',
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
                <span className="flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-foreground text-[9px] font-semibold text-background">本</span>
                <span className="truncate">本地 Devin</span>
                <ChevronDown size={12} className="shrink-0 text-muted-foreground" />
              </button>
              {orgMenu && (
                <>
                  <div className="fixed inset-0 z-20" onClick={() => setOrgMenu(false)} />
                  <div role="menu" className="absolute left-0 top-9 z-30 w-[220px] overflow-hidden rounded-[10px] bg-card/95 p-1 shadow-lg ring-1 ring-border backdrop-blur-[8px]">
                    <button role="menuitem" onClick={() => { setOrgMenu(false); nav('/settings') }}
                      className="flex w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] text-foreground outline-none hover:bg-tint-secondary">
                      <Settings2 size={14} className="text-muted-foreground" /> 首选项…
                    </button>
                    <div role="separator" className="mx-2 h-[9px] bg-border bg-clip-content py-1" />
                    <button role="menuitem" onClick={async () => { setOrgMenu(false); if (!confirm('重启服务？server 将自动重生，页面稍后自动刷新。')) return; await adminFetch('/api/admin/restart', { method: 'POST', body: JSON.stringify({}) }).catch(() => null); waitForRestart() }}
                      className="flex w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] text-foreground outline-none hover:bg-tint-secondary">
                      <RotateCcw size={14} className="text-muted-foreground" /> 重启服务
                    </button>
                    <button role="menuitem" onClick={async () => { setOrgMenu(false); if (!confirm('重新构建并重启？构建约 1-3 分钟。')) return; await adminFetch('/api/admin/redeploy', { method: 'POST', body: JSON.stringify({}) }).catch(() => null); waitForRestart() }}
                      className="flex w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] text-foreground outline-none hover:bg-tint-secondary">
                      <RefreshCw size={14} className="text-muted-foreground" /> 重新构建并重启
                    </button>
                  </div>
                </>
              )}
            </div>
            <button
              onClick={() => setPaletteOpen(true)}
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
                  <div className="px-2 pb-1 pt-2 text-[12px] font-medium text-muted-foreground">未读会话</div>
                  {unreadSessions.length === 0 && <div className="px-2 pb-2 pt-1 text-[13px] text-muted-foreground">暂无未读</div>}
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
              <span className="min-w-0 flex-1 truncate">新会话</span>
            </Link>
            <Link
              to="/admin/sessions"
              className="mb-px flex h-[30px] items-center gap-2 rounded-[6px] px-2 text-[13px] leading-[18px] text-foreground hover:bg-tint-secondary"
            >
              <Rows3 size={14} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">会话管理</span>
            </Link>
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {tree.length > 0 ? (
              <SessionTree tree={tree} archivedTree={archTree} activeDevinId={current?.devin_session_id || ''} onOpen={openTreeSession} onPrefetch={prefetchRegisteredSession} onRefresh={loadTree} prefs={treePrefs} onPrefs={updateTreePrefs} folderOrder={folderOrder} folderTotals={folderTotals} onLoadMore={treeCursor ? loadMoreTree : undefined} loadingMore={loadingMore} />
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
          <LocalDock />
        </aside>
      )}

      {/* center: timeline (hidden while the tabs panel is in full width) */}
      <div
        className={cn('relative flex min-w-0 flex-1 flex-col', effShowPanel && !fullWidth && 'md:basis-0', fullWidth && effShowPanel && 'max-md:flex md:hidden')}
        style={effShowPanel && !fullWidth && window.innerWidth >= 768 ? { flexGrow: 100 - rightPct } : undefined}
        onDragEnter={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragOver((n) => n + 1) } }}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() }}
        onDragLeave={(e) => { if (e.dataTransfer.types.includes('Files')) setDragOver((n) => Math.max(0, n - 1)) }}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          setDragOver(0)
          for (const f of e.dataTransfer.files) void upload(f)
        }}
      >
        {paletteOpen && !isVisitor && (
          <CommandPalette
            sessions={sessions}
            onClose={() => setPaletteOpen(false)}
            onTheme={(t) => { setThemeState(t); setTheme(t) }}
            onToggleSidebar={() => setSidebar((v) => !v)}
          />
        )}

        {dragOver > 0 && (
          <div className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-xl border-2 border-dashed border-foreground/40 bg-background/80">
            <p className="flex items-center gap-2 text-[14px] leading-[20px] text-muted-foreground">
              <UploadCloud size={18} /> Drop files here to share them with Devin
            </p>
          </div>
        )}
        <header className="flex h-11 flex-shrink-0 items-center justify-between overflow-hidden border-b border-transparent p-2 pr-[7px]">
          <div className="flex min-w-0 flex-1 items-center gap-2">
          {!isVisitor && !sidebar && (
            <button
              data-slot="sidebar-trigger"
              onClick={() => { setPeek(false); setSidebar(true) }}
              className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground"
              aria-label="Expand sidebar"
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
              <span className="max-w-[160px] truncate max-md:max-w-[80px]">{detail.session.parent_title ?? 'Parent'}</span>
            </button>
          )}
          <h1 className="min-w-0 flex-1 truncate text-[13px] leading-[18px] max-md:min-w-[120px]">{isDraft ? '新会话' : current?.title || current?.devin_title || detail?.session.title || '会话镜像'}</h1>
          {headerPrs.length > 0 && (!isVisitor || caps.showChanges) && (
            <div className="relative min-w-0 shrink-0">
              <button
                ref={prChipRef}
                type="button"
                aria-label={`${headerPrs.length} pull requests`}
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
              className="flex h-5 min-w-0 max-w-[280px] items-center gap-1 overflow-hidden truncate whitespace-nowrap rounded-[6px] px-1.5 font-mono text-[11px] leading-4 text-muted-foreground [background:var(--muted)]"
            >
              <FolderOpen size={11} className="shrink-0" />
              <span className="min-w-0 truncate" style={{ direction: 'rtl', textAlign: 'left' }}>{detail.session.cwd}</span>
            </span>
          )}
          {!isVisitor && workSecs > 0 && (
            <span title="Work time" className="flex h-5 items-center gap-1 rounded-[6px] px-1.5 text-[11px] font-medium tabular-nums leading-4 text-muted-foreground [background:var(--muted)]">
              <Clock size={11} /> {fmtWorkedDur(workSecs * 1000)}
            </span>
          )}
          </div>
          <div className="flex shrink-0 items-center gap-px pl-1">
          {!isVisitor && (
          <div className="relative flex items-center gap-px">
            <button
              ref={settingsButtonRef}
              type="button"
              aria-label="Session settings"
              aria-expanded={settingsOpen}
              onClick={() => toggleHeaderMenu()}
              className={cn('flex size-7 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-[18px]', settingsOpen && 'bg-accent')}
            >
              <SessionSettingsGlyph />
            </button>
            {settingsOpen && detail && (
              <HeaderMenuPortal open pos={headerMenuPos} onClose={closeHeaderMenus}>
              <div
                role="menu"
                onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); closeHeaderMenus() } }}
                className="absolute right-0 top-8 z-20 w-[280px] max-w-[calc(100vw-10px)] overflow-hidden rounded-[10px] bg-[rgba(255,255,255,0.94)] p-0 text-[13px] leading-[18px] outline outline-1 outline-black/[.06] shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)] backdrop-blur-[8px] dark:bg-[#1f1f1f]/[.94]"
              >
                {/* Session-scoped actions only — app prefs live in /settings,
                    service ops in the sidebar org menu / LocalDock gear. */}
                <div className="p-1">
                {settingsSub === 'rename' ? (
                  <input
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onKeyDown={async (e) => {
                      if (e.key === 'Escape') { setSettingsSub('none'); return }
                      if (e.key === 'Enter' && renameDraft.trim()) {
                        const title = renameDraft.trim()
                        setSettingsOpen(false); setSettingsSub('none')
                        await adminFetch('/api/admin/mirror/session-title', { method: 'POST', body: JSON.stringify({ devin_id: detail.session.devin_session_id, title }) }).catch(() => null)
                        reloadDetail(); loadTree()
                      }
                    }}
                    className="mb-0.5 h-[30px] w-full rounded-md border border-border bg-transparent px-2 text-[13px] outline-none"
                  />
                ) : (
                  <button
                    role="menuitem"
                    onMouseEnter={() => setSettingsSub('none')}
                    onClick={() => { setRenameDraft(current?.title || current?.devin_title || ''); setSettingsSub('rename') }}
                    className={settingsRowCls}
                  >
                    <Pencil size={14} className="text-muted-foreground" /> Rename
                  </button>
                )}
                {!isSub && <div className="relative">
                  <button
                    role="menuitem"
                    aria-haspopup="menu"
                    onMouseEnter={(e) => {
                      setSettingsSub('folder')
                      const r = e.currentTarget.getBoundingClientRect()
                      setFolderSubPos({ left: Math.max(8, r.left - 226), top: Math.min(r.top, Math.max(8, window.innerHeight - 296)) })
                    }}
                    className={settingsRowCls}
                  >
                    <FolderIcon size={14} className="text-muted-foreground" /> Folder
                    {treeNode?.folder && <span className="ml-auto max-w-24 truncate text-[12px] text-muted-foreground">{treeNode.folder}</span>}
                    <ChevronRight size={13} className={cn('text-muted-foreground', !treeNode?.folder && 'ml-auto')} />
                  </button>
                  {settingsSub === 'folder' && folderSubPos && createPortal(
                    <div role="menu" style={{ left: folderSubPos.left, top: folderSubPos.top }} onMouseLeave={() => setSettingsSub('none')} className="fixed z-50 max-h-72 w-56 overflow-y-auto rounded-[10px] border border-border bg-card p-1 shadow-lg">
                      {folderOrder.map((f) => (
                        <button
                          key={f}
                          role="menuitem"
                          onClick={async () => {
                            setSettingsOpen(false); setSettingsSub('none')
                            await adminFetch('/api/admin/mirror/session-folder', { method: 'POST', body: JSON.stringify({ devin_id: detail.session.devin_session_id, folder: f }) }).catch(() => null)
                            loadTree()
                          }}
                          className={settingsRowCls}
                        >
                          <FolderIcon size={13} className="shrink-0 text-muted-foreground" />
                          <span className="truncate">{f}</span>
                          {treeNode?.folder === f && <Check size={13} className="ml-auto shrink-0" />}
                        </button>
                      ))}
                      {treeNode?.folder && (
                        <button
                          role="menuitem"
                          onClick={async () => {
                            setSettingsOpen(false); setSettingsSub('none')
                            await adminFetch('/api/admin/mirror/session-folder', { method: 'POST', body: JSON.stringify({ devin_id: detail.session.devin_session_id, folder: null }) }).catch(() => null)
                            loadTree()
                          }}
                          className={settingsRowCls}
                        >
                          <X size={13} className="text-muted-foreground" /> Remove from folder
                        </button>
                      )}
                      {folderOrder.length === 0 && <p className="px-2 py-1.5 text-[12px] text-muted-foreground">No folders</p>}
                    </div>,
                    document.body,
                  )}
                </div>}
                  {!isSub && <button
                  role="menuitem"
                  onMouseEnter={() => setSettingsSub('none')}
                  onClick={async () => {
                    setSettingsOpen(false)
                    const nowArchived = !detail.session.archived
                    await adminFetch(`/api/admin/session/${id}/archive`, {
                      method: 'POST',
                      body: JSON.stringify({ archived: nowArchived }),
                    })
                    // An archived session leaves the sidebar — land on the
                    // management page where the 已归档 group shows it.
                    if (nowArchived) nav('/admin/sessions')
                    else reloadDetail()
                  }}
                  className={settingsRowCls}
                >
                  {detail.session.archived ? <><OArchive size={14} className="text-muted-foreground" /> Unarchive</> : <><OArchive size={14} className="text-muted-foreground" /> Archive</>}
                </button>}
                <div className={settingsSeparatorCls} />
                <button
                  role="menuitem"
                  onClick={() => {
                    navigator.clipboard.writeText(window.location.origin + (detail.share_url || `/admin/${id}`))
                    setCopied(true); setTimeout(() => setCopied(false), 1500)
                    setSettingsOpen(false); setSettingsSub('none')
                  }}
                  className={settingsRowCls}
                >
                  {copied ? <Check size={13} /> : <Link2 size={13} className="text-muted-foreground" />} Copy session link
                </button>
                {/* Verified live on local acp: uploads the transcript to
                    Cognition and returns an app.devin.ai share URL. */}
                {!isSub && <button
                  role="menuitem"
                  onClick={async () => {
                    setSettingsOpen(false); setSettingsSub('none')
                    if (!confirm('分享到 Devin 云端？会话内容将上传到 Cognition 并生成公开链接。')) return
                    const r = await adminFetch<{ ok: boolean; url?: string; error?: string }>(`/api/admin/session/${id}/share`, { method: 'POST', body: JSON.stringify({}) }).catch(() => null)
                    if (r?.ok && r.url) { navigator.clipboard.writeText(r.url); setControlMsg(`已分享: ${r.url}`) }
                    else setControlMsg(r?.error || 'Share failed')
                  }}
                  className={settingsRowCls}
                >
                  <Share2 size={13} className="text-muted-foreground" /> Share to Devin cloud
                </button>}
                {/* Desktop "Open in new window" — each session can live in its
                    own browser window. */}
                <button
                  role="menuitem"
                  onMouseEnter={() => setSettingsSub('none')}
                  onClick={() => { setSettingsOpen(false); setSettingsSub('none'); window.open(`${window.location.origin}/admin/${id}`, '_blank', 'noopener') }}
                  className={settingsRowCls}
                >
                  <ArrowUpRight size={13} className="text-muted-foreground" /> Open in new window
                </button>
                {!isSub && <div className="mt-1 border-t border-border px-2 pb-1 pt-2">
                  <p className="mb-1 text-[12px] text-muted-foreground">访客权限</p>
                  <Combo
                    className="w-full"
                    value={detail.session.permission}
                    onPick={async (v) => {
                      await adminFetch(`/api/admin/session/${id}/permission`, { method: 'POST', body: JSON.stringify({ permission: v }) })
                      reloadDetail()
                    }}
                    options={[
                      { v: 'detailed', l: '详细时间线（可聊+传文件+事件详情）' },
                      { v: 'full', l: '可聊 + 传文件' },
                      { v: 'chat', l: '仅可聊' },
                      { v: 'readonly', l: '只读' },
                    ]}
                  />
                </div>}
                <div className={settingsSeparatorCls} />
                {/* Subagent (child session) controls: foreground/background +
                    cancel — the desktop subagent semantics. */}
                {isSub && detail.session.subagent?.live && (
                  <button
                    role="menuitem"
                    onClick={async () => {
                      setSettingsOpen(false); setSettingsSub('none')
                      const action = detail.session.subagent?.isBackground ? 'foreground' : 'background'
                      const r = await adminFetch<{ ok: boolean; error?: string }>(`/api/admin/session/${id}/control`, { method: 'POST', body: JSON.stringify({ action }) }).catch(() => null)
                      setControlMsg(r?.ok ? `Subagent → ${action}` : r?.error || 'Control failed')
                      reloadDetail()
                    }}
                    className={settingsRowCls}
                  >
                    <Laptop size={13} className="text-muted-foreground" /> {detail.session.subagent.isBackground ? 'Bring to foreground' : 'Send to background'}
                  </button>
                )}
                {!isSub && (
                  <>
                {/* Kill the hosting acp process; next op respawns + replays
                    session/load — the local analog of cloud "reboot VM". */}
                <button
                  role="menuitem"
                  onClick={async () => {
                    setSettingsOpen(false); setSettingsSub('none')
                    if (!confirm('Restart agent process？承载此会话的 devin acp 进程将被终止，下次操作自动重放历史。')) return
                    const r = await adminFetch<{ ok: boolean }>(`/api/admin/session/${id}/restart`, { method: 'POST', body: JSON.stringify({}) }).catch(() => null)
                    setControlMsg(r?.ok ? 'Agent process restarting — history replays on next action' : 'Restart failed')
                  }}
                  className={settingsRowCls}
                >
                  <RotateCcw size={13} className="text-muted-foreground" /> Restart agent process
                </button>
                  </>
                )}
                {/* Verified live: {_cognition.ai/session/end} → dispatched.
                    For a sub session the server maps end → subagent cancel. */}
                <button
                  role="menuitem"
                  onClick={async () => {
                    setSettingsOpen(false); setSettingsSub('none')
                    if (!confirm(isSub ? 'End subagent？子智能体将被取消（转录保留）。' : 'End session？会话将被标记为结束（历史保留，桌面端同款操作）。')) return
                    const r = await adminFetch<{ ok: boolean; error: string }>(`/api/admin/session/${id}/end`, { method: 'POST', body: JSON.stringify({}) }).catch(() => null)
                    setControlMsg(r?.ok ? (isSub ? 'Subagent cancelled' : 'Session end dispatched') : r?.error || 'End failed')
                    reloadDetail()
                  }}
                  className={settingsRowCls}
                >
                  <Square size={13} className="text-muted-foreground" /> {isSub ? 'End subagent' : 'End session'}
                </button>
                <div className={settingsSeparatorCls} />
                <div className="px-2 pb-1 pt-1.5 text-[12px] leading-[18px] text-muted-foreground">
                  <div className="flex justify-between"><span>User messages:</span><span className="text-foreground">{userMsgCount}</span></div>
                  {detail.session.platform && <div className="flex justify-between"><span>Platform:</span><span className="text-foreground">{detail.session.platform}</span></div>}
                  {detail.session.subagent && <div className="flex justify-between"><span>Subagent:</span><span className="text-foreground">{[detail.session.subagent.profile, detail.session.subagent.model].filter(Boolean).join(' · ') || detail.session.subagent.agentId}</span></div>}
                  {detail.dashboard_url && <p className="break-all pt-1 text-[11px] leading-[15px]">看板推送接口：POST {window.location.origin}{detail.dashboard_url}</p>}
                </div>
                </div>
              </div>
              </HeaderMenuPortal>
            )}
          </div>
          )}
          {!effShowPanel && !isDraft && (
            <button
              onClick={() => setShowPanel(true)}
              aria-label="Show tabs panel"
              title="Show tabs panel"
              className="flex size-7 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <PanelHideTabsIcon size={18} />
            </button>
          )}
          </div>
        </header>

        {isDraft && loaded && (
          // Desktop new-session: empty state + composer center as one unit —
          // mt-auto here + mb-auto on the footer split free space equally.
          <div className="mx-auto mt-auto flex w-full max-w-[648px] flex-col items-center gap-2 px-6 text-center">
            <DevinMark size={48} className="text-foreground/15" />
            <p className="mt-2 text-[17px] font-medium leading-[26px] text-foreground">新会话</p>
            <p className="text-[13px] leading-[18px] text-muted-foreground">
              输入第一条消息即创建会话{draftFolder ? `，归入「${draftFolder}」` : ''}
            </p>
            <div className="mt-3 flex items-center gap-2 text-[12px] leading-[16px] text-muted-foreground">
              工作目录
              <DirPicker
                value={draftCwd}
                onChange={setDraftCwd}
                repos={composerMeta?.repos ?? []}
                recents={recentCwds}
                primaryCwd={composerMeta?.primary_cwd}
              />
            </div>
          </div>
        )}
        <div className={cn('relative flex min-h-0 flex-1 flex-col', isDraft && 'hidden')}>
        {findOpen && (
          <div className="absolute right-4 top-2 z-30 flex items-center gap-1 rounded-lg border border-border bg-card px-2 py-1 shadow-lg">
            <OSearch size={13} className="text-muted-foreground" />
            <input
              ref={findInputRef}
              autoFocus
              value={findQ}
              onChange={(e) => setFindQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); if (findHits.length) setFindPos((p) => (p + (e.shiftKey ? -1 : 1) + findHits.length) % findHits.length) }
                if (e.key === 'Escape') setFindOpen(false)
              }}
              placeholder="Find in session"
              className="w-44 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground"
            />
            <span className="min-w-[42px] text-center text-[11px] tabular-nums text-muted-foreground">
              {findQ ? `${findHits.length ? Math.min(findPos, findHits.length - 1) + 1 : 0}/${findHits.length}` : ''}
            </span>
            <button type="button" aria-label="Previous match" className="rounded p-0.5 hover:bg-accent disabled:opacity-40" disabled={!findHits.length}
              onClick={() => setFindPos((p) => (p - 1 + findHits.length) % findHits.length)}><ChevronUp size={14} /></button>
            <button type="button" aria-label="Next match" className="rounded p-0.5 hover:bg-accent disabled:opacity-40" disabled={!findHits.length}
              onClick={() => setFindPos((p) => (p + 1) % findHits.length)}><ChevronDown size={14} /></button>
            <button type="button" aria-label="Close find" className="rounded p-0.5 hover:bg-accent" onClick={() => setFindOpen(false)}><X size={14} /></button>
          </div>
        )}
        <div
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget
            const near = el.scrollHeight - el.scrollTop - el.clientHeight < 60
            stickBottom.current = near
            setShowJump(!near)
            // Official backfills older history automatically as you approach the top
            // (bundle: tail_window_backfill, backfillStatus loading/idle) — no button.
            if (el.scrollTop < 600) loadOlder()
            updateIdxActive()
          }}
          style={isDraft ? undefined : { paddingBottom: 20 + bandH }}
          className={cn('min-h-0 flex-1 overflow-y-auto pt-[20px] max-md:pl-[60px] max-md:pr-4 md:pl-[68px] md:pr-6', effShowPanel && 'max-md:hidden', isDraft && 'hidden')}
        >
          {connLost && (
            <div className="sticky top-0 z-10 mx-auto mb-2 w-fit rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[12px] leading-[16px] text-amber-600 dark:text-amber-400">
              Connection lost. Some data may be outdated.
            </div>
          )}
          {!loaded && (
            <div className="mx-auto max-w-[648px] pt-2" aria-hidden>
              <TimelineSkeleton rows={7} />
            </div>
          )}

          {loaded && tlError === 'mirror_not_configured' && <p className="text-xs text-muted-foreground">会话镜像未配置（缺少 Devin Web 令牌）。</p>}
          {loaded && tlError === 'token_expired' && <p className="text-xs text-amber-600">镜像令牌已失效，需重新配置。</p>}
          {loaded && tlError && tlError !== 'mirror_not_configured' && tlError !== 'token_expired' && <p className="text-xs text-red-600">镜像读取失败：{tlError}</p>}
          <div className="mx-auto max-w-[648px]"><div>
            {loaded && cursor && (
              <div className="mb-4" aria-hidden>
                <TimelineSkeleton rows={3} />
              </div>
            )}
            {groups.map((g, gi) =>
              g.type === 'item' && g.item.kind === 'permission' ? (
                <PermissionCard
                  key={g.item.id}
                  item={g.item}
                  sessionId={id}
                  resolved={permResolved.get(g.item.permission?.requestId || '')}
                  onOpenSidebar={() => { setPermSide(g.item); setShowPanel(true) }}
                />
              ) : g.type === 'item' && g.item.kind === 'secret_request' ? (
                <SecretRequestCard
                  key={g.item.id}
                  item={g.item}
                  provided={secretProvided.has(g.item.secretRequest?.requestId || '')}
                  onProvide={caps.canProvideSecret ? provideSecret : undefined}
                />
              ) : g.type === 'item' && g.item.kind === 'workflow' ? (
                (() => {
                  const it = g.item
                  const runId = it.workflow?.runId || ''
                  const running = wf.status.get(runId) === 'running'
                  const agentMap = wf.agents.get(runId)
                  const done = agentMap ? [...agentMap.values()].filter((s) => s !== 'running' && s !== 'queued').length : 0
                  return (
                    <div key={it.id} data-eid={it.id} data-testid="transcript-workflow-run" className="relative my-4 flex w-full flex-col overflow-hidden rounded-xl border border-border bg-card">
                      <div className="flex items-center gap-1.5 px-2.5 py-2">
                        <WorkflowIcon size={14} className="shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-[12px] leading-[16px] text-muted-foreground">
                          {running ? (it.workflow?.resumed ? 'Resuming workflow' : 'Running workflow') : 'Ran workflow'}
                        </span>
                        <div className="my-[-2px] flex shrink-0 items-center gap-px">
                          <a
                            href="https://docs.devin.ai/work-with-devin/dynamic-workflows"
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label="View workflow documentation"
                            className="inline-flex size-6 shrink-0 items-center justify-center rounded-[6px] bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground"
                          >
                            <BookOpen size={16} />
                          </a>
                          <span className="shrink-0 select-none text-[12px] text-muted-foreground">{time(it.ts)}</span>
                        </div>
                      </div>
                      <button
                        onClick={() => { setWfRunId(runId || null); openTab('agents') }}
                        className="flex w-full min-w-0 cursor-pointer flex-col gap-1 border-t border-border px-2.5 py-2 text-left"
                      >
                        <span className="truncate text-[13px] font-medium leading-[18px]">{it.workflow?.name || 'Workflow run'}</span>
                        {!!agentMap?.size && (
                          <span className="truncate text-[12px] leading-[16px] text-muted-foreground">{done}/{agentMap.size} agents</span>
                        )}
                      </button>
                    </div>
                  )
                })()
              ) : g.type === 'item' && g.item.raw_type === 'pr_created' && g.item.pr ? (
                <div key={g.item.id} data-eid={g.item.id} className="my-2 w-full min-w-0">
                  <PrCreatedCard
                    pr={mergeLivePr(g.item.pr, detail?.session.pull_requests)}
                    onAnalyze={!isVisitor && caps.canAnalyzePr && g.item.pr.prUrl ? () => openPr(g.item.pr!.prUrl!) : undefined}
                  />
                </div>
              ) : g.type === 'item' && STANDALONE_GIT_TYPES.has(g.item.raw_type || '') ? (
                <StandaloneGitRow key={g.item.id} item={g.item} timestamp={rowClock(g.item.ts)} />
              ) : g.type === 'row' ? (
                <div key={g.item.id} className="wg-time-host relative pb-2.5">
                  <EventRow item={g.item} sessionId={id} mt={mediaTok} live={gi === groups.length - 1 && status === 'working' && g.item.kind === 'shell' && !g.item.exitCode} tempOpen={g.item.id === tailThoughtId} selected={g.item.id === worklogJump && panel === 'worklog'} standalone onStepChanges={onStepChanges} onOpenProgress={onOpenProgress} onOpenSubagent={onOpenSubagent} />
                  <span className="wg-gutter-time pointer-events-none absolute right-0 top-0 hidden h-[18px] select-none items-center whitespace-nowrap bg-background pl-3 text-[12px] leading-[16px] text-muted-foreground md:flex proportional-nums">{rowClock(g.item.ts)}</span>
                </div>
              ) : g.type === 'item' && (g.item.kind === 'env_suggestion' || g.item.kind === 'bot_flag') ? (
                <EventRow key={g.item.id} item={g.item} sessionId={id} mt={mediaTok} envSupersededBy={envSuperseded.get(g.item.id)} onOpenSubagent={onOpenSubagent} />
              ) : g.type === 'item' && g.item.callout ? (
                <CalloutCard key={g.item.id} item={g.item} timestamp={rowClock(g.item.ts)} />
              ) : g.type === 'item' && g.item.kind === 'status' ? (
                <div key={g.item.id} data-eid={g.item.id} className="relative my-2 flex items-start gap-2 text-[13px] leading-[18px] text-muted-foreground">
                  <span className="min-w-0 flex-1 break-words">{g.item.title}</span>
                  <span className="shrink-0 text-[12px] leading-[16px]">{rowClock(g.item.ts)}</span>
                </div>
              ) : g.type === 'item' ? (() => {
                const parsed = splitAttachments(g.item.body || '', g.item.quoteMeta, g.item.quotes)
                const { text, quotes } = parsed
                const attachments = g.item.attachments?.length
                  ? g.item.attachments.map((a) => ({ url: a.url, name: a.name ?? a.url.split('/').pop() ?? 'file' }))
                  : parsed.attachments
                const isUser = g.item.role === 'user'
                const own = isOwnUserMessage(g.item)
                const showHeader = messageHeaders.get(g.item.id) === true
                const hasText = !isUser || !!text.trim() || !!g.item.answers?.length || !!(translations[g.item.id] || g.item.translation)
                // Official `ua`: repo pills only on the initial message; they join the file
                // attachments in one group stacked under the bubble.
                const repos = g.item.raw_type === 'initial_user_message' ? extractRepos(g.item.body || '', detail?.session.repos) : []
                return (
                <div key={g.item.id} data-eid={g.item.id} className={cn('group group/message-wrapper relative my-4 flex flex-col gap-1', own ? 'items-end' : 'items-start')}>
                  {!own && showHeader ? (
                    <ParticipantHeader kind={isUser ? 'user' : 'devin'} name={isUser ? (g.item.title || 'User') : undefined} ts={g.item.ts} />
                  ) : null}
                  {hasText && <div className={cn(
                    'text-[14px] leading-[20px]',
                    isUser
                      ? cn('w-fit max-w-full overflow-hidden rounded-[16px] bg-tint-tertiary px-3.5 py-2', own ? 'rounded-tr-[4px]' : 'rounded-tl-[4px] self-start')
                      : 'w-full',
                  )} title={!isUser ? clock(g.item.ts) : undefined}>
                    {(() => {
                      const inner = (
                        <>
                          {g.item.answers?.length && g.item.questions?.[0]?.question ? (
                            <div className="flex flex-col gap-1">
                              {g.item.questions.map((q, qi) => (
                                <div key={qi} className="flex flex-col gap-0.5">
                                  <p className="text-[13px] leading-[18px] text-muted-foreground">Q: {q.question}</p>
                                  <p>{g.item.answers?.[qi] || ''}</p>
                                </div>
                              ))}
                            </div>
                          ) : (translations[g.item.id] || g.item.translation) ? (
                            <div className="space-y-2">
                              <p className="text-[12px] leading-[16px] text-muted-foreground">Original:</p>
                              <Markdown text={text} rewriteUrl={(u) => attachmentUrl(id, u, mediaTok)} onFileRef={onFileRef} />
                              <p className="text-[12px] leading-[16px] text-muted-foreground">Translation:</p>
                              <Markdown text={translations[g.item.id] || g.item.translation || ''} rewriteUrl={(u) => attachmentUrl(id, u, mediaTok)} onFileRef={onFileRef} />
                            </div>
                          ) : (
                            <Markdown text={text} rewriteUrl={(u) => attachmentUrl(id, u, mediaTok)} onFileRef={onFileRef} />
                          )}
                          {!isUser && attachments.length > 0 && (
                            <div className={cn('flex flex-col gap-2', text.trim() ? 'mt-[18px]' : '')}>
                              {attachments.map((a) => (
                                <AttachmentCard key={a.url} name={a.name} href={attachmentUrl(id, a.url, mediaTok)} ts={g.item.ts} onOpenTab={openFileTab} />
                              ))}
                            </div>
                          )}
                        </>
                      )
                      return isUser ? <CollapsibleBody>{inner}</CollapsibleBody> : inner
                    })()}
                  </div>}
                  {isUser && (
                    <UserAttachments
                      attachments={attachments.map((a) => ({ name: a.name, href: attachmentUrl(id, a.url, mediaTok) }))}
                      repos={repos}
                      quotes={quotes.map((q) => (q.screenshot ? { ...q, screenshot: { ...q.screenshot, url: attachmentUrl(id, q.screenshot.url, mediaTok) } } : q))}
                      secrets={g.item.secretsSent?.names}
                      onQuoteNavigate={jumpToQuote}
                      own={own}
                      hasText={hasText}
                      ts={g.item.ts}
                      onOpenTab={openFileTab}
                    />
                  )}
                  <MessageToolbar
                    text={g.item.body || ''}
                    eid={g.item.id}
                    ts={g.item.ts}
                    tab={typeof panel === 'string' ? serializeOfficialTab(panel, urlPrs, urlFiles) || undefined : undefined}
                    onStartNewSession={g.item.role === 'user' && !isVisitor ? () => {
                      try { localStorage.setItem('wb2-new-session-draft', g.item.body || '') } catch { /* quota */ }
                      nav('/admin/new')
                    } : undefined}
                    onSideChat={isVisitor ? undefined : () => { setScAnchor({ id: g.item.id, ts: g.item.ts }); openTab('sidechat') }}
                    sessionId={g.item.role === 'user' || isVisitor ? undefined : id}
                    onTranslated={isVisitor ? undefined : (t) => setTranslations((p) => ({ ...p, [g.item.id]: t }))}
                  />
                </div>
                )
              })() : (
                <WorkGroup
                  // keyed by the newest member: history backfill prepends older items and may
                  // extend the group backwards, which must not remount it (would drop open state)
                  key={gi === groups.length - 1 ? 'w-tail' : `w${g.items[g.items.length - 1]?.id ?? gi}`}
                  items={g.items}
                  seconds={g.seconds}
                  sessionId={id}
                  mt={mediaTok}
                  defaultOpen
                  live={gi === groups.length - 1 && status === 'working'}
                  tailThoughtId={tailThoughtId}
                  selectedId={panel === 'worklog' ? worklogJump ?? undefined : undefined}
                  onStepChanges={onStepChanges}
                  onOpenProgress={onOpenProgress}
                />
              ),
            )}
            {statusState.enum === 'blocked' && actionRequired ? (
              <div className="mb-2 mt-5 flex flex-col gap-2 text-muted-foreground">
                <div className="flex items-start gap-[6px]">
                  <WakePersona tone="action" />
                  <span className="min-h-[17px] text-[13px] leading-[18px]">{actionRequired}</span>
                </div>
              </div>
            ) : ['initializing', 'resume_requested', 'resume_requested_frontend', 'suspend_requested', 'suspend_requested_frontend', 'paused', 'stopped', 'queued', 'waiting'].includes(statusState.enum) ? (
              <div className="mb-2 mt-5 flex items-start gap-[6px] text-muted-foreground">
                {statusState.persona === 'thinking' ? <ThinkingPersona /> : statusState.persona === 'sleep' ? <WakePersona /> : <span className="mt-1 size-2 shrink-0 rounded-full bg-orange-500" />}
                <span className="min-h-[17px] text-[13px] leading-[18px]">{statusState.tailText}</span>
              </div>
            ) : statusState.enum === 'blocked' ? (
              <div className="my-4 flex items-center gap-2 text-[13px] leading-[18px] text-muted-foreground">
                <AwaitingInstructionsGlyph className="size-4 shrink-0 text-orange-500" />
                {statusState.tailText}
              </div>
            ) : ['working', 'resumed', 'restored'].includes(statusState.enum) ? (
              // Official working-status row (DOM sampled 2026-08-31): 17px animated Devin
              // persona + 13px current-action line from latest_status_contents.message.
              <div className="mb-2 mt-5 flex flex-col gap-2 text-muted-foreground">
                <div className="flex items-start gap-[6px]">
                  <ThinkingPersona />
                  <span className="min-h-[17px] text-[13px] leading-[18px]">
                    {statusState.tailText}
                  </span>
                </div>
              </div>
            ) : statusState.isSleeping && (!woke || controlling) && !isVisitor && statusState.wakeable ? (
              <button
                type="button"
                aria-label="Wake Devin up"
                disabled={controlling}
                onClick={() => void control('resume')}
                className="group mt-5 mb-2 flex cursor-pointer items-start gap-[6px] text-left"
              >
                <WakePersona />
                <span className="grid min-h-[17px] overflow-hidden text-[13px] leading-[18px]">
                  <span className="col-start-1 row-start-1 duration-200 group-hover:-translate-y-full motion-safe:transition-transform">Devin went to sleep</span>
                  <span className="col-start-1 row-start-1 translate-y-full duration-200 group-hover:translate-y-0 motion-safe:transition-transform">{controlling ? 'Connecting…' : statusState.wakeText}</span>
                </span>
              </button>
            ) : statusState.isSleeping && !isVisitor && !statusState.wakeable ? (
              <div className="mb-2 mt-5 flex items-start gap-[6px] text-muted-foreground">
                <WakePersona />
                <div className="flex flex-col">
                  <span className="min-h-[17px] text-[13px] leading-[18px]">{statusState.shortMessage}</span>
                  {statusState.enum === 'crashed' && detail?.session.auto_recover ? (
                    <span className="text-[12px] leading-[16px] text-muted-foreground">
                      已自动发送「继续」尝试恢复 ({detail.session.auto_recover.attempts}/3)
                    </span>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div></div>
        </div>
        {/* Official session index: right-edge minimap of tick bars; popup (280px, opens left) lists user
            messages, item click scrolls the timeline while the popup stays open. */}
        {indexEntries.length > 0 && (
          <>
            {indexOpen && <div className="fixed inset-0 z-20" onClick={() => setIndexOpen(false)} />}
            <div data-quote-safe-area="true" className="pointer-events-none absolute bottom-2.5 right-0 top-2.5 z-30 flex w-7 flex-col justify-center md:w-[52px]">
              <button
                type="button"
                aria-label="Session index"
                aria-haspopup="dialog"
                aria-expanded={indexOpen}
                onClick={() => setIndexOpen(!indexOpen)}
                className="pointer-events-auto mr-1 cursor-pointer py-2 md:mr-2"
              >
                <div
                  className={cn(
                    'flex flex-col gap-2 pl-2 pr-1 duration-300 motion-safe:transition-opacity md:pl-4 md:pr-2',
                    indexOpen ? 'opacity-0' : 'opacity-100',
                  )}
                >
                  {idxTicks.map((t) => (
                    <div
                      key={t.id}
                      className={cn(
                        'h-[1.5px] w-full rounded-full',
                        t.id === idxActive
                          ? 'bg-foreground'
                          : t.kind === 'git'
                            ? 'bg-purple-500'
                            : 'bg-tint-secondary',
                      )}
                    />
                  ))}
                </div>
              </button>
              {indexOpen && (
                <div
                  role="dialog"
                  className="pointer-events-auto absolute right-8 top-1/2 z-40 w-[280px] -translate-y-1/2 overflow-hidden rounded-[10px] border border-border bg-card/95 p-0 shadow-lg backdrop-blur md:right-[52px]"
                >
                  <div className="max-h-[min(595px,calc(100vh-16px))] overflow-y-auto rounded-[10px]">
                    <div className="flex flex-col gap-0 p-1.5">
                      {indexEntries.map((it) => (
                        <button
                          key={it.id}
                          onMouseEnter={(e) => {
                            if (it.kind !== 'message' || !(it.body || '').trim() || !it.origin || it.origin === 'web') { setIdxTip(null); return }
                            const r = e.currentTarget.getBoundingClientRect()
                            setIdxTip({ id: it.id, top: r.top, right: r.left - 8 })
                          }}
                          onMouseLeave={() => setIdxTip(null)}
                          onClick={async () => {
                            // events folded into a collapsed work group have no rendered row; fall back to the nearest by timestamp
                            stickBottom.current = false
                            let node = scrollRef.current?.querySelector(`[data-eid="${CSS.escape(it.id)}"]`)
                            if (!node && cursor) {
                              // entry beyond the loaded window — backfill history first (official full-history index jump)
                              await loadUntil(it.id, it.ts)
                              await new Promise((res) => requestAnimationFrame(res))
                              node = scrollRef.current?.querySelector(`[data-eid="${CSS.escape(it.id)}"]`)
                              // backfilled toward the target but its row may be folded into a
                              // work group: land on the oldest loaded row rather than stale state
                              if (!node) node = scrollRef.current?.querySelector('[data-eid]')
                            }
                            if (!node) {
                              const target = new Date(it.ts).getTime()
                              const byDist = [...allItems].sort(
                                (a, b) => Math.abs(new Date(a.ts).getTime() - target) - Math.abs(new Date(b.ts).getTime() - target),
                              )
                              for (const cand of byDist) {
                                node = scrollRef.current?.querySelector(`[data-eid="${CSS.escape(cand.id)}"]`) ?? null
                                if (node) break
                              }
                            }
                            node?.scrollIntoView({ block: 'start' })
                          }}
                          className="flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] hover:bg-accent"
                        >
                          {it.kind === 'git' ? (
                            (() => {
                              const pr = mergeLivePr(it.pr || {}, detail?.session.pull_requests)
                              return (
                                <>
                                  <PrStateIcon state={pr.state} draft={pr.draft} size={16} />
                                  <span className="min-w-0 shrink-0 truncate">{pr.pullNumber !== undefined ? `#${pr.pullNumber}` : 'PR'}</span>
                                  {pr.additions !== undefined || pr.deletions !== undefined ? (
                                    <span className="flex shrink-0 gap-0.5">
                                      <span className="text-[rgb(0,165,88)]">+{pr.additions ?? 0}</span>
                                      <span className="text-[#f53b3a]">−{pr.deletions ?? 0}</span>
                                    </span>
                                  ) : null}
                                </>
                              )
                            })()
                          ) : (
                            <>
                              {/* Official: only non-web (API) user messages get the 16px circular glyph; web messages are plain pl-6 rows */}
                              {it.origin && it.origin !== 'web' ? (
                                <>
                                  <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted">
                                    <ApiOriginGlyph />
                                  </span>
                                  <span className="truncate">{indexPreview(it.body || '')}</span>
                                </>
                              ) : (
                                <span className="min-w-0 flex-1 truncate pl-6">{indexPreview(it.body || '')}</span>
                              )}
                            </>
                          )}
                        </button>
                      ))}
                      {queued.map((q) => (
                        <button
                          key={`q-${q.id}`}
                          onClick={() => {
                            const el = scrollRef.current
                            if (el) el.scrollTo({ top: el.scrollHeight })
                          }}
                          className="flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] hover:bg-accent"
                        >
                          <span className="min-w-0 flex-1 truncate pl-6">{(q.text || '').split('\n')[0].slice(0, 80)}</span>
                        </button>
                      ))}
                      <button
                        onClick={() => {
                          const el = scrollRef.current
                          if (el) el.scrollTo({ top: el.scrollHeight })
                        }}
                        className="flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] hover:bg-accent"
                      >
                        <span className="min-w-0 flex-1 truncate pl-6 text-muted-foreground">Scroll to bottom</span>
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {indexOpen && idxTip && (() => {
                const it = indexEntries.find((x) => x.id === idxTip.id)
                if (!it) return null
                return (
                  <div
                    role="dialog"
                    style={{ position: 'fixed', top: Math.max(8, Math.min(idxTip.top, window.innerHeight - 308)), left: idxTip.right - 280 }}
                    className="pointer-events-none z-50 max-h-[300px] w-[280px] overflow-hidden whitespace-pre-wrap rounded-[10px] border border-border bg-card p-2.5 text-left text-[13px] leading-[18px] shadow-lg"
                  >
                    {(it.body || '').slice(0, 1200)}
                  </div>
                )
              })()}
            </div>
          </>
        )}
        </div>

        <footer className={cn('relative max-md:z-20', effShowPanel && 'max-md:hidden', isDraft && 'mb-auto')}>
          {showJump && (
            <button
              aria-label="Scroll to bottom"
              onClick={() => {
                const el = scrollRef.current
                if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
              }}
              className="absolute -top-11 left-1/2 z-30 flex h-7 w-9 -translate-x-1/2 cursor-pointer items-center justify-center rounded-full bg-[rgba(31,31,31,0.94)] text-white/90 shadow-[0_1px_3px_0_rgba(0,0,0,0.25),0_1px_2px_0_rgba(0,0,0,0.06)] transition-colors hover:bg-[rgba(51,51,51,0.94)]"
            >
              <ChevronDown size={20} />
            </button>
          )}
          <BeardBand
            onBandHeight={setBandH}
            band={queued.length > 0 || (pending && pending.questions?.length && caps.canAnswerQuestion) ? (
              <>
          {queued.length > 0 && (
            // Official queue band (sampled 2026-09-01): summary row h-8 "N message(s) queued" + Clear all icon;
            // sortable rows min-h-9 rounded-xl, clock icon, hover icon actions Edit / Remove from queue / Send now.
            <BandItem>
              <div className="flex h-8 items-center justify-between gap-2 py-1 pl-3.5 pr-1">
                <span className="truncate text-[12px] text-muted-foreground">{queued.length} message{queued.length > 1 ? 's' : ''} queued</span>
                <button
                  onClick={() => { void queueOpReq({ op: 'clear' }).then((ok) => { if (ok) setQueued([]) }) }}
                  aria-label="Clear all"
                  title="Clear all"
                  className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X size={16} />
                </button>
              </div>
              <ol className="flex max-h-60 flex-col overflow-y-auto">
                {queued.map((q) => (
                  <li
                    key={q.id}
                    draggable
                    role="button"
                    aria-roledescription="sortable"
                    onDragStart={() => { dragQ.current = q.id }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => { if (dragQ.current && dragQ.current !== q.id) void queueReorder(dragQ.current, q.id); dragQ.current = null }}
                    className={`group flex min-h-9 cursor-grab items-center gap-2 rounded-xl py-1.5 pl-3 pr-1.5 text-[13px] leading-[18px] opacity-80 hover:bg-accent hover:opacity-100 active:cursor-grabbing ${editingQ === q.id ? 'opacity-50' : ''}`}
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground group-hover:hidden" dangerouslySetInnerHTML={{ __html: QUEUE_DASHED_SVG }} />
                    <span className="hidden size-6 shrink-0 items-center justify-center text-muted-foreground group-hover:flex" dangerouslySetInnerHTML={{ __html: QUEUE_DRAG_SVG }} />
                    <span className="min-w-0 flex-1 truncate">{q.text}</span>
                    <button
                      onClick={() => void queueEditStart(q.id, q.text)}
                      aria-label="Edit message"
                      title="Edit message"
                      className="hidden size-6 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-muted hover:text-foreground group-hover:flex"
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      onClick={() => void queueOp('remove', q.id)}
                      aria-label="Remove from queue"
                      title="Remove from queue"
                      className="hidden size-6 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-muted hover:text-foreground group-hover:flex"
                    >
                      <X size={16} />
                    </button>
                    <button
                      onClick={() => void queueOp('send_now', q.id)}
                      aria-label="Send now"
                      title="Send now"
                      className="hidden size-6 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-muted hover:text-foreground group-hover:flex"
                    >
                      <ArrowUp size={16} />
                    </button>
                  </li>
                ))}
              </ol>
            </BandItem>
          )}
          {pending && pending.questions?.length && caps.canAnswerQuestion ? (
            <BandItem>
              <QuestionPanel
                key={pending.id}
                questions={pending.questions}
                onSubmit={(answers) => void answerQuestion(answers)}
                onDismiss={() => setDismissedQ(pending.id)}
                disabled={sending}
              />
            </BandItem>
          ) : null}
              </>
            ) : undefined}
          >
            {(suggestions.length > 0 || (atCat && trigger?.char === '@')) && (
              <div role="listbox" className="absolute bottom-full left-0 z-30 mb-1 max-h-[400px] w-[300px] overflow-y-auto rounded-[10px] border border-border bg-card p-1 shadow-lg">
                {atCat && trigger?.char === '@' && (
                  <div className="flex items-baseline justify-between gap-2 px-2 py-1">
                    <span className="text-[12px] font-medium text-muted-foreground">
                      {AT_CATEGORIES.find((c) => c.cat === atCat)?.title || ''}
                    </span>
                    <span className="truncate text-[11px] text-muted-foreground/70">
                      {AT_CATEGORIES.find((c) => c.cat === atCat)?.sub || ''}
                    </span>
                  </div>
                )}
                {suggestions.map((s, i) => (
                  <div
                    key={s.key}
                    role="option"
                    aria-selected={i === sugIdx}
                    onMouseDown={(e) => { e.preventDefault(); applySuggestion(s) }}
                    onMouseEnter={() => setSugIdx(i)}
                    className={cn('flex cursor-pointer select-none flex-col gap-0.5 rounded-[6px] px-2 py-1.5 text-[13px]', i === sugIdx && 'bg-accent')}
                  >
                    <span className="truncate">{s.title}</span>
                    {s.sub && <span className="truncate text-[12px] text-muted-foreground">{s.sub}</span>}
                  </div>
                ))}
              </div>
            )}
            {findings.length > 0 && suggestions.length === 0 && !(atCat && trigger?.char === '@') && (
              <div className="pointer-events-none absolute left-0 right-0 z-10 flex flex-col items-center gap-2 px-2" style={{ bottom: 'calc(100% + 8px)' }}>
                <div className="pointer-events-auto flex max-w-full items-center gap-1.5 rounded-full bg-foreground px-3 py-1.5 text-background shadow-lg">
                  <span className="flex min-w-0 items-center gap-1">
                    <span className="truncate text-[12px] leading-4">
                      {findings[0].finding_type === 'parallelizable_prompt'
                        ? 'This draft looks like several independent tasks'
                        : findings[0].finding_type === 'overkill_devin_mode'
                          ? `${mode} may be more than this task needs`
                          : findings[0].finding_type === 'no_plan_before_impl'
                            ? 'Consider asking Devin for a plan before implementing'
                            : findings[0].finding_type === 'non_work_usage'
                              ? 'Your prompt seems irrelevant to work use-cases'
                              : findings[0].finding_type === 'unrelated_followup_new_session'
                                ? 'This task looks unrelated to the current session'
                                : findings[0].finding_type === 'use_code_scan'
                                  ? 'This looks codebase-wide — a Code Scan may fit better'
                                  : findings[0].explanation}
                    </span>
                    <button type="button" aria-label="Show finding details" title={findings[0].explanation} className="flex shrink-0 cursor-default items-center opacity-70">
                      <Info size={14} />
                    </button>
                  </span>
                  {findings[0].finding_type === 'overkill_devin_mode' ? (
                    <button
                      type="button"
                      onClick={() => { setSelectedVersion('devin-2-5'); setFindings([]) }}
                      className="shrink-0 cursor-pointer text-[12px] leading-4 text-blue-400 hover:underline"
                    >
                      Switch mode
                    </button>
                  ) : findings[0].finding_type === 'parallelizable_prompt' ? (
                    /* Official click (sampled via route capture): appends this sentence to the draft — no network write. */
                    <button
                      type="button"
                      onClick={() => {
                        setInput((v) => `${v.trimEnd()}\nThese tasks are independent: split them into separate child sessions and run them in parallel.`)
                        setFindings([])
                      }}
                      className="shrink-0 cursor-pointer text-[12px] leading-4 text-blue-400 hover:underline"
                    >
                      Split into child sessions
                    </button>
                  ) : findings[0].finding_type === 'no_plan_before_impl' ? (
                    <button
                      type="button"
                      onClick={() => {
                        setInput((v) => `${v.trimEnd()}\nBefore implementing anything, investigate and propose a plan for me to review first.`)
                        setFindings([])
                      }}
                      className="shrink-0 cursor-pointer text-[12px] leading-4 text-blue-400 hover:underline"
                    >
                      Create plan
                    </button>
                  ) : findings[0].finding_type === 'non_work_usage' ? (
                    <button
                      type="button"
                      onClick={() => { setInput(''); setFindings([]) }}
                      className="shrink-0 cursor-pointer text-[12px] leading-4 text-blue-400 hover:underline"
                    >
                      Clear prompt
                    </button>
                  ) : findings[0].finding_type === 'unrelated_followup_new_session' ? (
                    /* Official (route-captured): plain <a> navigation to the org new-session page carrying
                       the draft — no session-creation write. Mirror navigates to the console new-session
                       dialog with the draft prefilled. */
                    <Link
                      to="/admin/new"
                      onClick={() => { try { localStorage.setItem('wb2-new-session-draft', input) } catch { /* quota */ } setFindings([]) }}
                      className="shrink-0 text-[12px] leading-4 text-blue-400 hover:underline"
                    >
                      Start new session
                    </Link>
                  ) : findings[0].finding_type === 'use_code_scan' ? (
                    /* Official (route-captured): POST /api/sessions with user_message
                       "Start a code scan to: <draft>" and additional_args.code_scan_builder, then
                       navigates to the new session. Mirror routes the same prompt through the
                       console child-session derivation flow instead of creating a top-level session. */
                    <button
                      type="button"
                      disabled={scanState === 'busy' || scanState === 'sent'}
                      onClick={() => {
                        setScanState('busy')
                        adminFetch<{ ok: boolean; note: string }>('/api/admin/sessions/new', {
                          method: 'POST',
                          body: JSON.stringify({ task: `Start a code scan to: ${input.trim()}` }),
                        })
                          .then(() => { setScanState('sent'); setInput(''); window.setTimeout(() => { setFindings([]); setScanState('idle') }, 1500) })
                          .catch(() => setScanState('error'))
                      }}
                      className={cn('shrink-0 text-[12px] leading-4 text-blue-400', scanState === 'busy' || scanState === 'sent' ? 'cursor-default opacity-60' : 'cursor-pointer hover:underline')}
                    >
                      {scanState === 'busy' ? 'Starting…' : scanState === 'sent' ? 'Scan requested' : scanState === 'error' ? 'Retry Code Scan' : 'Start a Code Scan'}
                    </button>
                  ) : null}
                </div>
              </div>
            )}
            {confirmSendOpen && (
              /* Official (bundle-sampled): warning_and_modal precheck mode opens a confirm
                 dialog before send — title/labels from the official locale, description =
                 first finding's recommendation. Back cancels; Send confirms once per draft. */
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setConfirmSendOpen(false)}>
                <div role="dialog" className="w-full max-w-sm rounded-xl border border-border bg-background p-4 shadow-lg" onClick={(e) => e.stopPropagation()}>
                  <p className="text-[14px] font-medium leading-[20px]">Confirm to send message</p>
                  <p className="mt-2 text-[13px] leading-[18px] text-muted-foreground">
                    {findings[0] ? COACH_RECOMMENDATIONS[findings[0].finding_type] || findings[0].explanation || '' : ''}
                  </p>
                  <div className="mt-4 flex items-center justify-end gap-2">
                    <button
                      className="cursor-pointer rounded-md px-3 py-1.5 text-[13px] text-muted-foreground hover:bg-muted"
                      onClick={() => setConfirmSendOpen(false)}
                    >
                      Back
                    </button>
                    {findings[0] && COACH_ACTIONS[findings[0].finding_type] && (
                      /* Official tertiaryAction: the finding's action button. applyAndSend
                         applies the action then sends; cancelAndApply closes and applies. */
                      <button
                        className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-[13px] hover:bg-muted"
                        onClick={() => {
                          const ft = findings[0].finding_type
                          setConfirmSendOpen(false)
                          if (ft === 'no_plan_before_impl' || ft === 'parallelizable_prompt') {
                            const sentence = ft === 'no_plan_before_impl'
                              ? 'Before implementing anything, investigate and propose a plan for me to review first.'
                              : 'These tasks are independent: split them into separate child sessions and run them in parallel.'
                            const next = `${input.trimEnd()}\n${sentence}`
                            confirmedDraftRef.current = next.trim()
                            autoSendRef.current = next
                            setFindings([])
                            setInput(next)
                          } else if (ft === 'overkill_devin_mode') {
                            setSelectedVersion('devin-2-5')
                            confirmedDraftRef.current = input.trim()
                            autoSendRef.current = input
                            setFindings([])
                            setAutoSendTick((t) => t + 1)
                          } else if (ft === 'non_work_usage') {
                            setInput('')
                            setFindings([])
                          } else if (ft === 'unrelated_followup_new_session') {
                            try { localStorage.setItem('wb2-new-session-draft', input) } catch { /* quota */ }
                            setFindings([])
                            nav('/admin/new')
                          } else if (ft === 'use_code_scan') {
                            setScanState('busy')
                            adminFetch<{ ok: boolean; note: string }>('/api/admin/sessions/new', {
                              method: 'POST',
                              body: JSON.stringify({ task: `Start a code scan to: ${input.trim()}` }),
                            })
                              .then(() => { setScanState('sent'); setInput(''); window.setTimeout(() => { setFindings([]); setScanState('idle') }, 1500) })
                              .catch(() => setScanState('error'))
                          }
                        }}
                      >
                        {COACH_ACTIONS[findings[0].finding_type]}
                      </button>
                    )}
                    <button
                      className="cursor-pointer rounded-md bg-primary px-3 py-1.5 text-[13px] text-primary-foreground hover:opacity-90"
                      onClick={() => {
                        confirmedDraftRef.current = input.trim()
                        setConfirmSendOpen(false)
                        void send()
                      }}
                    >
                      Send
                    </button>
                  </div>
                </div>
              </div>
            )}
            {staged.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-1 pt-1">
                {staged.map((f) => (
                  isStagedImage(f) ? (
                    <div key={f.url} className="group/attachment relative size-9 shrink-0">
                      <img
                        src={f.preview || attachmentUrl(id, f.url, mediaTok)}
                        alt={f.name}
                        className="size-9 rounded-[6px] object-cover"
                      />
                      <button
                        aria-label="Remove attachment"
                        onClick={() => removeStaged(f.url)}
                        className="absolute right-[-5px] top-[-5px] flex size-[18px] items-center justify-center rounded-full bg-foreground text-background opacity-0 focus-visible:opacity-100 group-hover/attachment:opacity-100 [@media(pointer:coarse)]:opacity-100"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ) : (
                    <div key={f.url} className="flex items-center gap-2 rounded-lg border border-border bg-background px-2 py-1.5">
                      <FileText size={16} className="shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <div className="max-w-[180px] truncate text-[12px] leading-[16px]">{f.name}</div>
                        <div className="text-[11px] leading-[14px] text-muted-foreground">{f.size < 1024 ? `${f.size} B` : `${(f.size / 1024).toFixed(1)} KB`}</div>
                      </div>
                      <button aria-label="Remove attachment" onClick={() => removeStaged(f.url)} className="cursor-pointer text-muted-foreground hover:text-foreground">
                        <X size={13} />
                      </button>
                    </div>
                  )
                ))}
              </div>
            )}
            {caps.canSendMessage ? (<>
            <ComposerEditor
              ref={editorRef}
              className="bg-transparent"
              disabled={statusState.inputDisabled || sending}
              placeholder={pending ? 'Respond directly to Devin\u2019s question or ask something else' : statusState.placeholder}
              placeholderNode={!pending && statusState.enum === 'working' && !isVisitor ? QUEUE_PLACEHOLDER : undefined}
              value={input}
              onChange={setInput}
              onFiles={(files) => { for (const f of files) void upload(f) }}
              onKeyDown={(e) => {
                if (suggestions.length > 0 && !e.nativeEvent.isComposing) {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setSugIdx((i) => (i + 1) % suggestions.length); return }
                  if (e.key === 'ArrowUp') { e.preventDefault(); setSugIdx((i) => (i - 1 + suggestions.length) % suggestions.length); return }
                  if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applySuggestion(suggestions[sugIdx]); return }
                  if (e.key === 'Escape') { e.preventDefault(); setAtCat(null); setInput((v) => v.replace(/[/!@$][\w\u4e00-\u9fff-]*$/, '')); return }
                }
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && editingQ && input.trim()) {
                  e.preventDefault()
                  const text = input.trim()
                  setInput('')
                  void queueEditSubmit(editingQ, text)
                  return
                }
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing && statusState.enum === 'working' && input.trim()) {
                  e.preventDefault()
                  const text = input.trim()
                  setInput('')
                  void queueSend(text)
                  return
                }
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  const mod = e.ctrlKey || e.metaKey
                  // sendWith 'ctrlenter': Enter inserts a newline, Ctrl+Enter sends.
                  if (sendWith === 'ctrlenter' ? mod : !mod) { e.preventDefault(); void send() }
                }
              }}
            />
            {/* Official toolbar row (sampled live 2026-09-01): min-h-7, 28px round icon buttons with 18px
                glyphs, mode pill h-7 rounded-full 1px border px-1.5 13/18, right cluster gap-1 with mic +
                a rounded-full foreground send group (opacity .5 when disabled) whose ⌄ split segment only
                expands once there is text. */}
            <div className="relative flex min-h-7 items-center justify-between gap-2">
              <div className={cn('flex min-w-0 flex-1 items-center gap-px', voiceRecording && 'invisible')}>
              {!isVisitor && <div className="relative">
                <button
                  ref={attachBtnRef}
                  onClick={() => setAttachOpen((v) => !v)}
                  disabled={uploading}
                  aria-label="Attach or mention"
                  title="Attach or mention"
                  className="flex size-7 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                >
                  {uploading ? <Loader2 size={18} className="animate-spin" /> : <Plus size={18} />}
                </button>
                {attachOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setAttachOpen(false)} />
                    <div
                      role="menu"
                      tabIndex={-1}
                      ref={(el) => { attachMenuRef.current = el; el?.focus() }}
                      onKeyDown={attachMenuKeyDown}
                      className="absolute bottom-8 left-0 z-20 flex max-h-[min(var(--available-height),400px)] w-[220px] flex-col overflow-hidden rounded-[10px] bg-[rgba(255,255,255,0.94)] shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)] outline outline-1 outline-black/[0.06] backdrop-blur-[8px] focus:outline-none dark:bg-[#1f1f1f]/[0.94] dark:outline-white/[0.06] [transition:transform_40ms_cubic-bezier(0.76,0,0.24,1),scale_40ms_cubic-bezier(0.76,0,0.24,1),opacity_40ms_cubic-bezier(0.76,0,0.24,1)]"
                    >
                      <div className="min-h-0 flex-1 overflow-hidden p-1">
                        {/* Official Attach or mention menu (sampled live 2026-08-31): Upload attachment + 8 mention categories. */}
                        {!isDraft && <><button
                          role="menuitem"
                          onClick={() => { setAttachOpen(false); anyRef.current?.click() }}
                          className="flex w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] outline-none hover:bg-tint-secondary [&>svg]:size-4 [&>svg]:shrink-0"
                        >
                          <OfficialGlyph svg={ATTACH_MENU_ICONS['Upload attachment']} className="text-muted-foreground" />
                          Upload attachment
                        </button>
                        <div role="separator" className="mx-2 h-[9px] bg-border bg-clip-content py-1" /></>}
                        {([
                          // Local attach menu — every entry must resolve against
                          // local data (composer-meta: workspaces/skills/sessions
                          // are real; playbooks/secrets/macros/plugins are always
                          // empty locally and are deliberately NOT listed).
                          ['Workspaces', 'repos', 'Repositories'],
                          ['Files', 'files', 'Files'],
                          ['Skills', 'skills', 'Skills'],
                          ['Sessions', 'sessions', 'Devin sessions'],
                        ] as [string, string, string][]).map(([label, cat, iconKey]) => (
                          <button
                            key={label}
                            role="menuitem"
                            onClick={() => { setAttachOpen(false); openMention(cat) }}
                            className="flex w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] outline-none hover:bg-tint-secondary [&>svg]:size-4 [&>svg]:shrink-0"
                          >
                            <OfficialGlyph svg={ATTACH_MENU_ICONS[iconKey]} className="text-muted-foreground" />
                            {label}
                          </button>
                        ))}
                        {/* On mobile the mode/model pills are hidden for width —
                            their menus open from here instead. */}
                        <div role="separator" className="mx-2 h-[9px] bg-border bg-clip-content py-1 md:hidden" />
                        {localModeGroup && (localModeGroup.options?.length ?? 0) > 0 && (
                          <button
                            role="menuitem"
                            onClick={() => { setAttachOpen(false); setSModeOpen(true) }}
                            className="flex w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] outline-none hover:bg-tint-secondary md:hidden [&>svg]:size-4 [&>svg]:shrink-0"
                          >
                            <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                              {LOCAL_MODE_ICONS[String(localModeOpt?._meta?.['cognition.ai/icon'] ?? '')] ?? <Settings2 size={16} />}
                            </span>
                            Session mode
                            <span className="ml-auto truncate text-[11px] text-muted-foreground">{localModeOpt?.name ?? localModeCurrent}</span>
                          </button>
                        )}
                        <button
                          role="menuitem"
                          onClick={() => { setAttachOpen(false); setModeOpen(true) }}
                          className="flex w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] outline-none hover:bg-tint-secondary md:hidden [&>svg]:size-4 [&>svg]:shrink-0"
                        >
                          <Settings2 size={16} className="text-muted-foreground" />
                          Model
                          <span className="ml-auto truncate text-[11px] text-muted-foreground">{modelPillLabel ?? (cfgReady ? (VERSION_LABEL[pillVersion] ?? pillVersion) : '…')}</span>
                        </button>
                      </div>
                    </div>
                  </>
                )}
                <input
                  ref={anyRef}
                  type="file"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = '' }}
                />
                <input
                  ref={imgRef}
                  type="file"
                  accept=".png,.jpg,.jpeg,.gif,.webp"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = '' }}
                />
              </div>}
              {isVisitor && caps.canUpload && (
                <div className="relative">
                  <button
                    onClick={() => anyRef.current?.click()}
                    disabled={uploading}
                    aria-label="Upload attachment"
                    title="Upload attachment"
                    className="flex size-7 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                  >
                    {uploading ? <Loader2 size={18} className="animate-spin" /> : <Plus size={18} />}
                  </button>
                  <input
                    ref={anyRef}
                    type="file"
                    className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = '' }}
                  />
                </div>
              )}
              {!isVisitor && localModeGroup && (localModeGroup.options?.length ?? 0) > 0 && (
                <div className="relative">
                  <button
                    onClick={() => { setSModeOpen((v) => !v); setModeOpen(false) }}
                    aria-label="Session mode"
                    title="Session mode"
                    className={cn('hidden h-7 max-w-full cursor-pointer items-center gap-1 overflow-hidden whitespace-nowrap rounded-full px-1.5 text-[13px] leading-[18px] md:flex', sModeOpen ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground')}
                  >
                    <span className="flex size-4 shrink-0 items-center justify-center">
                      {LOCAL_MODE_ICONS[String(localModeOpt?._meta?.['cognition.ai/icon'] ?? '')] ?? <Settings2 size={16} />}
                    </span>
                    <span className="min-w-0 truncate">{localModeOpt?.name ?? localModeCurrent ?? 'Mode'}</span>
                  </button>
                  {sModeOpen && <div className="fixed inset-0 z-10" onClick={() => setSModeOpen(false)} />}
                  {sModeOpen && (
                    <div role="menu" className="absolute bottom-8 left-0 z-20 flex w-[260px] flex-col overflow-hidden rounded-[10px] bg-[rgba(255,255,255,0.94)] shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)] outline outline-1 outline-black/[0.06] backdrop-blur-[8px] dark:bg-[#1f1f1f]/[0.94] dark:outline-white/[0.06]">
                      <div className="min-h-0 flex-1 overflow-y-auto p-1">
                        <div className="px-2 py-[5px] text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{localModeGroup.name ?? 'Session Mode'}</div>
                        {localModeGroup.options!.map((opt) => {
                          const cur = localModeCurrent === opt.value
                          return (
                            <button
                              key={opt.value}
                              role="menuitemradio"
                              aria-checked={cur}
                              onClick={() => chooseLocalOption(String(localModeGroup.id), opt.value)}
                              className="flex w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-[6px] text-[13px] outline-none hover:bg-tint-secondary"
                            >
                              <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                                {LOCAL_MODE_ICONS[String(opt._meta?.['cognition.ai/icon'] ?? '')] ?? <Circle size={14} />}
                              </span>
                              <span className="flex min-w-0 flex-1 flex-col text-left">
                                <span className="flex items-center gap-2">
                                  <span className="truncate">{opt.name || opt.value}</span>
                                  {cur && <OfficialGlyph svg={MODE_CHECK_ICON} className="ml-auto shrink-0 text-muted-foreground" />}
                                </span>
                                {opt.description && <span className="truncate text-[11px] text-muted-foreground">{opt.description}</span>}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
              {!isVisitor && <div className="relative">
                <button
                  onClick={() => { setModeOpen((v) => !v); setSModeOpen(false) }}
                  aria-label="Select mode"
                  className={cn('hidden h-7 max-w-full cursor-pointer items-center gap-[3px] overflow-hidden whitespace-nowrap rounded-full px-1.5 text-[13px] leading-[18px] md:flex', modeOpen ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground')}
                >
                  <span className="min-w-0 truncate">{modelPillLabel ?? (cfgReady ? (VERSION_LABEL[pillVersion] ?? pillVersion) : '…')}</span>
                </button>
                {modeOpen && <div className="fixed inset-0 z-10" onClick={() => setModeOpen(false)} />}
                {modeOpen && (
                  <div role="menu" className={cn('absolute bottom-8 left-0 z-20 flex w-[220px] flex-col overflow-hidden rounded-[10px] bg-[rgba(255,255,255,0.94)] shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)] outline outline-1 outline-black/[0.06] backdrop-blur-[8px] dark:bg-[#1f1f1f]/[0.94] dark:outline-white/[0.06] [transition:transform_40ms_cubic-bezier(0.76,0,0.24,1),scale_40ms_cubic-bezier(0.76,0,0.24,1),opacity_40ms_cubic-bezier(0.76,0,0.24,1)]', localCfg?.model ? 'max-h-[70vh]' : cfgReady ? 'h-[193px]' : '')}>
                    <div className={cn('min-h-0 flex-1 p-1', localCfg?.model ? 'overflow-y-auto' : 'overflow-hidden')}>
                    {localCfg?.model ? (
                      /* Desktop capability picker: model families in the left
                         column; effort-capable rows open a "Reasoning Effort" +
                         "Speed" flyout (ACP thought_level/speed groups), Fusion
                         combos collapse into one row like the capability card. */
                      <>
                        {familyRows.map((row) => {
                          const famOpts = [row.base, ...row.siblings]
                          const isCur = famOpts.some((m) => localCfg.model!.current === m.value)
                          const supportsImg = famOpts.some((m) => m._meta?.['cognition.ai/supportsImages'] === true)
                          const subKey = `model:${row.key}`
                          // Per-family data from the catalog: effort levels are
                          // the family set ∩ agent thought_level; Speed shows
                          // only when the family really has Fast Mode — e.g.
                          // gemini/glm/deepseek/grok/nemotron do NOT.
                          const famEfforts = new Set(famOpts.flatMap((m) => m.efforts ?? []))
                          // effortCtl=false on a catalog-known family means the
                          // family really has no effort control (kimi-k2-*) —
                          // hide the section instead of offering global levels.
                          const famEffortCtl = !row.known || famOpts.some((m) => m.effortCtl)
                          const effortOpts = famEffortCtl
                            ? (effortGroup?.options ?? []).filter((o) => !famEfforts.size || famEfforts.has(o.value))
                            : []
                          const showSpeed = (speedGroup?.options?.length ?? 0) > 0 && (!row.known || famOpts.some((m) => m.fast))
                          // `-fast` sibling variants duplicate what the Speed
                          // section already offers — don't list them twice.
                          const sibOpts = showSpeed ? row.siblings.filter((v) => !/-fast$/.test(v.value)) : row.siblings
                          const hasSub = (effortOpts.length > 0 || showSpeed || sibOpts.length > 0)
                            && (row.known || EFFORT_SUFFIX_RE.test(row.base.value))
                          return (
                            <div
                              key={row.key}
                              onMouseEnter={(e) => { if (hasSub) openModeSub(subKey, e.currentTarget); else setModeSub(null) }}
                              onMouseLeave={closeModeSub}
                            >
                              <button
                                role={hasSub ? 'menuitem' : 'menuitemradio'}
                                aria-checked={hasSub ? undefined : isCur}
                                aria-haspopup={hasSub ? 'menu' : undefined}
                                onClick={(e) => { if (hasSub) openModeSub(subKey, e.currentTarget.parentElement ?? e.currentTarget); else chooseLocalOption(localCfg.model!.id, row.base.value) }}
                                className="flex h-[30px] w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-[5px] text-[13px] outline-none hover:bg-tint-secondary"
                              >
                                <span className="flex h-4 w-[18px] shrink-0 items-center justify-center text-muted-foreground">
                                  {isCur && <OfficialGlyph svg={MODE_CHECK_ICON} />}
                                </span>
                                <span className="min-w-0 flex-1 truncate text-left">{row.label}</span>
                                {supportsImg && <ImageIcon size={13} className="shrink-0 text-muted-foreground" />}
                                {hasSub && <OfficialGlyph svg={MENU_CHEVRON_ICON} className="ml-auto shrink-0 text-muted-foreground" />}
                              </button>
                              {modeSub === subKey && modeSubPos && createPortal(
                                <div
                                  role="menu"
                                  onMouseEnter={() => { if (modeSubTimer.current) { clearTimeout(modeSubTimer.current); modeSubTimer.current = null } }}
                                  onMouseLeave={closeModeSub}
                                  style={{ left: modeSubPos.left, top: modeSubPos.top, maxHeight: Math.max(160, window.innerHeight - modeSubPos.top - 8) }}
                                  className="fixed z-50 w-[220px] overflow-y-auto rounded-[10px] bg-[rgba(255,255,255,0.94)] p-1 shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)] outline outline-1 outline-black/[0.06] backdrop-blur-[8px] dark:bg-[#1f1f1f]/[0.94] dark:outline-white/[0.06]"
                                >
                                  {effortOpts.length > 0 && (
                                    <>
                                      <div className="px-2 py-[5px] text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Reasoning Effort</div>
                                      {effortOpts.map((lvl) => (
                                        <button
                                          key={lvl.value}
                                          role="menuitemradio"
                                          aria-checked={effortGroup!.currentValue === lvl.value}
                                          onClick={() => chooseLocalOptions([
                                            { configId: localCfg.model!.id, value: row.base.value },
                                            { configId: String(effortGroup!.id), value: lvl.value },
                                          ])}
                                          className="flex h-[30px] w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-[5px] text-[13px] outline-none hover:bg-tint-secondary [&>svg]:size-4 [&>svg]:shrink-0"
                                        >
                                          <span className="flex h-4 w-[18px] shrink-0 items-center justify-center text-muted-foreground">
                                            {effortGroup!.currentValue === lvl.value && <OfficialGlyph svg={MODE_CHECK_ICON} />}
                                          </span>
                                          <span className="min-w-0 flex-1 truncate text-left">{lvl.name || lvl.value}</span>
                                        </button>
                                      ))}
                                    </>
                                  )}
                                  {sibOpts.length > 0 && (
                                    <>
                                      {effortOpts.length > 0 && <div role="separator" className="mx-2 my-1 h-px bg-border" />}
                                      <div className="px-2 py-[5px] text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Variants</div>
                                      {[row.base, ...sibOpts].map((v) => (
                                        <button
                                          key={v.value}
                                          role="menuitemradio"
                                          aria-checked={localCfg.model!.current === v.value}
                                          onClick={() => chooseLocalOption(localCfg.model!.id, v.value)}
                                          className="flex h-[30px] w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-[5px] text-[13px] outline-none hover:bg-tint-secondary [&>svg]:size-4 [&>svg]:shrink-0"
                                        >
                                          <span className="flex h-4 w-[18px] shrink-0 items-center justify-center text-muted-foreground">
                                            {localCfg.model!.current === v.value && <OfficialGlyph svg={MODE_CHECK_ICON} />}
                                          </span>
                                          <span className="min-w-0 flex-1 truncate text-left">{v === row.base ? 'Standard' : (v.name ?? v.value).replace(row.label, '').replace(/\b(none|min|minimal|low|medium|high|xhigh|max)\b/gi, '').trim() || v.name || v.value}</span>
                                        </button>
                                      ))}
                                    </>
                                  )}
                                  {showSpeed && (
                                    <>
                                      {(effortOpts.length > 0 || sibOpts.length > 0) && <div role="separator" className="mx-2 my-1 h-px bg-border" />}
                                      <div className="px-2 py-[5px] text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Speed</div>
                                      {speedGroup!.options!.map((sp) => (
                                        <button
                                          key={sp.value}
                                          role="menuitemradio"
                                          aria-checked={speedGroup!.currentValue === sp.value}
                                          onClick={() => chooseLocalOptions([
                                            { configId: localCfg.model!.id, value: row.base.value },
                                            { configId: String(speedGroup!.id), value: sp.value },
                                          ])}
                                          className="flex h-[30px] w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-[5px] text-[13px] outline-none hover:bg-tint-secondary [&>svg]:size-4 [&>svg]:shrink-0"
                                        >
                                          <span className="flex h-4 w-[18px] shrink-0 items-center justify-center text-muted-foreground">
                                            {speedGroup!.currentValue === sp.value && <OfficialGlyph svg={MODE_CHECK_ICON} />}
                                          </span>
                                          <span className="min-w-0 flex-1 truncate text-left">{sp.name || sp.value}</span>
                                        </button>
                                      ))}
                                    </>
                                  )}
                                </div>,
                                document.body,
                              )}
                            </div>
                          )
                        })}
                        {fusionModels.length > 0 && (
                          <div
                            onMouseEnter={(e) => openModeSub('fusion', e.currentTarget)}
                            onMouseLeave={closeModeSub}
                          >
                            <div role="separator" className="mx-2 my-1 h-px bg-border" />
                            <button
                              role="menuitem"
                              aria-haspopup="menu"
                              onClick={(e) => openModeSub('fusion', e.currentTarget.parentElement ?? e.currentTarget)}
                              className="flex h-[30px] w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-[5px] text-[13px] outline-none hover:bg-tint-secondary"
                            >
                              <span className="flex h-4 w-[18px] shrink-0 items-center justify-center text-muted-foreground">
                                {localCfg.model!.current.startsWith('fusion-') && <OfficialGlyph svg={MODE_CHECK_ICON} />}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-left">Fusion</span>
                              <OfficialGlyph svg={MENU_CHEVRON_ICON} className="ml-auto shrink-0 text-muted-foreground" />
                            </button>
                            {modeSub === 'fusion' && modeSubPos && createPortal(
                              <div
                                role="menu"
                                onMouseEnter={() => { if (modeSubTimer.current) { clearTimeout(modeSubTimer.current); modeSubTimer.current = null } }}
                                onMouseLeave={closeModeSub}
                                style={{ left: modeSubPos.left, top: modeSubPos.top, maxHeight: Math.max(160, window.innerHeight - modeSubPos.top - 8) }}
                                className="fixed z-50 w-[300px] overflow-y-auto rounded-[10px] bg-[rgba(255,255,255,0.94)] p-1 shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)] outline outline-1 outline-black/[0.06] backdrop-blur-[8px] dark:bg-[#1f1f1f]/[0.94] dark:outline-white/[0.06]"
                              >
                                <div className="px-2 py-[5px] text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Fusion</div>
                                {fusionModels.map((opt) => (
                                  <button
                                    key={opt.value}
                                    role="menuitemradio"
                                    aria-checked={localCfg.model!.current === opt.value}
                                    onClick={() => chooseLocalOption(localCfg.model!.id, opt.value)}
                                    className="flex h-[30px] w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-[5px] text-[13px] outline-none hover:bg-tint-secondary [&>svg]:size-4 [&>svg]:shrink-0"
                                  >
                                    <span className="flex h-4 w-[18px] shrink-0 items-center justify-center text-muted-foreground">
                                      {localCfg.model!.current === opt.value && <OfficialGlyph svg={MODE_CHECK_ICON} />}
                                    </span>
                                    <span className="min-w-0 flex-1 truncate text-left">{(opt.name || opt.value).replace(/^Fusion\s*\((.*)\)$/, '$1')}</span>
                                  </button>
                                ))}
                              </div>,
                              document.body,
                            )}
                          </div>
                        )}
                        {extraGroups.map((o) => {
                          const gid = String(o.id ?? '')
                          const current = String(o.currentValue ?? '')
                          const currentName = o.options!.find((x) => x.value === current)?.name ?? current
                          return (
                            <div
                              key={gid}
                              onMouseEnter={(e) => openModeSub(`grp:${gid}`, e.currentTarget)}
                              onMouseLeave={closeModeSub}
                            >
                              <div role="separator" className="mx-2 my-1 h-px bg-border" />
                              <button
                                role="menuitem"
                                aria-haspopup="menu"
                                onClick={(e) => openModeSub(`grp:${gid}`, e.currentTarget.parentElement ?? e.currentTarget)}
                                className="flex h-[30px] w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-[5px] text-[13px] outline-none hover:bg-tint-secondary"
                              >
                                <span className="flex h-4 w-[18px] shrink-0 items-center justify-center" />
                                <span className="flex min-w-0 flex-1 items-baseline gap-2 text-left">
                                  <span className="shrink-0">{o.name ?? gid}</span>
                                  <span className="min-w-0 truncate text-[12px] text-muted-foreground">{currentName || '—'}</span>
                                </span>
                                <OfficialGlyph svg={MENU_CHEVRON_ICON} className="ml-auto shrink-0 text-muted-foreground" />
                              </button>
                              {modeSub === `grp:${gid}` && modeSubPos && createPortal(
                                <div
                                  role="menu"
                                  onMouseEnter={() => { if (modeSubTimer.current) { clearTimeout(modeSubTimer.current); modeSubTimer.current = null } }}
                                  onMouseLeave={closeModeSub}
                                  style={{ left: modeSubPos.left, top: modeSubPos.top, maxHeight: Math.max(160, window.innerHeight - modeSubPos.top - 8) }}
                                  className="fixed z-50 w-[240px] overflow-y-auto rounded-[10px] bg-[rgba(255,255,255,0.94)] p-1 shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)] outline outline-1 outline-black/[0.06] backdrop-blur-[8px] dark:bg-[#1f1f1f]/[0.94] dark:outline-white/[0.06]"
                                >
                                  <div className="px-2 py-[5px] text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{o.name ?? gid}</div>
                                  {o.options!.map((opt) => (
                                    <button
                                      key={opt.value}
                                      role="menuitemradio"
                                      aria-checked={current === opt.value}
                                      onClick={() => chooseLocalOption(gid, opt.value)}
                                      className="flex h-[30px] w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-[5px] text-[13px] outline-none hover:bg-tint-secondary [&>svg]:size-4 [&>svg]:shrink-0"
                                    >
                                      <span className="flex h-4 w-[18px] shrink-0 items-center justify-center text-muted-foreground">
                                        {current === opt.value && <OfficialGlyph svg={MODE_CHECK_ICON} />}
                                      </span>
                                      <span className="min-w-0 flex-1 truncate text-left">{opt.name || opt.value}</span>
                                    </button>
                                  ))}
                                </div>,
                                document.body,
                              )}
                            </div>
                          )
                        })}
                      </>
                    ) : !cfgReady ? (
                      <div className="flex h-[30px] items-center px-3 text-[13px] text-muted-foreground">Loading…</div>
                    ) : (
                    <>
                    {/* Official mode menu: Fusion switch row, capability choices, and
                        Standard/Fast or Standard/Lightning speed submenus. */}
                    <button
                      role="menuitemcheckbox"
                      aria-checked={pillVersion.startsWith('devin-auto')}
                      onMouseEnter={() => setModeSub(null)}
                      onClick={() => { setSelectedVersion(pillVersion.startsWith('devin-auto') ? null : 'devin-auto'); setModeOpen(false) }}
                      className="flex h-[30px] w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-[5px] text-[13px] outline-none hover:bg-tint-secondary [&>svg]:size-4 [&>svg]:shrink-0"
                    >
                      <span className={cn('inline-flex h-4 w-[26px] shrink-0 items-center rounded-full border border-border px-px transition-colors', pillVersion.startsWith('devin-auto') ? 'justify-end bg-foreground' : 'justify-start bg-muted')}>
                        <span className="block size-3.5 rounded-full border-[0.5px] border-border bg-white shadow-sm" />
                      </span>
                      <span className="flex flex-1 items-center gap-1">Fusion <span className="cursor-pointer text-[13px] text-blue-500">Preview</span></span>
                    </button>
                    <div role="separator" className="mx-2 my-1 h-px bg-border" />
                    <div className="flex items-center gap-1.5 px-2 py-[5px] pl-[34px]">
                      <span className="flex-1 text-[12px] font-medium text-muted-foreground">Capability</span>
                      <OfficialGlyph svg={MODE_INFO_ICON} className="text-muted-foreground" />
                    </div>
                    {['Ultra', 'Normal', 'Lite', 'SWE-1.7'].map((m) => {
                      const hasSpeed = m === 'Normal' || m === 'SWE-1.7'
                      return (
                        <div key={m} className="relative" onMouseEnter={(e) => hasSpeed ? openModeSub(m, e.currentTarget) : setModeSub(null)} onMouseLeave={() => hasSpeed && closeModeSub()}>
                          <button
                            role={hasSpeed ? 'menuitem' : 'menuitemradio'}
                            aria-checked={hasSpeed ? undefined : mode === m}
                            aria-haspopup={hasSpeed ? 'menu' : undefined}
                            onClick={() => { if (!hasSpeed) { setSelectedVersion(versionOf(m, 'Standard')); setModeOpen(false) } }}
                            className="flex h-[30px] w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-[5px] text-[13px] outline-none hover:bg-tint-secondary [&>svg]:size-4 [&>svg]:shrink-0"
                          >
                            <span className="flex h-4 w-[18px] shrink-0 items-center justify-center text-muted-foreground">
                              {mode === m && <OfficialGlyph svg={MODE_CHECK_ICON} />}
                            </span>
                            <span className="min-w-0 flex-1 text-left">{m}</span>
                            {hasSpeed && <OfficialGlyph svg={MENU_CHEVRON_ICON} className="ml-auto text-muted-foreground" />}
                          </button>
                          {modeSub === m && modeSubPos && createPortal(
                            <div role="menu" onMouseEnter={() => { if (modeSubTimer.current) { clearTimeout(modeSubTimer.current); modeSubTimer.current = null } }} onMouseLeave={closeModeSub} style={{ left: modeSubPos.left, top: modeSubPos.top, maxHeight: Math.max(160, window.innerHeight - modeSubPos.top - 8) }} className="fixed z-50 w-[220px] overflow-y-auto rounded-[10px] bg-[rgba(255,255,255,0.94)] p-1 shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)] outline outline-1 outline-black/[0.06] backdrop-blur-[8px] dark:bg-[#1f1f1f]/[0.94] dark:outline-white/[0.06]">
                              {(m === 'SWE-1.7' ? ['Standard', 'Lightning'] : ['Standard', 'Fast']).map((sp) => (
                                <button
                                  key={sp}
                                  role="menuitemradio"
                                  aria-checked={mode === m && speed === sp}
                                  onClick={() => { setSelectedVersion(versionOf(m, sp)); setModeSub(null); setModeOpen(false) }}
                                  className="flex h-[30px] w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-[5px] text-[13px] outline-none hover:bg-tint-secondary [&>svg]:size-4 [&>svg]:shrink-0"
                                >
                                  <span className="flex h-4 w-[18px] shrink-0 items-center justify-center text-muted-foreground">
                                    {mode === m && speed === sp && <OfficialGlyph svg={MODE_CHECK_ICON} />}
                                  </span>
                                  <span className="min-w-0 flex-1 text-left">{sp}</span>
                                </button>
                              ))}
                            </div>,
                            document.body,
                          )}
                        </div>
                      )
                    })}
                    </>
                    )}
                    </div>
                  </div>
                )}
              </div>}
              {/* Context window fill — latest root-chain usage_update. */}
              {detail?.session.context_usage?.used != null && detail.session.context_usage.size ? (() => {
                const cu = detail.session.context_usage
                const pctUse = Math.min(100, Math.round(((cu.used ?? 0) / cu.size!) * 100))
                const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n))
                return (
                  <span
                    className="ml-1 inline-flex shrink-0 cursor-default items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground"
                    title={`上下文 ${cu.used!.toLocaleString()} / ${cu.size!.toLocaleString()} tokens（${pctUse}%）\n输入 ${cu.inputTokens?.toLocaleString() ?? '—'} · 输出 ${cu.outputTokens?.toLocaleString() ?? '—'} · 缓存命中 ${cu.cachedReadTokens?.toLocaleString() ?? '—'}`}
                  >
                    <span className="inline-block h-1.5 w-8 overflow-hidden rounded-full bg-muted">
                      <span
                        className={`block h-full rounded-full ${pctUse > 85 ? 'bg-red-500' : pctUse > 60 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                        style={{ width: `${pctUse}%` }}
                      />
                    </span>
                    {fmt(cu.used!)}/{fmt(cu.size!)}
                  </span>
                )
              })() : null}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {!isVisitor && <VoiceButton onText={(t) => setInput((v) => (v ? `${v} ${t}` : t))} onRecordingChange={setVoiceRecording} disabled={sending || statusState.inputDisabled} />}
                {status === 'working' && !isVisitor ? (
                  <button
                    onClick={() => void control('pause')}
                    disabled={controlling}
                    aria-label="Stop Devin"
                    title="Stop Devin"
                    className={cn('flex size-7 cursor-pointer items-center justify-center rounded-full bg-foreground text-background disabled:opacity-50', voiceRecording && 'invisible')}
                  >
                    {controlling ? <Loader2 size={16} className="animate-spin" /> : <Square size={12} fill="currentColor" />}
                  </button>
                ) : null}
                {(status !== 'working' || input.trim().length > 0) && <div className={cn('relative flex items-stretch', voiceRecording && 'invisible')}>
                  <div role="group" className={cn(
                    'inline-flex shrink-0 items-stretch overflow-hidden rounded-full transition-colors',
                    input.trim() ? 'bg-foreground text-background' : 'bg-tint-secondary text-muted-foreground',
                  )}>
                    <button
                      onClick={() => void send()}
                      disabled={sending || statusState.inputDisabled || !input.trim()}
                      aria-label="Send"
                      className="flex size-7 cursor-pointer items-center justify-center py-[5px] disabled:cursor-not-allowed"
                    >
                      {sending ? <Loader2 size={16} className="animate-spin" /> : <ArrowUp size={18} />}
                    </button>
                    {!isVisitor && <div className={cn('flex items-stretch overflow-hidden transition-[width,opacity] duration-150', input.trim() ? 'w-[21px] opacity-100' : 'w-0 opacity-0')}>
                      <span className="w-px shrink-0 self-stretch bg-white/[0.08]" />
                      <button
                        onClick={() => setSendOptOpen((v) => !v)}
                        disabled={!input.trim()}
                        tabIndex={input.trim() ? 0 : -1}
                        aria-label="More send options"
                        title="More send options"
                        className={cn('flex w-5 cursor-pointer items-center justify-center hover:bg-white/10', sendOptOpen && 'bg-white/10')}
                      >
                        <ChevronDown size={14} />
                      </button>
                    </div>}
                  </div>
                  {sendOptOpen && <div className="fixed inset-0 z-10" onClick={() => setSendOptOpen(false)} />}
                  {sendOptOpen && (
                    <div role="menu" className="absolute bottom-8 right-0 z-20 w-[270px] overflow-hidden rounded-[10px] bg-[rgba(255,255,255,0.94)] shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)] outline outline-1 outline-black/[0.06] backdrop-blur-[8px] dark:bg-[#1f1f1f]/[0.94] dark:outline-white/[0.06] [transition:transform_40ms_cubic-bezier(0.76,0,0.24,1),scale_40ms_cubic-bezier(0.76,0,0.24,1),opacity_40ms_cubic-bezier(0.76,0,0.24,1)]">
                      <div className="p-1">
                        {/* Official More send options menu (sampled live): Add to queue · Ctrl ⏎; width w-[270px] per bundle */}
                        <button
                          role="menuitem"
                          onClick={() => {
                            const text = input.trim()
                            setSendOptOpen(false)
                            if (text) { setInput(''); void queueSend(text) }
                          }}
                          className="flex w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-[13px] outline-none hover:bg-tint-secondary"
                        >
                          Add to queue
                          <span className="ml-auto text-[11px] text-muted-foreground">Ctrl ⏎</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>}
              </div>
            </div>
            </>) : (
              <p className="flex min-h-7 items-center px-1 text-[13px] leading-[18px] text-muted-foreground">只读分享，仅可查看会话</p>
            )}
            {controlMsg && <div className="px-1 pt-1 text-[12px] leading-[16px] text-muted-foreground">{controlMsg}</div>}
            {interrupted && (
              <div className="flex items-center gap-2 px-1 pt-1 text-[12px] leading-[16px] text-amber-600 dark:text-amber-400">
                <AlertTriangle size={13} className="shrink-0" />
                <span className="min-w-0 truncate" title={interrupted.text}>上一轮回复被中断（服务重启/进程终止）— 上下文已保留：{interrupted.text.slice(0, 80)}</span>
                <button onClick={() => void resumeInterrupted()} className="shrink-0 cursor-pointer underline hover:opacity-80">{interrupted.kind === 'resend' ? '重新发送' : '继续'}</button>
                <button onClick={dismissInterrupted} className="shrink-0 cursor-pointer underline hover:opacity-80">忽略</button>
              </div>
            )}
            {subDead && (
              <div className="flex items-center gap-2 px-1 pt-1 text-[12px] leading-[16px] text-muted-foreground">
                <AlertTriangle size={13} className="shrink-0" />
                <span className="min-w-0 truncate">子代理句柄已失效（宿主进程已重启/重放）— 不能续聊</span>
                <button onClick={() => void respawnSub()} className="shrink-0 cursor-pointer underline hover:opacity-80">派生新子代理继续</button>
              </div>
            )}
            {sendErr && (
              <div className="flex items-center gap-2 px-1 pt-1 text-[12px] leading-[16px] text-red-500">
                <span className="min-w-0 truncate">{sendErr}</span>
                <button onClick={() => void send()} className="shrink-0 cursor-pointer underline hover:text-red-400">Retry</button>
              </div>
            )}
          </BeardBand>
          {(() => {
            // Official env-suggestion banner below the composer (sampled live 2026-08-31).
            const sug = items.find((it) => it.kind === 'env_suggestion')
            if (isVisitor || !sug || envBannerGone || sug.envSuggestion?.dismissed) return null
            let dismissed = false
            try { dismissed = localStorage.getItem(`env-banner-dismissed:${sug.id}`) === '1' } catch { /* unavailable */ }
            if (dismissed) return null
            return (
              <div className="mt-2 flex min-h-[34px] items-center gap-1 rounded-lg border border-border bg-card py-1 pl-3 pr-1">
                <div className="flex min-h-6 min-w-0 flex-1 items-center justify-between gap-3 overflow-hidden">
                  <div className="flex min-w-0 flex-auto items-center gap-1.5">
                    <Lightbulb size={15} className="shrink-0 text-muted-foreground" />
                    <span className="line-clamp-1 text-start text-[13px] leading-4">
                      <span className="sm:hidden">Environment changes suggested</span>
                      <span className="hidden sm:inline">Devin suggested environment changes for your review</span>
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        const node = document.querySelector(`[data-eid="${CSS.escape(sug.id)}"]`)
                        node?.scrollIntoView({ block: 'center', behavior: 'smooth' })
                      }}
                      className="min-w-0 cursor-pointer truncate text-[13px] font-medium text-blue-500 hover:text-blue-500/80"
                    >
                      Review
                    </button>
                    <button
                      type="button"
                      disabled={!sug.envSuggestion?.contentsKey || envSaveState === 'sending' || envSaveState === 'done'}
                      title={sug.envSuggestion?.contentsKey ? undefined : '该事件无 contents key'}
                      onClick={() => {
                        const es = sug.envSuggestion
                        if (!es?.contentsKey || envSaveState === 'sending' || envSaveState === 'done') return
                        setEnvSaveState('sending')
                        adminFetch<{ ok: boolean; error: string | null }>(`/api/admin/session/${id}/env-suggestion-accept`, {
                          method: 'POST',
                          body: JSON.stringify({ event_id: sug.id, sink: es.sink, repo: es.repo, title: sug.title, summary: es.summary, contents_key: es.contentsKey, old_contents_key: es.oldContentsKey }),
                        }).then((r) => setEnvSaveState(r.ok ? 'done' : 'error')).catch(() => setEnvSaveState('error'))
                      }}
                      className={cn('min-w-0 truncate text-[13px] font-medium', envSaveState === 'error' ? 'text-red-500' : 'text-blue-500', sug.envSuggestion?.contentsKey && envSaveState === 'idle' ? 'cursor-pointer hover:text-blue-500/80' : envSaveState !== 'error' && 'opacity-50')}
                    >
                      <span>{envSaveState === 'sending' ? 'Saving…' : envSaveState === 'done' ? 'Saved' : envSaveState === 'error' ? 'Retry save' : <>Save<span className="hidden sm:inline"> to environment</span></>}</span>
                    </button>
                  </div>
                </div>
                <button
                  type="button"
                  aria-label="Dismiss"
                  onClick={() => dismissEnvBanner(sug.id)}
                  className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X size={16} />
                </button>
              </div>
            )
          })()}
        </footer>
      </div>

      {/* right: panels */}
      {effShowPanel && !fullWidth && (
        <div
          role="separator"
          aria-orientation="vertical"
          onMouseDown={startResize}
          className="relative z-10 -mx-0.5 hidden w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-primary/30 md:block"
        />
      )}
      {effShowPanel && (
        <aside
          className={cn(
            'flex w-full shrink-0 flex-col border-l border-border bg-card/40 max-md:absolute max-md:inset-x-0 max-md:top-11 max-md:bottom-0 max-md:z-40 max-md:max-w-none max-md:bg-background',
            fullWidth ? 'md:flex-1' : 'min-w-0 md:w-auto md:basis-0',
          )}
          style={!fullWidth && window.innerWidth >= 768 ? { flexGrow: rightPct } : undefined}
        >
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
                  onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); if (close) setPanelTabMenu({ x: e.clientX, y: e.clientY, close }) },
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
                  onDragOver: (e: React.DragEvent<HTMLDivElement>) => {
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
                    const { label, Icon } = PANELS[key]
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
              <div className="sticky right-0 z-10 flex h-7 shrink-0 items-center self-center bg-card/80 pl-1 backdrop-blur-sm">
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
                    .filter((k) => !addQ || PANELS[k].label.toLowerCase().includes(addQ.toLowerCase()))
                    .map((k) => (
                    <button
                      key={k}
                      role="menuitem"
                      onClick={() => { openTab(k); setAddQ('') }}
                      className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
                    >
                      {(() => { const { MenuIcon } = PANELS[k]; return <MenuIcon size={16} className="shrink-0 text-muted-foreground" /> })()}
                      <span className="min-w-0 truncate text-[13px] leading-[18px]">{PANELS[k].label}</span>
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
                        <span className="min-w-0 flex-1 truncate text-[13px] leading-[18px]">Attachments</span>
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
                        <span className="min-w-0 flex-1 truncate text-[13px] leading-[18px]">Pull requests</span>
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
          {(() => {
            function renderPanel(key: PanelKey | string) {
              if (key.startsWith('file:')) {
                const f = fileTabs.find((t) => `file:${t.href}` === key)
                if (!f) return null
                const vers: { href: string; ts: string }[] = []
                for (const m of detailMsgs) {
                  for (const a of m.attachments || []) {
                    if (a.name === f.name) vers.push({ href: attachmentUrl(id, a.url, mediaTok), ts: m.timestamp })
                  }
                }
                return <FileViewerPanel href={f.href} name={f.name} initialRaw={f.raw} versions={vers} />
              }
              if (key.startsWith('pr:')) return isVisitor ? null : <PrPanel id={id} prUrl={key.slice(3)} />
              if (isVisitor && !tabs.includes(key as PanelKey)) return null
              switch (key as PanelKey) {
                case 'progress': return <ProgressPanel items={items} id={id} status={status} />
                case 'changes': return <ChangesPanel items={allItems} sessionId={id} step={stepChanges} onClearStep={() => setStepChanges(null)} focus={focusFile} />
                case 'computer': return <ComputerPanel
                  id={id}
                  items={allItems}
                  mt={mediaTok}
                  asleep={!woke && !(woke || ['working', 'running', 'resumed', 'restored', 'initializing', 'resume_requested', 'resume_requested_frontend'].includes(statusState.enum))}
                  onWake={isVisitor ? undefined : () => void control('resume')}
                  canControl={!isVisitor}
                  showLiveDesktop={woke || ['working', 'running', 'resumed', 'restored', 'initializing', 'resume_requested', 'resume_requested_frontend'].includes(statusState.enum)}
                />
                case 'shell': return <ShellPanel items={items} />
                case 'term': return isVisitor ? null : <TermPanel id={id} />
                case 'worklog': return <WorklogPanel id={id} items={allItems} mt={mediaTok} onGoLive={() => openTab('computer')} onWake={isVisitor ? undefined : () => { void control('resume'); openTab('computer') }} jumpTo={worklogJump} finished={status === 'expired' || status === 'stopped'} asleep={(status === 'sleeping' || status === 'finished') && !woke} canLive={caps.showComputer && allItems.some((it) => it.kind === 'computer')} />
                case 'files': return <AttachmentsPanel messages={detailMsgs} sessionId={id} mt={mediaTok} onOpenTab={openFileTab} />
                case 'dashboard': return <div className="p-3"><Dashboard data={dashboard.data} updatedAt={dashboard.updatedAt} /></div>
                case 'sidechat': return isVisitor ? null : <SidechatPanel id={id} anchor={scAnchor} onStage={(f) => setStaged((s) => s.some((x) => x.url === f.url) ? s : [...s, f])} />
                case 'editor': return isVisitor ? null : <WorkspacePanel id={id} />
                case 'resources': return isVisitor ? null : <ResourcesPanel id={id} />
                case 'agents': return isVisitor ? null : wf.runs.length ? (
                  <AgentsPanel
                    runs={wf.runs}
                    selected={wfRunId}
                    onSelect={setWfRunId}
                    agentEvents={wf.agentEvents}
                    devinId={detail?.session.devin_session_id || ''}
                    onOpenSession={(pid, title) => openTreeSession({ devin_id: pid, title } as MirrorTreeSession)}
                  />
                ) : (
                  <SubagentsPanel id={id} />
                )
              }
            }
            const computerAsleep = !woke && !(woke || ['working', 'running', 'resumed', 'restored', 'initializing', 'resume_requested', 'resume_requested_frontend'].includes(statusState.enum))
            const newestPr = [...panelPrs].sort((a, b) => Number(b.number ?? prNumber(b) ?? 0) - Number(a.number ?? prNumber(a) ?? 0))[0]
            const landingRows: { key: string; label: string; description: string; MenuIcon: PanelIcon; disabled?: boolean; onClick: () => void }[] = [
              { key: 'computer', label: 'Computer', description: "Watch and control Devin's Computer", MenuIcon: PANELS.computer.MenuIcon, onClick: () => openTab('computer') },
              { key: 'editor', label: 'Editor', description: computerAsleep ? 'Wake up Devin to use the IDE' : "Full control of Devin's machine", MenuIcon: PANELS.editor.MenuIcon, disabled: computerAsleep, onClick: () => openTab('editor') },
              { key: 'changes', label: 'Changes', description: "See Devin's file edits", MenuIcon: PANELS.changes.MenuIcon, onClick: () => openTab('changes') },
              { key: 'worklog', label: 'Progress', description: "Understand Devin's history and actions", MenuIcon: PANELS.worklog.MenuIcon, onClick: () => openTab('worklog') },
              { key: 'agents', label: 'Agents', description: "Manage this session's child sessions", MenuIcon: PANELS.agents.MenuIcon, onClick: () => openTab('agents') },
              { key: 'sidechat', label: 'Side chat', description: 'Ask questions without interrupting main agent', MenuIcon: PANELS.sidechat.MenuIcon, onClick: () => openTab('sidechat') },
              ...(newestPr ? [{ key: 'pull-requests', label: 'Pull requests', description: 'View proposed code changes', MenuIcon: PanelPullRequestIcon, onClick: () => openPr(newestPr.pr_url) }] : []),
            ]
            const showLanding = !isVisitor && displayedPanelKeys.length === 0
            return (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
              {permSide ? <PermissionSidebarPanel item={permSide} /> : showLanding ? (
                <div className="flex flex-1 flex-col">
                  <div className="flex flex-1 items-center justify-center pb-20">
                    <div className="flex w-[320px] flex-col gap-px">
                      {landingRows.map((row) => (
                        <button
                          key={row.key}
                          type="button"
                          disabled={row.disabled}
                          onClick={row.onClick}
                          className="group/menu-item text-foreground hover:bg-tint-secondary disabled:text-muted-foreground flex w-full cursor-pointer select-none items-start gap-2 rounded-md px-2 py-[7px] text-left outline-none disabled:cursor-default disabled:hover:bg-transparent"
                        >
                          <span className="text-muted-foreground group-enabled/menu-item:group-hover/menu-item:text-foreground flex size-[18px] flex-shrink-0 items-center justify-center"><row.MenuIcon size={18} /></span>
                          <div className="min-w-0 flex-1"><div className="text-[13px] leading-[18px]">{row.label}</div><div className="text-muted-foreground text-[12px] leading-[16px]">{row.description}</div></div>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : renderPanel(panel)}
            </div>
          </div>
            )
          })()}
        </aside>
      )}
    </div>
  )
}

