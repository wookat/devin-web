/** Row properties toggleable via the official Property visibility submenu. */
const PROP_NAMES = ['Last updated', 'Status', 'Pull requests', 'Archived', 'Automation'] as const

/** Sidebar view preferences mirroring the official Sessions Properties menu. */
type TreePrefs = { sort: 'updated_at' | 'created_at'; hidden: Record<string, boolean>; compact: boolean; showArchived: boolean; statuses: string[]; propHidden: Record<string, boolean>; sessionTypes: string[]; platforms: string[]; automation: string[]; prStates: string[]; createdRange: string; updatedRange: string; createdCustom: [string, string]; updatedCustom: [string, string]; createdBy: 'self' | 'annotated'; tags: string[]; groupBy?: 'folders' | 'project' }

/** Official persists sidebar filters per-org in localStorage (sidebar-all-sessions-filters-<org> + session-sort-config). */
const TREE_PREFS_KEY = 'sidebar-sessions-prefs'

const DEFAULT_TREE_PREFS: TreePrefs = { sort: 'updated_at', hidden: {}, compact: false, showArchived: false, statuses: [], propHidden: {}, sessionTypes: ['devin', 'ada'], platforms: ['linux', 'windows', 'macos'], automation: ['automations', 'not_automations'], prStates: [], createdRange: '', updatedRange: 'month', createdCustom: ['', ''], updatedCustom: ['', ''], createdBy: 'self', tags: [], groupBy: 'folders' }

const RANGE_LABELS: [string, string][] = [['today', 'Today'], ['week', 'Last week'], ['2weeks', 'Last 2 weeks'], ['month', 'Last month']]
const RANGE_DAYS: Record<string, number> = { today: 0, week: 7, '2weeks': 14, month: 30 }
const dateFrom = (days: number) => new Date(Date.now() - days * 864e5).toISOString().slice(0, 10) + 'T00:00:00.000Z'

/** Builds the sidebar sessions filter query string from prefs (official v2sessions params). */
function buildFilterQ(p: TreePrefs): string {
  let q = p.statuses.map((s) => `&status=${s}`).join('')
  if (p.createdBy === 'annotated') q += '&created_by=annotated'
  q += p.tags.map((t) => `&tags=${encodeURIComponent(t)}`).join('')
  if (p.sessionTypes.length === 1) q += `&session_type=${p.sessionTypes[0]}`
  if (p.platforms.length < 3) q += p.platforms.map((s) => `&platforms=${s}`).join('')
  if (p.automation.length === 1) q += `&automation_filter=${p.automation[0]}`
  q += p.prStates.map((s) => `&pr_state=${s}`).join('')
  if (p.createdRange === 'custom') {
    if (p.createdCustom[0]) q += `&created_date_from=${encodeURIComponent(p.createdCustom[0] + 'T00:00:00.000Z')}`
    if (p.createdCustom[1]) q += `&created_date_to=${encodeURIComponent(p.createdCustom[1] + 'T23:59:59.999Z')}`
  } else if (p.createdRange) q += `&created_date_from=${encodeURIComponent(dateFrom(RANGE_DAYS[p.createdRange] ?? 30))}`
  if (p.updatedRange === 'custom') {
    if (p.updatedCustom[0]) q += `&updated_date_from=${encodeURIComponent(p.updatedCustom[0] + 'T00:00:00.000Z')}`
    if (p.updatedCustom[1]) q += `&updated_date_to=${encodeURIComponent(p.updatedCustom[1] + 'T23:59:59.999Z')}`
  } else if (p.updatedRange && p.updatedRange !== 'month') q += `&updated_date_from=${encodeURIComponent(dateFrom(RANGE_DAYS[p.updatedRange] ?? 30))}`
  return q
}

const filterCount = (p: TreePrefs) => (p.createdBy !== 'self' ? 1 : 0) + (p.tags.length ? 1 : 0) + (p.statuses.length ? 1 : 0) + (p.sessionTypes.length === 1 ? 1 : 0) + (p.platforms.length < 3 ? 1 : 0) + (p.automation.length === 1 ? 1 : 0) + (p.prStates.length ? 1 : 0) + (p.createdRange ? 1 : 0) + (p.updatedRange !== 'month' ? 1 : 0)

/** Shared row class for the header properties/more menus and the folder
 *  context menu (official 13px/18px menuitem). */
const menuItemCls = 'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] leading-[18px] hover:bg-accent'

/** Folder label-row ⋯ menu state: menu | rename-input, anchored at left/top. */
type FolderMenuState = { name: string; mode: 'menu' | 'rename'; left: number; top: number }

export { PROP_NAMES, type TreePrefs, TREE_PREFS_KEY, DEFAULT_TREE_PREFS, RANGE_LABELS, RANGE_DAYS, dateFrom, buildFilterQ, filterCount, menuItemCls, type FolderMenuState };
