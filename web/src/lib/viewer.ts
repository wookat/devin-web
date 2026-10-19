import { adminFetch, adminFetchSwr, shareFetch, shareFetchSwr } from './api'

/**
 * Who is looking at a session page. The admin mirror is the single renderer;
 * the visitor share route renders the same component with a visitor identity
 * and a permission profile. Everything viewer-specific funnels through here:
 * the transport (admin key vs. share token), the media URL scheme, and the
 * capability flags the UI gates on. The Worker stays the security boundary —
 * these flags only decide what the page shows and which endpoints it calls.
 */
export type SharePermission = 'readonly' | 'chat' | 'basic' | 'detailed' | 'full'

export interface ViewerCaps {
  canSendMessage: boolean
  canAnswerQuestion: boolean
  canUpload: boolean
  canResolvePermission: boolean
  canProvideSecret: boolean
  canApprovePr: boolean
  canAnalyzePr: boolean
  showProgress: boolean
  showChanges: boolean
  showComputer: boolean
  showShell: boolean
  showScreenshots: boolean
  showFiles: boolean
  showTerminal: boolean
  showLiveDesktop: boolean
}

export type Viewer =
  | { role: 'admin'; id: string; token: ''; permission: 'full'; caps: ViewerCaps }
  | { role: 'visitor'; id: string; token: string; permission: SharePermission; caps: ViewerCaps }

const ADMIN_CAPS: ViewerCaps = {
  canSendMessage: true,
  canAnswerQuestion: true,
  canUpload: true,
  canResolvePermission: true,
  canProvideSecret: true,
  canApprovePr: true,
  canAnalyzePr: true,
  showProgress: true,
  showChanges: true,
  showComputer: true,
  showShell: true,
  showScreenshots: true,
  showFiles: true,
  showTerminal: true,
  showLiveDesktop: true,
}

/** Visitor capability matrix; mirrors the Worker's per-tier 403 rules. */
export function capsFor(permission: SharePermission): ViewerCaps {
  const detailed = permission === 'detailed' || permission === 'full'
  const interactive = permission !== 'readonly'
  return {
    canSendMessage: interactive,
    canAnswerQuestion: interactive,
    canUpload: detailed,
    canResolvePermission: false,
    canProvideSecret: false,
    canApprovePr: false,
    canAnalyzePr: false,
    showProgress: true,
    showChanges: detailed,
    showComputer: detailed,
    showShell: detailed,
    showScreenshots: detailed,
    showFiles: detailed,
    showTerminal: detailed,
    showLiveDesktop: detailed,
  }
}

export function adminViewer(id: string): Viewer {
  return { role: 'admin', id, token: '', permission: 'full', caps: ADMIN_CAPS }
}

export function visitorViewer(shareId: string, token: string, permission: string): Viewer {
  const p: SharePermission =
    permission === 'readonly' || permission === 'chat' || permission === 'basic' || permission === 'detailed' || permission === 'full'
      ? permission
      : 'readonly'
  return { role: 'visitor', id: shareId, token, permission: p, caps: capsFor(p) }
}

let current: Viewer = adminViewer('')

/** Set by the route component before the session page renders. */
export function setViewer(v: Viewer): void {
  current = v
}

export function viewer(): Viewer {
  return current
}

export function isVisitor(): boolean {
  return current.role === 'visitor'
}

const tokenQuery = (path: string, token: string) => `${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`

/**
 * Session-scoped request. `path` is relative to the session
 * (`/timeline?limit=300`, `/message`, `/file-contents`, ...). Admins hit
 * `/api/admin/session/<id><path>` with the admin key; visitors hit
 * `/api/share/<shareId><path>?t=<token>` with no admin header.
 */
export function sessionFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const v = current
  return v.role === 'visitor'
    ? shareFetch<T>(v.id, v.token, path, init)
    : adminFetch<T>(`/api/admin/session/${v.id}${path}`, init)
}

export function sessionFetchSwr<T>(path: string): Promise<{ data: T; stale: boolean }> {
  const v = current
  return v.role === 'visitor'
    ? shareFetchSwr<T>(v.id, v.token, path)
    : adminFetchSwr<T>(`/api/admin/session/${v.id}${path}`)
}

/** Screenshot bytes: admin media route keyed by storage key + media token; visitors hold an opaque per-session id. */
export function screenshotUrl(sessionId: string, key: string, mt: string): string {
  const v = current
  if (v.role === 'visitor') return tokenQuery(`/api/share/${v.id}/screenshot?key=${encodeURIComponent(key)}`, v.token)
  return `/api/media/${sessionId}/screenshot?key=${encodeURIComponent(key)}&mt=${encodeURIComponent(mt)}`
}

/** Attachment bytes. Visitor timelines arrive with links already rewritten to the share proxy; anything else is routed through it. */
export function attachmentUrl(sessionId: string, url: string, mt: string): string {
  // Local workbench uploads are already same-origin API urls — serve directly.
  // Same for produced-file chips: /api/admin/session/*/file-raw?path=…
  if (url.startsWith('/api/')) return url
  const v = current
  if (v.role === 'visitor') {
    if (url.startsWith(`/api/share/${v.id}/`)) return url
    return tokenQuery(`/api/share/${v.id}/attachment?url=${encodeURIComponent(url)}`, v.token)
  }
  return `/api/media/${sessionId}/attachment?url=${encodeURIComponent(url)}&mt=${encodeURIComponent(mt)}`
}

/** Diff bodies for the Changes panel: admins send raw storage keys, visitors the opaque per-session handles. */
export function fetchFileContents(keys: string[]): Promise<{ files: Record<string, string>; error: string | null }> {
  const v = current
  return v.role === 'visitor'
    ? shareFetch(v.id, v.token, '/file-contents', { method: 'POST', body: JSON.stringify({ ids: keys }) })
    : adminFetch(`/api/admin/session/${v.id}/file-contents`, { method: 'POST', body: JSON.stringify({ keys }) })
}
