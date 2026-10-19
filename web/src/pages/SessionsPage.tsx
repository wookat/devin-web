import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { createPortal } from 'react-dom'
import { Archive, ArchiveRestore, Bell, Bot, Check, ChevronDown, ChevronRight, Download, FolderInput, ListFilter, PanelLeft, PanelLeftClose, Pin, PinOff, Plus, RefreshCw, RotateCcw, Rows3, Search, Settings2, Tag, X } from 'lucide-react'
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
const STATUS_TEXT: Record<string, { label: string; cls: string }> = {
  working: { label: '进行中', cls: 'text-text-green' },
  idle: { label: 'Sleeping', cls: 'text-muted-foreground' },
  blocked: { label: '等待输入', cls: 'text-text-orange' },
  finished: { label: 'Done', cls: 'text-muted-foreground' },
  stopped: { label: 'Stopped', cls: 'text-muted-foreground' },
  crashed: { label: 'Crashed', cls: 'text-text-red' },
  failed: { label: 'Failed', cls: 'text-text-red' },
  archived: { label: 'Archived', cls: 'text-muted-foreground' },
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

const STATUS_OPTS = [
  { v: 'working', l: '进行中' }, { v: 'blocked', l: '等待输入' }, { v: 'finished', l: 'Done' },
  { v: 'stopped', l: 'Stopped' }, { v: 'crashed', l: 'Crashed' }, { v: 'archived', l: '已归档' }, { v: 'unarchived', l: '未归档' },
]

/* Portal-anchored dropdown — same chrome as ui.tsx Combo (rounded-10, bg-95, blur-8). */
function Menu({ anchor, onClose, children, minW = 200 }: { anchor: DOMRect | null; onClose: () => void; children: ReactNode; minW?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [onClose])
  if (!anchor) return null
  const w = Math.max(minW, anchor.width)
  const left = Math.min(anchor.left, window.innerWidth - w - 8)
  let top = anchor.bottom + 4
  if (top + 320 > window.innerHeight - 8 && anchor.top - 4 - 320 > 8) top = anchor.top - 4 - 320
  return createPortal(
    <div ref={ref} className="menu-in fixed z-[100] overflow-y-auto rounded-[10px] bg-elevated/95 py-1 shadow-[0_10px_15px_-3px_rgba(0,0,0,0.06),0_4px_6px_-4px_rgba(0,0,0,0.1)] outline outline-1 outline-border-secondary backdrop-blur-[8px]" style={{ left, top, width: w, maxHeight: 'min(480px, 80vh)' }}>
      {children}
    </div>,
    document.body,
  )
}

/* Official menu item: h-30px px-2 py-1.5 gap-2 rounded-6 text-13, svg 16px */
const menuItem = 'flex w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] text-foreground outline-none hover:bg-tint-secondary [&>svg]:size-4 [&>svg]:shrink-0'
const menuHead = 'px-2 pb-1 pt-2 text-[12px] leading-[16px] text-muted-foreground'
const menuSep = 'mx-2 my-1 border-t border-border'

/* Official checkbox: 14px rounded-[4px] border .08 transparent; checked →
   bg-accent-primary rgb(49,124,255) + white check; focus-visible 1px accent
   outline offset-2 (all measured on app.devin.ai). */
const FOCUS_RING = 'outline-none focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent-primary'
function Cb({ checked, onToggle, label, stop = true }: { checked: boolean; onToggle: () => void; label: string; stop?: boolean }) {
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
      {checked && <Check size={12} strokeWidth={3} />}
    </button>
  )
}
/* Official row checkbox hit area: full row height, 38px wide — pulls back over
   the row's own 16px padding (exact class string measured from app.devin.ai). */
const CB_HIT = 'relative z-10 -my-2 -ml-4 -mr-2 flex items-center justify-center self-stretch pl-4 pr-2'

export default function SessionsPage() {
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
    .then((r) => { setRows(r.sessions ?? []); setFolders(r.folder_order ?? []); setFolderTotals(r.folder_totals ?? {}) })
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
    setSel(new Set()); setMsg(archived ? `已归档 ${n} 个会话` : `已恢复 ${n} 个会话`); void load()
  }
  const bulkFolder = async (folder: string | null) => {
    const n = sel.size
    for (const sid of sel) await act('/api/admin/mirror/session-folder', { devin_id: sid, folder })
    setSel(new Set()); setMenu(null); setMsg(`已移动 ${n} 个会话${folder ? ` → ${folder}` : '（移出文件夹）'}`); void load()
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

  const openMenu = (kind: string) => (e: ReactMouseEvent<HTMLElement>) => setMenu({ kind, r: e.currentTarget.getBoundingClientRect() })

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
            <Cb checked={sel.has(s.devin_id)} onToggle={() => toggle(s.devin_id)} label="选择会话" />
          </span>
          {hasKids ? (
            <button onClick={(e) => { e.stopPropagation(); loadKids() }} className="flex size-4 shrink-0 cursor-pointer items-center justify-center text-muted-foreground" aria-label={open ? '收起子会话' : '展开子会话'}>
              {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
          ) : <span className="size-4 shrink-0" />}
          {s.status_enum === 'archived'
            ? <Archive size={14} className="shrink-0 text-text-orange" aria-label="Archived" />
            : <Bot size={14} className={cn('shrink-0', dead ? 'text-muted-foreground/50' : 'text-text-green')} />}
          <div className="flex min-w-0 items-center gap-2 overflow-hidden" style={depth ? { paddingLeft: depth * 18 } : undefined}>
            <span className={cn('truncate text-[13px] font-medium leading-[18px] text-foreground', dead && 'text-muted-foreground')}>{s.title || s.devin_id}</span>
            <span className={cn('flex min-w-0 max-w-56 items-center whitespace-nowrap pr-0.5 text-[13px] leading-[18px]', st.cls)}>{st.label}</span>
            {dead && <span className="shrink-0 rounded bg-muted px-1 text-[10px] leading-[15px] text-muted-foreground">已失效</span>}
            {s.is_pinned && <Pin size={11} className="shrink-0 text-muted-foreground" />}
          </div>
          <div className="flex min-w-0 max-w-[50%] flex-1 items-center overflow-hidden">
            <span className="truncate text-[13px] leading-[18px] text-muted-foreground">{s.snippet}</span>
          </div>
          <div className="mr-auto" />
          <div className="relative flex shrink-0 items-center gap-[12px]">
            {showFolder && s.folder && <span className="flex items-center gap-1 text-[13px] leading-[18px] text-muted-foreground"><Tag size={12} />{s.folder}</span>}
            {showCreated && <span className="text-[13px] leading-[18px] text-muted-foreground">{fmtDay(s.created_at)}</span>}
            {showUpdated && <span className="text-[13px] leading-[18px] text-muted-foreground">{fmtDay(s.updated_at)}</span>}
            {showUser && <span className="flex size-6 items-center justify-center rounded-full bg-tint-secondary text-[10px] font-medium text-muted-foreground">L</span>}
          </div>
          {/* official hover slide-in actions: Pin + (local) archive */}
          <div className="absolute right-3 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 bg-background/80 pl-1 backdrop-blur-sm group-hover/row:flex">
            <button onClick={(e) => { e.stopPropagation(); pinRow(s) }} title={s.is_pinned ? 'Unpin' : 'Pin'} aria-label={s.is_pinned ? 'Unpin' : 'Pin'} className={cn('flex size-7 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-primary hover:text-foreground', FOCUS_RING)}>
              {s.is_pinned ? <PinOff size={14} /> : <Pin size={14} />}
            </button>
            <button onClick={(e) => { e.stopPropagation(); archRow(s) }} title={s.status_enum === 'archived' ? '取消归档' : '归档'} aria-label={s.status_enum === 'archived' ? '取消归档' : '归档'} className={cn('flex size-7 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-primary hover:text-foreground', FOCUS_RING)}>
              {s.status_enum === 'archived' ? <ArchiveRestore size={14} /> : <Archive size={14} />}
            </button>
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
            <Cb checked={all} onToggle={() => toggleSet(ids, !all)} label={`全选 ${name}`} />
          </span>
          {name}
        </div>
      </div>
    )
  }

  /* Official filter chip: 28px rounded-6 bordered card, icon + label + × */
  const Chip = ({ icon, label, onClear, kind }: { icon: ReactNode; label: string; onClear: () => void; kind: string }) => (
    <span className="inline-flex h-7 items-center gap-1 rounded-[6px] border border-border bg-card pr-0.5 text-[13px] leading-[18px] text-foreground">
      <button onClick={openMenu(kind)} className={cn('flex h-full cursor-pointer touch-manipulation items-center gap-1 rounded-l-[6px] pl-[10px] pr-1 text-foreground hover:bg-tint-secondary', FOCUS_RING)}>
        {icon}{label}
      </button>
      <button onClick={onClear} className={cn('flex size-5 cursor-pointer items-center justify-center rounded-[4px] text-muted-foreground hover:bg-tint-primary hover:text-foreground', FOCUS_RING)} aria-label="移除筛选"><X size={12} /></button>
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
                <span className="flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-foreground text-[9px] font-semibold text-background">本</span>
                <span className="truncate">本地 Devin</span>
                <ChevronDown size={12} className="shrink-0 text-muted-foreground" />
              </button>
              {orgMenu && (
                <>
                  <div className="fixed inset-0 z-20" onClick={() => setOrgMenu(false)} />
                  <div role="menu" className="absolute left-0 top-9 z-30 w-[220px] overflow-hidden rounded-[10px] bg-card/95 p-1 shadow-lg ring-1 ring-border backdrop-blur-[8px]">
                    <button role="menuitem" onClick={() => { setOrgMenu(false); nav('/settings') }}
                      className={menuItem}>
                      <Settings2 size={14} className="text-muted-foreground" /> 首选项…
                    </button>
                    <div role="separator" className="mx-2 h-[9px] bg-border bg-clip-content py-1" />
                    <button role="menuitem" onClick={async () => { setOrgMenu(false); if (!confirm('重启服务？server 将自动重生，页面稍后自动刷新。')) return; await adminFetch('/api/admin/restart', { method: 'POST', body: JSON.stringify({}) }).catch(() => null) }}
                      className={menuItem}>
                      <RotateCcw size={14} className="text-muted-foreground" /> 重启服务
                    </button>
                    <button role="menuitem" onClick={async () => { setOrgMenu(false); if (!confirm('重新构建并重启？构建约 1-3 分钟。')) return; await adminFetch('/api/admin/redeploy', { method: 'POST', body: JSON.stringify({}) }).catch(() => null) }}
                      className={menuItem}>
                      <RefreshCw size={14} className="text-muted-foreground" /> 重新构建并重启
                    </button>
                  </div>
                </>
              )}
            </div>
            <button
              onClick={() => searchRef.current?.focus()}
              className="ml-auto flex size-7 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground"
              aria-label="Search"
              title="Search"
            >
              <Search size={16} />
            </button>
            {/* official: Notifications bell between Search and Collapse — lists unread sessions */}
            <button
              onClick={() => setNotifOpen((v) => !v)}
              className="relative flex size-7 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground"
              aria-label="Notifications"
              title="Notifications"
            >
              <Bell size={16} />
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
              onClick={() => setSideOpen(false)}
              className="flex size-7 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground"
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
            >
              <PanelLeftClose size={16} />
            </button>
          </div>
          <nav className="flex flex-col px-2 pt-1">
            <Link
              to="/admin/new"
              className="mb-px flex h-[30px] items-center gap-2 rounded-[6px] px-2 text-[13px] leading-[18px] text-foreground hover:bg-tint-secondary"
            >
              <Plus size={14} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">新会话</span>
            </Link>
            <Link
              to="/admin/sessions"
              aria-current="page"
              className="mb-px flex h-[30px] items-center gap-2 rounded-[6px] bg-tint-secondary px-2 text-[13px] font-medium leading-[18px] text-foreground hover:bg-tint-secondary"
            >
              <Rows3 size={14} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">会话管理</span>
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
              aria-label="Expand sidebar"
              title="Expand sidebar"
            >
              <PanelLeft size={16} />
            </button>
          )}
          <h1 className="pl-1 text-[13px] font-medium leading-[18px]">Sessions</h1>
          <div className="ml-auto flex items-center gap-2">
            {/* official input-group: 28px shell, border .06, 16px icon, transparent
                input pl-6 pr-10 text-13; focus-within → accent border */}
            <div className="flex h-7 w-full min-w-0 max-w-[220px] items-center rounded-[6px] border border-border-secondary bg-card outline-none focus-within:border-accent-primary max-md:max-w-[150px]">
              <Search size={16} className="ml-[10px] shrink-0 text-muted-foreground" />
              <input
                ref={searchRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search sessions…"
                className="h-[26px] min-w-0 flex-1 bg-transparent py-[5px] pl-[6px] pr-[10px] text-[13px] leading-[16px] text-foreground caret-accent-primary outline-none placeholder:text-muted-foreground"
              />
              {q && <button onClick={() => setQ('')} className={cn('mr-1.5 flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-[4px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground', FOCUS_RING)} aria-label="清除搜索"><X size={12} /></button>}
            </div>
            <button onClick={openMenu('display')} className={cn('flex h-7 cursor-pointer touch-manipulation select-none items-center gap-1 whitespace-nowrap rounded-[6px] border border-border bg-card px-[10px] text-[13px] font-medium leading-[18px] text-foreground hover:bg-tint-secondary', FOCUS_RING)}>
              Display <ChevronDown size={16} className="shrink-0 text-muted-foreground" />
            </button>
          </div>
        </header>

        {/* filter row: official `flex items-start gap-2 sm:items-center` */}
        <div className="flex shrink-0 items-start gap-2 px-3 py-2 sm:items-center">
          <Cb checked={allFiltered} onToggle={() => toggleSet(sorted.map((s) => s.devin_id), !allFiltered)} label="全选" />
          {statusF.length > 0 && (
            <Chip kind="status" icon={<ListFilter size={14} className="text-muted-foreground" />} label={`Status is any of ${statusF.length} type${statusF.length > 1 ? 's' : ''}`} onClear={() => setStatusF([])} />
          )}
          {folderF.length > 0 && (
            <Chip kind="folder" icon={<Tag size={14} className="text-muted-foreground" />} label={folderF.length === 1 ? `Folder is ${folderF[0] === '__none' ? 'none' : folderF[0]}` : `Folder is any of ${folderF.length}`} onClear={() => setFolderF([])} />
          )}
          <button onClick={openMenu('addfilter')} className={cn('flex size-7 cursor-pointer touch-manipulation items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground', FOCUS_RING)} aria-label="添加筛选" title="添加筛选">
            <ListFilter size={16} />
          </button>
          {filtersOn && <button onClick={() => { setQ(''); setStatusF([]); setFolderF([]) }} className={cn('flex h-7 cursor-pointer touch-manipulation select-none items-center gap-1 whitespace-nowrap rounded-[6px] px-[10px] text-[13px] font-medium leading-[18px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground', FOCUS_RING)}>Clear filters</button>}
        </div>

        {/* list */}
        <div className="relative min-h-0 flex-1 overflow-y-auto pb-2">
          {grouped ? (
            <>
              {actives.length > 0 && <GroupHead name="Active sessions" ids={actives.map((s) => s.devin_id)} />}
              {actives.map((s) => <RowLine key={s.devin_id} s={s} />)}
              {inactives.length > 0 && <GroupHead name="Inactive sessions" ids={inactives.map((s) => s.devin_id)} />}
              {inactives.map((s) => <RowLine key={s.devin_id} s={s} />)}
            </>
          ) : (
            sorted.map((s) => <RowLine key={s.devin_id} s={s} />)
          )}
          {!sorted.length && (
            <div className="flex flex-col items-center gap-2 px-4 py-16 text-center">
              <p className="text-[13px] leading-[18px] text-muted-foreground">{filtersOn ? '没有匹配筛选的会话' : '还没有会话'}</p>
              {filtersOn && <button onClick={() => { setQ(''); setStatusF([]); setFolderF([]) }} className={cn('flex h-7 cursor-pointer select-none items-center rounded-[6px] px-[10px] text-[13px] font-medium leading-[18px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground', FOCUS_RING)}>Clear filters</button>}
            </div>
          )}
        </div>

        {/* bulk pill — official: `dark`-classed bg-bg-elevated #1f1f1f card,
            rounded-10 p-2 gap-2 h-46px, absolute bottom-4 centered, L4 shadow */}
        {sel.size > 0 && (
          <div className="dark absolute bottom-4 left-1/2 z-10 flex h-[46px] w-fit -translate-x-1/2 items-center gap-2 rounded-[10px] border border-border-secondary bg-elevated p-2 text-foreground shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5)]">
            <span className="pl-1 pr-1 text-[13px] font-medium leading-[18px]">{sel.size} selected</span>
            <button onClick={() => void bulkArchive(true)} title="归档" className="flex size-7 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground"><Archive size={16} /></button>
            <button onClick={() => void bulkArchive(false)} title="取消归档" className="flex size-7 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground"><ArchiveRestore size={16} /></button>
            <button onClick={openMenu('move')} title="移到文件夹" className="flex size-7 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground"><FolderInput size={16} /></button>
            <button onClick={() => toggleSet(sorted.slice(0, 50).map((s) => s.devin_id), true)} className="h-7 cursor-pointer rounded-[6px] px-[10px] text-[13px] font-medium leading-[18px] text-accent-primary hover:bg-tint-secondary">Select first 50 sessions</button>
            <button onClick={() => setSel(new Set())} className="flex size-7 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground" aria-label="清除选择"><X size={16} /></button>
          </div>
        )}
        {msg && <div className="fixed bottom-4 right-4 z-50 rounded-[8px] border border-border bg-card px-3 py-1.5 text-[12px] leading-[16px] text-muted-foreground shadow">{msg}</div>}
      </main>

      {/* Display menu — official structure (Sort by / Direction / Grouping / View / Display properties / Export) */}
      {menu?.kind === 'display' && (
        <Menu anchor={menu.r} onClose={() => setMenu(null)} minW={220}>
          <div className={menuHead}>Sort by</div>
          {[['updated', 'Updated'], ['created', 'Created']].map(([v, l]) => (
            <button key={v} className={menuItem} onClick={() => setSort(v as 'updated' | 'created')}>{l}{sort === v && <Check size={14} className="ml-auto" />}</button>
          ))}
          <div className={menuSep} />
          <div className={menuHead}>Direction</div>
          {[['desc', 'Newest first'], ['asc', 'Oldest first']].map(([v, l]) => (
            <button key={v} className={menuItem} onClick={() => setDir(v as 'desc' | 'asc')}>{l}{dir === v && <Check size={14} className="ml-auto" />}</button>
          ))}
          <div className={menuSep} />
          <div className={menuHead}>Grouping</div>
          <button className={menuItem} onClick={() => setGrouped(true)}>By status{grouped && <Check size={14} className="ml-auto" />}</button>
          <button className={menuItem} onClick={() => setGrouped(false)}>No grouping{!grouped && <Check size={14} className="ml-auto" />}</button>
          <div className={menuSep} />
          <div className={menuHead}>View</div>
          <button className={menuItem} onClick={() => setTreeView(false)}>Flat list{!treeView && <Check size={14} className="ml-auto" />}</button>
          <button className={menuItem} onClick={() => setTreeView(true)}>Tree view{treeView && <Check size={14} className="ml-auto" />}</button>
          <div className={menuSep} />
          <div className={menuHead}>Display properties</div>
          {([['Created', showCreated, setShowCreated], ['Updated', showUpdated, setShowUpdated], ['User', showUser, setShowUser], ['Folder', showFolder, setShowFolder]] as [string, boolean, (v: boolean) => void][]).map(([l, on, set]) => (
            <button key={l} className={menuItem} onClick={() => set(!on)}>{l}{on && <Check size={14} className="ml-auto" />}</button>
          ))}
          <div className={menuSep} />
          <button className={menuItem} onClick={exportCsv}><Download size={14} className="text-muted-foreground" /> Export to CSV</button>
        </Menu>
      )}

      {/* ☰ add-filter menu */}
      {menu?.kind === 'addfilter' && (
        <Menu anchor={menu.r} onClose={() => setMenu(null)}>
          <div className={menuHead}>Add filter</div>
          <button className={menuItem} onClick={(e) => setMenu({ kind: 'status', r: e.currentTarget.getBoundingClientRect() })}><ListFilter size={14} className="text-muted-foreground" /> Status</button>
          <button className={menuItem} onClick={(e) => setMenu({ kind: 'folder', r: e.currentTarget.getBoundingClientRect() })}><Tag size={14} className="text-muted-foreground" /> Folder</button>
        </Menu>
      )}

      {/* status filter — multi "is any of" like official */}
      {menu?.kind === 'status' && (
        <Menu anchor={menu.r} onClose={() => setMenu(null)}>
          <div className={menuHead}>Status is any of</div>
          {STATUS_OPTS.map((o) => {
            const on = statusF.includes(o.v)
            return (
              <button key={o.v} className={menuItem} onClick={() => setStatusF((p) => (on ? p.filter((x) => x !== o.v) : [...p, o.v]))}>
                {o.l}{on && <Check size={14} className="ml-auto" />}
              </button>
            )
          })}
        </Menu>
      )}

      {/* folder filter */}
      {menu?.kind === 'folder' && (
        <Menu anchor={menu.r} onClose={() => setMenu(null)}>
          <div className={menuHead}>Folder is</div>
          {[{ v: '__none', l: '(无文件夹)' }, ...folders.map((f) => ({ v: f, l: f }))].map((o) => {
            const on = folderF.includes(o.v)
            return (
              <button key={o.v} className={menuItem} onClick={() => setFolderF((p) => (on ? p.filter((x) => x !== o.v) : [...p, o.v]))}>
                {o.l}{on && <Check size={14} className="ml-auto" />}
              </button>
            )
          })}
        </Menu>
      )}

      {/* bulk move-to-folder */}
      {menu?.kind === 'move' && (
        <Menu anchor={menu.r} onClose={() => setMenu(null)}>
          <div className={menuHead}>移到文件夹</div>
          {folders.map((f) => <button key={f} className={menuItem} onClick={() => void bulkFolder(f)}><Tag size={14} className="text-muted-foreground" /> {f}</button>)}
          <button className={cn(menuItem, 'text-muted-foreground')} onClick={() => void bulkFolder(null)}>移出文件夹</button>
        </Menu>
      )}
    </div>
  )
}
