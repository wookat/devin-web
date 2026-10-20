import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'
import { createPortal } from 'react-dom'
import { Bot, Download, FolderInput, Plus, RefreshCw, RotateCcw, Rows3, Settings2, Tag } from 'lucide-react'
import { OArchive, OBell, OCheck, OChevronDown, OChevronRight, OCollapse, OCompose, OExpand, OPin, OSearch, OX } from '../components/officialIcons'
import { adminFetch } from '@/lib/api'
import { cn } from '@/lib/utils'
import { type MirrorTreeSession } from './mirror/treeCache'
import { type TreePrefs, TREE_PREFS_KEY, DEFAULT_TREE_PREFS, SessionTree } from './mirror/SessionTree'
import LocalDock from '@/components/LocalDock'

type Row = MirrorTreeSession

interface SessionsResp {
  sessions: Row[]
  folder_order?: string[]
  folder_totals?: Record<string, number>
}

/* Official status → colored text (measured app.devin.ai token values):
   green rgb(0,165,88) · orange rgb(245,142,58) · red rgb(245,59,58) · secondary rgba(25,25,25,.56) */
/* Real status_enum values only — sessionStatus emits working|blocked; archived
   comes from wb.json meta. No invented states (ended/finished/crashed don't
   exist on local acp session/list). */
const STATUS_TEXT: Record<string, { label: string; cls: string }> = {
  working: { label: '进行中', cls: 'text-text-green' },
  blocked: { label: '等待输入', cls: 'text-text-orange' },
  archived: { label: '已归档', cls: 'text-muted-foreground' },
}
const stText = (s: string) => STATUS_TEXT[s] ?? { label: s, cls: 'text-muted-foreground' }

const fmtDay = (iso: string | null | undefined) => {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const d = new Date(t)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
}

/* Real enum values only (sessionStatus: working|blocked; meta: archived). */
const STATUS_OPTS = [
  { v: 'working', l: '进行中', dot: 'bg-[rgb(0,165,88)]' },
  { v: 'blocked', l: '等待输入', dot: 'bg-[rgb(245,142,58)]' },
  { v: 'archived', l: '已归档', dot: 'bg-text-orange' },
  { v: 'unarchived', l: '未归档', dot: 'bg-muted-foreground' },
]

/* Portal-anchored dropdown — same chrome as ui.tsx Combo (rounded-10, bg-95, blur-8).
   side='right' renders an official-style flyout anchored to the item's right
   edge (used for filter submenus); clicks inside ANY menu don't close others. */
function Menu({ anchor, onClose, children, minW = 200, side }: { anchor: DOMRect | null; onClose: () => void; children: ReactNode; minW?: number; side?: 'right' }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null
      if (!ref.current?.contains(e.target as Node) && !t?.closest?.('[data-menu-el]')) onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [onClose])
  if (!anchor) return null
  const w = Math.max(minW, anchor.width)
  let left: number, top: number
  if (side === 'right') {
    left = anchor.right + 2
    if (left + w > window.innerWidth - 8) left = anchor.left - w - 2
    top = Math.max(8, Math.min(anchor.top - 4, window.innerHeight - 340))
  } else {
    left = Math.min(anchor.left, window.innerWidth - w - 8)
    top = anchor.bottom + 4
    if (top + 320 > window.innerHeight - 8 && anchor.top - 4 - 320 > 8) top = anchor.top - 4 - 320
  }
  return createPortal(
    <div ref={ref} data-menu-el className="menu-in fixed z-[100] overflow-y-auto rounded-[10px] bg-elevated/95 p-1 shadow-[0_10px_15px_-3px_rgba(0,0,0,0.06),0_4px_6px_-4px_rgba(0,0,0,0.1)] outline outline-1 outline-border-secondary backdrop-blur-[8px]" style={{ left, top, width: w, maxHeight: 'min(480px, 80vh)' }}>
      {children}
    </div>,
    document.body,
  )
}

/* Official "Add filters" glyph — centered funnel of three rounded bars,
   path copied verbatim from app.devin.ai (NOT lucide ListFilter, which is
   left-aligned). Rendered at 18px inside the 28×28 circle button. */
function FunnelGlyph({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M2.540 4.034 C 1.801 4.276,1.844 5.314,2.599 5.476 C 2.889 5.538,21.111 5.538,21.401 5.476 C 21.785 5.394,22.034 5.047,21.990 4.656 C 21.966 4.449,21.886 4.322,21.664 4.142 L 21.513 4.020 12.066 4.014 C 6.871 4.010,2.584 4.019,2.540 4.034 M5.571 11.279 C 5.395 11.321,5.266 11.411,5.133 11.586 C 5.035 11.714,5.020 11.769,5.020 12.003 C 5.020 12.243,5.033 12.289,5.142 12.426 C 5.210 12.511,5.344 12.620,5.441 12.670 L 5.617 12.760 12.000 12.760 L 18.383 12.760 18.559 12.670 C 18.656 12.620,18.790 12.511,18.858 12.426 C 18.967 12.289,18.980 12.244,18.980 12.000 C 18.980 11.755,18.968 11.712,18.856 11.574 C 18.787 11.489,18.670 11.384,18.596 11.340 C 18.462 11.261,18.382 11.260,12.080 11.254 C 8.571 11.250,5.642 11.262,5.571 11.279 M8.420 18.583 C 8.240 18.677,8.156 18.763,8.075 18.940 C 7.987 19.131,7.980 19.355,8.055 19.531 C 8.123 19.688,8.340 19.900,8.493 19.958 C 8.569 19.986,9.703 20.000,12.000 20.000 C 14.297 20.000,15.431 19.986,15.507 19.958 C 15.660 19.900,15.877 19.688,15.945 19.531 C 16.017 19.363,16.015 19.153,15.938 18.970 C 15.859 18.780,15.775 18.689,15.592 18.596 C 15.449 18.523,15.300 18.520,11.992 18.520 C 8.940 18.520,8.526 18.528,8.420 18.583" />
    </svg>
  )
}

/* Official menu item: h-30px px-2 py-1.5 gap-2 rounded-6 text-13, svg 16px,
   checked mark at the right (measured on app.devin.ai). */
const menuItem = 'flex w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] text-foreground outline-none hover:bg-tint-secondary [&>svg]:size-4 [&>svg]:shrink-0'
/* Official group label: 12px/500 secondary, py-[5px] px-2 → h-26 */
const menuHead = 'select-none px-2 py-[5px] text-[12px] font-medium leading-[16px] text-muted-foreground'
/* Official separator: 9px slot, centered 1px line, mx-2 (bg-clip-content trick) */
const menuSep = 'mx-2 h-[9px] bg-border-secondary bg-clip-content py-1'

/* Official checkbox: 14px rounded-[4px] border .08 transparent; checked →
   bg-accent-primary rgb(49,124,255) + white check; focus-visible 1px accent
   outline offset-2 (all measured on app.devin.ai). */
const FOCUS_RING = 'outline-none focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent-primary'
function Cb({ checked, onToggle, label, stop = true }: { checked: boolean; onToggle: () => void; label: string; stop?: boolean }) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={(e) => { if (stop) e.stopPropagation(); onToggle() }}
      className={cn(
        'flex size-[14px] shrink-0 cursor-pointer touch-manipulation items-center justify-center rounded-[4px] border transition-colors',
        FOCUS_RING,
        checked ? 'border-accent-primary bg-accent-primary text-white' : 'border-border bg-transparent hover:bg-tint-tertiary',
      )}
    >
      {checked && <OCheck size={12} />}
    </button>
  )
}
/* Official row checkbox hit area: full row height, 38px wide — pulls back over
   the row's own 16px padding (exact class string measured from app.devin.ai). */
const CB_HIT = 'relative z-10 -my-2 -ml-4 -mr-2 flex items-center justify-center self-stretch pl-4 pr-2'

export default function SessionsPage() {
  const { t } = useTranslation()
  const nav = useNavigate()
  const [rows, setRows] = useState<Row[]>([])
  const [folders, setFolders] = useState<string[]>([])
  const [folderTotals, setFolderTotals] = useState<Record<string, number>>({})
  const [q, setQ] = useState('')
  const [statusF, setStatusF] = useState<string[]>([])
  const [folderF, setFolderF] = useState<string[]>([])
  const [sort, setSort] = useState<'updated' | 'created'>('updated')
  const [dir, setDir] = useState<'desc' | 'asc'>('desc')
  const [grouped, setGrouped] = useState(true)
  const [treeView, setTreeView] = useState(true)
  const [showCreated, setShowCreated] = useState(false)
  const [showUpdated, setShowUpdated] = useState(true)
  const [showUser, setShowUser] = useState(true)
  const [showFolder, setShowFolder] = useState(false)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<{ kind: string; r: DOMRect } | null>(null)
  const [sub, setSub] = useState<{ kind: 'status' | 'folder'; r: DOMRect } | null>(null)
  const [msg, setMsg] = useState('')
  const [sideOpen, setSideOpen] = useState(window.innerWidth >= 1024)
  const [orgMenu, setOrgMenu] = useState(false)
  const [notifOpen, setNotifOpen] = useState(false)
  const unreadSessions = useMemo(() => rows.filter((s) => s.is_unread), [rows])
  const unreadCount = unreadSessions.length
  const [treePrefs, setTreePrefs] = useState<TreePrefs>(() => {
    try { return { ...DEFAULT_TREE_PREFS, ...JSON.parse(localStorage.getItem(TREE_PREFS_KEY) || '{}') } } catch { return DEFAULT_TREE_PREFS }
  })
  const loaded = useRef(false)
  const searchRef = useRef<HTMLInputElement>(null)

  const updateTreePrefs = (p: Partial<TreePrefs>) => setTreePrefs((prev) => {
    const n = { ...prev, ...p }
    try { localStorage.setItem(TREE_PREFS_KEY, JSON.stringify(n)) } catch { /* unavailable */ }
    return n
  })

  const load = () => adminFetch<SessionsResp>('/api/admin/mirror/sessions')
    .then((r) => {
      const sess = r.sessions ?? []
      setRows(sess)
      // folder_order may be empty even when sessions carry folder values —
      // union both sources so the Folder filter isn't left with just t('sp.noFolder').
      setFolders([...new Set([...(r.folder_order ?? []), ...sess.map((s) => s.folder).filter((f): f is string => !!f)])])
      setFolderTotals(r.folder_totals ?? {})
    })
    .catch(() => {})
  useEffect(() => {
    if (!loaded.current) { loaded.current = true; void load() }
    const t = setInterval(load, 8000)
    return () => clearInterval(t)
  }, [])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return rows.filter((s) => {
      if (statusF.length) {
        const ok = statusF.some((f) =>
          f === 'archived' ? s.status_enum === 'archived'
          : f === 'unarchived' ? s.status_enum !== 'archived'
          : s.status_enum === f)
        if (!ok) return false
      }
      if (folderF.length) {
        const ok = folderF.some((f) => (f === '__none' ? !s.folder : s.folder === f))
        if (!ok) return false
      }
      if (needle && ![s.title, s.devin_id, s.snippet].some((x) => (x ?? '').toLowerCase().includes(needle))) return false
      return true
    })
  }, [rows, q, statusF, folderF])

  const sorted = useMemo(() => {
    const key = (s: Row) => String((sort === 'created' ? s.created_at : s.updated_at) ?? '')
    const out = [...filtered].sort((a, b) => key(a).localeCompare(key(b)))
    return dir === 'desc' ? out.reverse() : out
  }, [filtered, sort, dir])

  // Official "By status" grouping: running turns → Active sessions; everything
  // else (incl. archived, which shows the orange box icon) → Inactive sessions.
  const actives = sorted.filter((s) => s.status_enum === 'working')
  const inactives = sorted.filter((s) => s.status_enum !== 'working')
  const filtersOn = !!(q.trim() || statusF.length || folderF.length)

  const toggle = (sid: string) => setSel((p) => { const n = new Set(p); n.has(sid) ? n.delete(sid) : n.add(sid); return n })
  const toggleSet = (ids: string[], on: boolean) => setSel((p) => { const n = new Set(p); ids.forEach((i) => (on ? n.add(i) : n.delete(i))); return n })
  const allFiltered = sorted.length > 0 && sorted.every((s) => sel.has(s.devin_id))

  const act = (path: string, payload: Record<string, unknown>) =>
    adminFetch(path, { method: 'POST', body: JSON.stringify(payload) }).catch(() => {})
  const bulkArchive = async (archived: boolean) => {
    const n = sel.size
    for (const sid of sel) await act('/api/admin/mirror/session-archive', { devin_id: sid, archived })
    setSel(new Set()); setMsg(archived ? `${t('sp.archivedN', { n })}` : `${t('sp.restoredN', { n })}`); void load()
  }
  const bulkFolder = async (folder: string | null) => {
    const n = sel.size
    for (const sid of sel) await act('/api/admin/mirror/session-folder', { devin_id: sid, folder })
    setSel(new Set()); setMenu(null); setMsg(`${t('sp.movedN', { n })}${folder ? ` → ${folder}` : t('sp.moveOutSuffix')}`); void load()
  }
  const pinRow = (s: Row) => void act('/api/admin/mirror/session-pin', { devin_id: s.devin_id, pinned: !s.is_pinned }).then(load)
  const archRow = (s: Row) => void act('/api/admin/mirror/session-archive', { devin_id: s.devin_id, archived: s.status_enum !== 'archived' }).then(load)

  const exportCsv = () => {
    const esc = (v: string) => `"${(v ?? '').replace(/"/g, '""')}"`
    const head = 'id,title,status,folder,created_at,updated_at'
    const lines = sorted.map((s) => [s.devin_id, s.title, s.status_enum, s.folder ?? '', s.created_at ?? '', s.updated_at ?? ''].map(esc).join(','))
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([head + '\n' + lines.join('\n')], { type: 'text/csv' }))
    a.download = 'sessions.csv'; a.click(); URL.revokeObjectURL(a.href); setMenu(null)
  }

  // 'status'/'folder' are flyout submenus — they anchor off the chip like the
  // parent menu does, so chip clicks reuse the same `sub` channel.
  const openMenu = (kind: string) => (e: ReactMouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    if (kind === 'status' || kind === 'folder') { setSub({ kind, r }); setMenu(null) }
    else { setMenu({ kind, r }); setSub(null) }
  }

  /* ---------- row — official h-[44px] rounded-[6px] gap-[12px] px-[16px] ---------- */
  const RowLine = ({ s, depth = 0 }: { s: Row; depth?: number }) => {
    const [kids, setKids] = useState<Row[] | null>(null)
    const [open, setOpen] = useState(false)
    const hasKids = treeView && ((s.children?.length ?? 0) > 0 || (s.total_children ?? 0) > 0)
    const st = stText(s.status_enum)
    const dead = s.resumable === false
    const loadKids = () => {
      if (open) { setOpen(false); return }
      setOpen(true)
      if (kids === null) adminFetch<{ children: Row[] }>(`/api/admin/mirror/session-children?root=${encodeURIComponent(s.devin_id)}`).then((r) => setKids(r.children || [])).catch(() => setKids([]))
    }
    return (
      <>
        <div
          className={cn('group/row relative isolate flex h-[44px] max-w-full cursor-pointer touch-manipulation select-none items-center gap-[12px] overflow-hidden rounded-[6px] py-[8px] pl-[16px] pr-[16px] hover:bg-tint-tertiary', sel.has(s.devin_id) && 'bg-tint-secondary hover:bg-tint-secondary')}
          onClick={() => nav(`/admin/${s.devin_id}`)}
          title={s.devin_id}
        >
          <span className={CB_HIT}>
            <Cb checked={sel.has(s.devin_id)} onToggle={() => toggle(s.devin_id)} label={t('sp.selectSession')} />
          </span>
          {hasKids ? (
            <button onClick={(e) => { e.stopPropagation(); loadKids() }} className="flex size-4 shrink-0 cursor-pointer items-center justify-center text-muted-foreground" aria-label={open ? t('sp.collapseKids') : t('sp.expandKids')}>
              {open ? <OChevronDown size={13} /> : <OChevronRight size={13} />}
            </button>
          ) : <span className="size-4 shrink-0" />}
          {s.status_enum === 'archived'
            ? <OArchive size={14} className="shrink-0 text-text-orange" aria-label={t('common.archivedAria')} />
            : <Bot size={14} className={cn('shrink-0', dead ? 'text-muted-foreground/50' : 'text-text-green')} />}
          <div className="flex min-w-0 items-center gap-2 overflow-hidden" style={depth ? { paddingLeft: depth * 18 } : undefined}>
            <span className={cn('truncate text-[13px] font-medium leading-[18px] text-foreground', dead && 'text-muted-foreground')}>{s.title || s.devin_id}</span>
            <span className={cn('flex min-w-0 max-w-56 items-center whitespace-nowrap pr-0.5 text-[13px] leading-[18px]', st.cls)}>{t('sp.st.' + s.status_enum, { defaultValue: st.label })}</span>
            {dead && <span className="shrink-0 rounded bg-muted px-1 text-[10px] leading-[15px] text-muted-foreground">{t('sp.deadBadge')}</span>}
            {s.is_pinned && <OPin size={11} className="shrink-0 text-muted-foreground" />}
          </div>
          <div className="flex min-w-0 max-w-[50%] flex-1 items-center overflow-hidden">
            <span className="truncate text-[13px] leading-[18px] text-muted-foreground">{s.snippet}</span>
          </div>
          <div className="mr-auto" />
          <div className="relative flex shrink-0 items-center gap-[12px]">
            {/* hover actions live IN the flow (official expands them before the
                meta) — no absolute overlay, so the avatar is never covered */}
            <span className="hidden items-center gap-0.5 group-hover/row:flex">
              <button onClick={(e) => { e.stopPropagation(); pinRow(s) }} title={s.is_pinned ? 'Unpin' : 'Pin'} aria-label={s.is_pinned ? 'Unpin' : 'Pin'} className={cn('flex size-7 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground', FOCUS_RING)}>
                {s.is_pinned ? <OPin size={14} /> : <OPin size={14} />}
              </button>
              <button onClick={(e) => { e.stopPropagation(); archRow(s) }} title={s.status_enum === 'archived' ? t('sp.unarchive') : t('sp.archive')} aria-label={s.status_enum === 'archived' ? t('sp.unarchive') : t('sp.archive')} className={cn('flex size-7 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground', FOCUS_RING)}>
                {s.status_enum === 'archived' ? <OArchive size={14} /> : <OArchive size={14} />}
              </button>
            </span>
            {showFolder && s.folder && <span className="flex items-center gap-1 text-[13px] leading-[18px] text-muted-foreground"><Tag size={12} />{s.folder}</span>}
            {showCreated && <span className="text-[13px] leading-[18px] text-muted-foreground">{fmtDay(s.created_at)}</span>}
            {showUpdated && <span className="text-[13px] leading-[18px] text-muted-foreground">{fmtDay(s.updated_at)}</span>}
            {showUser && <span className="flex size-6 items-center justify-center rounded-full bg-tint-secondary text-[10px] font-medium text-muted-foreground">L</span>}
          </div>
        </div>
        {open && kids && kids.map((k) => <RowLine key={k.devin_id} s={k} depth={depth + 1} />)}
      </>
    )
  }

  /* ---------- sticky group header, official h-36px border-b text-13/500 secondary ---------- */
  const GroupHead = ({ name, ids }: { name: string; ids: string[] }) => {
    const all = ids.length > 0 && ids.every((i) => sel.has(i))
    return (
      <div className="pointer-events-auto sticky top-0 z-[1] w-full select-none">
        <div className="flex h-9 items-center border-b border-border-secondary bg-background pl-6 text-[13px] font-medium leading-[18px] text-muted-foreground">
          <span className="-ml-6 flex items-center self-stretch pl-4 pr-4">
            <Cb checked={all} onToggle={() => toggleSet(ids, !all)} label={`${t('sp.selectAll', { name })}`} />
          </span>
          {name}
        </div>
      </div>
    )
  }

  /* Official filter chip: h-28 rounded-full pill, border .06, bg-tint-tertiary;
     inner: icon 15px mr-1.5 + label btn px-1 + remove btn rounded-r-full */
  const Chip = ({ icon, label, onClear, kind }: { icon: ReactNode; label: string; onClear: () => void; kind: string }) => (
    <span className="inline-flex h-7 max-w-full items-center rounded-full border border-border-secondary bg-tint-tertiary text-[13px] leading-[18px] text-foreground">
      <button onClick={openMenu(kind)} className={cn('flex h-full cursor-pointer touch-manipulation items-center gap-1 overflow-hidden whitespace-nowrap rounded-l-full pl-2 pr-1 py-0.5 text-foreground hover:bg-tint-secondary', FOCUS_RING)}>
        {icon}{label}
      </button>
      <button onClick={onClear} className={cn('flex h-full cursor-pointer items-center rounded-r-full py-0.5 pl-1 pr-1.5 text-muted-foreground hover:bg-tint-secondary hover:text-foreground', FOCUS_RING)} aria-label={t('sp.removeFilter')}><OX size={12} /></button>
    </span>
  )

  return (
    <div className="flex h-screen bg-background text-foreground">
      {/* ================= official sidebar replica (300px, same as AdminMirror) ================= */}
      {/* mobile scrim — official overlays the sidebar on a backdrop */}
      {sideOpen && <div className="fixed inset-0 z-40 bg-scrim md:hidden" onClick={() => setSideOpen(false)} />}
      {sideOpen && (
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
                    <button role="menuitem" onClick={() => { setOrgMenu(false); nav('/settings') }}
                      className={menuItem}>
                      <Settings2 size={14} className="text-muted-foreground" /> {t('sp.prefs')}
                    </button>
                    <div role="separator" className="mx-2 h-[9px] bg-border bg-clip-content py-1" />
                    <button role="menuitem" onClick={async () => { setOrgMenu(false); if (!confirm(t('sp.restartConfirm'))) return; await adminFetch('/api/admin/restart', { method: 'POST', body: JSON.stringify({}) }).catch(() => null) }}
                      className={menuItem}>
                      <RotateCcw size={14} className="text-muted-foreground" /> {t('sp.restart')}
                    </button>
                    <button role="menuitem" onClick={async () => { setOrgMenu(false); if (!confirm(t('sp.rebuildConfirm'))) return; await adminFetch('/api/admin/redeploy', { method: 'POST', body: JSON.stringify({}) }).catch(() => null) }}
                      className={menuItem}>
                      <RefreshCw size={14} className="text-muted-foreground" /> {t('sp.rebuild')}
                    </button>
                  </div>
                </>
              )}
            </div>
            <button
              onClick={() => searchRef.current?.focus()}
              className="ml-auto flex size-7 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground"
              aria-label={t('common.search')}
              title={t('common.search')}
            >
              <OSearch size={16} />
            </button>
            {/* official: Notifications bell between Search and Collapse — lists unread sessions */}
            <button
              onClick={() => setNotifOpen((v) => !v)}
              className="relative flex size-7 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground"
              aria-label={t('sp.notif')}
              title={t('sp.notif')}
            >
              <OBell size={16} />
              {unreadCount > 0 && <span className="absolute right-1 top-1 size-1.5 rounded-full bg-red-500" />}
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
              onClick={() => setSideOpen(false)}
              className="flex size-7 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground"
              aria-label={t('sp.collapseSb')}
              title={t('sp.collapseSb')}
            >
              <OCollapse size={16} />
            </button>
          </div>
          <nav className="flex flex-col px-2 pt-1">
            <Link
              to="/admin/new"
              className="mb-px flex h-[30px] items-center gap-2 rounded-[6px] px-2 text-[13px] leading-[18px] text-foreground hover:bg-tint-secondary"
            >
              <OCompose size={14} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{t('sp.newSession')}</span>
            </Link>
            <Link
              to="/admin/sessions"
              aria-current="page"
              className="mb-px flex h-[30px] items-center gap-2 rounded-[6px] bg-tint-secondary px-2 text-[13px] font-medium leading-[18px] text-foreground hover:bg-tint-secondary"
            >
              <Rows3 size={14} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{t('sp.sessionsMgmt')}</span>
            </Link>
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            <SessionTree
              tree={rows.filter((r) => r.status_enum !== 'archived')}
              archivedTree={rows.filter((r) => r.status_enum === 'archived')}
              activeDevinId=""
              onOpen={(s) => nav(`/admin/${s.devin_id}`)}
              onRefresh={load}
              prefs={treePrefs}
              onPrefs={updateTreePrefs}
              folderOrder={folders}
              folderTotals={folderTotals}
            />
          </div>
          <LocalDock />
        </aside>
      )}
      {/* collapsed → PanelLeft trigger renders inside the main header */}

      {/* ================= main ================= */}
      <main className="relative flex min-w-0 flex-1 flex-col">
        {/* header: official h-[44px] p-2 pr-[7px] border-b — Sessions | Search + Display */}
        <header className="flex h-11 shrink-0 select-none items-center gap-2 border-b border-border-secondary p-2 pr-[7px]">
          {!sideOpen && (
            <button
              onClick={() => setSideOpen(true)}
              className={cn('flex size-7 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground', FOCUS_RING)}
              aria-label={t('sp.expandSb')}
              title={t('sp.expandSb')}
            >
              <OExpand size={16} />
            </button>
          )}
          <h1 className="pl-1 text-[13px] font-medium leading-[18px]">{t('sp.sessions')}</h1>
          <div className="ml-auto flex items-center gap-2">
            {/* official input-group: 28px shell, border .06, 16px icon, transparent
                input pl-6 pr-10 text-13; focus-within → accent border */}
            <div className="flex h-7 w-full min-w-0 max-w-[220px] items-center rounded-[6px] border border-border-secondary bg-card outline-none focus-within:border-accent-primary max-md:max-w-[150px]">
              <OSearch size={16} className="ml-[10px] shrink-0 text-muted-foreground" />
              <input
                ref={searchRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t('sp.searchPh')}
                className="h-[26px] min-w-0 flex-1 bg-transparent py-[5px] pl-[6px] pr-[10px] text-[13px] leading-[16px] text-foreground caret-accent-primary outline-none placeholder:text-muted-foreground"
              />
              {q && <button onClick={() => setQ('')} className={cn('mr-1.5 flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-[4px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground', FOCUS_RING)} aria-label={t('sp.clearSearch')}><OX size={12} /></button>}
            </div>
            <button onClick={openMenu('display')} className={cn('flex h-7 cursor-pointer touch-manipulation select-none items-center gap-1 whitespace-nowrap rounded-[6px] border border-border bg-card px-[10px] text-[13px] font-medium leading-[18px] text-foreground hover:bg-tint-secondary', FOCUS_RING)}>
              {t('sp.display')} <OChevronDown size={16} className="shrink-0 text-muted-foreground" />
            </button>
          </div>
        </header>

        {/* filter row: official `flex items-start gap-2 sm:items-center` */}
        <div className="flex shrink-0 items-start gap-2 px-3 py-2 sm:items-center">
          <Cb checked={allFiltered} onToggle={() => toggleSet(sorted.map((s) => s.devin_id), !allFiltered)} label={t('sp.selectAll2')} />
          {statusF.length > 0 && (
            <Chip kind="status" icon={<FunnelGlyph size={14} className="text-muted-foreground" />} label={`Status is any of ${statusF.length} type${statusF.length > 1 ? 's' : ''}`} onClear={() => setStatusF([])} />
          )}
          {folderF.length > 0 && (
            <Chip kind="folder" icon={<Tag size={14} className="text-muted-foreground" />} label={folderF.length === 1 ? `Folder is ${folderF[0] === '__none' ? 'none' : folderF[0]}` : `Folder is any of ${folderF.length}`} onClear={() => setFolderF([])} />
          )}
          {/* official Add filters: 28×28 circle, border .06, white bg, 18px icon */}
          <button onClick={openMenu('addfilter')} className={cn('flex size-7 cursor-pointer touch-manipulation items-center justify-center rounded-full border border-border-secondary bg-card text-foreground hover:bg-tint-secondary', FOCUS_RING)} aria-label={t('sp.addFilters')} title={t('sp.addFilters')}>
            <FunnelGlyph size={18} />
          </button>
          {filtersOn && <button onClick={() => { setQ(''); setStatusF([]); setFolderF([]) }} className={cn('flex h-7 cursor-pointer touch-manipulation select-none items-center gap-1 whitespace-nowrap rounded-[6px] px-[10px] text-[13px] font-medium leading-[18px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground', FOCUS_RING)}>{t('sp.clearFilters')}</button>}
        </div>

        {/* list */}
        <div className="relative min-h-0 flex-1 overflow-y-auto pb-2">
          {grouped ? (
            <>
              {actives.length > 0 && <GroupHead name={t('sp.activeSessions')} ids={actives.map((s) => s.devin_id)} />}
              {actives.map((s) => <RowLine key={s.devin_id} s={s} />)}
              {inactives.length > 0 && <GroupHead name={t('sp.inactiveSessions')} ids={inactives.map((s) => s.devin_id)} />}
              {inactives.map((s) => <RowLine key={s.devin_id} s={s} />)}
            </>
          ) : (
            sorted.map((s) => <RowLine key={s.devin_id} s={s} />)
          )}
          {!sorted.length && (
            <div className="flex flex-col items-center gap-2 px-4 py-16 text-center">
              <p className="text-[13px] leading-[18px] text-muted-foreground">{filtersOn ? t('sp.noMatch') : t('sp.noneYet')}</p>
              {filtersOn && <button onClick={() => { setQ(''); setStatusF([]); setFolderF([]) }} className={cn('flex h-7 cursor-pointer select-none items-center rounded-[6px] px-[10px] text-[13px] font-medium leading-[18px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground', FOCUS_RING)}>{t('sp.clearFilters')}</button>}
            </div>
          )}
        </div>

        {/* bulk pill — official: `dark`-classed bg-bg-elevated #1f1f1f card,
            rounded-10 p-2 gap-2 h-46px, absolute bottom-4 centered, L4 shadow */}
        {sel.size > 0 && (
          <div className="dark absolute bottom-4 left-1/2 z-10 flex h-[46px] w-fit -translate-x-1/2 items-center gap-2 rounded-[10px] border border-border-secondary bg-elevated p-2 text-foreground shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5)]">
            <span className="pl-1 pr-1 text-[13px] font-medium leading-[18px]">{sel.size} selected</span>
            <button onClick={() => void bulkArchive(true)} title={t('sp.archive')} className="flex size-7 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground"><OArchive size={16} /></button>
            <button onClick={() => void bulkArchive(false)} title={t('sp.unarchive')} className="flex size-7 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground"><OArchive size={16} /></button>
            <button onClick={openMenu('move')} title={t('sp.moveTo')} className="flex size-7 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground"><FolderInput size={16} /></button>
            <button onClick={() => toggleSet(sorted.slice(0, 50).map((s) => s.devin_id), true)} className="h-7 cursor-pointer rounded-[6px] px-[10px] text-[13px] font-medium leading-[18px] text-accent-primary hover:bg-tint-secondary">{t('sp.selectFirst50')}</button>
            <button onClick={() => setSel(new Set())} className="flex size-7 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground" aria-label={t('sp.clearSel')}><OX size={16} /></button>
          </div>
        )}
        {msg && <div className="fixed bottom-4 right-4 z-50 rounded-[8px] border border-border bg-card px-3 py-1.5 text-[12px] leading-[16px] text-muted-foreground shadow">{msg}</div>}
      </main>

      {/* Display menu — official structure (Sort by / Direction / Grouping / View / Display properties / Export) */}
      {menu?.kind === 'display' && (
        <Menu anchor={menu.r} onClose={() => setMenu(null)} minW={280}>
          <div className={menuHead}>{t('sp.sortBy')}</div>
          {[['updated', t('sp.sortUpdated')], ['created', t('sp.sortCreated')]].map(([v, l]) => (
            <button key={v} className={menuItem} onClick={() => setSort(v as 'updated' | 'created')}>{l}{sort === v && <OCheck size={14} className="ml-auto" />}</button>
          ))}
          <div className={menuSep} />
          <div className={menuHead}>{t('sp.direction')}</div>
          {[['desc', t('sp.dirDesc')], ['asc', t('sp.dirAsc')]].map(([v, l]) => (
            <button key={v} className={menuItem} onClick={() => setDir(v as 'desc' | 'asc')}>{l}{dir === v && <OCheck size={14} className="ml-auto" />}</button>
          ))}
          <div className={menuSep} />
          <div className={menuHead}>{t('sp.grouping')}</div>
          <button className={menuItem} onClick={() => setGrouped(true)}>{t('sp.byStatus')}{grouped && <OCheck size={14} className="ml-auto" />}</button>
          <button className={menuItem} onClick={() => setGrouped(false)}>{t('sp.noGrouping')}{!grouped && <OCheck size={14} className="ml-auto" />}</button>
          <div className={menuSep} />
          <div className={menuHead}>{t('sp.view')}</div>
          <button className={menuItem} onClick={() => setTreeView(false)}>{t('sp.flatList')}{!treeView && <OCheck size={14} className="ml-auto" />}</button>
          <button className={menuItem} onClick={() => setTreeView(true)}>{t('sp.treeView')}{treeView && <OCheck size={14} className="ml-auto" />}</button>
          <div className={menuSep} />
          <div className={menuHead}>{t('sp.displayProps')}</div>
          {([[t('sp.sortCreated'), showCreated, setShowCreated], [t('sp.sortUpdated'), showUpdated, setShowUpdated], [t('sp.propUser'), showUser, setShowUser], [t('sp.propFolder'), showFolder, setShowFolder]] as [string, boolean, (v: boolean) => void][]).map(([l, on, set]) => (
            <button key={l} className={menuItem} onClick={() => set(!on)}>{l}{on && <OCheck size={14} className="ml-auto" />}</button>
          ))}
          <div className={menuSep} />
          <button className={menuItem} onClick={exportCsv}><Download size={14} className="text-muted-foreground" /> {t('sp.exportCsv')}</button>
        </Menu>
      )}

      {/* ☰ add-filter menu — official 220w flat list; rows open RIGHT flyouts
          (parent stays open, like the official submenu). */}
      {menu?.kind === 'addfilter' && (
        <Menu anchor={menu.r} onClose={() => { setMenu(null); setSub(null) }} minW={220}>
          <div className={menuHead}>{t('sp.addFilter')}</div>
          <button className={cn(menuItem, sub?.kind === 'status' && 'bg-tint-secondary')} onClick={(e) => setSub({ kind: 'status', r: e.currentTarget.getBoundingClientRect() })}><FunnelGlyph size={16} className="text-muted-foreground" /> <span className="min-w-0 flex-1 truncate">{t('sp.status')}</span><OChevronRight size={16} className="ml-auto text-muted-foreground" /></button>
          <button className={cn(menuItem, sub?.kind === 'folder' && 'bg-tint-secondary')} onClick={(e) => setSub({ kind: 'folder', r: e.currentTarget.getBoundingClientRect() })}><Tag className="text-muted-foreground" /> <span className="min-w-0 flex-1 truncate">{t('sp.folder')}</span><OChevronRight size={16} className="ml-auto text-muted-foreground" /></button>
        </Menu>
      )}

      {/* status flyout — colored dots + right check, multi "is any of" */}
      {sub?.kind === 'status' && (
        <Menu anchor={sub.r} onClose={() => setSub(null)} side="right" minW={200}>
          <div className={menuHead}>{t('sp.statusAny')}</div>
          {STATUS_OPTS.map((o) => {
            const on = statusF.includes(o.v)
            return (
              <button key={o.v} className={menuItem} onClick={() => setStatusF((p) => (on ? p.filter((x) => x !== o.v) : [...p, o.v]))}>
                <span className={cn('size-2 shrink-0 rounded-full', o.dot)} />
                <span className="min-w-0 flex-1 truncate">{t('sp.st.' + o.v)}</span>
                {on && <OCheck size={14} className="ml-auto shrink-0" />}
              </button>
            )
          })}
        </Menu>
      )}

      {/* folder flyout */}
      {sub?.kind === 'folder' && (
        <Menu anchor={sub.r} onClose={() => setSub(null)} side="right" minW={200}>
          <div className={menuHead}>{t('sp.folderIs')}</div>
          {[{ v: '__none', l: t('sp.noFolder') }, ...folders.map((f) => ({ v: f, l: f }))].map((o) => {
            const on = folderF.includes(o.v)
            return (
              <button key={o.v} className={menuItem} onClick={() => setFolderF((p) => (on ? p.filter((x) => x !== o.v) : [...p, o.v]))}>
                <Tag className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{t('sp.st.' + o.v)}</span>
                {on && <OCheck size={14} className="ml-auto shrink-0" />}
              </button>
            )
          })}
        </Menu>
      )}

      {/* bulk move-to-folder */}
      {menu?.kind === 'move' && (
        <Menu anchor={menu.r} onClose={() => setMenu(null)}>
          <div className={menuHead}>{t('sp.moveTo')}</div>
          {folders.map((f) => <button key={f} className={menuItem} onClick={() => void bulkFolder(f)}><Tag size={14} className="text-muted-foreground" /> {f}</button>)}
          <button className={cn(menuItem, 'text-muted-foreground')} onClick={() => void bulkFolder(null)}>{t('sp.removeFolder')}</button>
        </Menu>
      )}
    </div>
  )
}
