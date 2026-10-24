/**
 * AdminMirror — cloud-parity session view.
 * Extracted modules live in ./mirror/ (components, panels, tree, utils).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useTranslation } from 'react-i18next'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { Loader2, Settings2, Copy, Check, Archive, ArchiveRestore, Plus, FileText, Circle, ArrowUp, Square, Expand, Code, UploadCloud, Folder as FolderIcon, Pencil, Lightbulb, Info, Image as ImageIcon, AlertTriangle, MessageSquare, Sparkles, TextQuote, CornerDownLeft } from 'lucide-react'
import { adminFetch, adminFetchSwr, shareFetchSwr, type PublicMessage, type DashboardData } from '@/lib/api'
import { adminViewer, visitorViewer, setViewer, sessionFetch, sessionFetchSwr, attachmentUrl, type Viewer, type SharePermission } from '@/lib/viewer'
import { visibleInterval } from '@/lib/poll'
import { subscribeWs } from '@/lib/ws'
import { getTheme, setTheme, type Theme } from '@/lib/theme'
import { type TimelineItem, workSeconds } from '@/components/Timeline'
import { envSupersededMap } from '@/components/TimelineMerges'
import { type ComposerEditorHandle } from '@/components/ComposerEditor'
import DwMark from '@/components/DwMark'
import { type QuoteAttachment } from '../../shared/quotes'
import { cn } from '@/lib/utils'
import { type MirrorTreeSession } from './mirror/treeCache'
import { useSessionTreeData } from './mirror/useSessionTreeData'
import { prefetchSession, visitorTabs, type SessionDetail, tlSnapshots, messagesFromItems, type LocalCfg, EFFORT_SUFFIX_RE, modeOfVersion, type ShareMeta, defaultTabs, CommandPalette, TimelineSkeleton } from './mirror/pageBits'
import { type PanelKey, PANELS, parseOfficialTab, serializeOfficialTab, useUrlParamSync } from './mirror/panelTabs'
import { type TimelinePage, mergeItems, groupItems } from './mirror/timelineUtil'
import { reduceStatus } from './mirror/statusReduce'
import { type ComposerMetaT, type SuggestItem, AT_CATEGORIES } from './mirror/composerMeta'
import { useDraftSession } from './mirror/useDraftSession'
import { useSelectionQuote } from './mirror/useSelectionQuote'
import { type WfAgentEventState } from './mirror/AgentsPanel'
import { SessionMenu } from './mirror/SessionMenu'
import { SessionIndex } from './mirror/SessionIndex'
import { TimelineGroup, StatusTail } from './mirror/TimelineGroups'
import { DraftExplorer } from './mirror/DraftExplorer'
import { PanelContent } from './mirror/panelRender'
import { SidebarRail } from './mirror/SidebarRail'
import { ComposerFooter, type DraftQuote } from './mirror/ComposerFooter'
import { HeaderBar } from './mirror/HeaderBar'
import { TabStrip } from './mirror/TabStrip'
import { FindInSession } from './mirror/FindInSession'

let lastSeenLocalCfg: LocalCfg | null = null
/** cfg cache per agent — switching the draft picker must show THAT
 *  agent's models/modes, not whatever the last session echoed. */
const lastCfgByAgent = new Map<string, LocalCfg>()
// Per-session cfg cache — session A's config must never warm-start session B
// (module-level sharing was the "previous model / Ultra" flash on navigation).
const lastSeenCfgBySid = new Map<string, LocalCfg>()



export default function AdminMirrorPage() {
  const { t } = useTranslation()
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
  // Draft landing state (workspace/target/agent picks + first-send create)
  // lives in ./mirror/useDraftSession.
  const {
    draftCwd, setDraftCwd, draftTarget, setDraftTarget, draftSshCwd, setDraftSshCwd,
    draftAgent, setDraftAgent, draftPicks, sendDraft,
  } = useDraftSession({ draftFolder })
  const sessionSearch = useMemo(() => routerLoc.search, [id])
  const [visitorPerm, setVisitorPerm] = useState<SharePermission | null>(null)
  const vw = useMemo<Viewer>(
    () => (isVisitor ? visitorViewer(id, shareTok, visitorPerm ?? 'readonly') : adminViewer(id)),
    [isVisitor, id, shareTok, visitorPerm],
  )
  setViewer(vw)
  const caps = vw.caps
  const nav = useNavigate()
  const [items, setItems] = useState<TimelineItem[]>([])
  const [interrupted, setInterrupted] = useState<{ text: string; ts: number; kind?: 'continue' | 'resend'; attachments?: { url: string; name?: string; size?: number; mime?: string }[] } | null>(null)
  // 分身: per-session mode + escalation flag, ridden on the /timeline response.
  const [persona, setPersona] = useState<{ mode: string; escalated: boolean } | null>(null)
  const [personaBusy, setPersonaBusy] = useState(false)
  const [activity, setActivity] = useState<{ text: string } | null>(null)
  const reloadTl = useRef<(() => Promise<void>) | null>(null)
  /** Peek→real graduation: browsing starts in lazy-peek mode (no session/load,
   * no updatedAt bump); dwell/interaction flips to the real loading fetch. */
  const graduateTl = useRef<(() => void) | null>(null)
  const [envBannerGone, setEnvBannerGone] = useState(false)
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
  // addOpen lives here (openTab clears it); the rest of the add-menu cluster
  // moved to TabStrip.
  const [addOpen, setAddOpen] = useState(false)
  const [wfRunId, setWfRunId] = useState<string | null>(null)

  const [fullWidth, setFullWidth] = useState(false)
  // Layout memory — rail width / panel split / collapse states survive refresh.
  const layoutSaved = useMemo(() => {
    try { return JSON.parse(localStorage.getItem('dw-layout') || '{}') as { rightPct?: number; leftW?: number; sidebar?: boolean; showPanel?: boolean } } catch { return {} }
  }, [])
  const [rightPct, setRightPct] = useState(() => Math.min(75, Math.max(25, layoutSaved.rightPct ?? 60)))
  const [leftW, setLeftW] = useState(() => Math.min(480, Math.max(200, layoutSaved.leftW ?? 300)))
  const dragPct = useRef<number | null>(null)
  const dragLeftW = useRef<number | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  // Widths ride CSS vars DURING drag — zero React renders (a full re-render per
  // mousemove over the heavy timeline was the resize jank). State commits on
  // mouseup, which also persists via the layout effect below.
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const root = rootRef.current
    if (!root) return
    const onMove = (ev: MouseEvent) => {
      const rect = root.getBoundingClientRect()
      const side = root.querySelector<HTMLElement>('[data-slot="sidebar"][data-state="expanded"]')
      const sideW = window.innerWidth >= 768 ? (side?.getBoundingClientRect().width ?? 0) : 0
      const avail = rect.width - sideW
      if (avail <= 0) return
      const v = Math.min(75, Math.max(25, ((rect.right - ev.clientX) / avail) * 100))
      dragPct.current = v
      root.style.setProperty('--dw-rpct', v.toFixed(3))
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      if (dragPct.current != null) setRightPct(dragPct.current)
      dragPct.current = null
    }
    document.body.style.cursor = 'col-resize'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])
  const startResizeLeft = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const root = rootRef.current
    if (!root) return
    const onMove = (ev: MouseEvent) => {
      const v = Math.min(480, Math.max(200, ev.clientX - root.getBoundingClientRect().left))
      dragLeftW.current = v
      root.style.setProperty('--dw-left-w', `${v}px`)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      if (dragLeftW.current != null) setLeftW(dragLeftW.current)
      dragLeftW.current = null
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
  // Desktop parity: composer send shortcut (Settings → "Send messages with").
  const [sendWith, setSendWith] = useState<'enter' | 'ctrlenter'>(() =>
    (localStorage.getItem('dw-send-with') === 'ctrlenter' ? 'ctrlenter' : 'enter'))
  // While a turn is in flight: does Enter/Ctrl+Enter park the message in the
  // queue ('queue', official default) or interrupt the live turn ('interrupt')?
  const [workSend] = useState<'queue' | 'interrupt'>(() =>
    (localStorage.getItem('dw-work-send') === 'interrupt' ? 'interrupt' : 'queue'))
  const [modeOpen, setModeOpen] = useState(false)
  const [sModeOpen, setSModeOpen] = useState(false)
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null)
  const [optimisticVersion, setOptimisticVersion] = useState<string | null>(null)
  // Local ACP config: real model/mode options exposed by `devin acp` (when set,
  // the cloud version pill swaps to a local config menu).
  // The cfg carries the session id it was loaded for: navigation swaps `id`
  // one render before the fetch effect can swap the cfg, and painting the old
  // session's mode/model labels in that window is exactly the stale-model
  // ("Ultra") flash. Draft sessions use the carried-forward lastSeen cfg.
  const [localCfgState, setLocalCfgState] = useState<{ cfg: LocalCfg | null; sid: string | null }>(
    () => ({ cfg: isDraft ? lastSeenLocalCfg : null, sid: isDraft ? 'draft' : (id || null) })
  )
  const setLocalCfg = (cfgOrFn: LocalCfg | null | ((p: LocalCfg | null) => LocalCfg | null), sid?: string | null) => {
    const cur = isDraft ? 'draft' : (id || null)
    setLocalCfgState((prev) => {
      const base = prev.sid === cur ? prev.cfg : null
      return { cfg: typeof cfgOrFn === 'function' ? cfgOrFn(base) : cfgOrFn, sid: sid === undefined ? cur : sid }
    })
  }
  const localCfg = localCfgState.sid === (isDraft ? 'draft' : (id || null)) ? localCfgState.cfg : null
  // Live /config arrived for THIS session — distinguishes the real config from
  // a warm-start cache, so the cloud "Ultra" fallback can't flash while the
  // real config is still loading.
  const [cfgFetched, setCfgFetched] = useState(false)
  const [cfgTick, setCfgTick] = useState(0)
  useEffect(() => {
    let alive = true
    if (isVisitor || !id) { setLocalCfg(null, id || null); setCfgFetched(false); return }
    // Draft mode: show the carried-forward pick — the server applies lastConfig
    // at creation, and draft picks are POSTed right after the session exists.
    // cfgFetched only when the cache already carries a model group — otherwise
    // hold "…" until composer-meta returns the real agent config (no "Ultra"
    // flash on a model-less cached config).
    if (isDraft) { const c = lastCfgByAgent.get(draftAgent) ?? null; setLocalCfg(c); setCfgFetched(c?.model != null); return }
    // Warm-start ONLY from this session's own cached config — never from a
    // different session the module-level cache happens to remember.
    setLocalCfg(lastSeenCfgBySid.get(id) ?? null, id)
    setCfgFetched(false)
    // GET /config never starts a session/load server-side — it only waits for
    // one already in flight. So this is free on a peeked session and picks up
    // the real config once the timeline graduates (cfgTick bump).
    sessionFetch<LocalCfg>('/config')
      .then((c) => { if (alive) { lastSeenCfgBySid.set(id, c); lastSeenLocalCfg = c; setLocalCfg(c, id); setCfgFetched(true) } })
      .catch(() => { if (alive) setCfgFetched(true) })
    return () => { alive = false }
  }, [id, isVisitor, cfgTick])
  // Draft mode: pull agent-level cfg + dw.json lastConfig via composer-meta so
  // the mode/model pills show real values before any session exists (official
  // home shows the same pills on its new-session composer).
  useEffect(() => {
    if (!isDraft || isVisitor) return
    const cachedCfg = lastCfgByAgent.get(draftAgent)
    if (cachedCfg) { setLocalCfg(cachedCfg); setCfgFetched(true); return }
    void adminFetch<ComposerMetaT>(`/api/admin/composer-meta?agent=${draftAgent ?? ""}`)
      .then((m) => {
        setComposerMeta((prev) => prev ?? m)
        if (!m.cfg) return
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
        lastCfgByAgent.set(draftAgent, cfg)
        setLocalCfg(cfg)
        setCfgFetched(true)
      })
      .catch(() => {})
  }, [isDraft, isVisitor, draftAgent])
  const chooseLocalOptions = (pairs: { configId: string; value: string }[]) => {
    setModeOpen(false); setSModeOpen(false)
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
      if (isDraft) { lastSeenLocalCfg = next; lastCfgByAgent.set(draftAgent, next) }
      return next
    })
    if (isDraft) {
      draftPicks.current = [...draftPicks.current.filter((p) => !pairs.some((q) => q.configId === p.configId)), ...pairs]
      return
    }
    void Promise.all(pairs.map((p) => sessionFetch('/config', { method: 'POST', body: JSON.stringify(p) }).catch(() => null)))
      .then(() => sessionFetch<LocalCfg>('/config'))
      .then((c) => { lastSeenLocalCfg = c; if (id) lastSeenCfgBySid.set(id, c); setLocalCfg(c) })
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
  const modelPillLabel = localCfg?.model
    ? (localCfg.model.currentName || 'Model')
      + (EFFORT_SUFFIX_RE.test(localCfg.model.current) && effortCurName ? ` · ${effortCurName}` : '')
      + (speedCurName && speedCurName !== 'Standard' ? ` · ${speedCurName}` : '')
    : null
  const currentVersion = detail?.session.current_devin_version ?? null
  const pillVersion = selectedVersion ?? optimisticVersion ?? currentVersion ?? 'devin-ultra'
  const mode = modeOfVersion(pillVersion)
  useEffect(() => {
    if (optimisticVersion && currentVersion === optimisticVersion) setOptimisticVersion(null)
  }, [currentVersion, optimisticVersion])
  const [theme, setThemeState] = useState<Theme>(getTheme)
  // Official session-index entries: user messages plus PR rows ("#N" with a PR icon) in timeline order.
  // Official builds this from a full-history skeleton (`historySkeleton` in the bundle); the mirror
  // gets the same coverage from GET .../index (full log scan server-side), merged with live
  // window items so a just-sent message appears before the next index refetch.
  const [serverIdx, setServerIdx] = useState<TimelineItem[]>([])
  useEffect(() => {
    if (isDraft || isVisitor || !id) { setServerIdx([]); return }
    let alive = true
    adminFetch<{ entries: TimelineItem[] }>(`/api/admin/session/${id}/index`)
      .then((r) => { if (alive) setServerIdx(r.entries ?? []) })
      .catch(() => { if (alive) setServerIdx([]) })
    return () => { alive = false }
  }, [id, isDraft, isVisitor])
  const indexEntries = useMemo(() => {
    const loadedEntries = [...older, ...items].filter(
      (it) => (it.kind === 'message' && it.role === 'user') || (it.kind === 'git' && it.raw_type === 'pr_created'),
    )
    const seen = new Set(loadedEntries.map((it) => it.id))
    // Server index is authoritative for anything older than the window —
    // dedupe by id, keep server order then append live-only entries.
    const hist = serverIdx.filter((e) => !seen.has(e.id))
    return [...hist, ...loadedEntries]
  }, [older, items, serverIdx])
  const userMsgs = useMemo(() => indexEntries.filter((it) => it.kind === 'message'), [indexEntries])
  const userMsgCount = userMsgs.length
  const [dashboard, setDashboard] = useState<{ data: DashboardData | null; updatedAt?: string }>({ data: null })
  const [sidebar, setSidebar] = useState(() => (window.innerWidth >= 1024 ? (layoutSaved.sidebar ?? true) : false))
  // Official collapsed-sidebar behavior: hovering the left edge shows the sidebar as a floating flyout.
  const [peek, setPeek] = useState(false)
  const [showPanel, setShowPanel] = useState(() => (window.innerWidth >= 900 ? (layoutSaved.showPanel ?? true) : false))
  // Draft mode has no right-hand tabs — session panels would fetch /new.
  const effShowPanel = showPanel && !isDraft
  // Persist the layout memory whenever any piece changes.
  useEffect(() => {
    try { localStorage.setItem('dw-layout', JSON.stringify({ rightPct, leftW, sidebar, showPanel })) } catch { /* quota */ }
  }, [rightPct, leftW, sidebar, showPanel])
  const [permSide, setPermSide] = useState<TimelineItem | null>(null)
  // Official PR tabs ("PR #N") appear automatically for the session's pull requests; "Hide tab" removes one.
  const [hiddenPrs, setHiddenPrs] = useState<Set<string>>(new Set())
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
      const draft = localStorage.getItem('dw-new-session-draft') || ''
      localStorage.removeItem('dw-new-session-draft')
      return draft
    } catch { return '' }
  })
  // Per-session composer drafts (desktop keeps unsent text when switching
  // sessions). localStorage so drafts survive closing the tab/browser —
  // reopening restores the last page AND its composer state. inputForId
  // guards the id-switch render so the old session's text is never written
  // under the new session's key; the dw-new-session-draft handoff
  // (cross-page nav) takes priority on 'new'.
  const inputForId = useRef(id)
  useEffect(() => {
    if (inputForId.current !== id) {
      inputForId.current = id
      let draft = ''
      try {
        if (id === 'new') {
          draft = localStorage.getItem('dw-new-session-draft') || ''
          if (draft) localStorage.removeItem('dw-new-session-draft')
          else draft = localStorage.getItem('dw-input-draft:new') || ''
        } else {
          draft = localStorage.getItem(`dw-input-draft:${id}`) || ''
        }
      } catch { /* storage unavailable */ }
      setInput(draft)
      return
    }
    try {
      const k = `dw-input-draft:${id}`
      if (input) localStorage.setItem(k, input)
      else localStorage.removeItem(k)
    } catch { /* storage unavailable */ }
  }, [input, id])
  const [sending, setSending] = useState(false)
  const [uploading, setUploading] = useState(false)
  const uploadsInFlight = useRef(0)
  const [showJump, setShowJump] = useState(false)
  const [dragOver, setDragOver] = useState(0)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [queued, setQueued] = useState<{ id: string; text: string }[]>([])
  const [editingQ, setEditingQ] = useState<string | null>(null)
  const editingQRef = useRef<string | null>(null)
  useEffect(() => { editingQRef.current = editingQ }, [editingQ])
  // Queue is per-session server-side — drop the previous session's snapshot on
  // id switch so its band never bleeds into the next session before the first
  // timeline poll lands.
  useEffect(() => { setQueued([]); setEditingQ(null) }, [id])
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
  const coachMode = localStorage.getItem('dw-coach-precheck-mode') || 'warning_only'
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
    if (atCat !== 'files' || indexedPaths || isVisitor) return
    void adminFetch<{ paths: string[] }>(`/api/admin/mirror/indexed-paths?${isDraft ? `cwd=${encodeURIComponent(draftCwd || '')}` : `session=${encodeURIComponent(id)}`}`)
      .then((r) => setIndexedPaths(r.paths || []))
      .catch(() => setIndexedPaths([]))
  }, [atCat, indexedPaths, isVisitor, isDraft, id, draftCwd])
  // Draft cwd change → re-index for the new workspace.
  useEffect(() => { if (isDraft) setIndexedPaths(null) }, [isDraft, draftCwd])
  const editorRef = useRef<ComposerEditorHandle>(null)
  const composerWrapRef = useRef<HTMLDivElement | null>(null)

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
        return AT_CATEGORIES.map((c) => ({ ...c, title: t(c.title), sub: t(c.sub) }))
          .filter((c) => c.title.toLowerCase().includes(q))
          .map((c) => ({
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
  }, [trigger, composerMeta, atCat, indexedPaths, localCfg, t])

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
  // Official minimap: the tick nearest the current scroll position is highlighted (text-primary);
  // PR ticks are purple (bg-text-purple).
  // Official minimap is a vertically centred stack of the last 20 entries (gap-2, 1.5px bars),
  // not bars positioned at each row's on-screen height.
  const [idxActive, setIdxActive] = useState<string | null>(null)
  const idxIdSet = useMemo(() => new Set(indexEntries.map((it) => it.id)), [indexEntries])
  const updateIdxActive = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const mid = el.getBoundingClientRect().top + el.clientHeight / 2
    // One DOM pass in document order — index rows carry data-eid; the last
    // rendered index entry above mid-viewport is the active tick.
    let act: string | null = null
    for (const node of el.querySelectorAll<HTMLElement>('[data-eid]')) {
      const eid = node.dataset.eid
      if (eid && idxIdSet.has(eid) && node.getBoundingClientRect().top <= mid) act = eid
    }
    setIdxActive(act)
  }, [idxIdSet])
  useEffect(() => { updateIdxActive() }, [updateIdxActive, loaded])
  const [scAnchor, setScAnchor] = useState<{ id: string; ts: string } | null>(null)
  const [translations, setTranslations] = useState<Record<string, string>>({})
  const mediaTok = detail?.media_token || ''
  // Chat surfaces always own their scroll — the browser's async scroll restore
  // fires a mid-list scroll event during load that would otherwise kill the
  // bottom pin before the first message batch even lands.
  useEffect(() => {
    try {
      window.history.scrollRestoration = 'manual'
    } catch { /* non-fatal */ }
  }, [])
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickBottom = useRef(true)
  const anchor = useRef<{ id: string; offset: number } | null>(null)
  // Virtualized transcript anchors: event-id → virtual-row index plus the
  // virtualizer instance. Both are populated late in render (the row model
  // depends on allItems/groups) — refs keep early-declared callbacks working.
  const eidToRowRef = useRef<Map<string, number>>(new Map())
  const tlVirtRef = useRef<{ scrollToIndex: (index: number, opts?: { align?: 'start' | 'center' | 'end' | 'auto'; behavior?: 'auto' | 'smooth' }) => void } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // Last real-scroll timestamp — window trims wait for scroll-idle so a
  // boundWindow cut can never yank content mid-drag.
  const lastScrollAt = useRef(0)
  const trimTimer = useRef(0)
  // Load-window pin guard: transient not-near scroll events while content is
  // still arriving (browser scroll restoration, virtualizer settles) are NOT
  // user intent — without this they permanently kill the bottom pin and a
  // refresh lands mid-list instead of on the latest message.
  const bootGuardUntil = useRef(0)
  const userTookOver = useRef(false)

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
  // Session-tree data (registry list, mirror tree, prefs, pagination cursor,
  // ws status patching) lives in ./mirror/useSessionTreeData.
  const {
    sessions, tree, folderOrder, folderTotals, archTree,
    treeCursor, loadingMore, loadMoreTree, loadTree,
    treePrefs, updateTreePrefs,
  } = useSessionTreeData({ isVisitor, isDraft, id, booted })
  const unreadSessions = useMemo(() => tree.filter((s) => s.is_unread), [tree])
  // "Recent" dirs for the draft workspace picker = cwds of existing sessions
  // (tree order is already most-recently-updated first). SSH sessions carry
  // remote paths — exclude them from the local dir list.
  const recentCwds = useMemo(() => [...new Set(tree.filter((s) => !s.ssh).map((s) => s.cwd).filter((c): c is string => !!c))].slice(0, 8), [tree])
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
    // `items` without limit (mergeItems never evicts). Drop the OLDEST
    // excess — but ONLY at scroll-idle: a mid-drag trim removes rows above
    // the viewport, every surviving row's offset shifts, and nothing
    // compensated scrollTop → the content under the cursor teleports and
    // the scrollbar thumb jumps (the visible flicker). The cap is a memory
    // bound, not a DOM bound — virtualization mounts ~15 rows regardless —
    // so deferring 700ms costs nothing.
    const boundWindow = () => {
      const cid = idRef.current
      window.clearTimeout(trimTimer.current)
      trimTimer.current = window.setTimeout(() => {
        if (idRef.current !== cid) return
        if (Date.now() - lastScrollAt.current < 700) { boundWindow(); return }
        const cut = olderRef.current.length + itemsRef.current.length - 600
        if (cut <= 0) return
        // Never trim the row the anchor will restore onto — keep a buffer
        // band above the viewport so the cut can only eat truly offscreen
        // history.
        captureAnchor()
        const aid = anchor.current?.id
        let safeCut = cut
        if (aid) {
          const ai = [...olderRef.current, ...itemsRef.current].findIndex((it) => it.id === aid)
          if (ai >= 0) safeCut = Math.min(cut, Math.max(0, ai - 24))
        }
        if (safeCut <= 0) { anchor.current = null; return }
        const cutN = safeCut
        const dropO = Math.min(olderRef.current.length, cutN)
        // Re-anchor the keyset cursor to the smallest eidx left displayed —
        // index arithmetic on a seq boundary pointed back-pages INSIDE the
        // live window → duplicate prepend → trim → refetch loop.
        if (!isVisitor) setCursor((prev) => {
          if (prev == null) return prev
          let b = Infinity
          for (const it of olderRef.current.slice(dropO)) {
            if (typeof it.eidx === 'number' && it.eidx < b) b = it.eidx
          }
          for (const it of itemsRef.current.slice(cutN - dropO)) {
            if (typeof it.eidx === 'number' && it.eidx < b) b = it.eidx
          }
          return b === Infinity ? prev : String(b)
        })
        // The [items, older] layout effect puts the anchored row back at the
        // same pixel offset, making the trim invisible. (Pinned-at-bottom
        // viewers need nothing: the RO pin keeps them on the live edge.)
        if (dropO) setOlder((prev) => prev.slice(dropO))
        if (cutN - dropO > 0) setItems((prev) => prev.slice(cutN - dropO))
      }, 700)
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
    const load = (fresh = false, retryN = 0) => {
      captureAnchor()
      return sessionFetchSwr<TimelinePage>(`/timeline?limit=300${peek ? '&peek=1' : ''}${first ? '&boot=1' : fresh ? '&fresh=1' : ''}`)
        .then(({ data: r, stale }) => {
          if (!alive) return
          // A stale boot copy paints instantly; pull the revalidated page right after.
          if (first && stale && followUp == null) followUp = window.setTimeout(() => { if (!alive) return; followUp = null; load() }, 800)
          // A generation change mid-window (peek gen-0 → live gen-N, or a
          // server-side rebuild bumping gen) can't merge — `e${i}` ids belong
          // to different item spaces and would union into duplicate rows that
          // the next reset then wipes (the visible flicker). Swap wholesale.
          const genFlip = windowGen.current !== (r.gen ?? 0)
          if (first || r.reset || genFlip) {
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
            try { gone = localStorage.getItem(`dw-intd:${id}`) === String(r.interrupted.ts) } catch { /* unavailable */ }
            setInterrupted(gone ? null : r.interrupted)
          } else setInterrupted(null)
          if (r.persona) setPersona(r.persona)
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
          // Two silent retries before counting — a restart's exit→listen dead
          // window (~2-6s) plus a stale pooled socket should never surface the
          // banner. Only ~10s+ of sustained failure raises it.
          if (retryN < 2) {
            window.setTimeout(() => { if (alive) void load(false, retryN + 1) }, 1200 * (retryN + 1))
            return
          }
          setTlError((e as Error).message)
          setLoaded(true)
          failCount.current += 1
          console.warn(`[timeline] fetch failed (${failCount.current}/2):`, e)
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
      if (!alive) return
      if (ev.sessionId !== id) return
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
      } else if (ev.type === 'prompt_done' || ev.type === 'account_limited' || ev.type === 'account_rotated' || ev.type === 'persona_state') {
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

  // dashboard tab: admin viewers read the per-session admin endpoint (always
  // available); visitors read the share endpoint (requires a share token).
  useEffect(() => {
    if (panel !== 'dashboard' || !detail || (isVisitor && !detail.share_url)) return
    const token = isVisitor ? shareTok : new URL(detail.share_url ?? window.location.origin, window.location.origin).searchParams.get('t') || ''
    const url = isVisitor
      ? `/api/share/${detail.session.id}/dashboard?t=${encodeURIComponent(token)}`
      : `/api/admin/session/${detail.session.id}/dashboard`
    const fetchDash = () =>
      fetch(url)
        .then((r) => r.json())
        .then((r: { dashboard: DashboardData | null; updated_at?: string }) => setDashboard({ data: r.dashboard, updatedAt: r.updated_at }))
        .catch(() => {})
    fetchDash()
    return visibleInterval(fetchDash, 3000)
  }, [panel, detail, isVisitor, shareTok])

  // Copy link deep links: official ?ts=<epoch ms> (legacy #e-<eventId> still honored)
  useEffect(() => {
    if (!loaded) return
    let gi: number | null = null
    const tsParam = new URLSearchParams(location.search).get('ts')
    if (tsParam) {
      const target = Number(tsParam)
      // nearest event by timestamp that maps to a virtual row
      const byDist = [...items].sort(
        (a, b) => Math.abs(new Date(a.ts).getTime() - target) - Math.abs(new Date(b.ts).getTime() - target),
      )
      for (const it of byDist) {
        const row = eidToRowRef.current.get(it.id)
        if (row != null) { gi = row; break }
      }
    } else if (location.hash.startsWith('#e-')) {
      const eid = decodeURIComponent(location.hash.slice(3))
      gi = eidToRowRef.current.get(eid) ?? null
    }
    if (gi == null) return
    stickBottom.current = false
    userTookOver.current = true
    const row = gi
    requestAnimationFrame(() => tlVirtRef.current?.scrollToIndex(row, { align: 'center' }))
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
  const scrollToRow = useCallback((eventId: string, align: 'start' | 'center' | 'end' | 'auto' = 'center'): boolean => {
    const gi = eidToRowRef.current.get(eventId)
    const virt = tlVirtRef.current
    if (gi == null || !virt) return false
    stickBottom.current = false
    userTookOver.current = true
    // Instant jump to the estimated position, then refine onto the mounted
    // node — far jumps accumulate estimate error (folded events have no node,
    // so the group row stays the landing point).
    virt.scrollToIndex(gi, { align, behavior: 'auto' })
    requestAnimationFrame(() => {
      const node = scrollRef.current?.querySelector<HTMLElement>(`[data-eid="${CSS.escape(eventId)}"]`)
      node?.scrollIntoView({ block: align === 'start' ? 'start' : 'center', behavior: 'smooth' })
    })
    return true
  }, [])
  // Bottom-anchored scroll — the ONE canonical "go to latest" for every
  // jump-bottom affordance (footer pill + index popup row). The stick latch
  // engages BEFORE the jump so the resize pin owns the landing: a smooth
  // scrollTo(scrollHeight) lands short because mid-path virtualizer mounts
  // keep growing scrollHeight past the stale target, and the smooth scroll's
  // own not-near scroll events would clear the latch again. Instant jump →
  // the resulting scroll event is `near` → latch holds → every subsequent
  // measurement correction keeps the REAL bottom (composer tail) in view.
  const scrollToBottom = useCallback(() => {
    stickBottom.current = true
    userTookOver.current = false
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
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
      // Anchor BEFORE the prepend: the [items, older] layout effect puts
      // this row back at the same pixel offset. scrollHeight deltas only
      // measure the virtualizer's ESTIMATES — the viewport landed off by
      // the estimate error for a frame before measurements corrected it
      // (the blank flash on every pull).
      captureAnchor()
      setOlder((prev) => [...r.items.map((it) => ({ ...it, pageCursor })), ...prev])
      if (!r.error) setCursor(r.next_cursor)
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
        captureAnchor()
        setOlder((prev) => [...r.items.map((it) => ({ ...it, pageCursor })), ...prev])
        cur = r.next_cursor
        setCursor(r.next_cursor)
        await new Promise((res) => requestAnimationFrame(res))
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

  // Selection -> quote draft (official SelectionQuoteAffordance, message-text
  // scope): the selectionchange chain + quote-chip drafts live in
  // ./mirror/useSelectionQuote.
  const {
    selQuote, setSelQuote, draftQuotes, setDraftQuotes,
    quoteGuardUntil, quoteDraftFrom, stageQuoteDraft,
  } = useSelectionQuote({ isVisitor, isDraft, isSub, allItemsRef })

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
  }, [items, older])

  // First data has arrived — for the settle window afterwards, not-near scroll
  // events are treated as transient (restores/measurements) and re-pinned
  // unless the user has already taken over with a real gesture.
  useEffect(() => {
    if (loaded) bootGuardUntil.current = Date.now() + 1500
  }, [loaded])

  // While stickBottom holds, ANY total-size change (virtual rows measuring in,
  // stream appends, prepended pages, composer growth) re-pins the view to the
  // true bottom — this is what makes refresh land on the newest message
  // instead of wherever the first estimate pass left it.
  useEffect(() => {
    const el = scrollRef.current
    const list = listRef.current
    if (!el || !list) return
    const ro = new ResizeObserver(() => {
      if (stickBottom.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(list)
    if (composerWrapRef.current) ro.observe(composerWrapRef.current)
    return () => ro.disconnect()
  }, [loaded])

  // Official grouper wraps even a lone event in the live tail group ("Working
// for …") — needs the working flag, which sidebarStatus derives from these
// enum values; computed here because `status` is declared further down.
const sessionWorking = ['working', 'running', 'resumed', 'restored'].includes(
  detail?.session.status_enum_raw || detail?.session.status || '',
)
const groups = useMemo(() => groupItems(allItems, sessionWorking), [allItems, sessionWorking])
  // Virtualized transcript rows: [older-page skeleton?] + groups + StatusTail.
  // Only rows near the viewport mount — long sessions keep a bounded DOM
  // (content-visibility was tried and reverted: Chromium STATUS_BREAKPOINT
  // crashes on prepend-while-culled). Keys are stable across prepends so
  // measured heights carry over.
  const vRows = useMemo(() => {
    const rows: { key: string; kind: 'sk' | 'g' | 'tail'; g: (typeof groups)[number] | null; gi: number }[] = []
    if (loaded && cursor) rows.push({ key: 'sk', kind: 'sk', g: null, gi: -1 })
    groups.forEach((g, gi) => {
      const key = g.type === 'work' ? (gi === groups.length - 1 ? 'w-tail' : `w${g.items[g.items.length - 1]?.id ?? gi}`) : g.item.id
      rows.push({ key, kind: 'g', g, gi })
    })
    rows.push({ key: 'tail', kind: 'tail', g: null, gi: -1 })
    return rows
  }, [groups, loaded, cursor])
  const eidToRow = useMemo(() => {
    const m = new Map<string, number>()
    vRows.forEach((r, i) => {
      if (!r.g) return
      if (r.g.type === 'work') for (const it of r.g.items) m.set(it.id, i)
      else m.set(r.g.item.id, i)
    })
    return m
  }, [vRows])
  const tlVirt = useVirtualizer({
    count: vRows.length,
    getScrollElement: () => scrollRef.current,
    // Estimates must match REAL row heights or every mount produces a
    // measure delta the virtualizer compensates with a scrollTop write —
    // that's the scrollbar bounce. Work groups render collapsed ~28px
    // EventRows (memo'd, expand on click) + header chrome; flat rows are
    // messages with body-length-scaled height. A wrong-by-thousands
    // estimate made each mounted group kick the scrollbar mid-drag.
    estimateSize: (i) => {
      const r = vRows[i]
      if (!r || r.kind !== 'g' || !r.g) return 64
      const g = r.g
      if (g.type === 'work') return g.items.length * 28 + 56
      const len = g.item.body?.length ?? 0
      return Math.max(56, 56 + Math.ceil(len / 90) * 19)
    },
    getItemKey: (i) => vRows[i]?.key ?? i,
    // ~2 viewports mounted either side — a hard jump lands on real rows
    // instead of an unmounted spacer gap.
    overscan: 16,
  })
  // Resize drift above the viewport shifts scrollTop back into place; growth
  // at/under the viewport (live tail) must not move what the user is reading.
  // (Instance property in v3.14 — not a constructor option.)
  tlVirt.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, virt) => item.start < (virt.scrollOffset ?? 0)
  eidToRowRef.current = eidToRow
  tlVirtRef.current = tlVirt
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
    if (!caps.canProvideSecret) throw new Error(t('visitor.noPermission'))
    const r = await adminFetch<{ ok: boolean; error?: string | null }>(`/api/admin/session/${id}/secret-response`, {
      method: 'POST',
      body: JSON.stringify({ request_id: requestId, value }),
    })
    if (!r.ok) throw new Error(r.error === 'request_not_found' ? t('visitor.requestGone') : r.error === 'no_ack' ? t('visitor.upstreamUnconfirmed') : t('common.failed'))
  }, [id, caps.canProvideSecret, t])

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

  // <quoted_artifact> wire serialization — the markup devin's own composer
  // emits; stored verbatim in the log so extractQuotes renders the chips.
  const escXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const escAttr = (s: string) => escXml(s).replace(/"/g, '&quot;')
  const withQuotes = (bodyText: string, quotes = draftQuotes) => {
    if (!quotes.length) return bodyText
    // Official Er() wire shape: optional <caption> (user's note) + <content>.
    return quotes.map((q) => {
      const ev = q.kind === 'worklog' && q.endEventId
        ? ` start_event_id="${escAttr(q.eventId ?? '')}" end_event_id="${escAttr(q.endEventId)}"`
        : ` event_id="${escAttr(q.eventId ?? '')}"`
      return `<quoted_artifact kind="${escAttr(q.kind)}" author="${q.author}"${ev}${q.tsMs ? ` ts_ms="${q.tsMs}"` : ''}>${q.caption ? `\n<caption>${escXml(q.caption)}</caption>` : ''}\n<content>\n${escXml(q.text)}\n</content>\n</quoted_artifact>`
    }).join('\n\n') + (bodyText ? `\n\n${bodyText}` : '')
  }

  // Central send-error surface: every composer catch routes here so failures
  // get an audit trail in server.log, and the drain 503 becomes a readable
  // "restarting — waiting on <sessions> · Ns" message instead of a raw string.
  const reportSendError = (e: unknown, fallback: string) => {
    const msg = e instanceof Error && e.message ? e.message : fallback
    void adminFetch('/api/admin/audit', { method: 'POST', body: JSON.stringify({ action: 'send-error', detail: `${id} ${msg}`.slice(0, 280) }) }).catch(() => null)
    if (msg === 'server_restarting' && !isVisitor) {
      void adminFetch<{ draining: boolean; waiting: string[]; elapsed_ms: number }>('/api/admin/drain')
        .then((d) => {
          if (d.draining) setSendErr(t('composer.drainWait', { sessions: d.waiting.join(', ') || '—', elapsed: Math.max(1, Math.round(d.elapsed_ms / 1000)) }))
          else setSendErr(t('composer.serverRestarting'))
        })
        .catch(() => setSendErr(t('composer.serverRestarting')))
      return
    }
    setSendErr(msg)
  }

  async function send(preset?: string, extraQuotes?: DraftQuote[]) {
    let text = (preset ?? input).trim()
    const quotesNow = extraQuotes ?? draftQuotes
    if (statusState.inputDisabled || (!text && !(preset === undefined && (staged.length || quotesNow.length))) || sending) return
    if (!caps.canSendMessage) { setSendErr(t('visitor.chatForbidden')); return }
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
      if (text || draftQuotes.length) { setInput(''); setDraftQuotes([]); void queueSend(withQuotes(text)) }
      return
    }
    // Free text typed while an option question is pending answers the
    // question with other_text (official composer semantics).
    if (preset === undefined && pending) {
      if (!caps.canAnswerQuestion) { setSendErr(t('visitor.answerForbidden')); return }
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
        reportSendError(e, t('am.sendFail'))
      } finally { setSending(false) }
      return
    }
    // Draft (/admin/new): the first send IS the session — create it with the
    // text as the task, replay draft config picks onto it, then swap in place
    // (desktop-parity new-session flow; server also applies lastConfig).
    if (isDraft) {
      // SSH targets must exist server-side (composer-meta.ssh_hosts mirrors
      // prefs.sshHosts). A stale pick on an older backend would otherwise be
      // silently created as a LOCAL session in a mangled "~/…" dir.
      if (draftTarget.kind === 'ssh' && !(composerMeta?.ssh_hosts ?? []).some((h) => h.target === draftTarget.host.target)) {
        setSendErr(t('draft.sshSaveFail'))
        return
      }
      setSending(true)
      setSendErr(null)
      try {
        await sendDraft(text, staged.map((f) => ({ url: f.url, name: f.name, size: f.size })), () => { setInput(''); setStaged([]) })
      } catch (e) {
        reportSendError(e, t('menu.createFailed'))
      } finally { setSending(false) }
      return
    }
    setSending(true)
    setSendErr(null)
    const wireText = preset === undefined ? withQuotes(text, quotesNow) : text
    // Local echo (rendered as a plain user row) until the upstream event replaces it.
    const echo: TimelineItem = {
      id: `local-${Date.now()}`, ts: new Date().toISOString(), kind: 'message', role: 'user',
      body: wireText, raw_type: 'user_message',
      ...(preset === undefined && staged.length
        ? { attachments: staged.map((f) => ({ url: f.url, name: f.name, size: f.size })) }
        : {}),
    }
    setItems((prev) => [...prev, echo])
    const draft = { input, staged, quotes: quotesNow }
    pendingPreviewRef.current = draft.staged
    if (preset === undefined) { setInput(''); setStaged([]); setDraftQuotes([]) }
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
          setSendErr(t('am.modelFail'))
        }
      }
      graduateTl.current?.() // sending is interaction — start the real load now
      const res = await sessionFetch<{ ok: boolean; queued?: string }>('/message', {
        method: 'POST',
        body: JSON.stringify({
          message: wireText,
          // Real attachment blocks — the server converts staged uploads into
          // ACP image/resource/resource_link prompt blocks.
          attachments: preset === undefined ? staged.map((f) => ({ url: f.url, name: f.name, size: f.size })) : [],
        }),
      })
      messageSent = true
      revokePreviews(draft.staged)
      pendingPreviewRef.current = []
      if (res?.queued) {
        // Auto-queued mid-turn: it lands in the queue band, not the timeline —
        // drop the local echo and reflect the queue immediately.
        setQueued((q) => [...q, { id: res.queued!, text }])
        setItems((prev) => prev.filter((it) => it.id !== echo.id))
        return
      }
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
      if (preset === undefined && !messageSent) { setInput((cur) => cur || draft.input); setStaged((cur) => (cur.length ? cur : draft.staged)); setDraftQuotes((cur) => (cur.length ? cur : draft.quotes)) }
      reportSendError(e, t('am.sendFail'))
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
          : { message: t('common.continue'), attachments: [] }),
      })
      await reloadTl.current?.()
    } catch (e) {
      setInterrupted(it) // resend failed — put the banner back
      reportSendError(e, t('am.sendFail'))
    }
  }
  const dismissInterrupted = () => {
    if (!interrupted) return
    try { localStorage.setItem(`dw-intd:${id}`, String(interrupted.ts)) } catch { /* unavailable */ }
    setInterrupted(null)
  }

  // 分身代答: chip cycles off → semi → auto (per-session override stored in
  // dw.json); '问分身' fires a manual ask on the session's tail question.
  const cyclePersonaMode = async () => {
    const order = ['off', 'semi', 'auto']
    const next = order[(order.indexOf(persona?.mode ?? 'off') + 1) % order.length]
    try {
      const r = await fetch('/api/admin/session-persona', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, mode: next }),
      }).then((res) => res.json())
      if (r.persona) setPersona(r.persona)
    } catch { /* keep old state */ }
  }
  const askPersonaNow = async () => {
    if (personaBusy || sending) return
    setPersonaBusy(true)
    try {
      await fetch('/api/admin/session-persona-ask', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      await reloadTl.current?.()
    } finally { setPersonaBusy(false) }
  }

  // Dead subagent handle: the registry that held it was emptied by a restart/
  // replay, so resume relays can never land. Respawn sends the text with
  // respawn:1 — the lead spawns a SUCCESSOR carrying this agent's context.
  const subDead = isSub && detail?.session.subagent?.resumable === false
  // Owning ACP agent — devin-private UI (share/end/subagent controls) hides
  // for sessions other agents own. Draft picker is separate (draftAgent).
  const sessionAgent = detail?.session?.agent ?? 'devin'
  const isDevinSession = sessionAgent === 'devin'
  const respawnSub = async () => {
    if (sending) return
    const msg = input.trim() || t('panel.continueTask')
    setSending(true)
    try {
      await sessionFetch('/message', { method: 'POST', body: JSON.stringify({ message: msg, respawn: true }) })
      setInput('')
      setControlMsg(t('menu.successorSent'))
    } catch (e) {
      reportSendError(e, t('am.sendFail'))
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
    if (!caps.canAnswerQuestion) { setSendErr(t('visitor.answerForbidden')); return }
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
      reportSendError(e, t('am.answerFail'))
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
    setControlMsg(t('menu.restartingWait'))
    const t0 = Date.now()
    let sawDown = false
    const tick = async () => {
      let up = false
      try { up = (await fetch('/api/accounts', { cache: 'no-store' })).ok } catch { /* down */ }
      if (!up) sawDown = true
      if (sawDown && up) { location.reload(); return }
      if (sawDown) setControlMsg(t('menu.restartingBack'))
      if (Date.now() - t0 < 6 * 60 * 1000) setTimeout(tick, 1500)
      else setControlMsg(t('menu.restartTimeout'))
    }
    setTimeout(tick, 1000)
  }

  async function upload(file: File) {
    if (!caps.canUpload) return
    const preview = URL.createObjectURL(file)
    pendingPreviewRef.current.push({ url: '', name: file.name, size: file.size, preview })
    setUploading(true)
    uploadsInFlight.current += 1
    try {
      const upName = file.name || `upload.${(file.type.split(';')[0].split('/')[1] || 'bin')}`
      const r = isDraft
        ? await adminFetch<{ ok: boolean; url?: string; name?: string; size?: number; error?: string }>(`/api/admin/upload-stage?filename=${encodeURIComponent(upName)}`, { method: 'POST', body: file })
        : await sessionFetch<{ ok: boolean; url?: string; name?: string; size?: number; error?: string }>(`/upload-stage?filename=${encodeURIComponent(upName)}`, { method: 'POST', body: file })
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
  const removeStaged = (url: string) => {
    setStaged((files) => {
      const removed = files.find((file) => file.url === url)
      if (removed) revokePreviews([removed])
      return files.filter((file) => file.url !== url)
    })
  }

  const composerEl = (
    <ComposerFooter
      effShowPanel={effShowPanel}
      showJump={showJump}
      onScrollBottom={scrollToBottom}
      isDraft={isDraft}
      isVisitor={isVisitor}
      id={id}
      caps={caps}
      sendErr={sendErr}
      send={send}
      interrupted={interrupted}
      resumeInterrupted={resumeInterrupted}
      dismissInterrupted={dismissInterrupted}
      subDead={subDead}
      respawnSub={respawnSub}
      controlMsg={controlMsg}
      persona={persona}
      personaBusy={personaBusy}
      cyclePersonaMode={cyclePersonaMode}
      askPersonaNow={askPersonaNow}
      envBannerGone={envBannerGone}
      items={items}
      dismissEnvBanner={dismissEnvBanner}
      draftTarget={draftTarget}
      setDraftTarget={setDraftTarget}
      draftSshCwd={draftSshCwd}
      setDraftSshCwd={setDraftSshCwd}
      draftCwd={draftCwd}
      setDraftCwd={setDraftCwd}
      recentCwds={recentCwds}
      composerMeta={composerMeta}
      setComposerMeta={setComposerMeta}
      draftAgent={draftAgent}
      setDraftAgent={setDraftAgent}
      queued={queued}
      setQueued={setQueued}
      queueOpReq={queueOpReq}
      queueReorder={queueReorder}
      queueEditStart={queueEditStart}
      queueOp={queueOp}
      queueSend={queueSend}
      queueEditSubmit={queueEditSubmit}
      editingQ={editingQ}
      pending={pending}
      answerQuestion={answerQuestion}
      setDismissedQ={setDismissedQ}
      sending={sending}
      suggestions={suggestions}
      atCat={atCat}
      setAtCat={setAtCat}
      trigger={trigger}
      sugIdx={sugIdx}
      setSugIdx={setSugIdx}
      applySuggestion={applySuggestion}
      openMention={openMention}
      findings={findings}
      setFindings={setFindings}
      scanState={scanState}
      setScanState={setScanState}
      confirmSendOpen={confirmSendOpen}
      setConfirmSendOpen={setConfirmSendOpen}
      confirmedDraftRef={confirmedDraftRef}
      autoSendRef={autoSendRef}
      setAutoSendTick={setAutoSendTick}
      setSelectedVersion={setSelectedVersion}
      modeOpen={modeOpen}
      setModeOpen={setModeOpen}
      sModeOpen={sModeOpen}
      setSModeOpen={setSModeOpen}
      input={input}
      setInput={setInput}
      mode={mode}
      draftQuotes={draftQuotes}
      setDraftQuotes={setDraftQuotes}
      staged={staged}
      removeStaged={removeStaged}
      mediaTok={mediaTok}
      editorRef={editorRef}
      statusState={statusState}
      upload={upload}
      uploading={uploading}
      sendWith={sendWith}
      workSend={workSend}
      status={status}
      control={control}
      controlling={controlling}
      localModeGroup={localModeGroup}
      localModeOpt={localModeOpt}
      localModeCurrent={localModeCurrent}
      modelPillLabel={modelPillLabel}
      cfgFetched={cfgFetched}
      pillVersion={pillVersion}
      localCfg={localCfg}
      effortGroup={effortGroup}
      speedGroup={speedGroup}
      extraGroups={extraGroups}
      chooseLocalOption={chooseLocalOption}
      chooseLocalOptions={chooseLocalOptions}
      detail={detail}
      sessionAgent={sessionAgent}
      selQuote={selQuote}
      setSelQuote={setSelQuote}
      stageQuoteDraft={stageQuoteDraft}
      quoteDraftFrom={quoteDraftFrom}
      nav={nav}
    />
  )

  return (
    <div ref={rootRef} className="relative flex h-dvh overflow-hidden bg-background" style={{ '--dw-rpct': String(dragPct.current ?? rightPct), '--dw-left-w': `${dragLeftW.current ?? leftW}px` } as React.CSSProperties}>

      {/* left: session list (administrator only; visitors have no session tree) */}
      <SidebarRail
        isVisitor={isVisitor}
        sidebar={sidebar}
        peek={peek}
        setSidebar={setSidebar}
        setPeek={setPeek}
        isDraft={isDraft}
        nav={nav}
        onOpenPalette={() => setPaletteOpen(true)}
        waitForRestart={waitForRestart}
        unreadSessions={unreadSessions}
        tree={tree}
        archTree={archTree}
        activeDevinId={current?.devin_session_id || ''}
        onOpen={openTreeSession}
        onPrefetch={prefetchRegisteredSession}
        onRefresh={loadTree}
        prefs={treePrefs}
        onPrefs={updateTreePrefs}
        folderOrder={folderOrder}
        folderTotals={folderTotals}
        onLoadMore={treeCursor ? loadMoreTree : undefined}
        loadingMore={loadingMore}
        sessions={sessions}
        id={id}
      />

      {/* left rail resize handle — width rides --dw-left-w (see index.css) */}
      {!isVisitor && sidebar && (
        <div
          role="separator"
          aria-orientation="vertical"
          onMouseDown={startResizeLeft}
          className="relative z-10 -mx-0.5 hidden w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-primary/30 md:block"
        />
      )}

      {/* center: timeline (hidden while the tabs panel is in full width) */}
      <div
        className={cn('relative flex min-w-0 flex-1 flex-col', effShowPanel && !fullWidth && 'md:basis-0', fullWidth && effShowPanel && 'max-md:flex md:hidden')}
        style={effShowPanel && !fullWidth && window.innerWidth >= 768 ? { flexGrow: 'calc(100 - var(--dw-rpct))' } : undefined}
        onDragEnter={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragOver((n) => n + 1) } }}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() }}
        onDragLeave={(e) => { if (e.dataTransfer.types.includes('Files')) setDragOver((n) => Math.max(0, n - 1)) }}
        onDrop={(e) => {
          // Workspace-tree file drag → insert an @path mention into the composer.
          const wbPath = e.dataTransfer.getData('text/x-dw-path')
          if (wbPath) {
            e.preventDefault()
            setInput((cur) => (cur.trim() ? `${cur} @${wbPath} ` : `@${wbPath} `))
            return
          }
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
        <HeaderBar
          isVisitor={isVisitor}
          sidebar={sidebar}
          setPeek={setPeek}
          setSidebar={setSidebar}
          detail={detail}
          isDraft={isDraft}
          current={current}
          caps={caps}
          openPr={openPr}
          workSecs={workSecs}
          id={id}
          isSub={isSub}
          isDevinSession={isDevinSession}
          treeNode={treeNode}
          folderOrder={folderOrder}
          userMsgCount={userMsgCount}
          reloadDetail={reloadDetail}
          loadTree={loadTree}
          onControlMsg={setControlMsg}
          effShowPanel={effShowPanel}
          setShowPanel={setShowPanel}
        />

        {isDraft && loaded && (
          // Desktop New-Space parity: centered column = watermark + tip card
          // stacked directly on the composer (mt-auto/mb-auto halves the free
          // space); controls + Recent projects sit below the composer.
          <div className="mx-auto mt-auto flex w-full max-w-[692px] flex-col items-center gap-2 px-6 text-center">
            <DwMark size={48} className="text-foreground/15" />
            <p className="mt-2 text-[17px] font-medium leading-[26px] text-foreground">{t('menu.newSession')}</p>
            <p className="text-[13px] leading-[18px] text-muted-foreground">
              {t('menu.draftHint')}{draftFolder ? t('menu.draftHintFolder', { folder: draftFolder }) : ''}
            </p>
          </div>
        )}
        <div className={cn('@container/chat-pane relative flex min-h-0 flex-1 flex-col', isDraft && 'hidden')}>
        <FindInSession items={allItems} scrollRef={scrollRef} onJump={scrollToRow} />
        <div
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget
            const near = el.scrollHeight - el.scrollTop - el.clientHeight < 60
            // Position-derived stick state: every NON-user scroll source is
            // distance-preserving (virtualizer measure-adjusts shift
            // scrollTop and scrollHeight equally) or bottom-landing (the
            // pins) — so a not-near scroll can only be the user moving away.
            // Scrollbar drags emit no wheel/pointer/key events at all; the
            // old gesture window never saw them, so the bottom pin fought
            // every drag — each stream resize yanked scrollTop back to the
            // edge = the bouncing scrollbar + strobing viewport.
            if (near) {
              stickBottom.current = true
            } else if (!userTookOver.current && Date.now() < bootGuardUntil.current) {
              // Load-window transient (scroll restore / measure settle): not
              // user intent — re-pin instead of dropping the bottom latch.
              el.scrollTop = el.scrollHeight
              stickBottom.current = true
            } else {
              stickBottom.current = false
            }
            if (!near) lastScrollAt.current = Date.now()
            setShowJump(!near)
            // Official backfills older history automatically as you approach the top
            // (bundle: tail_window_backfill, backfillStatus loading/idle) — no button.
            if (el.scrollTop < 600) loadOlder()
            updateIdxActive()
          }}
          onWheel={(e) => {
            // An upward wheel unsticks IMMEDIATELY — during heavy streaming the
            // bottom-pin observer can otherwise win the race against the queued
            // scroll event and yank the user back to the live edge.
            if (e.deltaY < 0) {
              stickBottom.current = false
              userTookOver.current = true
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'PageUp' || e.key === 'Home' || e.key === 'ArrowUp') {
              stickBottom.current = false
              userTookOver.current = true
            }
          }}
          // scrollbar-gutter both-edges: a classic (layout) scrollbar eats
          // the RIGHT side of the content box only, leaving the column
          // off-center vs the page (left pad < right pad+bar). both-edges
          // reserves a matching gutter on the left so the visible side
          // margins stay equal; overlay scrollbars (touch) reserve 0.
          className={cn('flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-[20px] @[448px]/chat-pane:px-6 [scrollbar-gutter:stable_both-edges]', effShowPanel && 'max-md:hidden', isDraft && 'hidden')}
        >
          {connLost && (
            <div className="sticky top-0 z-10 mx-auto mb-2 w-fit rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[12px] leading-[16px] text-amber-600 dark:text-amber-400">
              {t('am.connLost')}
            </div>
          )}
          {!loaded && (
            <div className="mx-auto max-w-[692px] pt-2" aria-hidden>
              <TimelineSkeleton rows={7} />
            </div>
          )}

          {loaded && tlError === 'mirror_not_configured' && <p className="text-xs text-muted-foreground">{t('menu.mirrorNotConfigured')}</p>}
          {loaded && tlError === 'token_expired' && <p className="text-xs text-amber-600">{t('menu.mirrorTokenExpired')}</p>}
          {loaded && tlError && tlError !== 'mirror_not_configured' && tlError !== 'token_expired' && <p className="text-xs text-red-600">{t('menu.mirrorReadFailed', { err: tlError })}</p>}
          <div className="mx-auto w-full max-w-[692px] shrink-0"><div ref={listRef} className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0" style={{ height: tlVirt.getTotalSize(), position: 'relative' }}>
            {tlVirt.getVirtualItems().map((vi) => {
              const row = vRows[vi.index]
              return (
                <div key={vi.key} data-index={vi.index} ref={tlVirt.measureElement} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}>
                  {!row || row.kind === 'sk' ? (
                    <div className="mb-4" aria-hidden>
                      <TimelineSkeleton rows={3} />
                    </div>
                  ) : row.kind === 'tail' ? (
                    <StatusTail statusState={statusState} actionRequired={actionRequired} woke={woke} controlling={controlling} onResume={() => void control('resume')} isVisitor={isVisitor} detail={detail} />
                  ) : row.g ? (
                    // keyed by the newest member: history backfill prepends older items and may
                    // extend the group backwards, which must not remount it (would drop open state)
                    <TimelineGroup g={row.g} isLast={row.gi === groups.length - 1} id={id} isVisitor={isVisitor} isSub={isSub} caps={caps} detail={detail} status={status} panel={panel} mediaTok={mediaTok} permResolved={permResolved} secretProvided={secretProvided} provideSecret={provideSecret} wf={wf} onOpenWfRun={(runId) => { setWfRunId(runId || null); openTab('agents') }} onOpenPr={openPr} onOpenPermission={(it) => { setPermSide(it); setShowPanel(true) }} envSuperseded={envSuperseded} messageHeaders={messageHeaders} translations={translations} onTranslated={(itemId, tr) => setTranslations((p) => ({ ...p, [itemId]: tr }))} onFileRef={onFileRef} openFileTab={openFileTab} jumpToQuote={jumpToQuote} onSelQuote={setSelQuote} quoteGuardUntil={quoteGuardUntil} onControlMsg={setControlMsg} onSideChat={(it) => { setScAnchor({ id: it.id, ts: it.ts }); openTab('sidechat') }} onStepChanges={onStepChanges} onOpenProgress={onOpenProgress} onOpenSubagent={onOpenSubagent} worklogJump={worklogJump} tailThoughtId={tailThoughtId} urlPrs={urlPrs} urlFiles={urlFiles} />
                  ) : null}
                </div>
              )
            })}
          </div></div>
          {/* Session mode: the composer rides INSIDE the scroll element as a
              sticky tail — in flow it is the last item (so no message is ever
              hidden behind it and no band-height measuring is needed); off the
              bottom it sticks to the scrollport bottom. The scrollbar spans the
              full pane height and stays hoverable; the fade is pointer-transparent
              so text under it stays selectable and wheel-scrollable. */}
          {!isDraft && (
            <div ref={composerWrapRef} className="pointer-events-none sticky bottom-0 z-30 mt-auto w-full bg-gradient-to-t from-background via-background/85 to-transparent pt-10">
              <div className="pointer-events-auto">{composerEl}</div>
            </div>
          )}
        </div>
        <SessionIndex entries={indexEntries} active={idxActive} scrollRef={scrollRef} stickBottom={stickBottom} userTookOver={userTookOver} cursor={cursor} olderPending={loadingOlder} loadUntil={loadUntil} allItems={allItems} pullRequests={detail?.session.pull_requests} queued={queued} onJump={(eid) => scrollToRow(eid, 'start')} onScrollBottom={scrollToBottom} />
        </div>

        {/* Draft mode keeps the composer in flow (it anchors the centered
            hero); session mode renders it inside the scroll element — see the
            sticky tail above. */}
        {isDraft && <div>{composerEl}</div>}

        {isDraft && loaded && (
          // Desktop New-Space lower segment: Local env · Choose folder ·
          // Go-to-sessions row, then Recent projects + starter suggestions.
          // mb-auto keeps the free space AFTER this block, not between it and
          // the composer.
          <div className="mx-auto mb-auto w-full max-w-[692px] px-6 pb-8">
            {draftCwd && <DraftExplorer root={draftCwd} />}
            <div className="mt-4">
              <div className="mb-1.5 flex items-center justify-between">
                <p className="text-[11px] font-medium text-muted-foreground">{t('draft.recentProjects')}</p>
                <button onClick={() => nav('/admin/sessions')} className="cursor-pointer text-[12px] leading-[16px] text-muted-foreground hover:text-foreground">{t('draft.viewAll')}</button>
              </div>
              <div className="rounded-[10px] border border-border">
                {recentCwds.length === 0 ? (
                  <p className="px-3 py-2.5 text-[12px] leading-[16px] text-muted-foreground">{t('draft.noProjects')}</p>
                ) : recentCwds.slice(0, 5).map((dir) => (
                  <button
                    key={dir}
                    onClick={() => setDraftCwd(dir)}
                    title={dir}
                    className="flex w-full cursor-pointer items-center gap-2 border-b border-border px-3 py-2 text-left last:border-b-0 hover:bg-tint-secondary"
                  >
                    <FolderIcon size={13} className="shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate text-[12px] leading-[16px] text-foreground">{dir}</span>
                  </button>
                ))}
              </div>
            </div>
            {composerMeta && (composerMeta.sessions.length > 0 || composerMeta.commands.length > 0 || composerMeta.skills.length > 0) && (
              <div className="mt-4 flex w-full flex-col gap-3 text-left">
                {composerMeta.sessions.length > 0 && (
                  <div>
                    <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">{t('draft.recent')}</p>
                    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
                      {composerMeta.sessions.slice(0, 3).map((s) => (
                        <button
                          key={s.id}
                          onClick={() => nav(`/admin/${s.id}`)}
                          className="flex min-w-0 cursor-pointer items-center gap-2 rounded-[8px] border border-border bg-card px-2.5 py-2 text-left hover:bg-tint-secondary"
                        >
                          <MessageSquare size={13} className="shrink-0 text-muted-foreground" />
                          <span className="min-w-0 truncate text-[12px] leading-[16px] text-foreground">{s.title || s.id}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {(composerMeta.commands.length > 0 || composerMeta.skills.length > 0) && (
                  <div>
                    <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">{t('draft.try')}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {composerMeta.commands.slice(0, 5).map((c) => (
                        <button
                          key={`c:${c.command}`}
                          title={c.description}
                          onClick={() => setInput(`/${c.command} `)}
                          className="cursor-pointer rounded-full border border-border bg-card px-2.5 py-1 text-[12px] leading-[16px] text-foreground hover:bg-tint-secondary"
                        >
                          /{c.command}
                        </button>
                      ))}
                      {composerMeta.skills.slice(0, 4).map((s) => (
                        <button
                          key={`s:${s.name}`}
                          title={s.description ?? s.name}
                          onClick={() => setInput((v) => (v ? `${v.replace(/\s+$/, '')} @${s.name} ` : `@${s.name} `))}
                          className="cursor-pointer rounded-full border border-border bg-card px-2.5 py-1 text-[12px] leading-[16px] text-foreground hover:bg-tint-secondary"
                        >
                          @{s.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
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
          style={!fullWidth && window.innerWidth >= 768 ? { flexGrow: 'var(--dw-rpct)' } : undefined}
        >
          <TabStrip
            isVisitor={isVisitor}
            caps={caps}
            allItems={allItems}
            detail={detail}
            treeNode={treeNode}
            id={id}
            mediaTok={mediaTok}
            panel={panel}
            setPanel={setPanel}
            setTabs={setTabs}
            setFileTabs={setFileTabs}
            setClosedTabIds={setClosedTabIds}
            setHiddenPrs={setHiddenPrs}
            setUserPickedActiveTab={setUserPickedActiveTab}
            setPermSide={setPermSide}
            setTabOrder={setTabOrder}
            tabSyncBlocked={tabSyncBlocked}
            displayedPanelKeys={displayedPanelKeys}
            prTabs={prTabs}
            fileTabs={fileTabs}
            closedTabIds={closedTabIds}
            attachFiles={attachFiles}
            openTab={openTab}
            openFileTab={openFileTab}
            addOpen={addOpen}
            setAddOpen={setAddOpen}
            fullWidth={fullWidth}
            setFullWidth={setFullWidth}
            setShowPanel={setShowPanel}
          />
          <PanelContent
            panel={panel}
            displayedPanelKeys={displayedPanelKeys}
            permSide={permSide}
            isVisitor={isVisitor}
            tabs={tabs}
            fileTabs={fileTabs}
            detailMsgs={detailMsgs}
            id={id}
            mediaTok={mediaTok}
            items={items}
            allItems={allItems}
            status={status}
            statusState={statusState}
            stepChanges={stepChanges}
            onClearStep={() => setStepChanges(null)}
            focusFile={focusFile}
            woke={woke}
            control={control}
            openTab={openTab}
            openPr={openPr}
            worklogJump={worklogJump}
            caps={caps}
            dashboard={dashboard}
            scAnchor={scAnchor}
            onStage={(f) => setStaged((s) => s.some((x) => x.url === f.url) ? s : [...s, f])}
            wf={wf}
            wfRunId={wfRunId}
            setWfRunId={setWfRunId}
            detail={detail}
            openTreeSession={openTreeSession}
            panelPrs={panelPrs}
            openFileTab={openFileTab}
          />
        </aside>
      )}
    </div>
  )
}
