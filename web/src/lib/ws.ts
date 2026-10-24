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

import { adminKey } from './api'

type Handler = (ev: WsEvent) => void

const handlers = new Set<Handler>()
let ws: WebSocket | null = null
let retry = 0
let retryTimer: number | null = null
// Session-scoped heavy streams (token deltas, terminal output, agent logs)
// are only sent for these ids; [] = nothing heavy, null = everything
// (legacy). The mirror page sets its own session id on mount.
let scope: string[] | null = []

function sendScope(sock: WebSocket) {
  try { sock.send(JSON.stringify({ type: 'sub', sessions: scope })) } catch { /* not open yet */ }
}

/** Scope this client's heavy session streams to the given session ids.
 *  Pass the open session's id; [] receives no streams; null = all. */
export function setWsSessionScope(ids: string[] | null) {
  scope = ids
  if (ws && ws.readyState === WebSocket.OPEN) sendScope(ws)
}

function ensure() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  if (retryTimer != null) return
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const sock = new WebSocket(`${proto}://${location.host}/ws${adminKey() ? `?key=${encodeURIComponent(adminKey())}` : ''}`)
  ws = sock
  sock.onopen = () => { retry = 0; sendScope(sock) }
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
