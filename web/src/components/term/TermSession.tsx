import { forwardRef, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { adminKey } from '@/lib/api'
import { termTheme, watchTermTheme } from './xtermTheme'
import { TerminalEditor, TerminalLifecycle } from './terminalEditor'
import { useTerminalHandle, type TermSessionHandle } from './terminalHandle'
export type { TermSessionHandle } from './terminalHandle'

/** One interactive terminal: an xterm bound to a `/ws/term` socket.
 *
 * Wire protocol: in `{d}` / `{kill:true}` / `{interrupt:true}`, out
 * `{d}` / `{exit,interrupted?}` / `{shell,hint}` / `{ready:true}`.
 * Local children use pipes; SSH children own a remote PTY.
 *
 * Two input paths keyed by the server's {shell} profile:
 *  - "pipe" (local cmd.exe / sh -i): a pipe-fed shell echoes NOTHING until
 *    it reads a line — keystrokes used to be invisible until Enter, and
 *    arrow keys corrupted the line (ESC bytes landed inside the command).
 *    The client runs a small line editor: immediate echo, ←/→/Home/End,
 *    Backspace/Delete, Ctrl+C/U, ↑/↓ history, bracketed-paste, live
 *    syntax-highlighted redraw. Enter ships `line\n` to stdin; the shell
 *    echoes the real `cwd>` prompt between commands.
 *  - "pty" (ssh): the remote end echoes+edits itself — raw passthrough.
 *
 * Agent mode overrides either path: the edited line goes to onAgentLine
 * (the term-agent API), never to stdin.
 *
 * Enter translation is pipe-only; PTY input/output stays byte-transparent. */
interface Props {
  sid: string
  run?: string
  active: boolean
  /** When true, Enter dispatches the edited line to `onAgentLine` (the
   *  term-agent API) instead of the child shell. */
  agentMode?: boolean
  onAgentLine?: (line: string) => void
  onLive(live: boolean): void
}

const ESC = '\x1b['
/** ANSI colorizer for a shell command line: program green-bold, env
 *  assignments + flags cyan, quoted strings yellow, operators magenta. */
export function hlCmd(s: string): string {
  const R = `${ESC}0m`
  let out = '', tok = '', q = '', seenCmd = false
  const flush = () => {
    if (!tok) return
    const t = tok; tok = ''
    if (/^".*"$|^'.*'$/.test(t)) out += `${ESC}33m${t}${R}`
    else if (/^[|&;><]+$/.test(t)) out += `${ESC}35m${t}${R}`
    else if (!seenCmd && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(t)) out += `${ESC}36m${t}${R}`
    else if (!seenCmd) { seenCmd = true; out += `${ESC}1;32m${t}${R}` }
    else if (/^--?[^\s=]+/.test(t)) out += `${ESC}36m${t}${R}`
    else out += t
  }
  for (const ch of s) {
    if (q) { tok += ch; if (ch === q) q = ''; continue }
    if (ch === '"' || ch === "'") { q = ch; tok += ch; continue }
    if (/\s/.test(ch)) { flush(); out += ch; continue }
    if (/[|&;><]/.test(ch)) { flush(); out += `${ESC}35m${ch}${R}`; continue }
    tok += ch
  }
  flush()
  return out
}

const TermSession = forwardRef<TermSessionHandle, Props>(function TermSession({ sid, run, active, agentMode, onAgentLine, onLive }, ref) {
  const { t } = useTranslation()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const refitRef = useRef<() => void>(() => {})
  const liveRef = useRef(false)
  const sendRef = useRef<(d: string) => void>(() => {})
  const onLiveRef = useRef(onLive)
  const tRef = useRef(t)
  const onAgentLineRef = useRef(onAgentLine)
  const writeOutRef = useRef<(d: string) => void>(() => {})
  const editorRef = useRef<TerminalEditor | null>(null)
  const hintRef = useRef<string | undefined>(undefined)
  const revisionRef = useRef(0)
  const agentModeRef = useRef(!!agentMode)
  agentModeRef.current = !!agentMode
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
    // Reconnect state: the spawned shell lives and dies with its ws — a
    // backend restart/bounce kills both, and without a retry the pane sits
    // dead forever. `dead` latches on unmount (kill sent) so teardown never
    // revives; the lifecycle latches on a clean child exit (typing `exit` must
    // not resurrect the shell).
    let ws: WebSocket
    let dead = false
    let retryT: ReturnType<typeof setTimeout> | null = null
    let attempt = 0
    const frame = (m: object) => {
      if (ws?.readyState !== WebSocket.OPEN || !liveRef.current) return
      try { ws.send(JSON.stringify(m)) } catch { /* never replay uncertain input */ }
    }
    const editor = new TerminalEditor({
      write: (d) => term.write(d),
      send: (d) => frame({ d }),
      interrupt: () => {
        frame({ interrupt: true })
        setLive(false)
        editor.connection(false)
      },
      interruptHint: () => tRef.current('tm.cancelledDraft'),
      agentLine: (line) => onAgentLineRef.current?.(line),
      cancelAgent: () => { revisionRef.current++ },
      cols: () => term.cols,
      rows: () => term.rows,
      highlight: hlCmd,
    })
    editor.agent = agentModeRef.current
    editorRef.current = editor
    const refit = () => {
      // Erase at the OLD width before xterm reflows the buffer, or the old
      // draft's wrapped-row geometry becomes stale during resize.
      editor.hideForResize()
      term.write('', () => {
        if (dead) return
        try { fit.fit(); editor.redraw() } catch { /* hidden */ }
      })
    }
    refitRef.current = refit
    writeOutRef.current = (d) => editor.output(d)
    sendRef.current = (data) => {
      if (!liveRef.current) return
      frame({ d: editor.shell === 'pipe' ? data.replace(/\r\n?/g, '\n') : data })
    }
    const dataSub = term.onData((d) => editor.feed(d))

    const lifecycle = new TerminalLifecycle()
    const connect = () => {
      ws = new WebSocket(`${proto}://${location.host}/ws/term?session=${encodeURIComponent(sid)}${run ? `&${run}` : ''}${adminKey() ? `&key=${encodeURIComponent(adminKey())}` : ''}`)
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(String(ev.data))
          const profile = m.shell === 'pty' || m.shell === 'pipe'
          if (profile) editor.connection(false, m.shell)
          if (typeof m.hint === 'string') hintRef.current = m.hint
          // Static assets can update before the backend is bounced. Legacy
          // profiles have no ready flag; new servers explicitly send false
          // until their child is wired. Neither path queues/replays input.
          if (m.ready || (profile && m.ready === undefined)) {
            attempt = 0
            setLive(true)
            if (editor.shell === 'pipe') term.write('\x1b[?2004h')
            editor.connection(true)
          }
          if (typeof m.d === 'string') editor.output(m.d)
          if (m.exit !== undefined) {
            lifecycle.exit(!!m.interrupted)
            setLive(false)
            editor.connection(false)
            term.write(m.interrupted
              ? `\r\n\x1b[2m[${tRef.current('tm.interrupted')}]\x1b[0m\r\n`
              : `\r\n\x1b[2m[exited ${m.exit}]\x1b[0m\r\n`)
          }
        } catch { /* non-json */ }
      }
      ws.onclose = () => {
        setLive(false)
        editor.connection(false, null)
        if (!lifecycle.shouldReconnect(dead)) return
        term.write(`\r\n\x1b[2m[${tRef.current('tm.disconnected')} · ${tRef.current('tm.retrying')}]\x1b[0m\r\n`)
        // The child died with the socket — reconnect respawns it. Backoff
        // caps at 8s; retries run while mounted (a stopped backend still
        // revives the pane when it comes back).
        retryT = setTimeout(connect, Math.min(800 * 2 ** attempt, 8000))
        attempt++
      }
    }
    connect()

    // Re-theme when <html>.dark flips; refit whenever the box gets real size.
    const unwatch = watchTermTheme(() => { term.options.theme = termTheme() })
    const ro = new ResizeObserver(() => {
      if (host.clientWidth > 0 && host.clientHeight > 0) {
        refit()
      }
    })
    ro.observe(host)

    return () => {
      dead = true
      editor.dispose()
      if (retryT) { clearTimeout(retryT); retryT = null }
      unwatch()
      ro.disconnect()
      dataSub.dispose()
      // Closing a CONNECTING socket logs a console warning and drops the
      // kill on the floor — defer to open so the spawned shell still dies.
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.onopen = () => {
          try { ws.send(JSON.stringify({ kill: true })) } catch { /* gone */ }
          try { ws.close() } catch { /* gone */ }
        }
        ws.onmessage = null
      } else {
        try { ws.send(JSON.stringify({ kill: true })) } catch { /* gone */ }
        try { ws.close() } catch { /* gone */ }
      }
      term.dispose()
      termRef.current = null
      fitRef.current = null
      sendRef.current = () => {}
      writeOutRef.current = () => {}
      editorRef.current = null
      refitRef.current = () => {}
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
      refitRef.current()
      termRef.current?.focus()
    }
  }, [active])

  // Agent-mode flip: reset the line buffer and drop a tinted ❯ prompt so
  // the user sees input now happens inline, not in the shell.
  useEffect(() => {
    editorRef.current?.mode(!!agentMode)
  }, [agentMode])

  useTerminalHandle(ref, () => ({
    send: (d: string) => sendRef.current(d),
    write: (d: string) => writeOutRef.current(d),
    setLine: (s: string) => editorRef.current?.setLine(s),
    clear: () => termRef.current?.clear(),
    focus: () => termRef.current?.focus(),
    isLive: () => liveRef.current,
    shellHint: () => hintRef.current,
    revision: () => revisionRef.current,
    agentSettled: () => editorRef.current?.agentSettled(),
  }))

  return (
    <div
      ref={hostRef}
      className="absolute inset-0 overflow-hidden p-1.5 pl-2"
      style={{ display: active ? undefined : 'none' }}
    />
  )
})

export default TermSession
