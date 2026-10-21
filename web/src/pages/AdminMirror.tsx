/**
 * AdminMirror — cloud-parity session view.
 * Extracted modules live in ./mirror/ (components, panels, tree, utils).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '@/i18n'
import { createPortal } from 'react-dom'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Loader2, ChevronRight, ChevronDown, ChevronUp, Settings2, Copy, Check, RotateCcw, Archive, ArchiveRestore, Plus, FileText, Circle, ArrowUp, ArrowUpRight, Square, Link2, X, Expand, Code, Workflow as WorkflowIcon, BookOpen, UploadCloud, Folder as FolderIcon, Pencil, Clock, Lightbulb, Info, Laptop, FolderOpen, Image as ImageIcon, Share2, RefreshCw, AlertTriangle, Rows3, Globe, MessageSquare, Sparkles, GitFork, TextQuote, CornerDownLeft, GitPullRequest, Zap, Shield } from 'lucide-react'
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
import DwMark from '@/components/DwMark'
import TermPanel from '@/components/TermPanel'
import BeardBand, { BandItem } from '@/components/BeardBand'
import { LightboxImage } from '@/components/Lightbox'
import { filePillSvg } from '@/components/filePillIcons'
import WakePersona from '@/components/WakePersona'
import ThinkingPersona from '@/components/ThinkingPersona'
import UserAttachments, { IMAGE_RE } from '@/components/UserAttachments'
import { extractRepos } from '@/lib/repos'
import { type QuoteAttachment } from '../../shared/quotes'
import QuoteChip from '@/components/QuoteChip'
import { cn, fmtTime } from '@/lib/utils'
import { ATTACH_MENU_ICONS, MODE_INFO_ICON, MODE_CHECK_ICON, MENU_CHEVRON_ICON } from '@/lib/officialMenuIcons'
import { PanelAddTabIcon, PanelAttachmentsIcon, PanelCloseTabIcon, PanelFullWidthIcon, PanelHideTabsIcon, PanelPullRequestIcon } from '@/components/panelTabIcons'
import { readTreeCache, type MirrorTreeSession, type TreeCachePayload, writeTreeCache } from './mirror/treeCache'
import { prefetchSession, visitorTabs, type SessionDetail, tlSnapshots, messagesFromItems, type LocalCfg, EFFORT_SUFFIX_RE, modeOfVersion, speedOfVersion, type ShareMeta, defaultTabs, CommandPalette, TimelineSkeleton, LOCAL_MODE_ICONS, VERSION_LABEL, versionOf } from './mirror/pageBits'
import { type PanelKey, PANELS, findItemText, parseOfficialTab, serializeOfficialTab, useUrlParamSync, ADD_TAB_ORDER, prNumber, type PanelIcon } from './mirror/panelTabs'
import { type TimelinePage, preview, mergeItems, groupItems, time, rowClock, clock, COACH_RECOMMENDATIONS, COACH_ACTIONS } from './mirror/timelineUtil'
import { reduceStatus, stText } from './mirror/statusReduce'
import { type ComposerMetaT, type SuggestItem, AT_CATEGORIES, QUEUE_DASHED_SVG, QUEUE_DRAG_SVG, QUEUE_PLACEHOLDER } from './mirror/composerMeta'
import { type TreePrefs, TREE_PREFS_KEY, DEFAULT_TREE_PREFS, buildFilterQ, SessionTree } from './mirror/SessionTree'
import DirPicker from './mirror/DirPicker'
import LocalPicker, { type DraftTarget } from './mirror/LocalPicker'
import CodeView from '@/components/CodeView'
import { type WfAgentEventState, AgentsPanel } from './mirror/AgentsPanel'
import { SessionSettingsGlyph, HeaderMenuPortal, AwaitingInstructionsGlyph, ApiOriginGlyph, OfficialGlyph, BubblePlusGlyph, CloseQuoteGlyph } from './mirror/glyphs'
import { PermissionCard, PermissionSidebarPanel } from './mirror/Permission'
import { EventRow, WorkGroup } from './mirror/TimelineRows'
import ModelPicker from './mirror/ModelPicker'
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
// Per-session cfg cache — session A's config must never warm-start session B
// (module-level sharing was the "previous model / Ultra" flash on navigation).
const lastSeenCfgBySid = new Map<string, LocalCfg>()

/* Official dark-quote tokens (verbatim from app.devin.ai .dark scope):
   wax bg rgb(31,31,31,.94)+blur, border white/.04, text white/.9, hint /.52. */
const QWAX = 'rgb(31 31 31 / 0.94)'
const QBORDER = 'rgb(255 255 255 / 0.04)'
const QBORDER_FOCUS = 'rgb(255 255 255 / 0.08)'
const QTEXT = 'rgb(255 255 255 / 0.9)'
const QTINT = 'rgb(255 255 255 / 0.05)'

/** Queue-row preview: stored queue text is the raw wire string — it can carry
 *  <quoted_artifact …> XML wrappers, ATTACHMENT:"url" marker lines and multi-line
 *  bodies. Render a readable one-line summary instead of raw markup. */
function queuePreview(raw: string): string {
  let s = raw
  s = s.replace(/<quoted_artifact\b[^>]*>([\s\S]*?)<\/quoted_artifact>/g, (_m, inner: string) => {
    const cap = inner.match(/<caption>([\s\S]*?)<\/caption>/)?.[1]?.trim()
    const body = inner.match(/<content>([\s\S]*?)<\/content>/)?.[1]?.trim()
    const excerpt = (cap || body || '').split('\n')[0].slice(0, 60)
    return excerpt ? `❝${excerpt}❞` : ''
  })
  s = s.replace(/^ATTACHMENT:"?([^"\n]+)"?\s*$/gm, '[附件] $1')
  s = s.replace(/<[^>]+>/g, '')
  return s.replace(/\s+/g, ' ').trim()
}

/** Floating quote affordance — official SelectionQuoteAffordance, two states:
 *  minimal  = dark pill above the anchor, [bubble-plus=Add caption]
 *             [close-quote-2=Add to chat ⏎]; typing begins the caption.
 *  expanded = the official 360px wax card: quoted-text preview header,
 *             caption input (min-h 28), footer split button
 *             [Add to chat | ▾ → Send immediately ⌘⏎]. Enter commits,
 *             ⌘/Ctrl+Enter sends immediately, Esc dismisses. */
function QuotePill({ x, y, placement = 'above', hidden, startExpanded, quoteText, onCommit, onSend, onClose }: {
  x: number; y: number; placement?: 'above' | 'below'; hidden?: boolean; startExpanded?: boolean; quoteText?: string
  onCommit: (caption: string) => void; onSend?: (caption: string) => void; onClose: () => void
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(!!startExpanded)
  const [caption, setCaption] = useState('')
  const [sendMenu, setSendMenu] = useState(false)
  const capRef = useRef<HTMLInputElement>(null)
  const cardRef = useRef<HTMLFormElement>(null)
  const [cardH, setCardH] = useState(0)
  useEffect(() => { if (expanded) capRef.current?.focus() }, [expanded])
  // Official card geometry: top = anchor - measuredHeight when 'above' (the
  // anchor point is the layer origin; gap 6 already folded into y).
  useLayoutEffect(() => { if (expanded && cardRef.current) setCardH(cardRef.current.getBoundingClientRect().height) })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        if (onSend) { e.preventDefault(); onSend(caption.trim()); return }
      }
      if (expanded) return
      if (e.key === 'Enter') { e.preventDefault(); onCommit(caption); return }
      if (e.key.length === 1 && !/\p{C}/u.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        setExpanded(true); setCaption(e.key)
      }
    }
    // Official: while the pill is up, a plain-text paste becomes the caption
    // (file clipboard items are ignored).
    const onPaste = (e: ClipboardEvent) => {
      if ([...(e.clipboardData?.items ?? [])].some((i) => i.kind === 'file')) return
      const txt = e.clipboardData?.getData('text/plain')
      if (txt) { e.preventDefault(); e.stopPropagation(); setExpanded(true); setCaption(txt) }
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('paste', onPaste, true)
    return () => { document.removeEventListener('keydown', onKey, true); document.removeEventListener('paste', onPaste, true) }
  }, [expanded, caption, onCommit, onSend, onClose])
  const iconBtn = 'flex h-6 w-6 items-center justify-center rounded-md'
  return (
    <div
      className="dw-quote-pill fixed left-0 top-0 z-50 select-none"
      style={{
        transform: `translate(${x}px, ${expanded ? (placement === 'above' ? y - cardH : y) : (placement === 'above' ? y - 28 : y)}px)`,
        transformOrigin: placement === 'above' ? 'center bottom' : 'center top',
        visibility: hidden ? 'hidden' : undefined,
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {expanded ? (
        /* Official expanded card: 360px wax, r12, border secondary, blur, p6 gap10 */
        <form
          ref={cardRef}
          className="dark w-[360px] overflow-hidden rounded-[12px] border backdrop-blur"
          style={{ background: QWAX, borderColor: sendMenu ? QBORDER_FOCUS : QBORDER, color: QTEXT }}
          onSubmit={(e) => { e.preventDefault(); onCommit(caption.trim()) }}
        >
          <div className="flex flex-col" style={{ padding: 6, gap: 10 }}>
            {quoteText && (
              <div className="line-clamp-3 text-[12px] leading-4" style={{ color: 'rgb(255 255 255 / 0.52)' }}>
                {quoteText}
              </div>
            )}
            <input
              ref={capRef}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onCommit(caption.trim()) }
                if (e.key === 'Escape') { e.preventDefault(); setCaption(''); onClose() }
                e.stopPropagation()
              }}
              placeholder={t('quote.captionPh')}
              className="min-h-7 w-full bg-transparent text-[13px] leading-5 outline-none"
              style={{ color: QTEXT }}
            />
            <div className="flex h-7 items-stretch justify-end">
              {onSend ? (
                /* Official split button: [Add to chat][|][▾ → Send immediately ⌘⏎] */
                <div className="relative flex items-stretch rounded-[6px] border" style={{ borderColor: QBORDER_FOCUS, background: QTINT }}>
                  <button
                    type="submit"
                    className="rounded-l-[5px] px-2 text-[13px] hover:bg-[rgb(255_255_255/0.08)]"
                    style={{ color: QTEXT }}
                  >{t('quote.addToChat')}</button>
                  <div className="w-px" style={{ background: QBORDER_FOCUS }} />
                  <button
                    type="button"
                    aria-label={t('quote.moreOptions')}
                    className="flex w-6 items-center justify-center rounded-r-[5px] hover:bg-[rgb(255_255_255/0.08)]"
                    style={{ color: QTEXT }}
                    onClick={() => setSendMenu((v) => !v)}
                  >
                    <ChevronDown size={13} />
                  </button>
                  {sendMenu && (
                    <div className="absolute right-0 top-[30px] z-10 min-w-[180px] rounded-lg border p-1 shadow-md" style={{ background: QWAX, borderColor: QBORDER, backdropFilter: 'blur(8px)' }}>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1 text-left text-[13px] hover:bg-[rgb(255_255_255/0.05)]"
                        style={{ color: QTEXT }}
                        onClick={() => onSend(caption.trim())}
                      >
                        <span>{t('quote.sendImmediately')}</span>
                        <kbd className="flex gap-0.5 text-[10px]" style={{ color: 'rgb(255 255 255 / 0.52)' }}>⌘⏎</kbd>
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <button type="submit" className="rounded-[6px] px-2 text-[13px] hover:bg-[rgb(255_255_255/0.08)]" style={{ color: QTEXT, background: QTINT }}>
                  {t('quote.addToChat')}
                </button>
              )}
            </div>
          </div>
        </form>
      ) : (
        /* Official minimal pill (verbatim `ht` class): h-7 gap-px rounded-8
           p-0.5, bg-elevated, shadow-L1, ring-inset border-secondary */
        <div
          className="flex h-7 min-w-fit items-center gap-px whitespace-nowrap rounded-[8px] p-0.5 shadow-[0_1px_2px_0_rgba(0,0,0,0.2)] ring-1 ring-inset ring-[rgb(255_255_255/0.04)]"
          style={{ background: 'rgb(31 31 31)', color: QTEXT }}
        >
          <button
            type="button"
            title={`${t('quote.addCaption')} — ${t('quote.startTyping')}`}
            aria-label={t('quote.addCaption')}
            className={iconBtn}
            style={{ color: QTEXT }}
            onMouseOver={(e) => (e.currentTarget.style.background = QTINT)}
            onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
            onClick={() => setExpanded(true)}
          >
            <BubblePlusGlyph className="size-4" />
          </button>
          <button
            type="submit"
            title={`${t('quote.addToChat')} ⏎`}
            aria-label={t('quote.addToChat')}
            className={iconBtn}
            style={{ color: QTEXT }}
            onMouseOver={(e) => (e.currentTarget.style.background = QTINT)}
            onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
            onClick={() => onCommit(caption.trim())}
          >
            <CloseQuoteGlyph className="size-4" />
          </button>
        </div>
      )}
    </div>
  )
}

// Official composer collapse (decoded from the deob'd bundle — kE/OE/DE):
// the toolbar row reports clientWidth; the collapsible "leading" cluster
// reports scrollWidth−clientWidth overflow. overflow>1 → level+1, recording
// the width that level needed (hysteresis, so levels don't flicker); when the
// row later has room for the recorded need → level−1. A 200ms cooldown
// between escalations prevents thrash. RO watches the row, the cluster, and
// every cluster child (MutationObserver keeps the child set current).
function useCollapseLevel(toolbarEl: HTMLElement | null, leadingEl: HTMLElement | null, maxLevel = 3): number {
  const [level, setLevel] = useState(0)
  const st = useRef({ level: 0, requiredAt: [] as (number | undefined)[], cooldown: 0, timer: 0 })
  const measureRef = useRef<() => void>(() => {})
  useLayoutEffect(() => {
    const s = st.current
    if (!toolbarEl || !leadingEl) {
      s.level = 0
      s.requiredAt = []
      setLevel(0)
      return
    }
    const measure = () => {
      const available = toolbarEl.clientWidth
      if (available <= 0) return
      const overflow = leadingEl.scrollWidth - leadingEl.clientWidth
      const now = Date.now()
      const cooling = now < s.cooldown
      if (cooling) {
        // During cooldown escalations are capped at the current level; a
        // deferred re-measure runs right after the cooldown ends.
        window.clearTimeout(s.timer)
        s.timer = window.setTimeout(() => measureRef.current(), s.cooldown - now + 25)
      }
      const cap = cooling ? s.level : maxLevel
      if (overflow > 1 && s.level < cap) {
        s.requiredAt[s.level] = available + overflow
        s.level += 1
        s.cooldown = now + 200
        setLevel(s.level)
      } else if (s.level > 0) {
        const need = s.requiredAt[s.level - 1]
        if (need === undefined || available >= need) {
          s.requiredAt[s.level - 1] = undefined
          s.level -= 1
          setLevel(s.level)
        }
      }
    }
    measureRef.current = measure
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(toolbarEl)
    ro.observe(leadingEl)
    const seen = new Set<Element>()
    const watchChildren = () => {
      for (const el of seen) if (!leadingEl.contains(el)) { ro.unobserve(el); seen.delete(el) }
      for (const el of Array.from(leadingEl.children)) if (!seen.has(el)) { ro.observe(el); seen.add(el) }
    }
    watchChildren()
    const mo = new MutationObserver(() => { watchChildren(); measure() })
    mo.observe(leadingEl, { childList: true })
    return () => { ro.disconnect(); mo.disconnect(); window.clearTimeout(s.timer) }
  }, [toolbarEl, leadingEl, maxLevel])
  return level
}

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
  // Draft workspace pick (desktop parity: new session lets you choose the repo).
  const [draftCwd, setDraftCwd] = useState('')
  // Draft run target — local or `本地+SSH` (agent CLI on a configured remote
  // host). Persisted like the desktop target pick; remote cwd is free text
  // (no remote fs browse).
  const [draftTarget, setDraftTargetState] = useState<DraftTarget>(() => {
    try {
      const p = JSON.parse(localStorage.getItem('dw-draft-target') ?? 'null')
      if (p?.kind === 'ssh' && typeof p.host?.target === 'string' && p.host.target) return p as DraftTarget
    } catch { /* unavailable */ }
    return { kind: 'local' }
  })
  const [draftSshCwd, setDraftSshCwd] = useState('')
  const setDraftTarget = useCallback((v: DraftTarget) => {
    setDraftTargetState(v)
    try { localStorage.setItem('dw-draft-target', JSON.stringify(v)) } catch { /* unavailable */ }
  }, [])
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
  // 分身: per-session mode + escalation flag, ridden on the /timeline response.
  const [persona, setPersona] = useState<{ mode: string; escalated: boolean } | null>(null)
  const [personaBusy, setPersonaBusy] = useState(false)
  const [draftAgent, setDraftAgent] = useState('devin')
  const [agentMenuOpen, setAgentMenuOpen] = useState(false)
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
  const treeIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => { treeIdsRef.current = new Set(tree.map((s) => s.devin_id)) }, [tree])
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
    (localStorage.getItem('dw-send-with') === 'ctrlenter' ? 'ctrlenter' : 'enter'))
  // While a turn is in flight: does Enter/Ctrl+Enter park the message in the
  // queue ('queue', official default) or interrupt the live turn ('interrupt')?
  const [workSend] = useState<'queue' | 'interrupt'>(() =>
    (localStorage.getItem('dw-work-send') === 'interrupt' ? 'interrupt' : 'queue'))
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
    if (isDraft) { setLocalCfg(lastSeenLocalCfg); setCfgFetched(lastSeenLocalCfg?.model != null); return }
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
        setCfgFetched(true)
      })
      .catch(() => {})
  }, [isDraft, isVisitor])
  // Config picks made in draft mode — replayed onto the session right after
  // creation (the server also applies dw.json lastConfig on its own).
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
  const [voiceRecording, setVoiceRecording] = useState(false)
  const [sending, setSending] = useState(false)
  const [uploading, setUploading] = useState(false)
  const uploadsInFlight = useRef(0)
  const [attachOpen, setAttachOpen] = useState(false)
  const attachMenuRef = useRef<HTMLDivElement | null>(null)
  // Composer pill collapse — official overflow-hysteresis (see useCollapseLevel):
  //   0 full labels · 1 icons only · 2 mode+model move into the "+" menu ·
  //   3 context meter joins them too (mirrors the mobile "+" menu).
  const [pillRowEl, setPillRowEl] = useState<HTMLDivElement | null>(null)
  const [pillGroupEl, setPillGroupEl] = useState<HTMLDivElement | null>(null)
  const pillTier = useCollapseLevel(pillRowEl, pillGroupEl, 3)
  const attachBtnRef = useRef<HTMLButtonElement | null>(null)
  // Pill menus portal to body (the pill group clips overflow for collapse
  // measurement, so in-tree absolute menus would be cut off).
  const sModeBtnRef = useRef<HTMLButtonElement | null>(null)
  const modelBtnRef = useRef<HTMLButtonElement | null>(null)
  const sendOptBtnRef = useRef<HTMLButtonElement | null>(null)
  const agentBtnRef = useRef<HTMLButtonElement | null>(null)
  // Card element for portaling popups that must paint above the card — the
  // card is `overflow-hidden` AND lives under the BeardBand `relative z-30`
  // stacking context, so any in-tree popup is both clipped and out-z'd.
  const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null)

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
  const loadTreeRef = useRef(loadTree)
  loadTreeRef.current = loadTree

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
    const load = (fresh = false, retryN = 0) => {
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
    let treeMissTimer: number | null = null
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
      // Sidebar status pushes — patch the matching tree row in place for ANY
      // session (this filter otherwise drops every non-current event).
      if (ev.type === 'session_status' && typeof ev.sessionId === 'string') {
        const sid = ev.sessionId
        const st = typeof ev.status === 'string' ? ev.status : 'blocked'
        setTree((prev) => prev.map((s) =>
          s.devin_id === sid && s.status_enum !== 'archived'
            ? { ...s, status_enum: st, activity_status: st === 'working' ? 'working' : 'idle' }
            : s,
        ))
        // Status for a session the tree doesn't list (created by another
        // client or beyond the loaded page) — one debounced list refresh.
        if (!treeIdsRef.current.has(sid)) {
          if (treeMissTimer == null) treeMissTimer = window.setTimeout(() => { treeMissTimer = null; if (alive) loadTreeRef.current() }, 2000)
        }
        return
      }
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
      if (treeMissTimer != null) clearTimeout(treeMissTimer)
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

  // Selection → quote draft (official SelectionQuoteAffordance, message-text
  // scope): select text inside a message bubble → floating pill → click adds
  // it to the composer as a quote chip; send() serializes drafts into
  // <quoted_artifact> markup so the round-trip renders real QuoteChips.
  type DraftQuote = QuoteAttachment & { author: 'user' | 'devin'; endEventId?: string }
  const [selQuote, setSelQuote] = useState<{ x: number; y: number; text: string; eventId: string; author: 'user' | 'devin'; tsMs?: number; expanded?: boolean; kind?: 'message' | 'worklog'; endEventId?: string; placement?: 'above' | 'below'; hidden?: boolean } | null>(null)
  const [draftQuotes, setDraftQuotes] = useState<DraftQuote[]>([])
  const quoteGuardUntil = useRef(0)
  const quoteDraftFrom = (q: { text: string; eventId: string; author: 'user' | 'devin'; tsMs?: number; kind?: 'message' | 'worklog'; endEventId?: string }, caption: string): DraftQuote => ({
    kind: q.kind ?? 'message',
    label: q.kind === 'worklog' ? 'Worklog' : q.author === 'devin' ? 'Devin message' : 'User message',
    text: q.text, eventId: q.eventId, tsMs: q.tsMs, author: q.author,
    ...(q.endEventId ? { endEventId: q.endEventId } : {}),
    ...(caption ? { caption } : {}),
  } as DraftQuote)
  const stageQuoteDraft = (q: { text: string; eventId: string; author: 'user' | 'devin'; tsMs?: number; kind?: 'message' | 'worklog'; endEventId?: string }, caption: string) => {
    setDraftQuotes((d) => d.some((x) => x.eventId === q.eventId && x.text === q.text) ? d : [...d, quoteDraftFrom(q, caption)])
    window.getSelection()?.removeAllRanges()
  }
  useEffect(() => {
    if (isVisitor || isDraft || isSub) { setSelQuote(null); return }
    const onSel = () => {
      const sel = window.getSelection()
      // Toolbar-opened quotes (expanded pill) outlive the selection collapse
      // that clicking the toolbar button itself fires; and while focus lives
      // inside the pill (caption input), collapses don't dismiss it either.
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        if (Date.now() > quoteGuardUntil.current && !document.activeElement?.closest?.('.dw-quote-pill')) setSelQuote(null)
        return
      }
      quoteGuardUntil.current = 0
      const node = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement
      const host = node?.closest?.('[data-eid]')
      if (!host) { setSelQuote(null); return }
      const range = sel.getRangeAt(0)
      // Official Bt/Wt/Ut port: anchor rect from getClientRects (≤3.5-line
      // spans anchor above the whole block; else backwards→start-above,
      // forwards→end-below), left-edge horizontal clamp (margin 8, gap 6),
      // pill size {w53,h28}, hidden when the anchor rect leaves every
      // overflow ancestor's vertical band.
      const quoteAnchor = (): { x: number; y: number; placement: 'above' | 'below'; hidden: boolean } => {
        const rects = range.getClientRects()
        const r0 = rects[0]; const rN = rects[rects.length - 1]
        const an = sel.anchorNode; const fn = sel.focusNode
        const backwards = !!an && !!fn && (an === fn ? sel.focusOffset < sel.anchorOffset : !!(an.compareDocumentPosition(fn) & Node.DOCUMENT_POSITION_PRECEDING))
        let ar: { top: number; bottom: number; left: number }; let above: boolean
        if (!r0 || !rN) { const b = range.getBoundingClientRect(); ar = { top: b.top, bottom: b.bottom, left: b.left }; above = backwards }
        else if (r0 !== rN && rN.bottom - r0.top <= Math.max(r0.height, rN.height) * 3.5) { ar = { top: r0.top, bottom: rN.bottom, left: r0.left }; above = true }
        else if (backwards) { ar = { top: r0.top, bottom: r0.bottom, left: r0.left }; above = true }
        else { ar = { top: rN.top, bottom: rN.bottom, left: rN.right }; above = false }
        const M = 8, G = 6, PW = 53, PH = 28
        const x = Math.min(Math.max(ar.left, M), window.innerWidth - M - PW)
        const fitsAbove = ar.top - G - PH >= M; const fitsBelow = ar.bottom + G + PH <= window.innerHeight - M
        const placement: 'above' | 'below' = above ? (fitsAbove || !fitsBelow ? 'above' : 'below') : (fitsBelow || !fitsAbove ? 'below' : 'above')
        const y = placement === 'above' ? ar.top - G : ar.bottom + G
        let hidden = false
        for (let el = (range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement); el; el = el.parentElement) {
          if (getComputedStyle(el).overflowY === 'visible') continue
          const er = el.getBoundingClientRect()
          if (ar.bottom <= er.top || ar.top >= er.bottom) { hidden = true; break }
        }
        return { x, y, placement, hidden }
      }
      const eid = host.getAttribute('data-eid')
      const item = allItemsRef.current.find((it) => it.id === eid)
      // Official second mechanism: selections spanning worklog rows resolve
      // to a kind:'worklog' quote over the [start,end) event-id range.
      if (!item || item.kind !== 'message') {
        const anchors = [...document.querySelectorAll<HTMLElement>('[data-quote-anchor]')]
          .filter((a) => range.intersectsNode(a))
        if (anchors.length >= 1 && item?.kind !== 'message') {
          const first = anchors[0].getAttribute('data-quote-anchor')
          const last = anchors[anchors.length - 1].getAttribute('data-quote-anchor')
          const text = sel.toString().replace(/\s+/g, ' ').trim()
          const pos = quoteAnchor()
          if (text && first && last) {
            setSelQuote({ ...pos, text, eventId: first, endEventId: last, author: 'devin', kind: 'worklog' })
            return
          }
        }
        setSelQuote(null); return
      }
      // Official extraction (xt): clone the range offscreen and strip
      // .select-none UI chrome (badges, action bars) before taking text.
      const frag = sel.getRangeAt(0).cloneContents()
      let text: string
      if (!frag.querySelector('.select-none')) text = sel.toString().replace(/\s+/g, ' ').trim()
      else {
        const off = host.ownerDocument.createElement('div')
        off.style.cssText = 'position:fixed;left:-99999px;top:0'
        off.appendChild(frag)
        off.querySelectorAll('.select-none').forEach((n) => n.remove())
        text = (off.innerText || '').replace(/\s+/g, ' ').trim()
        off.remove()
      }
      if (!text) { setSelQuote(null); return }
      const pos = quoteAnchor()
      setSelQuote({
        ...pos,
        text,
        eventId: eid!,
        author: item.role === 'user' ? 'user' : 'devin',
        tsMs: Date.parse(item.ts) || undefined,
      })
    }
    document.addEventListener('selectionchange', onSel)
    window.addEventListener('pointerup', onSel)
    return () => { document.removeEventListener('selectionchange', onSel); window.removeEventListener('pointerup', onSel) }
  }, [isVisitor, isDraft, isSub])

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
    node.classList.add('dw-find-hit')
    return () => node.classList.remove('dw-find-hit')
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
        reportSendError(e, 'Failed to send message. Try again.')
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
        const task = text.startsWith('/queue ') ? text.slice(7).trim() : text
        const r = await adminFetch<{ ok: boolean; id?: string; error?: string }>('/api/admin/sessions/new', {
          method: 'POST',
          body: JSON.stringify({
            task,
            folder: draftFolder || undefined,
            // Local target → picked dir (empty = server default). SSH target →
            // the remote dir (text input falls back to the host's default).
            cwd: draftTarget.kind === 'ssh' ? (draftSshCwd.trim() || draftTarget.host.cwd || undefined) : (draftCwd || undefined),
            ssh: draftTarget.kind === 'ssh' ? draftTarget.host.target : undefined,
            agent: draftAgent,
            attachments: staged.map((f) => ({ url: f.url, name: f.name, size: f.size })),
          }),
        })
        if (!r.ok || !r.id) throw new Error(r.error || 'create failed')
        for (const pick of draftPicks.current) {
          void adminFetch(`/api/admin/session/${r.id}/config`, { method: 'POST', body: JSON.stringify(pick) }).catch(() => null)
        }
        draftPicks.current = []
        setInput(''); setStaged([])
        nav(`/admin/${r.id}`, { replace: true })
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
          setSendErr('Failed to switch model')
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
      reportSendError(e, 'Failed to send message. Try again.')
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
      reportSendError(e, 'Failed to send message. Try again.')
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
      reportSendError(e, 'Failed to send message. Try again.')
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
      reportSendError(e, 'Failed to submit answer. Try again.')
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

  // Model pill — one render shared by the toolbar right cluster (sessions;
  // collapse tiers drive icon/text) and the draft chin row (always text).
  const modelPillEl = (alwaysText: boolean) => {
    const iconMode = !alwaysText && pillTier >= 1
    return (
      <div className="relative">
        <button
          ref={modelBtnRef}
          onClick={() => { setModeOpen((v) => !v); setSModeOpen(false) }}
          aria-label="Select mode"
          title={modelPillLabel ?? (cfgFetched ? (VERSION_LABEL[pillVersion] ?? pillVersion) : '…')}
          className={cn('flex h-7 cursor-pointer items-center overflow-hidden whitespace-nowrap rounded-full text-[13px] leading-[18px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground', iconMode ? 'size-7 justify-center' : 'max-w-[240px] gap-[3px] px-[6px]', modeOpen && 'bg-tint-secondary text-foreground')}
        >
          {iconMode && <Sparkles size={18} className="shrink-0" />}
          {!iconMode && <span className="min-w-0 truncate">{modelPillLabel ?? (cfgFetched ? (VERSION_LABEL[pillVersion] ?? pillVersion) : '…')}</span>}
        </button>
        {modeOpen && <div className="fixed inset-0 z-10" onClick={() => setModeOpen(false)} />}
        {modeOpen && modelBtnRef.current && createPortal(
          <div role="menu" style={{ bottom: window.innerHeight - modelBtnRef.current.getBoundingClientRect().top + 6, right: window.innerWidth - modelBtnRef.current.getBoundingClientRect().right, maxHeight: modelBtnRef.current.getBoundingClientRect().top - 14 }} className={cn('fixed z-50 flex flex-col overflow-hidden rounded-[10px] bg-[rgba(255,255,255,0.94)] shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)] outline outline-1 outline-black/[0.06] backdrop-blur-[8px] dark:bg-[#1f1f1f]/[0.94] dark:outline-white/[0.06] [transition:transform_40ms_cubic-bezier(0.76,0,0.24,1),scale_40ms_cubic-bezier(0.76,0,0.24,1),opacity_40ms_cubic-bezier(0.76,0,0.24,1)]', localCfg?.model ? 'w-[248px] max-h-[70vh]' : 'w-[220px]', cfgFetched && !localCfg?.model ? 'h-[193px]' : '')}>
            <div className={cn('min-h-0 flex-1', localCfg?.model ? 'overflow-y-auto' : 'overflow-hidden p-1')}>
            {localCfg?.model ? (
              <ModelPicker
                model={localCfg.model}
                effortGroup={effortGroup}
                speedGroup={speedGroup}
                extraGroups={extraGroups}
                onPick={chooseLocalOption}
                onPickMulti={chooseLocalOptions}
                onClose={() => setModeOpen(false)}
              />
            ) : !cfgFetched ? (
              <div className="flex h-[30px] items-center px-3 text-[13px] text-muted-foreground">{t('common.loading')}</div>
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
              <span className="flex flex-1 items-center gap-1">Fusion <span className="cursor-pointer text-[13px] text-blue-500">{t('am.preview')}</span></span>
            </button>
            <div role="separator" className="mx-2 my-1 h-px bg-border" />
            <div className="flex items-center gap-1.5 px-2 py-[5px] pl-[34px]">
              <span className="flex-1 text-[12px] font-medium text-muted-foreground">{t('am.capability')}</span>
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
          </div>,
          document.body,
        )}
      </div>
    )
  }

  // Draft agent picker — the outermost layer's bottom-right control (chin),
  // chromeless like the model pill per the official text-button treatment.
  const agentPillEl = isDraft && !isVisitor ? (
    <div className="relative shrink-0">
      <button
        ref={agentBtnRef}
        onClick={() => setAgentMenuOpen((v) => !v)}
        title={t('draft.agentPick')}
        className={cn('flex h-7 shrink-0 cursor-pointer items-center gap-[3px] overflow-hidden whitespace-nowrap rounded-full px-[6px] text-[13px] leading-[18px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground', agentMenuOpen && 'bg-tint-secondary text-foreground')}
      >
        <Sparkles size={14} className="shrink-0" />{composerMeta?.agents?.find((a) => a.id === draftAgent)?.label ?? draftAgent}
        <ChevronDown size={11} className="shrink-0 opacity-60" />
      </button>
      {agentMenuOpen && agentBtnRef.current && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setAgentMenuOpen(false)} />
          {createPortal(
            <div role="menu" style={{ bottom: window.innerHeight - agentBtnRef.current.getBoundingClientRect().top + 8, right: window.innerWidth - agentBtnRef.current.getBoundingClientRect().right, maxHeight: agentBtnRef.current.getBoundingClientRect().top - 14 }} className="fixed z-50 w-[220px] overflow-y-auto rounded-[10px] bg-card shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1)] outline outline-1 outline-black/[0.06] dark:outline-white/[0.06]">
            <div className="p-1">
              {(composerMeta?.agents ?? [{ id: 'devin', label: 'Devin Local' }]).map((a) => (
                <button
                  key={a.id}
                  role="menuitem"
                  onClick={() => { setDraftAgent(a.id); setAgentMenuOpen(false) }}
                  className="flex w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] hover:bg-accent"
                >
                  <Sparkles size={13} className="text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{a.label}</span>
                  {a.id === draftAgent && <Check size={13} className="shrink-0" />}
                </button>
              ))}
            </div>
            <p className="border-t border-border/40 px-3 py-1.5 text-[11px] leading-[14px] text-muted-foreground">
              {t('draft.agentHint')}
            </p>
          </div>,
          document.body,
          )}
        </>
      )}
    </div>
  ) : null

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
          <h1 className="min-w-0 flex-1 truncate text-[13px] leading-[18px] max-md:min-w-[120px]">{isDraft ? t('menu.newSession') : current?.title || current?.devin_title || detail?.session.title || t('menu.sessionMirror')}</h1>
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
                      {folderOrder.length === 0 && <p className="px-2 py-1.5 text-[12px] text-muted-foreground">{t('tree.noFolders')}</p>}
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
                  {detail.session.archived ? <><OArchive size={14} className="text-muted-foreground" /> {t('sp.unarchive')}</> : <><OArchive size={14} className="text-muted-foreground" /> {t('sp.archive')}</>}
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
                    Cognition and returns an app.devin.ai share URL. Devin-private
                    extension — hidden for sessions owned by other agents. */}
                {!isSub && isDevinSession && <button
                  role="menuitem"
                  onClick={async () => {
                    setSettingsOpen(false); setSettingsSub('none')
                    if (!confirm(t('menu.shareToCloudConfirm'))) return
                    const r = await adminFetch<{ ok: boolean; url?: string; error?: string }>(`/api/admin/session/${id}/share`, { method: 'POST', body: JSON.stringify({}) }).catch(() => null)
                    if (r?.ok && r.url) { navigator.clipboard.writeText(r.url); setControlMsg(t('menu.sharedOk', { url: r.url })) }
                    else setControlMsg(r?.error || 'Share failed')
                  }}
                  className={settingsRowCls}
                >
                  <Share2 size={13} className="text-muted-foreground" /> {t('menu.shareToCloud')}
                </button>}
                {/* Fork — native session/fork on agents that advertise it
                    (opencode), transcript-seed fallback on devin. Dedicated
                    agents report canFork:false and the item hides. */}
                {!isSub && detail.session.canFork && <button
                  role="menuitem"
                  onClick={async () => {
                    setSettingsOpen(false); setSettingsSub('none')
                    const r = await adminFetch<{ ok: boolean; id?: string; error?: string }>(`/api/admin/session/${id}/fork`, { method: 'POST', body: JSON.stringify({}) }).catch(() => null)
                    if (r?.ok && r.id) nav(`/admin/${r.id}`)
                    else setControlMsg(r?.error || t('menu.forkFailed'))
                  }}
                  className={settingsRowCls}
                >
                  <GitFork size={13} className="text-muted-foreground" /> {t('menu.forkSession')}
                </button>}
                {/* Desktop "Open in new window" — each session can live in its
                    own browser window. */}
                <button
                  role="menuitem"
                  onMouseEnter={() => setSettingsSub('none')}
                  onClick={() => { setSettingsOpen(false); setSettingsSub('none'); window.open(`${window.location.origin}/admin/${id}`, '_blank', 'noopener') }}
                  className={settingsRowCls}
                >
                  <ArrowUpRight size={13} className="text-muted-foreground" /> {t('menu.openNewWindow')}
                </button>
                {!isSub && <div className="mt-1 border-t border-border px-2 pb-1 pt-2">
                  <p className="mb-1 text-[12px] text-muted-foreground">{t('visitor.permission')}</p>
                  <Combo
                    className="w-full"
                    value={detail.session.permission}
                    onPick={async (v) => {
                      await adminFetch(`/api/admin/session/${id}/permission`, { method: 'POST', body: JSON.stringify({ permission: v }) })
                      reloadDetail()
                    }}
                    options={[
                      { v: 'detailed', l: t('visitor.permDetailed') },
                      { v: 'full', l: t('visitor.permChatFile') },
                      { v: 'chat', l: t('visitor.permChat') },
                      { v: 'readonly', l: t('visitor.permReadonly') },
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
                    if (!confirm(t('menu.restartAgentConfirm'))) return
                    const r = await adminFetch<{ ok: boolean }>(`/api/admin/session/${id}/restart`, { method: 'POST', body: JSON.stringify({}) }).catch(() => null)
                    setControlMsg(r?.ok ? t('menu.agentRestarting') : t('menu.agentRestartFailed'))
                  }}
                  className={settingsRowCls}
                >
                  <RotateCcw size={13} className="text-muted-foreground" /> {t('menu.restartAgent')}
                </button>
                  </>
                )}
                {/* Verified live: {_cognition.ai/session/end} → dispatched.
                    For a sub session the server maps end → subagent cancel.
                    Devin-private extension — hidden on other agents' sessions. */}
                {(isSub || isDevinSession) && <button
                  role="menuitem"
                  onClick={async () => {
                    setSettingsOpen(false); setSettingsSub('none')
                    if (!confirm(isSub ? t('menu.endSubagentConfirm') : t('menu.endSessionConfirm'))) return
                    const r = await adminFetch<{ ok: boolean; error: string }>(`/api/admin/session/${id}/end`, { method: 'POST', body: JSON.stringify({}) }).catch(() => null)
                    setControlMsg(r?.ok ? (isSub ? t('menu.subagentCancelled') : t('menu.sessionEndSent')) : r?.error || t('menu.endFailed'))
                    reloadDetail()
                  }}
                  className={settingsRowCls}
                >
                  <Square size={13} className="text-muted-foreground" /> {isSub ? t('menu.endSubagent') : t('menu.endSession')}
                </button>}
                <div className={settingsSeparatorCls} />
                <div className="px-2 pb-1 pt-1.5 text-[12px] leading-[18px] text-muted-foreground">
                  <div className="flex justify-between"><span>{t('am.userMsgs')}</span><span className="text-foreground">{userMsgCount}</span></div>
                  {detail.session.platform && <div className="flex justify-between"><span>{t('am.platform')}</span><span className="text-foreground">{detail.session.platform}</span></div>}
                  {detail.session.subagent && <div className="flex justify-between"><span>{t('am.subagent')}</span><span className="text-foreground">{[detail.session.subagent.profile, detail.session.subagent.model].filter(Boolean).join(' · ') || detail.session.subagent.agentId}</span></div>}
                  {detail.dashboard_url && <p className="break-all pt-1 text-[11px] leading-[15px]">{t('tabs.dashboardPush')}：POST {window.location.origin}{detail.dashboard_url}</p>}
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
          className={cn('min-h-0 flex-1 overflow-y-auto pt-[20px] px-4 @[448px]/chat-pane:px-6', effShowPanel && 'max-md:hidden', isDraft && 'hidden')}
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
          <div className="mx-auto max-w-[692px]"><div className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
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
                    <div key={it.id} data-eid={it.id} data-testid="transcript-workflow-run" className="relative my-2.5 flex w-full flex-col overflow-hidden rounded-xl border border-border bg-card">
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
                <div key={g.item.id} data-eid={g.item.id} className="my-2.5 w-full min-w-0">
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
                <div key={g.item.id} data-eid={g.item.id} className="relative my-2.5 flex items-start gap-2 text-[13px] leading-[18px] text-muted-foreground">
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
                <div key={g.item.id} data-eid={g.item.id} data-message-event-id={g.item.id} data-message-author={isUser ? 'user' : 'devin'} data-message-ts={g.item.ts ? String(new Date(g.item.ts).getTime()) : undefined} data-quotable-surface className={cn('group group/message-wrapper relative my-2.5 flex flex-col gap-1', own ? 'items-end' : 'items-start')}>
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
                              <p className="text-[12px] leading-[16px] text-muted-foreground">{t('am.original')}</p>
                              <Markdown text={text} rewriteUrl={(u) => attachmentUrl(id, u, mediaTok)} onFileRef={onFileRef} />
                              <p className="text-[12px] leading-[16px] text-muted-foreground">{t('am.translation')}</p>
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
                      try { localStorage.setItem('dw-new-session-draft', g.item.body || '') } catch { /* quota */ }
                      nav('/admin/new')
                    } : undefined}
                    onQuote={!isVisitor && caps.canSendMessage && !isSub ? () => {
                      // Whole-message quote — official's second entry point:
                      // hover toolbar ❝ opens the same pill pre-expanded at
                      // the message row's top edge.
                      const host = document.querySelector(`[data-eid="${CSS.escape(g.item.id)}"]`)
                      const r = host?.getBoundingClientRect()
                      const bodyText = (g.item.body || '').replace(/<quoted_artifact[\s\S]*?<\/quoted_artifact>/g, '').trim().slice(0, 4000)
                      if (!bodyText || !r) return
                      quoteGuardUntil.current = Date.now() + 800
                      setSelQuote({ x: Math.min(Math.max(r.left, 8), window.innerWidth - 8 - 360), y: r.top - 6, placement: 'above', text: bodyText, eventId: g.item.id, author: g.item.role === 'user' ? 'user' : 'devin', tsMs: g.item.ts ? Date.parse(g.item.ts) : undefined, expanded: true })
                    } : undefined}
                    onFork={!isVisitor && detail?.session.canFork && !isSub ? () => {
                      void (async () => {
                        const r = await adminFetch<{ ok: boolean; id?: string; error?: string }>(`/api/admin/session/${id}/fork`, { method: 'POST', body: JSON.stringify({ anchor: g.item.id }) }).catch(() => null)
                        if (r?.ok && r.id) nav(`/admin/${r.id}`)
                        else setControlMsg(r?.error || t('menu.forkFailed'))
                      })()
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
                <span className="min-h-[17px] text-[13px] leading-[18px]">{stText(t, statusState.tailText)}</span>
              </div>
            ) : statusState.enum === 'blocked' ? (
              <div className="my-4 flex items-center gap-2 text-[13px] leading-[18px] text-muted-foreground">
                <AwaitingInstructionsGlyph className="size-4 shrink-0 text-orange-500" />
                {stText(t, statusState.tailText)}
              </div>
            ) : ['working', 'resumed', 'restored'].includes(statusState.enum) ? (
              // Official working-status row (DOM sampled 2026-08-31): 17px animated Devin
              // persona + 13px current-action line from latest_status_contents.message.
              <div className="mb-2 mt-5 flex flex-col gap-2 text-muted-foreground">
                <div className="flex items-start gap-[6px]">
                  <ThinkingPersona />
                  <span className="min-h-[17px] text-[13px] leading-[18px]">
                    {stText(t, statusState.tailText)}
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
                  <span className="col-start-1 row-start-1 translate-y-full duration-200 group-hover:translate-y-0 motion-safe:transition-transform">{controlling ? t('menu.connecting') : stText(t, statusState.wakeText)}</span>
                </span>
              </button>
            ) : statusState.isSleeping && !isVisitor && !statusState.wakeable ? (
              <div className="mb-2 mt-5 flex items-start gap-[6px] text-muted-foreground">
                <WakePersona />
                <div className="flex flex-col">
                  <span className="min-h-[17px] text-[13px] leading-[18px]">{stText(t, statusState.shortMessage)}</span>
                  {statusState.enum === 'crashed' && detail?.session.auto_recover ? (
                    <span className="text-[12px] leading-[16px] text-muted-foreground">
                      {t('menu.autoResumed', { n: detail.session.auto_recover.attempts })}
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
                aria-label={t('am.sessionIndex')}
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
                            if (it.kind !== 'message' || !(it.body || '').trim()) { setIdxTip(null); return }
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
                            if (node) {
                              node.scrollIntoView({ block: 'start' })
                              // Official jump feedback: the landed row is marked once.
                              // (dw-find-hit is a static outline, not an animation —
                              // clear it on a timer, not animationend.)
                              node.classList.add('dw-find-hit')
                              window.setTimeout(() => node!.classList.remove('dw-find-hit'), 1600)
                            }
                          }}
                          className={cn('flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] hover:bg-accent', it.id === idxActive && 'bg-accent')}
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
                              <span className="ml-auto shrink-0 pl-2 text-[11px] text-muted-foreground">{fmtTime(it.ts)}</span>
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
                        <span className="min-w-0 flex-1 truncate pl-6 text-muted-foreground">{t('am.scrollBottom')}</span>
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

        <footer className={cn('relative max-md:z-20', effShowPanel && 'max-md:hidden')}>
          {showJump && (
            <button
              aria-label={t('am.scrollBottom')}
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
            cardRef={setCardEl}
            wrapClassName={isDraft ? 'max-w-[692px]' : undefined}
            bareCard={isDraft}
            chin={isDraft || interrupted || subDead || sendErr || controlMsg || (persona && !isVisitor && !isDraft && (persona.mode !== 'off' || persona.escalated)) || (() => {
              if (isVisitor || envBannerGone) return false
              const sug = items.find((it) => it.kind === 'env_suggestion')
              if (!sug || sug.envSuggestion?.dismissed) return false
              try { return localStorage.getItem(`env-banner-dismissed:${sug.id}`) !== '1' } catch { return true }
            })() ? (
              <>
                {sendErr && (
                  <BandItem slot="chin">
                    <div className="flex min-h-7 items-center gap-2 pl-3 pr-1 text-red-500">
                      <AlertTriangle size={12} className="shrink-0" />
                      <span className="min-w-0 flex-1 truncate text-[12px] leading-[16px]" title={sendErr}>{sendErr}</span>
                      <button
                        onClick={() => void send()}
                        className="shrink-0 cursor-pointer rounded-[6px] px-1.5 py-0.5 text-[12px] font-medium hover:bg-accent"
                      >
                        {t('common.retry')}
                      </button>
                    </div>
                  </BandItem>
                )}
                {interrupted && (
                  <BandItem slot="chin">
                    <div className="flex min-h-7 items-center gap-2 pl-3 pr-1 text-amber-600 dark:text-amber-400">
                      <AlertTriangle size={12} className="shrink-0" />
                      <span className="min-w-0 flex-1 truncate text-[12px] leading-[16px]" title={interrupted.text}>{t('composer.resumeTurn')}</span>
                      <button
                        onClick={() => void resumeInterrupted()}
                        className="shrink-0 cursor-pointer rounded-[6px] px-1.5 py-0.5 text-[12px] font-medium hover:bg-accent"
                      >
                        {interrupted.kind === 'resend' ? t('common.resend') : t('common.continue')}
                      </button>
                      <button
                        onClick={dismissInterrupted}
                        aria-label={t('composer.resumeDismiss')}
                        title={t('composer.resumeDismiss')}
                        className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-[6px] hover:bg-accent"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  </BandItem>
                )}
                {subDead && (
                  <BandItem slot="chin">
                    <div className="flex min-h-7 items-center gap-2 pl-3 pr-1 text-muted-foreground">
                      <AlertTriangle size={12} className="shrink-0" />
                      <span className="min-w-0 flex-1 truncate text-[12px] leading-[16px]">{t('tree.handleDead')}</span>
                      <button
                        onClick={() => void respawnSub()}
                        className="shrink-0 cursor-pointer rounded-[6px] px-1.5 py-0.5 text-[12px] font-medium hover:bg-accent"
                      >
                        {t('menu.spawnSuccessor')}
                      </button>
                    </div>
                  </BandItem>
                )}
                {controlMsg && (
                  <BandItem slot="chin">
                    <div className="flex min-h-7 items-center gap-2 pl-3 pr-1 text-muted-foreground">
                      <span className="min-w-0 flex-1 truncate text-[12px] leading-[16px]" title={controlMsg}>{controlMsg}</span>
                    </div>
                  </BandItem>
                )}
                {persona && !isVisitor && !isDraft && (persona.mode !== 'off' || persona.escalated) && (
                  <BandItem slot="chin">
                    <div className="flex min-h-7 items-center gap-2 pl-3 pr-1 text-muted-foreground">
                      <button
                        onClick={() => void cyclePersonaMode()}
                        title={t('persona.cycleTip')}
                        className="shrink-0 cursor-pointer rounded-full border border-border px-2 py-0.5 text-[12px] leading-[16px] hover:bg-tint-secondary"
                      >
                        🎭 {t('persona.label')} · {t(`persona.${persona.mode}`)}
                      </button>
                      {persona.escalated && (
                        <span className="flex min-w-0 items-center gap-1 text-amber-600 dark:text-amber-400">
                          <AlertTriangle size={13} className="shrink-0" />
                          <span className="truncate text-[12px] leading-[16px]">{t('persona.escalated')}</span>
                        </span>
                      )}
                      {persona.mode === 'semi' && !persona.escalated && (
                        <button
                          onClick={() => void askPersonaNow()}
                          disabled={personaBusy}
                          className="shrink-0 cursor-pointer text-[12px] underline hover:opacity-80 disabled:opacity-50"
                        >
                          {personaBusy ? t('persona.asking') : t('persona.ask')}
                        </button>
                      )}
                    </div>
                  </BandItem>
                )}
                {(() => {
                  if (isVisitor || envBannerGone) return null
                  const sug = items.find((it) => it.kind === 'env_suggestion')
                  if (!sug || sug.envSuggestion?.dismissed) return null
                  let dismissed = false
                  try { dismissed = localStorage.getItem(`env-banner-dismissed:${sug.id}`) === '1' } catch { /* unavailable */ }
                  if (dismissed) return null
                  return (
                    <BandItem slot="chin">
                      <div className="flex min-h-7 items-center gap-2 pl-3 pr-1">
                        <Lightbulb size={13} className="shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-[12px] leading-[16px]">
                          <span className="sm:hidden">{t('am.envSuggested')}</span>
                          <span className="hidden sm:inline">{t('am.envSuggestedLong')}</span>
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            const node = document.querySelector(`[data-eid="${CSS.escape(sug.id)}"]`)
                            node?.scrollIntoView({ block: 'center', behavior: 'smooth' })
                          }}
                          className="shrink-0 cursor-pointer rounded-[6px] px-1.5 py-0.5 text-[12px] font-medium text-blue-500 hover:bg-accent"
                        >
                          Review
                        </button>
                        <button
                          type="button"
                          disabled={!sug.envSuggestion?.contentsKey || envSaveState === 'sending' || envSaveState === 'done'}
                          title={sug.envSuggestion?.contentsKey ? undefined : t('panel.eventNoContents')}
                          onClick={() => {
                            const es = sug.envSuggestion
                            if (!es?.contentsKey || envSaveState === 'sending' || envSaveState === 'done') return
                            setEnvSaveState('sending')
                            adminFetch<{ ok: boolean; error: string | null }>(`/api/admin/session/${id}/env-suggestion-accept`, {
                              method: 'POST',
                              body: JSON.stringify({ event_id: sug.id, sink: es.sink, repo: es.repo, title: sug.title, summary: es.summary, contents_key: es.contentsKey, old_contents_key: es.oldContentsKey }),
                            }).then((r) => setEnvSaveState(r.ok ? 'done' : 'error')).catch(() => setEnvSaveState('error'))
                          }}
                          className={cn('shrink-0 rounded-[6px] px-1.5 py-0.5 text-[12px] font-medium', envSaveState === 'error' ? 'cursor-pointer text-red-500 hover:bg-accent' : 'text-blue-500', sug.envSuggestion?.contentsKey && envSaveState === 'idle' ? 'cursor-pointer hover:bg-accent' : envSaveState !== 'error' && 'opacity-50')}
                        >
                          {envSaveState === 'sending' ? t('common.saving') : envSaveState === 'done' ? t('menu.savedEnv') : envSaveState === 'error' ? t('menu.retrySaveEnv') : <>{t('common.save')}<span className="hidden sm:inline"> {t('menu.saveToEnvSuffix')}</span></>}
                        </button>
                        <button
                          type="button"
                          aria-label="Dismiss"
                          onClick={() => dismissEnvBanner(sug.id)}
                          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-accent hover:text-foreground"
                        >
                          <X size={13} />
                        </button>
                      </div>
                    </BandItem>
                  )
                })()}
                {isDraft && !isVisitor && (
                  // Draft chin row — official Ask-page bottom strip: run target
                  // (本地 / SSH host) + workspace picker | agent pill. Lives in
                  // the wax area, not inside the card (no divider).
                  <BandItem slot="chin">
                    <div className="flex min-h-7 w-full min-w-0 items-center gap-2 pl-2 pr-0.5">
                      <LocalPicker
                        target={draftTarget}
                        hosts={composerMeta?.ssh_hosts ?? []}
                        onChange={setDraftTarget}
                        onHosts={(h) => setComposerMeta((m) => (m ? { ...m, ssh_hosts: h } : m))}
                      />
                      {draftTarget.kind === 'ssh' ? (
                        <DirPicker
                          ssh={draftTarget.host.target}
                          value={draftSshCwd}
                          onChange={setDraftSshCwd}
                          repos={[]}
                          recents={[]}
                          primaryCwd={draftTarget.host.cwd || '~'}
                        />
                      ) : (
                        <DirPicker
                          value={draftCwd}
                          onChange={setDraftCwd}
                          repos={composerMeta?.repos ?? []}
                          recents={recentCwds}
                          primaryCwd={composerMeta?.primary_cwd}
                        />
                      )}
                      <div className="ml-auto flex shrink-0 items-center">{agentPillEl}</div>
                    </div>
                  </BandItem>
                )}
              </>
            ) : undefined}
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
                    <span className="min-w-0 flex-1 truncate">{queuePreview(q.text)}</span>
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
            {(suggestions.length > 0 || (atCat && trigger?.char === '@')) && cardEl && createPortal(
              <div role="listbox" style={{ bottom: window.innerHeight - cardEl.getBoundingClientRect().top + 4, left: cardEl.getBoundingClientRect().left, maxHeight: Math.min(400, cardEl.getBoundingClientRect().top - 12) }} className="fixed z-50 w-[300px] overflow-y-auto rounded-[10px] border border-border bg-card p-1 shadow-lg">
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
              </div>,
              document.body,
            )}
            {findings.length > 0 && suggestions.length === 0 && !(atCat && trigger?.char === '@') && cardEl && createPortal(
              <div className="pointer-events-none fixed z-50 flex flex-col items-center gap-2 px-2" style={{ bottom: window.innerHeight - cardEl.getBoundingClientRect().top + 8, left: cardEl.getBoundingClientRect().left, width: cardEl.getBoundingClientRect().width }}>
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
                                  ? t('menu.codeScanFit')
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
                      onClick={() => { try { localStorage.setItem('dw-new-session-draft', input) } catch { /* quota */ } setFindings([]) }}
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
                      {scanState === 'busy' ? t('menu.starting') : scanState === 'sent' ? t('menu.scanSent') : scanState === 'error' ? t('menu.retryScan') : t('menu.startScan')}
                    </button>
                  ) : null}
                </div>
              </div>,
              document.body,
            )}
            {confirmSendOpen && (
              /* Official (bundle-sampled): warning_and_modal precheck mode opens a confirm
                 dialog before send — title/labels from the official locale, description =
                 first finding's recommendation. Back cancels; Send confirms once per draft. */
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setConfirmSendOpen(false)}>
                <div role="dialog" className="w-full max-w-sm rounded-xl border border-border bg-background p-4 shadow-lg" onClick={(e) => e.stopPropagation()}>
                  <p className="text-[14px] font-medium leading-[20px]">{t('am.confirmSend')}</p>
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
                            try { localStorage.setItem('dw-new-session-draft', input) } catch { /* quota */ }
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
            {draftQuotes.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-1 pt-1">
                {draftQuotes.map((q, i) => (
                  <div key={i} className="group/draft-quote relative">
                    <QuoteChip quote={q} />
                    <button
                      aria-label={t('quote.remove')}
                      onClick={() => setDraftQuotes((d) => d.filter((_, j) => j !== i))}
                      className="absolute right-[-5px] top-[-5px] z-10 flex size-[18px] items-center justify-center rounded-full bg-foreground text-background opacity-0 focus-visible:opacity-100 group-hover/draft-quote:opacity-100 [@media(pointer:coarse)]:opacity-100"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {staged.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-1 pt-1">
                {staged.map((f) => (
                  isStagedImage(f) ? (
                    <div key={f.url} className="group/attachment relative size-9 shrink-0">
                      <LightboxImage
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
            {/* Draft is two layers only: the gray wax + this one inner surface
                (the outer card renders bare via BeardBand bareCard). */}
            <div className={cn(isDraft && 'rounded-[14px] border border-border bg-background p-1.5')}>
            {caps.canSendMessage ? (<>
            <ComposerEditor
              ref={editorRef}
              className={cn('bg-transparent', isDraft && 'min-h-[44px]')}
              disabled={statusState.inputDisabled || sending}
              placeholder={pending ? t('composer.respondPending') : isDraft ? t('draft.message') : stText(t, statusState.placeholder)}
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
                  // workSend 'interrupt': Ctrl+Enter sends NOW (cancels the live
                  // turn, settle→flush fires it); 'queue' parks it (default).
                  if (workSend === 'interrupt') void queueOpReq({ op: 'send_now', message: text })
                  else void queueSend(text)
                  return
                }
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  const mod = e.ctrlKey || e.metaKey
                  // sendWith 'ctrlenter': Enter inserts a newline, Ctrl+Enter sends.
                  if (sendWith === 'ctrlenter' ? mod : !mod) {
                    e.preventDefault()
                    // workSend 'interrupt' reroutes the normal send to send_now
                    // while a turn is live (plain /message would auto-queue).
                    if (statusState.enum === 'working' && workSend === 'interrupt' && input.trim()) {
                      const text = input.trim()
                      setInput('')
                      void queueOpReq({ op: 'send_now', message: text })
                    } else void send()
                  }
                }
              }}
            />
            {/* Official toolbar row (sampled live 2026-09-01): min-h-7, 28px round icon buttons with 18px
                glyphs, mode pill h-7 rounded-full 1px border px-1.5 13/18, right cluster gap-1 with mic +
                a rounded-full foreground send group (opacity .5 when disabled) whose ⌄ split segment only
                expands once there is text. */}
            <div ref={setPillRowEl} className="relative flex min-h-7 items-center justify-between gap-2">
              <div className={cn('flex shrink-0 items-center gap-px', voiceRecording && 'invisible')}>
              {!isVisitor && <div className="relative">
                <button
                  ref={attachBtnRef}
                  onClick={() => setAttachOpen((v) => !v)}
                  disabled={uploading}
                  aria-label="Attach or mention"
                  title="Attach or mention"
                  className="flex size-7 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-tint-secondary hover:text-foreground disabled:opacity-50"
                >
                  {uploading ? <Loader2 size={18} className="animate-spin" /> : <Plus size={18} />}
                </button>
                {attachOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setAttachOpen(false)} />
                    {attachBtnRef.current && createPortal(
                    <div
                      role="menu"
                      tabIndex={-1}
                      ref={(el) => { attachMenuRef.current = el; el?.focus() }}
                      onKeyDown={attachMenuKeyDown}
                      style={{ bottom: window.innerHeight - attachBtnRef.current.getBoundingClientRect().top + 6, left: attachBtnRef.current.getBoundingClientRect().left, maxHeight: Math.min(400, attachBtnRef.current.getBoundingClientRect().top - 14) }}
                      className="fixed z-50 flex w-[220px] flex-col overflow-hidden rounded-[10px] bg-[rgba(255,255,255,0.94)] shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)] outline outline-1 outline-black/[0.06] backdrop-blur-[8px] focus:outline-none dark:bg-[#1f1f1f]/[0.94] dark:outline-white/[0.06] [transition:transform_40ms_cubic-bezier(0.76,0,0.24,1),scale_40ms_cubic-bezier(0.76,0,0.24,1),opacity_40ms_cubic-bezier(0.76,0,0.24,1)]"
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
                        {/* When the pills collapse into this menu (narrow composer
                            — pillTier≥2, or any sub-md width) their entries open
                            the same dropdowns from here. */}
                        {pillTier >= 2 && <div role="separator" className="mx-2 h-[9px] bg-border bg-clip-content py-1" />}
                        {pillTier >= 2 && localModeGroup && (localModeGroup.options?.length ?? 0) > 0 && (
                          <button
                            role="menuitem"
                            onClick={() => { setAttachOpen(false); setSModeOpen(true) }}
                            className="flex w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] outline-none hover:bg-tint-secondary [&>svg]:size-4 [&>svg]:shrink-0"
                          >
                            <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                              {LOCAL_MODE_ICONS[String(localModeOpt?._meta?.['cognition.ai/icon'] ?? '')] ?? <Settings2 size={16} />}
                            </span>
                            Session mode
                            <span className="ml-auto truncate text-[11px] text-muted-foreground">{localModeOpt?.name ?? localModeCurrent}</span>
                          </button>
                        )}
                        {pillTier >= 2 && (
                          <button
                            role="menuitem"
                            onClick={() => { setAttachOpen(false); setModeOpen(true) }}
                            className="flex w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] outline-none hover:bg-tint-secondary [&>svg]:size-4 [&>svg]:shrink-0"
                          >
                            <Sparkles size={16} className="text-muted-foreground" />
                            Model
                            <span className="ml-auto truncate text-[11px] text-muted-foreground">{modelPillLabel ?? (cfgFetched ? (VERSION_LABEL[pillVersion] ?? pillVersion) : '…')}</span>
                          </button>
                        )}
                        {pillTier >= 3 && detail?.session.context_usage?.used != null && detail.session.context_usage.size ? (
                          <div className="flex w-full select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] text-muted-foreground">
                            <span className="inline-block h-1.5 w-8 shrink-0 overflow-hidden rounded-full bg-muted">
                              <span className="block h-full rounded-full bg-emerald-500" style={{ width: `${Math.min(100, Math.round((detail.session.context_usage.used! / detail.session.context_usage.size!) * 100))}%` }} />
                            </span>
                            Context
                            <span className="ml-auto truncate text-[11px] text-muted-foreground">{detail.session.context_usage.used!.toLocaleString()}/{detail.session.context_usage.size!.toLocaleString()}</span>
                          </div>
                        ) : null}
                      </div>
                    </div>,
                    document.body,
                    )}
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
                    className="flex size-7 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-tint-secondary hover:text-foreground disabled:opacity-50"
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
              </div>
              <div className="flex min-w-0 items-center gap-1">
                <div ref={setPillGroupEl} className="flex min-w-0 items-center gap-px overflow-hidden [&>*]:!shrink-0">
              {!isVisitor && localModeGroup && (localModeGroup.options?.length ?? 0) > 0 && pillTier < 2 && (
                <div className="relative">
                  <button
                    ref={sModeBtnRef}
                    onClick={() => { setSModeOpen((v) => !v); setModeOpen(false) }}
                    aria-label="Session mode"
                    title={localModeOpt?.name ?? localModeCurrent ?? 'Session mode'}
                    className={cn('flex h-7 cursor-pointer items-center overflow-hidden whitespace-nowrap rounded-full text-[13px] leading-[18px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground', pillTier >= 1 ? 'size-7 justify-center' : 'max-w-[220px] gap-1 px-[6px]', sModeOpen && 'bg-tint-secondary text-foreground')}
                  >
                    {pillTier >= 1 ? (
                      <span className="flex size-[18px] shrink-0 items-center justify-center">
                        {LOCAL_MODE_ICONS[String(localModeOpt?._meta?.['cognition.ai/icon'] ?? '')] ?? <Settings2 size={18} />}
                      </span>
                    ) : (
                      <span className="min-w-0 truncate">{localModeOpt?.name ?? localModeCurrent ?? 'Mode'}</span>
                    )}
                  </button>
                  {sModeOpen && <div className="fixed inset-0 z-10" onClick={() => setSModeOpen(false)} />}
                  {sModeOpen && sModeBtnRef.current && createPortal(
                    <div role="menu" style={{ bottom: window.innerHeight - sModeBtnRef.current.getBoundingClientRect().top + 6, right: window.innerWidth - sModeBtnRef.current.getBoundingClientRect().right, maxHeight: sModeBtnRef.current.getBoundingClientRect().top - 14 }} className="fixed z-50 flex w-[260px] flex-col overflow-hidden rounded-[10px] bg-[rgba(255,255,255,0.94)] shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)] outline outline-1 outline-black/[0.06] backdrop-blur-[8px] dark:bg-[#1f1f1f]/[0.94] dark:outline-white/[0.06]">
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
                    </div>,
                    document.body,
                  )}
                </div>
              )}
              {!isVisitor && pillTier < 2 && modelPillEl(false)}
              {/* Context window fill — latest root-chain usage_update. Collapses
                  to the bare bar at tier≥1 and leaves the row at tier 3 (it then
                  shows inside the "+" menu instead). */}
              {detail?.session.context_usage?.used != null && detail.session.context_usage.size && pillTier < 3 ? (() => {
                const cu = detail.session.context_usage
                const pctUse = Math.min(100, Math.round(((cu.used ?? 0) / cu.size!) * 100))
                const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n))
                return (
                  <span
                    className="inline-flex h-7 shrink-0 cursor-default items-center gap-1 rounded-full px-[6px] text-[11px] tabular-nums text-muted-foreground"
                    title={t('visitor.contextTip', { used: cu.used!.toLocaleString(), size: cu.size!.toLocaleString(), pct: pctUse, input: cu.inputTokens?.toLocaleString() ?? '—', output: cu.outputTokens?.toLocaleString() ?? '—', cached: cu.cachedReadTokens?.toLocaleString() ?? '—' })}
                  >
                    <span className="inline-block h-1.5 w-8 overflow-hidden rounded-full bg-muted">
                      <span
                        className={`block h-full rounded-full ${pctUse > 85 ? 'bg-red-500' : pctUse > 60 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                        style={{ width: `${pctUse}%` }}
                      />
                    </span>
                    {pillTier < 1 && `${fmt(cu.used!)}/${fmt(cu.size!)}`}
                  </span>
                )
              })() : null}
                </div>
                {/* Open sessions show their owning agent read-only (desktop
                    parity) — the pick happens at draft time only. */}
                {!isDraft && !isVisitor && sessionAgent !== 'devin' && (
                  <span
                    title={t('draft.agentPick')}
                    className="mr-0.5 flex h-7 shrink-0 items-center gap-1 rounded-full border border-border px-2 text-[12px] leading-[16px] text-muted-foreground"
                  >
                    <Sparkles size={13} />{composerMeta?.agents?.find((a) => a.id === sessionAgent)?.label ?? sessionAgent}
                  </span>
                )}
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
                {(status !== 'working' || input.trim().length > 0) && <div className={cn('relative flex shrink-0 items-stretch', voiceRecording && 'invisible')}>
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
                    {/* Queue affordances exist only while a turn runs — idle
                        sends go straight through, so the split menu hides. */}
                    {!isVisitor && statusState.enum === 'working' && <div className={cn('flex items-stretch overflow-hidden transition-[width,opacity] duration-150', input.trim() ? 'w-[26px] opacity-100' : 'w-0 opacity-0')}>
                      <span className="w-px shrink-0 self-stretch bg-white/[0.08]" />
                      <button
                        ref={sendOptBtnRef}
                        onClick={() => setSendOptOpen((v) => !v)}
                        disabled={!input.trim()}
                        tabIndex={input.trim() ? 0 : -1}
                        aria-label="More send options"
                        title="More send options"
                        className={cn('flex w-[25px] shrink-0 cursor-pointer items-center justify-center hover:bg-white/10', sendOptOpen && 'bg-white/10')}
                      >
                        <ChevronDown size={14} />
                      </button>
                    </div>}
                  </div>
                  {sendOptOpen && <div className="fixed inset-0 z-10" onClick={() => setSendOptOpen(false)} />}
                  {sendOptOpen && sendOptBtnRef.current && createPortal(
                    <div role="menu" style={{ bottom: window.innerHeight - sendOptBtnRef.current.getBoundingClientRect().top + 6, right: window.innerWidth - sendOptBtnRef.current.getBoundingClientRect().right, maxHeight: sendOptBtnRef.current.getBoundingClientRect().top - 14 }} className="fixed z-50 w-[270px] overflow-y-auto rounded-[10px] bg-[rgba(255,255,255,0.94)] shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)] outline outline-1 outline-black/[0.06] backdrop-blur-[8px] dark:bg-[#1f1f1f]/[0.94] dark:outline-white/[0.06] [transition:transform_40ms_cubic-bezier(0.76,0,0.24,1),scale_40ms_cubic-bezier(0.76,0,0.24,1),opacity_40ms_cubic-bezier(0.76,0,0.24,1)]">
                      <div className="p-1">
                        {/* Official More send options menu (sampled live): Add to queue · Ctrl ⏎; width w-[270px] per bundle */}
                        {/* Working-session escape: interrupts the live turn and
                            sends now (server cancels → settle flush fires it). */}
                        {statusState.enum === 'working' && (
                          <button
                            role="menuitem"
                            onClick={() => {
                              const text = input.trim()
                              setSendOptOpen(false)
                              if (text) { setInput(''); void queueOpReq({ op: 'send_now', message: text }) }
                            }}
                            className="flex w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-[13px] outline-none hover:bg-tint-secondary"
                          >
                            {t('composer.sendNow')}
                          </button>
                        )}
                        <button
                          role="menuitem"
                          onClick={() => {
                            const text = input.trim()
                            setSendOptOpen(false)
                            if (text) { setInput(''); void queueSend(text) }
                          }}
                          className="flex w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-[13px] outline-none hover:bg-tint-secondary"
                        >
                          {t('composer.addToQueue')}
                          <span className="ml-auto text-[11px] text-muted-foreground">Ctrl ⏎</span>
                        </button>
                      </div>
                    </div>,
                    document.body,
                  )}
                </div>}
              </div>
            </div>
            </>) : (
              <p className="flex min-h-7 items-center px-1 text-[13px] leading-[16px] text-muted-foreground">{t('menu.readonlyBanner')}</p>
            )}
            </div>
            {/* Floating quote form over a text selection inside a message —
                official SelectionQuoteAffordance mini-form: [✏ Add caption]
                [⏎ Add to chat]; typing while open starts a caption, Enter
                commits. mousedown+preventDefault keeps the selection alive. */}
            {selQuote && caps.canSendMessage && (
              <QuotePill
                x={selQuote.x}
                y={selQuote.y}
                placement={selQuote.placement}
                hidden={selQuote.hidden}
                startExpanded={selQuote.expanded}
                quoteText={selQuote.text}
                onCommit={(caption) => {
                  stageQuoteDraft(selQuote, caption)
                  setSelQuote(null)
                }}
                onSend={caps.canSendMessage ? (caption) => {
                  // Official "Send immediately" — commit + dispatch in one go.
                  const q = quoteDraftFrom(selQuote, caption)
                  const merged = draftQuotes.some((x) => x.eventId === q.eventId && x.text === q.text) ? draftQuotes : [...draftQuotes, q]
                  setDraftQuotes(merged)
                  setSelQuote(null)
                  window.getSelection()?.removeAllRanges()
                  void send(undefined, merged)
                } : undefined}
                onClose={() => setSelQuote(null)}
              />
            )}
          </BeardBand>
        </footer>
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
              { key: 'computer', label: t('panels.computer'), description: t('panels.computer_d'), MenuIcon: PANELS.computer.MenuIcon, onClick: () => openTab('computer') },
              { key: 'editor', label: t('panels.editor'), description: computerAsleep ? t('panels.editorWake') : t('panels.editor_d'), MenuIcon: PANELS.editor.MenuIcon, disabled: computerAsleep, onClick: () => openTab('editor') },
              { key: 'changes', label: t('panels.changes'), description: t('panels.changes_d'), MenuIcon: PANELS.changes.MenuIcon, onClick: () => openTab('changes') },
              { key: 'worklog', label: t('panels.worklog'), description: t('panels.worklog_d'), MenuIcon: PANELS.worklog.MenuIcon, onClick: () => openTab('worklog') },
              { key: 'agents', label: t('panels.agents'), description: t('panels.agents_d'), MenuIcon: PANELS.agents.MenuIcon, onClick: () => openTab('agents') },
              { key: 'sidechat', label: t('panels.sidechat'), description: t('panels.sidechat_d'), MenuIcon: PANELS.sidechat.MenuIcon, onClick: () => openTab('sidechat') },
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

/* Draft-page project explorer — browse the picked workspace before the
 * session exists (fs/list + fs/file; read-only CodeView preview). */
function DraftExplorer({ root }: { root: string }) {
  const { t } = useTranslation()
  const [dirs, setDirs] = useState<Record<string, { name: string; dir: boolean }[] | 'loading'>>({})
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [file, setFile] = useState<{ path: string; text: string | null; binary?: boolean } | null>(null)
  const load = (p: string) => {
    setDirs((m) => ({ ...m, [p]: 'loading' }))
    void adminFetch<{ entries: { name: string; dir: boolean }[] }>(`/api/admin/fs/list?path=${encodeURIComponent(p)}`)
      .then((d) => setDirs((m) => ({ ...m, [p]: d.entries })))
      .catch(() => setDirs((m) => ({ ...m, [p]: [] })))
  }
  useEffect(() => { setDirs({}); setOpen({}); setFile(null); load(root) }, [root]) // eslint-disable-line react-hooks/exhaustive-deps
  const renderDir = (p: string, depth: number): React.ReactNode => {
    const es = dirs[p]
    if (!es || es === 'loading') return null
    return es.map((e) => {
      const fp = `${p.replace(/[\\/]+$/, '')}\\${e.name}`
      const isOpen = !!open[fp]
      return (
        <div key={fp}>
          <button
            className="flex w-full cursor-pointer items-center gap-1.5 rounded px-1.5 py-[3px] text-left text-[12px] hover:bg-tint-secondary"
            style={{ paddingLeft: 6 + depth * 14 }}
            onClick={() => {
              if (e.dir) { setOpen((m) => ({ ...m, [fp]: !m[fp] })); if (!dirs[fp]) load(fp) }
              else {
                void adminFetch<{ text: string | null; binary: boolean }>(`/api/admin/fs/file?path=${encodeURIComponent(fp)}`)
                  .then((d) => setFile({ path: fp, ...d })).catch(() => {})
              }
            }}
          >
            {e.dir ? (isOpen ? <ChevronDown size={12} className="shrink-0 text-muted-foreground" /> : <ChevronRight size={12} className="shrink-0 text-muted-foreground" />) : <span className="w-3 shrink-0" />}
            <span className="min-w-0 flex-1 truncate">{e.name}</span>
          </button>
          {e.dir && isOpen && renderDir(fp, depth + 1)}
        </div>
      )
    })
  }
  return (
    <div className="mt-3 flex h-[300px] w-full max-w-[720px] overflow-hidden rounded-[10px] border border-border bg-card text-left">
      <div className="w-[240px] shrink-0 overflow-auto border-r border-border p-1.5">
        <div className="px-1.5 pb-1 text-[11px] font-medium text-muted-foreground">{root.replace(/[\\/]+$/, '').split(/[\\/]/).pop()}</div>
        {renderDir(root, 0)}
      </div>
      <div className="min-w-0 flex-1 overflow-auto bg-background">
        {file
          ? file.binary || file.text === null
            ? <p className="p-4 text-[12px] text-muted-foreground">{t('ws.binary')}</p>
            : <CodeView text={file.text} name={file.path} />
          : <p className="p-4 text-[12px] text-muted-foreground">{t('draft.pickFile')}</p>}
      </div>
    </div>
  )
}

