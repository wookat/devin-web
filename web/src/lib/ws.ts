/**
 * Tiny shared WebSocket client for the local web server (`/ws`).
 * One connection fanned out to all subscribers; auto-reconnects with backoff.
 * Same-origin only — the server enforces the CSRF/DNS-rebinding origin check.
 */

export interface WsEvent {
  type: string
  sessionId?: string
  items?: unknown[]
  [key: string]: unknown
}

type Handler = (ev: WsEvent) => void

const handlers = new Set<Handler>()
let ws: WebSocket | null = null
let retry = 0
let retryTimer: number | null = null

function ensure() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  if (retryTimer != null) return
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const sock = new WebSocket(`${proto}://${location.host}/ws`)
  ws = sock
  sock.onopen = () => { retry = 0 }
  sock.onmessage = (m) => {
    let ev: WsEvent
    try { ev = JSON.parse(String(m.data)) as WsEvent } catch { return }
    for (const fn of handlers) {
      try { fn(ev) } catch { /* one bad listener must not starve the rest */ }
    }
  }
  sock.onclose = () => {
    if (ws === sock) ws = null
    if (!handlers.size) return
    const delay = Math.min(1000 * 2 ** retry++, 10_000)
    retryTimer = window.setTimeout(() => { retryTimer = null; ensure() }, delay)
  }
  sock.onerror = () => { /* onclose follows and handles the retry */ }
}

/** Subscribe to every server event. Returns an unsubscribe function. */
export function subscribeWs(fn: Handler): () => void {
  handlers.add(fn)
  ensure()
  return () => {
    handlers.delete(fn)
    if (!handlers.size && ws) { ws.close(); ws = null }
  }
}
