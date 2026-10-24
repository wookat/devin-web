import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { ChevronsUpDown, CircleDot, Folder as FolderIcon, List, ListFilter, Plus, RotateCcw, Settings2 } from 'lucide-react'
import { OArchive, OCheck, OChevronLeft, OChevronRight, ODots, OSearch } from '../../components/officialIcons'
import { adminFetch } from '@/lib/api'
import { type MirrorTreeSession } from './treeCache'
import { PROP_NAMES, type TreePrefs, DEFAULT_TREE_PREFS, RANGE_LABELS, filterCount, menuItemCls } from './treePrefs'
import { dateLoc } from '@/lib/datetime'

/** Official-style inline month calendar for the Filter Custom… date range. */
function MenuCalendar({ title, range, onPick, onReset }: { title: string; range: [string, string]; onPick: (d: string) => void; onReset: () => void }) {
  const { t } = useTranslation()
  const [month, setMonth] = useState(() => { const n = new Date(); return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1)) })
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  const label = (s: string) => s ? new Date(s + 'T00:00:00Z').toLocaleDateString(dateLoc(), { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—'
  const first = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1))
  const start = new Date(first); start.setUTCDate(1 - first.getUTCDay())
  const days: Date[] = Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setUTCDate(start.getUTCDate() + i); return d })
  return (
    <div className="px-2 pb-2" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between py-[5px]">
        <span className="text-[12px] font-medium text-muted-foreground">{title}</span>
        <button role="menuitem" onClick={onReset} className="cursor-pointer text-[12px] font-medium text-primary hover:underline">{t('common.reset')}</button>
      </div>
      <div className="flex items-center gap-2 pb-1 text-[12px] text-muted-foreground">
        <span>{label(range[0])}</span><span>{label(range[1])}</span>
      </div>
      <div className="flex items-center justify-between py-1">
        <button aria-label={t('tree.prevMonth')} onClick={() => setMonth(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 1, 1)))} className="flex size-6 items-center justify-center rounded-md hover:bg-muted"><OChevronLeft size={13} /></button>
        <span className="text-[13px] font-medium">{month.toLocaleDateString(dateLoc(), { month: 'long', year: 'numeric', timeZone: 'UTC' })}</span>
        <button aria-label={t('tree.nextMonth')} onClick={() => setMonth(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1)))} className="flex size-6 items-center justify-center rounded-md hover:bg-muted"><OChevronRight size={13} /></button>
      </div>
      <div className="grid grid-cols-7 text-center text-[12px] text-muted-foreground">{Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(dateLoc(), { weekday: 'narrow', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 5, 2 + i)))).map((d) => <span key={d} className="p-px leading-4">{d}</span>)}</div>
      <div className="grid grid-cols-7">
        {days.map((d) => {
          const ds = fmt(d)
          const inMonth = d.getUTCMonth() === month.getUTCMonth()
          const sel = ds === range[0] || ds === range[1]
          const inRange = range[0] && range[1] && ds > range[0] && ds < range[1]
          return (
            <button key={ds} onClick={() => onPick(ds)} className={`size-[30px] rounded-[6px] text-center text-[13px] ${sel ? 'bg-primary text-primary-foreground' : inRange ? 'bg-muted' : 'hover:bg-muted'} ${inMonth ? '' : 'text-muted-foreground/50'}`}>
              {d.getUTCDate()}
            </button>
          )
        })}
      </div>
    </div>
  )
}

type HeaderMenuMode = 'main' | 'sort' | 'filter' | 'group' | 'propvis' | 'more' | 'moreactions' | 'newfolder' | 'flt_stype' | 'flt_machine' | 'flt_auto' | 'flt_status' | 'flt_pr' | 'flt_created' | 'flt_updated' | 'flt_created_cal' | 'flt_updated_cal' | 'flt_createdby' | 'flt_tags'

/** The "Sessions" label row (Properties + ⋯ triggers) and the portaled header
 *  menu stack they drive: sort, filter + every flt_* submenu (incl. the
 *  Custom… calendars), group/property-visibility, new-folder input, more
 *  actions. Sub-menus open as a stack of fixed panels beside the parent —
 *  pushMenu appends, hoverMenu swaps the panel at a depth, trimMenu/popMenu
 *  collapse it back. */
function TreeHeaderMenus({ prefs, onPrefs, tree, folderNames, folderAction }: { prefs: TreePrefs; onPrefs: (p: Partial<TreePrefs>) => void; tree: MirrorTreeSession[]; folderNames: string[]; folderAction: (path: string, payload: Record<string, unknown>) => Promise<void> }) {
  const { t } = useTranslation()
  const [propsMenu, setPropsMenu] = useState<{ mode: HeaderMenuMode; left: number; top: number; stack?: { mode: HeaderMenuMode; left: number; top: number }[] } | null>(null)
  const [fltSearch, setFltSearch] = useState('')
  const [meName, setMeName] = useState('')
  useEffect(() => { adminFetch<{ members: { user_id: string; name: string }[] }>('/api/admin/mirror/members').then((r) => setMeName(r.members?.[0]?.name || '')).catch(() => {}) }, [])
  const [tagSearch, setTagSearch] = useState('')
  // Official builds the Tags submenu from tags on the loaded sessions (no directory call); agent:-namespaced tags are not shown.
  const orgTags = useMemo(() => {
    const set = new Set<string>()
    const walk = (list: MirrorTreeSession[]) => { for (const s of list) { for (const t of s.tags || []) if (!t.includes(':')) set.add(t); walk(s.children) } }
    walk(tree)
    return [...set].sort()
  }, [tree])
  const [newFolderDraft, setNewFolderDraft] = useState('')
  const openHeaderMenu = (e: React.MouseEvent<HTMLButtonElement>, mode: 'main' | 'more') => {
    e.stopPropagation()
    const r = e.currentTarget.getBoundingClientRect()
    setPropsMenu((m) => (m?.mode === mode ? null : {
      mode,
      left: Math.max(4, Math.min(r.left, window.innerWidth - 250)),
      top: Math.min(r.bottom + 4, window.innerHeight - 260),
    }))
  }
  const pushMenu = (e: React.MouseEvent, mode: HeaderMenuMode) => {
    e.stopPropagation()
    const item = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const panel = (e.currentTarget as HTMLElement).closest('[role="menu"]')?.getBoundingClientRect()
    const left = Math.min((panel?.right ?? item.right) - 2, window.innerWidth - 224)
    const top = Math.min(item.top - 4, window.innerHeight - 260)
    setPropsMenu((m) => m && { ...m, stack: [...(m.stack ?? []), { mode, left, top }] })
  }
  const replaceMenu = (mode: HeaderMenuMode) => {
    setPropsMenu((m) => {
      if (!m) return m
      if (m.stack?.length) { const st = [...m.stack]; st[st.length - 1] = { ...st[st.length - 1], mode }; return { ...m, stack: st } }
      return { ...m, mode }
    })
  }
  const popMenu = () => setPropsMenu((m) => (m ? (m.stack?.length ? { ...m, stack: m.stack.slice(0, -1) } : null) : m))
  const trimMenu = (depth: number) => setPropsMenu((m) => (m && (m.stack?.length ?? 0) > depth ? { ...m, stack: (m.stack ?? []).slice(0, depth) } : m))
  const hoverMenu = (e: React.MouseEvent, depth: number, mode: HeaderMenuMode) => {
    const item = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const panel = (e.currentTarget as HTMLElement).closest('[role="menu"]')?.getBoundingClientRect()
    const left = Math.min((panel?.right ?? item.right) - 2, window.innerWidth - 224)
    const top = Math.min(item.top - 4, window.innerHeight - 260)
    setPropsMenu((m) => {
      if (!m) return m
      if (m.stack?.[depth]?.mode === mode) return m
      return { ...m, stack: [...(m.stack ?? []).slice(0, depth), { mode, left, top }] }
    })
  }
  useEffect(() => {
    if (!propsMenu) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') popMenu() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [propsMenu])
  const groupNames = [...folderNames, 'Pinned', 'Recent', 'Archived']
  return (
    <>
      <div data-slot="sidebar-label-row" className="group/label sticky top-0 z-20 flex h-8 w-full shrink-0 items-center justify-between gap-px bg-background pl-1 pr-1 text-[12px] font-medium text-muted-foreground">
        <span data-slot="sidebar-group-label" className="min-w-0 flex-1 truncate pl-1">{t('tree.sessions')}</span>
        <button
          aria-label={t('tree.properties')}
          title={t('tree.properties')}
          onClick={(e) => openHeaderMenu(e, 'main')}
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md opacity-0 transition-all hover:text-foreground focus:opacity-100 group-hover/label:opacity-100"
        >
          <Settings2 size={13} />
        </button>
        <button
          aria-label={t('common.more')}
          title={t('common.more')}
          onClick={(e) => openHeaderMenu(e, 'more')}
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md opacity-0 transition-all hover:text-foreground focus:opacity-100 group-hover/label:opacity-100"
        >
          <ODots size={14} />
        </button>
      </div>
      {propsMenu && createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); setPropsMenu(null) }} />
          {[{ mode: propsMenu.mode, left: propsMenu.left, top: propsMenu.top }, ...(propsMenu.stack ?? [])].map((panel, pi) => (
          <div
            key={pi}
            role="menu"
            style={{ left: panel.left, top: panel.top }}
            className="menu-in fixed z-50 max-h-[70vh] min-w-[220px] overflow-y-auto rounded-[10px] bg-white/[.94] dark:bg-[#1f1f1f]/[.94] p-1 text-popover-foreground shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)] outline outline-1 outline-black/[.08] backdrop-blur-[8px] dark:outline-white/[.04] dark:-outline-offset-1"
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); popMenu() } }}
          >
            {panel.mode === 'main' && (
              <>
                <div className="flex items-center justify-between px-2 py-1">
                  <span className="text-[12px] text-muted-foreground">{t('tree.propertiesTxt')}</span>
                  <button role="menuitem" onClick={(e) => { e.stopPropagation(); onPrefs({ ...DEFAULT_TREE_PREFS }); setPropsMenu(null) }} className="cursor-pointer text-[12px] font-medium leading-4 text-primary hover:underline">{t('common.reset')}</button>
                </div>
                <button role="menuitem" aria-haspopup="menu" onMouseEnter={(e) => hoverMenu(e, pi, 'sort')} onClick={(e) => { pushMenu(e, 'sort') }} className={menuItemCls}>
                  <ChevronsUpDown size={13} className="text-muted-foreground" /> {t('tree.sort')}
                  <span className="ml-auto flex items-center gap-1 text-muted-foreground">{prefs.sort === 'created_at' ? t('tree.lastCreated') : t('tree.lastUpdated')} <OChevronRight size={12} /></span>
                </button>
                <button role="menuitem" aria-haspopup="menu" onMouseEnter={(e) => hoverMenu(e, pi, 'filter')} onClick={(e) => { pushMenu(e, 'filter') }} className={menuItemCls}>
                  <ListFilter size={13} className="text-muted-foreground" /> {t('tree.filter')}
                  <span className="ml-auto flex items-center gap-1 text-muted-foreground">{filterCount(prefs) > 0 ? filterCount(prefs) : ''} <OChevronRight size={12} /></span>
                </button>
                <button role="menuitem" aria-haspopup="menu" onMouseEnter={(e) => hoverMenu(e, pi, 'group')} onClick={(e) => { pushMenu(e, 'group') }} className={menuItemCls}>
                  <FolderIcon size={13} className="text-muted-foreground" /> {t('tree.group')}
                  <span className="ml-auto flex items-center gap-1 text-muted-foreground">{t('tree.folders')} <OChevronRight size={12} /></span>
                </button>
                <button role="menuitem" aria-haspopup="menu" onMouseEnter={(e) => hoverMenu(e, pi, 'propvis')} onClick={(e) => { pushMenu(e, 'propvis') }} className={menuItemCls}>
                  <CircleDot size={13} className="text-muted-foreground" /> {t('tree.propVis')}
                  <span className="ml-auto flex items-center gap-1 text-muted-foreground">{PROP_NAMES.filter((n) => !prefs.propHidden[n]).length} <OChevronRight size={12} /></span>
                </button>
                <button
                  role="menuitemcheckbox"
                  aria-checked={prefs.compact}
                  onMouseEnter={() => trimMenu(pi)}
                  onClick={(e) => { e.stopPropagation(); onPrefs({ compact: !prefs.compact }) }}
                  className={menuItemCls}
                >
                  <List size={13} className="text-muted-foreground" /> {t('tree.compactView')}
                  <span className={`ml-auto flex h-4 w-7 items-center rounded-full p-0.5 transition-colors ${prefs.compact ? 'justify-end bg-blue-500' : 'bg-muted-foreground/30'}`}><span className="size-3 rounded-full bg-white" /></span>
                </button>
              </>
            )}
            {panel.mode === 'sort' && (['updated_at', 'created_at'] as const).map((k) => (
              <button
                key={k}
                role="menuitemradio"
                aria-checked={prefs.sort === k}
                onClick={(e) => { e.stopPropagation(); onPrefs({ sort: k }); setPropsMenu(null) }}
                className={menuItemCls}
              >
                <span className="flex w-4 justify-center">{prefs.sort === k && <OCheck size={13} />}</span>
                {k === 'updated_at' ? t('tree.lastUpdated') : t('tree.lastCreated')}
              </button>
            ))}
            {panel.mode === 'filter' && (
              <>
                <div className="mb-1 flex items-center gap-2 border-b border-border px-2 pb-1.5 pt-1">
                  <OSearch size={13} className="shrink-0 text-muted-foreground" />
                  <input
                    autoFocus
                    value={fltSearch}
                    onChange={(e) => setFltSearch(e.target.value)}
                    placeholder={t('tree.searchFilters')}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setFltSearch(''); popMenu() } }}
                    className="w-full min-w-0 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
                  />
                </div>
                {(['flt_stype','flt_createdby','flt_machine','flt_auto','flt_status','flt_pr','flt_tags','flt_archived','flt_created','flt_updated'] as const).filter((m) => !fltSearch || t('tree.flt.' + m).toLowerCase().includes(fltSearch.toLowerCase())).map((m) =>
                  m === 'flt_archived' ? (
                    <div key={m} role="menuitem" aria-disabled="true" className={`${menuItemCls} cursor-default opacity-50`}>{t('menu.archivedTxt')}</div>
                  ) : (
                  <button key={m} role="menuitem" aria-haspopup="menu" onMouseEnter={(e) => hoverMenu(e, pi, m)} onClick={(e) => { e.stopPropagation(); setFltSearch(''); pushMenu(e, m) }} className={menuItemCls}>
                    {t('tree.flt.' + m)}
                    <span className="ml-auto flex items-center gap-1 text-muted-foreground"><OChevronRight size={12} /></span>
                  </button>
                  ))}
                {filterCount(prefs) > 0 ? (
                  <button role="menuitem" onClick={(e) => { e.stopPropagation(); onPrefs({ statuses: [], sessionTypes: ['devin', 'ada'], platforms: ['linux', 'windows', 'macos'], automation: ['automations', 'not_automations'], prStates: [], createdRange: '', updatedRange: 'month', createdCustom: ['', ''], updatedCustom: ['', ''], createdBy: 'self', tags: [] }) }} className={menuItemCls}>
                    <RotateCcw size={13} className="text-muted-foreground" /> {t('tree.resetDefault')}
                  </button>
                ) : (
                  <div role="menuitem" aria-disabled="true" className={`${menuItemCls} cursor-default opacity-50`}>
                    <RotateCcw size={13} className="text-muted-foreground" /> {t('tree.resetDefault')}
                  </div>
                )}
              </>
            )}
            {panel.mode === 'flt_createdby' && (
              <>
                <div className="flex items-center justify-between gap-2 px-2">
                  <div className="py-[5px] text-[12px] font-medium text-muted-foreground">{t('tree.createdBy')}</div>
                  <button role="menuitem" onClick={(e) => { e.stopPropagation(); onPrefs({ createdBy: 'self' }) }} className="cursor-pointer text-[12px] font-medium text-primary hover:underline">{t('common.reset')}</button>
                </div>
                <button role="menuitemcheckbox" aria-checked={prefs.createdBy === 'self'} onClick={(e) => { e.stopPropagation(); onPrefs({ createdBy: prefs.createdBy === 'self' ? 'annotated' : 'self' }) }} className={menuItemCls}>
                  <span className="flex w-4 justify-center">{prefs.createdBy === 'self' && <OCheck size={13} />}</span>
                  {meName || 'Me'}
                </button>
              </>
            )}
            {panel.mode === 'flt_tags' && (
              <>
                <div className="flex items-center justify-between gap-2 px-2">
                  <div className="py-[5px] text-[12px] font-medium text-muted-foreground">{t('tree.tags')}</div>
                  <button role="menuitem" onClick={(e) => { e.stopPropagation(); onPrefs({ tags: [] }) }} className="cursor-pointer text-[12px] font-medium text-primary hover:underline">{t('common.reset')}</button>
                </div>
                <div className="mb-1 flex items-center gap-2 border-b border-border px-2 pb-1.5">
                  <OSearch size={13} className="shrink-0 text-muted-foreground" />
                  <input autoFocus value={tagSearch} onChange={(e) => setTagSearch(e.target.value)} placeholder={t('tree.searchTags')} onClick={(e) => e.stopPropagation()} className="w-full min-w-0 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground" />
                </div>
                {orgTags.filter((t) => !tagSearch || t.toLowerCase().includes(tagSearch.toLowerCase())).map((t) => {
                  const on = prefs.tags.includes(t)
                  return (
                    <button key={t} role="menuitemcheckbox" aria-checked={on} onClick={(e) => { e.stopPropagation(); onPrefs({ tags: on ? prefs.tags.filter((x) => x !== t) : [...prefs.tags, t] }) }} className={menuItemCls}>
                      <span className="flex w-4 justify-center">{on && <OCheck size={13} />}</span>
                      {t}
                    </button>
                  )
                })}
                {orgTags.length === 0 && <div className="px-2 py-1.5 text-[13px] text-muted-foreground">{t('tree.noTags')}</div>}
              </>
            )}
            {panel.mode === 'flt_status' && (['running', 'inactive'] as const).map((s) => {
              const on = prefs.statuses.includes(s)
              return (
                <button key={s} role="menuitemcheckbox" aria-checked={on} onClick={(e) => { e.stopPropagation(); onPrefs({ statuses: on ? prefs.statuses.filter((x) => x !== s) : [...prefs.statuses, s] }) }} className={menuItemCls}>
                  <span className="flex w-4 justify-center">{on && <OCheck size={13} />}</span>
                  {s === 'running' ? t('tree.running') : t('tree.inactive')}
                </button>
              )
            })}
            {panel.mode === 'flt_stype' && ([['devin', 'Agent'], ['ada', 'Ask']] as const).map(([v, label]) => {
              const on = prefs.sessionTypes.includes(v)
              return (
                <button key={v} role="menuitemcheckbox" aria-checked={on} onClick={(e) => { e.stopPropagation(); onPrefs({ sessionTypes: on ? prefs.sessionTypes.filter((x) => x !== v) : [...prefs.sessionTypes, v] }) }} className={menuItemCls}>
                  <span className="flex w-4 justify-center">{on && <OCheck size={13} />}</span>
                  {label}
                </button>
              )
            })}
            {panel.mode === 'flt_machine' && ([['linux', 'Linux'], ['windows', 'Windows'], ['macos', 'macOS']] as const).map(([v, label]) => {
              const on = prefs.platforms.includes(v)
              return (
                <button key={v} role="menuitemcheckbox" aria-checked={on} onClick={(e) => { e.stopPropagation(); onPrefs({ platforms: on ? prefs.platforms.filter((x) => x !== v) : [...prefs.platforms, v] }) }} className={menuItemCls}>
                  <span className="flex w-4 justify-center">{on && <OCheck size={13} />}</span>
                  {label}
                </button>
              )
            })}
            {panel.mode === 'flt_auto' && ([['automations', 'Automation'], ['not_automations', 'Not automation']] as const).map(([v, label]) => {
              const on = prefs.automation.includes(v)
              return (
                <button key={v} role="menuitemcheckbox" aria-checked={on} onClick={(e) => { e.stopPropagation(); onPrefs({ automation: on ? prefs.automation.filter((x) => x !== v) : [...prefs.automation, v] }) }} className={menuItemCls}>
                  <span className="flex w-4 justify-center">{on && <OCheck size={13} />}</span>
                  {t('tree.auto.' + v)}
                </button>
              )
            })}
            {panel.mode === 'flt_pr' && ([['open', 'Open'], ['draft', 'Draft'], ['merged', 'Merged'], ['closed', 'Closed'], ['no_pr', 'No PR']] as const).map(([v, label]) => {
              const on = prefs.prStates.includes(v)
              return (
                <button key={v} role="menuitemcheckbox" aria-checked={on} onClick={(e) => { e.stopPropagation(); onPrefs({ prStates: on ? prefs.prStates.filter((x) => x !== v) : [...prefs.prStates, v] }) }} className={menuItemCls}>
                  <span className="flex w-4 justify-center">{on && <OCheck size={13} />}</span>
                  {t('tree.pr.' + v)}
                </button>
              )
            })}
            {(panel.mode === 'flt_created' || panel.mode === 'flt_updated') && RANGE_LABELS.map(([v, label]) => {
              const created = panel.mode === 'flt_created'
              const cur = created ? prefs.createdRange : prefs.updatedRange
              const on = cur === v
              return (
                <button key={v} role="menuitemcheckbox" aria-checked={on} onClick={(e) => { e.stopPropagation(); onPrefs(created ? { createdRange: on ? '' : v } : { updatedRange: on ? 'month' : v }) }} className={menuItemCls}>
                  <span className="flex w-4 justify-center">{on && <OCheck size={13} />}</span>
                  {t('tree.range.' + v)}
                </button>
              )
            })}
            {(panel.mode === 'flt_created' || panel.mode === 'flt_updated') && (
              <button role="menuitem" onClick={(e) => { e.stopPropagation(); replaceMenu(panel.mode === 'flt_created' ? 'flt_created_cal' : 'flt_updated_cal') }} className={menuItemCls}>
                <span className="flex w-4 justify-center" />
                {t('tree.custom')}
              </button>
            )}
            {(panel.mode === 'flt_created_cal' || panel.mode === 'flt_updated_cal') && (() => {
              const created = panel.mode === 'flt_created_cal'
              const range = created ? prefs.createdCustom : prefs.updatedCustom
              const set = (r: [string, string]) => onPrefs(created ? { createdRange: 'custom', createdCustom: r } : { updatedRange: 'custom', updatedCustom: r })
              return (
                <MenuCalendar
                  title={created ? t('tree.flt.flt_created') : t('tree.flt.flt_updated')}
                  range={range}
                  onPick={(d) => {
                    // Official: first pick = single-day range (from=to); a pick while from===to extends it; a pick after a wider range starts a new single-day range.
                    if (!range[0] || range[0] !== range[1]) set([d, d])
                    else set(d < range[0] ? [d, range[0]] : [range[0], d])
                  }}
                  onReset={() => onPrefs(created ? { createdRange: '', createdCustom: ['', ''] } : { updatedRange: 'month', updatedCustom: ['', ''] })}
                />
              )
            })()}
            {panel.mode === 'propvis' && (
              <>
                <div className="flex items-center justify-between gap-2 px-2">
                  <div className="py-[5px] text-[12px] font-medium text-muted-foreground">{t('tree.propertiesTxt')}</div>
                  <button role="menuitem" onClick={(e) => { e.stopPropagation(); onPrefs({ propHidden: Object.fromEntries(PROP_NAMES.map((n) => [n, true])) }) }} className="cursor-pointer select-none text-[12px] font-medium text-primary outline-none hover:underline">
                    {t('tree.hideAll')}
                  </button>
                </div>
                {PROP_NAMES.map((n) => {
                  const on = !prefs.propHidden[n]
                  return (
                    <button
                      key={n}
                      role="menuitemcheckbox"
                      aria-checked={on}
                      onClick={(e) => { e.stopPropagation(); onPrefs({ propHidden: { ...prefs.propHidden, [n]: on } }) }}
                      className={menuItemCls}
                    >
                      <span className="flex w-4 justify-center">{on && <OCheck size={13} />}</span>
                      {t('tree.props.' + n)}
                    </button>
                  )
                })}
              </>
            )}
            {panel.mode === 'group' && (
              <>
                {(['folders', 'project'] as const).map((gb) => (
                  <button
                    key={gb}
                    role="menuitemradio"
                    aria-checked={(prefs.groupBy ?? 'folders') === gb}
                    onClick={(e) => { e.stopPropagation(); onPrefs({ groupBy: gb }) }}
                    className={menuItemCls}
                  >
                    <span className="flex w-4 justify-center">{(prefs.groupBy ?? 'folders') === gb && <OCheck size={13} />}</span>
                    <span className="truncate">{gb === 'folders' ? t('tree.groupFolders') : t('tree.groupProject')}</span>
                  </button>
                ))}
                <div role="separator" className="mx-2 my-1 h-px bg-border" />
                {groupNames.map((g) => {
                  const visible = g === 'Archived' ? prefs.showArchived : !prefs.hidden[g]
                  return (
                    <button
                      key={g}
                      role="menuitemcheckbox"
                      aria-checked={visible}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (g === 'Archived') onPrefs({ showArchived: !prefs.showArchived })
                        else onPrefs({ hidden: { ...prefs.hidden, [g]: visible } })
                      }}
                      className={menuItemCls}
                    >
                      <span className="flex w-4 justify-center">{visible && <OCheck size={13} />}</span>
                      <span className="truncate">{g === 'Pinned' ? t('tree.gPinned') : g === 'Recent' ? t('tree.gRecent') : g === 'Archived' ? t('menu.archived') : g}</span>
                    </button>
                  )
                })}
                <button role="menuitem" onClick={(e) => { e.stopPropagation(); setNewFolderDraft(''); pushMenu(e, 'newfolder') }} className={menuItemCls}>
                  <Plus size={13} className="text-muted-foreground" /> {t('tree.createFolder')}
                </button>
              </>
            )}
            {panel.mode === 'more' && (
              <>
                <button role="menuitem" onClick={(e) => { e.stopPropagation(); setNewFolderDraft(''); pushMenu(e, 'newfolder') }} className={menuItemCls}>
                  <Plus size={13} className="text-muted-foreground" /> {t('menu.newFolder')}
                </button>
                <button role="menuitem" onMouseEnter={() => trimMenu(pi)} onClick={(e) => { e.stopPropagation(); window.location.href = '/' }} className={menuItemCls}>
                  <List size={13} className="text-muted-foreground" /> {t('tree.viewAll')}
                </button>
                <button role="menuitem" aria-haspopup="menu" onMouseEnter={(e) => hoverMenu(e, pi, 'moreactions')} onClick={(e) => { pushMenu(e, 'moreactions') }} className={menuItemCls}>
                  <ODots size={13} className="text-muted-foreground" /> {t('tree.moreActions')}
                  <span className="ml-auto flex items-center gap-1 text-muted-foreground"><OChevronRight size={12} /></span>
                </button>
              </>
            )}
            {panel.mode === 'moreactions' && (
              <div role="menuitem" aria-disabled="true" title={t('tree.orgOp')} className={`${menuItemCls} cursor-default opacity-50`}>
                <OArchive size={13} className="text-muted-foreground" /> {t('tree.archiveAll')}
              </div>
            )}
            {panel.mode === 'newfolder' && (
              <input
                autoFocus
                value={newFolderDraft}
                placeholder={t('tree.folderName')}
                onChange={(e) => setNewFolderDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') { e.stopPropagation(); popMenu() }
                  if (e.key === 'Enter' && newFolderDraft.trim()) {
                    e.stopPropagation()
                    folderAction('/api/admin/mirror/folder-create', { name: newFolderDraft.trim() })
                    setPropsMenu(null)
                  }
                }}
                className="h-7 w-full min-w-0 rounded-[6px] border border-border bg-transparent px-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
              />
            )}
          </div>
          ))}
        </>,
        document.body,
      )}
    </>
  )
}

export { MenuCalendar, TreeHeaderMenus };
