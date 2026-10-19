

interface MirrorTreeSession {
  devin_id: string
  title: string
  status_enum: string
  status_enum_raw?: string
  status_message?: string | null
  status_short_message?: string | null
  queue_position?: number
  sleep_reason?: string
  activity_status: string
  updated_at: string
  snippet: string
  folder: string | null
  is_unread: boolean
  is_pinned: boolean
  children: MirrorTreeSession[]
  total_children: number
  pull_requests?: { state: string; pr_url: string; draft: boolean; number?: number }[]
  tags?: string[]
  keep_alive_until?: string
  cwd?: string | null
  created_at?: string | null
  /** devin `_meta` lock: some acp holds the session open. Harmless when
   *  `loaded_here` (this workbench is the holder); otherwise another app. */
  is_locked?: boolean
  loaded_here?: boolean
}

interface TreeCachePayload {
  sessions: MirrorTreeSession[]
  folder_order: string[]
  folder_totals: Record<string, number>
  next_cursor: string | null
}

function readTreeCache(): TreeCachePayload | null {
  try {
    const raw = localStorage.getItem('wb2-tree-cache')
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<TreeCachePayload>
    if (!Array.isArray(parsed.sessions)) return null
    return {
      sessions: parsed.sessions,
      folder_order: Array.isArray(parsed.folder_order) ? parsed.folder_order : [],
      folder_totals: parsed.folder_totals && typeof parsed.folder_totals === 'object' ? parsed.folder_totals : {},
      next_cursor: typeof parsed.next_cursor === 'string' ? parsed.next_cursor : null,
    }
  } catch {
    return null
  }
}

function writeTreeCache(payload: TreeCachePayload): void {
  try {
    const raw = JSON.stringify(payload)
    if (raw.length <= 2 * 1024 * 1024) localStorage.setItem('wb2-tree-cache', raw)
  } catch { /* quota or private browsing */ }
}

/** Official row subtitle relative time (e.g. "20 days ago"). */
function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (!iso || Number.isNaN(ms)) return ''
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`
  const mo = Math.floor(d / 30)
  return `${mo} month${mo === 1 ? '' : 's'} ago`
}


export { type MirrorTreeSession, type TreeCachePayload, readTreeCache, writeTreeCache, relTime };
