import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { ChevronLeft, Plus, FileText, CircleDot, PanelLeft, ArrowUp, List, Code, Languages, ArrowUpRight, Search, Lightbulb, Laptop, Sparkles, MessageCircle, ShieldOff } from 'lucide-react'
import { adminFetchSwr, type AdminSession, type PublicMessage } from '@/lib/api'
import { type ViewerCaps, type SharePermission } from '@/lib/viewer'
import { type Theme } from '@/lib/theme'
import { type TimelineItem } from '@/components/Timeline'
import DevinMark from '@/components/DevinMark'
import { Select } from '@/components/ui'
import { cn } from '@/lib/utils'
import { type PanelKey } from './panelTabs'
import { type Group } from './composerMeta'
import { aggregateFiles } from './ChangesPanel'
import { splitAttachments } from './attachments'

function CommandPalette({ sessions, onClose, onTheme, onToggleSidebar }: {
  sessions: AdminSession[]
  onClose: () => void
  onTheme: (t: Theme) => void
  onToggleSidebar: () => void
}) {
  const { t } = useTranslation()
  const [q, setQ] = useState('')
  const [mode, setMode] = useState<'home' | 'search'>('home')
  const [submenu, setSubmenu] = useState<'none' | 'go' | 'theme'>('none')
  const nav = (path: string) => { window.location.assign(path) }
  type Cmd = { label: string; run: () => void; icon: ReactNode; group?: string; shortcut?: string; render?: ReactNode }
  const rootCmds: Cmd[] = [
    {
      label: 'Start session with a prompt…',
      run: () => nav('/admin/new'),
      icon: <DevinMark size={16} />,
      render: <><span>{t('pal.startSession')}</span><span className="text-muted-foreground"> with a prompt…</span></> },
    { label: 'Search sessions…', run: () => { setMode('search'); setQ('') }, icon: <Search size={16} /> },
    { group: 'Actions', label: 'Go to…', run: () => { setSubmenu('go'); setQ('') }, icon: <ArrowUpRight size={16} /> },
    { group: 'Actions', label: 'Change theme…', run: () => { setSubmenu('theme'); setQ('') }, icon: <Languages size={16} /> },
    { group: 'Actions', label: 'Toggle sidebar', run: onToggleSidebar, icon: <PanelLeft size={16} />, shortcut: 'Ctrl B' },
  ]
  const submenuCmds: Record<'go' | 'theme', Cmd[]> = {
    go: [
      { label: 'New session', run: () => nav('/admin/new'), icon: <Plus size={16} /> },
      { label: 'All sessions', run: () => nav('/'), icon: <List size={16} /> },
    ],
    theme: (['light', 'dark', 'system'] as Theme[]).map((value) => ({
      label: value === 'light' ? 'Light mode' : value === 'dark' ? 'Dark mode' : 'System',
      run: () => { onTheme(value); onClose() },
      icon: value === 'light' ? <Lightbulb size={16} /> : value === 'dark' ? <CircleDot size={16} /> : <Laptop size={16} /> })) }
  const cmds: Cmd[] = submenu !== 'none'
    ? submenuCmds[submenu]
    : mode === 'home' ? rootCmds : sessions.map((s) => ({
    label: s.title || s.devin_title || s.id,
    icon: <Search size={16} />,
    run: () => nav(`/admin/${s.id}`) }))
  const ql = q.trim().toLowerCase()
  const filtered = ql ? cmds.filter((c) => c.label.toLowerCase().includes(ql)) : cmds
  const [sel, setSel] = useState(0)
  const clamped = Math.min(sel, Math.max(0, filtered.length - 1))
  useEffect(() => { setSel(0) }, [mode, submenu])
  const backToRoot = () => { setSubmenu('none'); setMode('home'); setQ(''); setSel(0) }
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[15vh]" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('pal.aria')}
        className="w-full max-w-[680px] overflow-hidden rounded-[16px] bg-[rgba(255,255,255,0.94)] text-foreground shadow-[0_25px_50px_-12px_rgba(0,0,0,.25)] outline-none backdrop-blur-[8px] md:min-h-[403px] dark:bg-[#1f1f1f]/[.94]"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            if (submenu !== 'none') backToRoot()
            else onClose()
          }
          if (e.key === 'Backspace' && !q && submenu !== 'none') { e.preventDefault(); backToRoot() }
          if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, filtered.length - 1)) }
          if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)) }
          if (e.key === 'Enter' && filtered[clamped]) { filtered[clamped].run(); if (submenu === 'none' && mode === 'home' && filtered[clamped].label !== 'Search sessions…' && !['Go to…', 'Change theme…'].includes(filtered[clamped].label)) onClose() }
        }}
      >
        <div className={cn(
          submenu === 'none' ? 'flex h-12 items-center gap-2 border-b border-border px-4' : 'flex flex-row items-center gap-2 px-4 py-4',
        )}>
          {submenu !== 'none' && (
            <button type="button" aria-label={t('pal.back')} onClick={backToRoot} className="cursor-pointer">
              <ChevronLeft size={22} className="text-muted-foreground" />
            </button>
          )}
          {submenu === 'none' && <Search size={16} className="shrink-0 text-muted-foreground" />}
          <input
            autoFocus
            value={q}
            onChange={(e) => { setQ(e.target.value); setSel(0) }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                if (submenu !== 'none') backToRoot()
                else if (mode === 'search') { setMode('home'); setQ('') }
                else onClose()
              }
              if (e.key === 'Backspace' && !q && submenu !== 'none') { e.preventDefault(); backToRoot() }
            }}
            placeholder={submenu === 'go' ? 'Search in Go to…' : submenu === 'theme' ? 'Search in Theme…' : mode === 'search' ? 'Search sessions…' : 'Type a command or search…'}
            className={cn('min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground', submenu !== 'none' ? 'text-[17px] leading-[26px]' : 'text-[14px] leading-[20px]')}
          />
        </div>
        <div className="max-h-[360px] overflow-y-auto p-2">
          {filtered.length === 0 && <p className="px-3 py-6 text-[13px] text-muted-foreground">{t('pal.noSessions')}</p>}
          {filtered.map((c, i) => (
            <Fragment key={`${c.label}-${i}`}>
              {submenu === 'none' && mode === 'home' && c.group && !filtered[i - 1]?.group && <p className="px-3 pb-1 pt-2 text-[12px] text-muted-foreground">{c.group}</p>}
              <button
                onClick={() => {
                  c.run()
                  if (submenu === 'none' && mode === 'home' && !['Search sessions…', 'Go to…', 'Change theme…'].includes(c.label)) onClose()
                }}
                onMouseEnter={() => setSel(i)}
                className={cn('group/menu-item text-[14px] text-foreground relative flex min-h-10 w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-3 py-2 text-left outline-none', i === clamped ? 'bg-tint-secondary' : '')}
              >
                <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4 [&_svg]:shrink-0">{c.icon}</span>
                <span className="min-w-0 flex-1 truncate">{c.render || c.label}</span>
                {c.shortcut && <kbd className="shrink-0 rounded bg-black/[.06] px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{c.shortcut}</kbd>}
              </button>
            </Fragment>
          ))}
          {submenu === 'none' && mode === 'home' && (
            <div className="mt-2 flex items-center gap-3 border-t border-black/[.06] px-3 py-3 text-[12px] text-muted-foreground dark:border-white/[.08]">
              <span><kbd className="rounded bg-black/[.06] px-1.5 py-0.5 font-mono text-[11px]">↑</kbd> <kbd className="rounded bg-black/[.06] px-1.5 py-0.5 font-mono text-[11px]">↓</kbd> Navigate</span>
              <span><kbd className="rounded bg-black/[.06] px-1.5 py-0.5 font-mono text-[11px]">esc</kbd> Close</span>
              <span className="ml-auto"><kbd className="rounded bg-black/[.06] px-1.5 py-0.5 font-mono text-[11px]">↵</kbd> Select</span>
          </div>
          )}
          {submenu === 'none' && mode === 'search' && (
            <button type="button" onClick={() => { setMode('home'); setQ('') }} className="mt-1 w-full px-3 py-2 text-left text-[12px] text-muted-foreground hover:bg-black/[.06]">
              esc <span className="float-right">{t('pal.backTxt')}</span>
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** Official Skeleton component semantics: pulsing placeholder bars while history loads. */
function TimelineSkeleton({ rows }: { rows: number }) {
  const widths = ['w-3/5', 'w-4/5', 'w-2/5', 'w-full', 'w-3/4', 'w-1/2', 'w-5/6']
  return (
    <div className="flex animate-pulse flex-col gap-4">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex flex-col gap-2">
          <div className={cn('h-4 rounded-md bg-muted', widths[i % widths.length])} />
          <div className={cn('h-4 rounded-md bg-muted', widths[(i + 3) % widths.length])} />
        </div>
      ))}
    </div>
  )
}

interface SessionDetail {
  session: {
    id: string
    devin_session_id: string
    title: string
    devin_title: string
    permission: string
    archived: number
    status: string
    status_message?: string | null
    status_enum_raw?: string | null
    status_short_message?: string | null
    queue_position?: number
    sleep_reason?: string
    auto_recover?: { attempts: number; lastAt: number }
    current_devin_version?: string | null
    platform?: string | null
    pull_request?: { url?: string } | null
    pull_requests?: { title?: string; state: string; pr_url: string; draft: boolean; number?: number; additions?: number; deletions?: number; authorLogin?: string }[]
    repos?: string[]
    cwd?: string | null
    is_locked?: boolean
    loaded_here?: boolean
    context_usage?: {
      used: number | null
      size: number | null
      inputTokens: number | null
      outputTokens: number | null
      cachedReadTokens: number | null
      totalAcuCost: number | null
      ts: number
    } | null
    /** sub:<root>:<aid> child session — parent link + spawn metadata. */
    parent_devin_id?: string | null
    parent_title?: string | null
    subagent?: {
      agentId: string; profile: string; model: string; task: string
      isBackground: boolean; live: boolean
      /** false = handle gone (restart/replay) — composer relays would only
       * burn a lead turn to learn "doesn't exist"; offer respawn instead. */
      resumable?: boolean
    } | null
  }
  messages: PublicMessage[]
  share_url: string | null
  dashboard_url: string | null
  media_token?: string
}

const tlSnapshots = new Map<string, {
  items: TimelineItem[]
  older: TimelineItem[]
  cursor: string | null
  detail: SessionDetail | null
  at: number
}>()

const sessionPrefetchedAt = new Map<string, number>()

function prefetchSession(id: string): void {
  const now = Date.now()
  if (now - (sessionPrefetchedAt.get(id) || 0) < 30_000) return
  sessionPrefetchedAt.set(id, now)
  // Local backend: detail is memory-only (no session/load), so this prefetch
  // is cheap and side-effect free. Timeline/config are deliberately NOT
  // prefetched — hitting them starts a full history replay, which bumps the
  // session's updatedAt and costs a replay on every sidebar hover.
  void adminFetchSwr<SessionDetail>(`/api/admin/session/${id}?slim=1&boot=1`).catch(() => {})
}

const VERSION_LABEL: Record<string, string> = {
  'devin-ultra': 'Ultra',
  'devin-2-5': 'Normal',
  'devin-fast-opus': 'Fast',
  devin_lite: 'Lite',
  'devin-swe-1-7': 'SWE-1.7',
  'devin-swe-1-7-lightning': 'SWE-1.7 Lightning',
  'devin-auto': 'Fusion',
  'devin-auto-fast': 'Fusion Fast' }

/** Local ACP session config (GET /config): real model + mode options. */
type LocalCfgOption = { value: string; name?: string; description?: string; efforts?: string[]; effortCtl?: boolean; family?: string; fast?: boolean; ctx1m?: boolean; _meta?: Record<string, unknown> }
type LocalCfg = {
  options?: { id?: string; name?: string; category?: string; currentValue?: string; options?: LocalCfgOption[] }[]
  mode?: string | null
  commands?: { name: string; description?: string; input?: { hint?: string } }[]
  model?: { id: string; current: string; currentName: string; options: LocalCfgOption[] } | null
}

/** ACP model values bake the default effort into the id (`swe-2-high`,
 * `claude-fable-5-1-medium`). The desktop picker expands such families into a
 * "Reasoning Effort" submenu; models without a suffix offer no submenu. */
const EFFORT_SUFFIX_RE = /-(minimal|low|medium|high|xhigh|max|ultra|pro|none)$/

/** lucide icons keyed by the agent's `cognition.ai/icon` meta (mode options). */
const LOCAL_MODE_ICONS: Record<string, ReactNode> = {
  code: <Code size={16} />,
  sparkles: <Sparkles size={16} />,
  'message-circle': <MessageCircle size={16} />,
  'file-text': <FileText size={16} />,
  'shield-off': <ShieldOff size={16} /> }

/**
 * Last successfully fetched /config — model options are agent-level so the
 * previous session's copy is a valid stand-in while the next fetch resolves.
 * Keeps the pill from flashing the cloud "Ultra" label on navigation.
 */

const versionOf = (m: string, speed: string): string =>
  m === 'Ultra'
    ? 'devin-ultra'
    : m === 'Lite'
      ? 'devin_lite'
      : m === 'Fusion'
        ? 'devin-auto'
        : m === 'Normal'
          ? (speed === 'Fast' ? 'devin-fast-opus' : 'devin-2-5')
          : (speed === 'Lightning' ? 'devin-swe-1-7-lightning' : 'devin-swe-1-7')

function modeOfVersion(version: string): string {
  if (version.startsWith('devin-auto')) return 'Fusion'
  if (version === 'devin-ultra') return 'Ultra'
  if (version === 'devin_lite') return 'Lite'
  if (version.startsWith('devin-swe')) return 'SWE-1.7'
  return 'Normal'
}

function speedOfVersion(version: string): string {
  if (version === 'devin-fast-opus') return 'Fast'
  if (version === 'devin-swe-1-7-lightning') return 'Lightning'
  return 'Standard'
}

/** Visitor /meta projection (Worker `share.get('/:shareId/meta')`). */
interface ShareMeta {
  title: string
  permission: SharePermission
  status: string
  status_message: string | null
  status_enum_raw?: string | null
  status_short_message?: string | null
  queue_position?: number
  pull_request: { url?: string } | null
  pull_requests: { title?: string; state: string; pr_url: string; draft: boolean; number?: number; additions?: number; deletions?: number; authorLogin?: string }[]
  platform?: string | null
}

/** Right-panel tabs a visitor tier is allowed to open (admins keep their persisted set). */
function visitorTabs(caps: ViewerCaps, items: TimelineItem[] = []): PanelKey[] {
  const out: PanelKey[] = []
  if (caps.showProgress) {
    out.push('worklog')
    if (items.some((it) => it.kind === 'todo')) out.push('progress')
  }
  if (caps.showChanges) out.push('changes')
  if (caps.showComputer) out.push('computer')
  if (caps.showShell) out.push('shell')
  if (caps.showFiles) out.push('files')
  out.push('dashboard')
  return out
}

/** Official signal-derived admin tab order, used only when a session has no saved tabs. */
function defaultTabs(items: TimelineItem[], groups: Group[]): PanelKey[] {
  const out: PanelKey[] = []
  if (groups.some((group) => group.type === 'work' || group.type === 'row')) out.push('worklog')
  if (aggregateFiles(items).length > 0) out.push('changes')
  if (items.some((it) => it.kind === 'computer')) out.push('computer')
  if (items.some((it) => it.kind === 'workflow' || it.kind === 'workflow_agent' || it.subagent?.agentId)) out.push('agents')
  if (items.some((it) => it.kind === 'todo')) out.push('progress')
  return out
}

/** Attachments the visitor can see live in the sanitized event stream (no /messages list). */
function messagesFromItems(items: TimelineItem[]): PublicMessage[] {
  const out: PublicMessage[] = []
  for (const it of items) {
    if (it.kind !== 'message') continue
    const attachments = it.attachments?.length
      ? it.attachments.map((a) => ({ url: a.url, name: a.name ?? a.url.split('/').pop() ?? 'file' }))
      : splitAttachments(it.body || '', it.quoteMeta, it.quotes).attachments
    if (!attachments.length) continue
    out.push({ id: it.id, role: it.role === 'devin' ? 'devin' : 'user', message: it.body || '', timestamp: it.ts, attachments })
  }
  return out
}


export { CommandPalette, TimelineSkeleton, type SessionDetail, tlSnapshots, sessionPrefetchedAt, prefetchSession, VERSION_LABEL, type LocalCfgOption, type LocalCfg, EFFORT_SUFFIX_RE, LOCAL_MODE_ICONS, versionOf, modeOfVersion, speedOfVersion, type ShareMeta, visitorTabs, defaultTabs, messagesFromItems };
