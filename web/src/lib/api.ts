import type { QuoteAttachment } from '../../shared/quotes'

export interface PublicMessage {
  id: string
  role: 'devin' | 'user' | 'admin' | 'visitor'
  message: string
  timestamp: string
  attachments: { url: string; name: string }[]
  quotes?: QuoteAttachment[]
}

export interface AdminSession {
  id: string
  devin_session_id: string
  title: string
  devin_title: string
  permission: 'detailed' | 'full' | 'chat' | 'readonly'
  archived: number
  pinned?: number
  created_at: string
  status: string
  status_enum_raw?: string
  status_message?: string | null
  status_short_message?: string | null
  queue_position?: number
  sleep_reason?: string
  last_message: string
  last_timestamp: string
  share_url: string
}

export type Widget =
  | { type: 'metric'; title: string; value: string | number; unit?: string }
  | { type: 'progress'; title: string; percent: number; value?: string }
  | { type: 'table'; title: string; columns: string[]; rows: (string | number)[][] }
  | { type: 'log'; title: string; lines: string[] }
  | { type: 'chart'; title: string; series: { name: string; points: [number, number][] }[] }

export interface DashboardData {
  title?: string
  updated?: string
  widgets?: Widget[]
}

export function adminKey(): string {
  return localStorage.getItem('wb_admin_key') || ''
}

export function setAdminKey(k: string) {
  localStorage.setItem('wb_admin_key', k)
}

const prefetched = new Map<string, Promise<Response>>()
const adminSwrInFlight = new Map<string, Promise<{ data: unknown; stale: boolean }>>()

/**
 * Starts an admin GET before the route chunk has even loaded; the first matching
 * `adminFetch` for the same path consumes the in-flight response.
 */
export function prefetchAdmin(path: string): void {
  if (!adminKey() || prefetched.has(path)) return
  const p = fetch(path, { headers: { 'x-admin-key': adminKey() } })
  p.catch(() => prefetched.delete(path))
  prefetched.set(path, p)
}

async function adminResponse(path: string, init?: RequestInit): Promise<Response> {
  const primed = !init ? prefetched.get(path) : undefined
  if (primed) prefetched.delete(path)
  const res = primed ? await primed : await fetch(path, {
    ...init,
    headers: { ...(init?.headers || {}), 'x-admin-key': adminKey(), ...(init?.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}) },
  })
  if (res.status === 401) throw new Error('unauthorized')
  if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error || 'error')
  return res
}

export async function adminFetch<T>(path: string, init?: RequestInit): Promise<T> {
  return (await adminResponse(path, init)).json()
}

/** Like `adminFetch`, also reporting whether the Worker served a stale SWR copy. */
export async function adminFetchSwr<T>(path: string): Promise<{ data: T; stale: boolean }> {
  const existing = adminSwrInFlight.get(path)
  if (existing) return existing as Promise<{ data: T; stale: boolean }>
  const request = adminResponse(path)
    .then(async (res) => ({ data: await res.json() as T, stale: res.headers.get('x-cache') === 'stale' }))
    .finally(() => { adminSwrInFlight.delete(path) })
  adminSwrInFlight.set(path, request)
  return request
}

function shareUrl(shareId: string, token: string, path: string): string {
  const sep = path.includes('?') ? '&' : '?'
  return `/api/share/${shareId}${path}${sep}t=${encodeURIComponent(token)}`
}

/** Guest-page counterpart of `prefetchAdmin`: same in-flight handoff, no admin header. */
export function prefetchShare(shareId: string, token: string, path: string): void {
  const url = shareUrl(shareId, token, path)
  if (prefetched.has(url)) return
  const p = fetch(url)
  p.catch(() => prefetched.delete(url))
  prefetched.set(url, p)
}

async function shareResponse(shareId: string, token: string, path: string, init?: RequestInit): Promise<Response> {
  const url = shareUrl(shareId, token, path)
  const primed = !init ? prefetched.get(url) : undefined
  if (primed) prefetched.delete(url)
  const res = primed ? await primed : await fetch(url, {
    ...init,
    headers: { ...(init?.headers || {}), ...(init?.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}) },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string }
    throw new Error(body.error || 'error')
  }
  return res
}

export async function shareFetch<T>(shareId: string, token: string, path: string, init?: RequestInit): Promise<T> {
  return (await shareResponse(shareId, token, path, init)).json()
}

/** Guest-page counterpart of `adminFetchSwr`. */
export async function shareFetchSwr<T>(shareId: string, token: string, path: string): Promise<{ data: T; stale: boolean }> {
  const res = await shareResponse(shareId, token, path)
  return { data: await res.json(), stale: res.headers.get('x-cache') === 'stale' }
}
