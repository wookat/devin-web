import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { adminKey } from '@/lib/api'
import { termTheme, watchTermTheme } from './xtermTheme'

/** One interactive terminal: an xterm bound to a `/ws/term` socket.
 *
 * Wire protocol (server-owned): in `{d:"input"}` / `{kill:true}`, out
 * `{d:"raw output (ANSI ok)"}` / `{exit:code}`. The spawned child is pipe-fed
 * (cmd.exe / `sh -i` / `devin ssh` / ssh tunnel), not a pty — so there is no
 * resize frame; cols/rows are purely client-side for display + wrapping.
 *
 * Enter translation: xterm reports CR for Enter, but a bare CR never flushes
 * a line through `sh -i`'s pipe stdin, and CR+LF leaves a literal \r inside
 * the line there. LF is the one terminator every child accepts (cmd.exe
 * pipes, `sh -i`, and remote ptys behind `devin ssh`/`ssh -tt` all treat LF
 * as Enter), so outgoing data is normalized `\r\n? → \n`. */
export interface TermSessionHandle {
  /** Queue/write input bytes to the child (CR normalized to LF). */
  send(data: string): void
  /** Write bytes to the xterm display only (never reaches the child). */
  write(data: string): void
  clear(): void
  focus(): void
  isLive(): boolean
}

interface Props {
  sid: string
  run?: string
  active: boolean
  /** When true, keystrokes are captured as a local line buffer (echoed
   *  but never sent to the child); Enter fires `onAgentLine`. */
  agentMode?: boolean
  onAgentLine?: (line: string) => void
  onLive(live: boolean): void
}

const TermSession = forwardRef<TermSessionHandle, Props>(function TermSession({ sid, run, active, agentMode, onAgentLine, onLive }, ref) {
  const { t } = useTranslation()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const liveRef = useRef(false)
  const sendRef = useRef<(d: string) => void>(() => {})
  const onLiveRef = useRef(onLive)
  const tRef = useRef(t)
  const agentRef = useRef({ mode: false, buf: '' })
  const onAgentLineRef = useRef(onAgentLine)
  onLiveRef.current = onLive
  onAgentLineRef.current = onAgentLine
  tRef.current = t

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({
      fontFamily: '"Roboto Mono", ui-monospace, monospace',
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 2000,
      theme: termTheme(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    fitRef.current = fit
    try { fit.fit() } catch { /* hidden/zero-size — refit on activate */ }

    const setLive = (l: boolean) => { if (liveRef.current !== l) { liveRef.current = l; onLiveRef.current(l) } }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws/term?session=${encodeURIComponent(sid)}${run ? `&${run}` : ''}${adminKey() ? `&key=${encodeURIComponent(adminKey())}` : ''}`)
    // Keystrokes typed before the socket opens ride out on open.
    const early: string[] = []
    const send = (data: string) => {
      const d = data.replace(/\r\n?/g, '\n')
      if (ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify({ d })) } catch { /* dead */ } }
      else if (ws.readyState === WebSocket.CONNECTING) early.push(d)
    }
    sendRef.current = send
    // Agent mode: capture the line locally — echo chars, backspace edits,
    // Enter submits via onAgentLine. Nothing reaches the child shell.
    const dataSub = term.onData((d) => {
      const a = agentRef.current
      if (!a.mode) { send(d); return }
      for (const ch of d) {
        if (ch === '\r') {
          const line = a.buf
          a.buf = ''
          term.write('\r\n')
          onAgentLineRef.current?.(line)
        } else if (ch === '\x7f') {
          if (a.buf.length) { a.buf = a.buf.slice(0, -1); term.write('\b \b') }
        } else if (ch === '\x03') {
          a.buf = ''
          term.write('^C\r\n\x1b[36m❯\x1b[0m ')
        } else if (ch >= ' ') {
          a.buf += ch
          term.write(ch)
        }
      }
    })

    let exited = false
    ws.onopen = () => {
      setLive(true)
      for (const d of early.splice(0)) { try { ws.send(JSON.stringify({ d })) } catch { /* dead */ } }
    }
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(String(e.data))
        if (typeof m.d === 'string') term.write(m.d)
        if (m.exit !== undefined) {
          exited = true
          setLive(false)
          term.write(`\r\n\x1b[2m[exited ${m.exit}]\x1b[0m\r\n`)
        }
      } catch { /* non-json */ }
    }
    ws.onclose = () => {
      if (!exited) term.write(`\r\n\x1b[2m[${tRef.current('tm.disconnected')}]\x1b[0m\r\n`)
      setLive(false)
    }

    // Re-theme when <html>.dark flips; refit whenever the box gets real size.
    const unwatch = watchTermTheme(() => { term.options.theme = termTheme() })
    const ro = new ResizeObserver(() => {
      if (host.clientWidth > 0 && host.clientHeight > 0) { try { fit.fit() } catch { /* busy */ } }
    })
    ro.observe(host)

    return () => {
      unwatch()
      ro.disconnect()
      dataSub.dispose()
      try { ws.send(JSON.stringify({ kill: true })) } catch { /* gone */ }
      try { ws.close() } catch { /* gone */ }
      term.dispose()
      termRef.current = null
      fitRef.current = null
      sendRef.current = () => {}
    }
    // sid/run are fixed for the lifetime of a mounted tab — the panel remounts
    // a fresh TermSession (new key) when they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Becoming visible: the box may have resized while hidden — refit, then hand
  // keyboard focus to the terminal so typing lands in it right away.
  useEffect(() => {
    const host = hostRef.current
    if (active && host && host.clientWidth > 0) {
      try { fitRef.current?.fit() } catch { /* not laid out yet */ }
      termRef.current?.focus()
    }
  }, [active])

  // Agent-mode flip: reset the line buffer and drop a tinted ❯ prompt so
  // the user sees input now happens inline, not in the shell.
  useEffect(() => {
    agentRef.current.mode = !!agentMode
    agentRef.current.buf = ''
    if (agentMode) termRef.current?.write('\x1b[36m❯\x1b[0m ')
  }, [agentMode])

  useImperativeHandle(ref, () => ({
    send: (d: string) => sendRef.current(d),
    write: (d: string) => termRef.current?.write(d),
    clear: () => termRef.current?.clear(),
    focus: () => termRef.current?.focus(),
    isLive: () => liveRef.current,
  }), [])

  return (
    <div
      ref={hostRef}
      className="absolute inset-0 overflow-hidden p-1.5 pl-2"
      style={{ display: active ? undefined : 'none' }}
    />
  )
})

export default TermSession
