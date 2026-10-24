import { relAgo } from '@/lib/datetime'



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
  /** Manual row order within its section — index into the server's stored
   *  sessionOrder list. -1/absent = never ordered (sorts to the top by
   *  updated_at; once anything is positioned the whole section's order is
   *  materialized server-side). */
  forder?: number
  children: MirrorTreeSession[]
  total_children: number
  pull_requests?: { state: string; pr_url: string; draft: boolean; number?: number }[]
  tags?: string[]
  keep_alive_until?: string
  cwd?: string | null
  /** SSH-hosted session — cwd is a path on the remote host, not local. */
  ssh?: string | null
  created_at?: string | null
  /** devin `_meta` lock: some acp holds the session open. Harmless when
   *  `loaded_here` (this web is the holder); otherwise another app. */
  is_locked?: boolean
  loaded_here?: boolean
  /** Owning ACP agent id — non-devin rows get a small badge (devin default). */
  agent?: string
  /** sub: rows only — false once the acp registry dropped the agent handle
   * (server restart / session replay); the row greys and the child page
   * offers respawn instead of a doomed resume relay. */
  resumable?: boolean
}

interface TreeCachePayload {
  sessions: MirrorTreeSession[]
  folder_order: string[]
  folder_totals: Record<string, number>
  next_cursor: string | null
}

function readTreeCache(): TreeCachePayload | null {
  try {
    const raw = localStorage.getItem('dw-tree-cache')
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
    if (raw.length <= 2 * 1024 * 1024) localStorage.setItem('dw-tree-cache', raw)
  } catch { /* quota or private browsing */ }
}

/** Official row subtitle relative time (e.g. "20 days ago"). */
function relTime(iso: string | null | undefined): string {
  if (!iso) return ''
  return relAgo(new Date(iso).getTime())
}


export { type MirrorTreeSession, type TreeCachePayload, readTreeCache, writeTreeCache, relTime };
