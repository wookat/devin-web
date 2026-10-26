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
 * `{d:"raw output (ANSI ok)"}` / `{exit:code}` / `{shell:"pty"|"pipe"}`.
 * The spawned child is pipe-fed (cmd.exe / `sh -i` / `devin ssh` / ssh
 * tunnel), not a pty — so there is no resize frame; cols/rows are purely
 * client-side for display + wrapping.
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
 * Enter translation: LF is the one terminator every child accepts (cmd.exe
 * pipes, `sh -i`, remote ptys) so outgoing data is normalized `\r\n? → \n`. */
export interface TermSessionHandle {
  /** Queue/write input bytes to the child (CR normalized to LF). */
  send(data: string): void
  /** Write bytes to the xterm display only (never reaches the child). */
  write(data: string): void
  /** Load a string into the editable input line (pty → sends without \n
   *  so it lands in the remote shell's input, awaiting Enter). */
  setLine(data: string): void
  clear(): void
  focus(): void
  isLive(): boolean
}

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
  const liveRef = useRef(false)
  const sendRef = useRef<(d: string) => void>(() => {})
  const onLiveRef = useRef(onLive)
  const tRef = useRef(t)
  const onAgentLineRef = useRef(onAgentLine)
  // Line-editor state: pty=false means the child can't echo/edit — we do.
  const ed = useRef({
    pty: false, agent: false,
    buf: '', cur: 0,            // buffer + cursor (code-point index)
    hist: [] as string[], hIdx: -1, stash: '',
    esc: '',                   // partial ESC sequence accumulator
  })
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

    // ---- local line editor (pipe shells + agent mode) ---------------------
    const promptStr = () => ed.current.agent ? `${ESC}36m❯${ESC}0m ` : `${ESC}32m❯${ESC}0m `
    const chars = () => [...ed.current.buf]
    const redraw = () => {
      const e = ed.current
      term.write(`\r${ESC}K${promptStr()}${hlCmd(e.buf)}`)
      const tail = chars().length - e.cur
      if (tail > 0) term.write(`${ESC}${tail}D`)
    }
    const submit = () => {
      const e = ed.current
      const line = e.buf
      e.buf = ''; e.cur = 0; e.hIdx = -1; e.stash = ''
      term.write('\r\n')
      if (line.trim()) { e.hist.unshift(line); if (e.hist.length > 50) e.hist.length = 50 }
      if (e.agent) onAgentLineRef.current?.(line)
      else send(line + '\n')
    }
    const setBuf = (s: string, cur = [...s].length) => {
      const e = ed.current
      e.buf = s; e.cur = Math.max(0, Math.min(cur, [...s].length))
      redraw()
    }
    const histDown = () => {
      const e = ed.current
      if (e.hIdx === -1) return
      if (e.hIdx === 0) { e.hIdx = -1; setBuf(e.stash) }
      else { e.hIdx--; setBuf(e.hist[e.hIdx] ?? '') }
    }
    const histUp = () => {
      const e = ed.current
      if (!e.hist.length) return
      if (e.hIdx === -1) { e.stash = e.buf; e.hIdx = 0 }
      else if (e.hIdx < e.hist.length - 1) e.hIdx++
      else return
      setBuf(e.hist[e.hIdx] ?? '')
    }

    /** Feed one input token through the line editor. */
    const editKey = (tok: string) => {
      const e = ed.current
      if (tok === '\r' || tok === '\n') { submit(); return }
      if (tok === '\x7f') { // Backspace — delete char left of cursor
        if (e.cur > 0) { const a = chars(); a.splice(e.cur - 1, 1); e.cur--; e.buf = a.join(''); redraw() }
        return
      }
      if (tok === '\x03') { e.buf = ''; e.cur = 0; e.hIdx = -1; term.write('^C\r\n' + promptStr()); return }
      if (tok === '\x15') { // Ctrl+U — kill to start
        const a = chars(); a.splice(0, e.cur); e.buf = a.join(''); e.cur = 0; redraw(); return
      }
      if (tok === '\x01') { e.cur = 0; redraw(); return }                 // ^A home
      if (tok === '\x05') { e.cur = chars().length; redraw(); return }    // ^E end
      if (tok === `${ESC}D`) { if (e.cur > 0) { e.cur--; redraw() } return }
      if (tok === `${ESC}C`) { if (e.cur < chars().length) { e.cur++; redraw() } return }
      if (tok === `${ESC}H` || tok === `${ESC}1~` || tok === `${ESC}[H`) { e.cur = 0; redraw(); return }
      if (tok === `${ESC}F` || tok === `${ESC}4~` || tok === `${ESC}[F`) { e.cur = chars().length; redraw(); return }
      if (tok === `${ESC}3~`) { const a = chars(); if (e.cur < a.length) { a.splice(e.cur, 1); e.buf = a.join(''); redraw() } return }
      if (tok === `${ESC}A`) { histUp(); return }
      if (tok === `${ESC}B`) { histDown(); return }
      if (tok === `${ESC}200~` || tok === `${ESC}201~`) return // paste markers — handled upstream
      if (tok === '\x1b') return // bare ESC — ignore
      // printable run — insert at cursor
      if (tok.length && [...tok].every((c) => c >= ' ' || c === '\t')) {
        const a = chars(); a.splice(e.cur, 0, tok); e.buf = a.join(''); e.cur += [...tok].length; e.hIdx = -1; redraw()
      }
    }

    /** Split an onData chunk into editor tokens: ESC sequences, newline, and
     *  printable runs. Partial sequences stash in ed.esc. */
    const feedEditor = (d: string) => {
      const e = ed.current
      let s = e.esc + d
      e.esc = ''
      let paste = false
      while (s.length) {
        const i = s.indexOf('\x1b')
        if (i !== 0) {
          // printable run before the next ESC (or the whole remainder)
          const run = i === -1 ? s : s.slice(0, i)
          s = s.slice(run.length)
          if (paste) { editKey(run.replace(/[\r\n]+/g, ' ')); continue }
          for (const part of run.split(/(\r\n?|\n)/)) {
            if (part === '') continue
            if (/\r|\n/.test(part)) editKey('\r')
            else editKey(part)
          }
          continue
        }
        // s starts with ESC — find the sequence end (final byte 0x40-0x7e)
        if (s.length < 2) { e.esc = s; return }
        const m = /^(\x1b\[[0-9;]*[~A-Za-z]|\x1b.)/.exec(s)
        if (!m) { e.esc = s.slice(0, 1); s = s.slice(1); continue }
        const seq = m[0]
        s = s.slice(seq.length)
        if (seq === `${ESC}200~`) { paste = true; continue }
        if (seq === `${ESC}201~`) { paste = false; continue }
        editKey(seq)
      }
    }

    const dataSub = term.onData((d) => {
      const e = ed.current
      if (e.agent || !e.pty) { feedEditor(d); return }
      send(d)
    })

    let exited = false
    ws.onopen = () => {
      setLive(true)
      for (const d of early.splice(0)) { try { ws.send(JSON.stringify({ d })) } catch { /* dead */ } }
    }
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(String(ev.data))
        if (m.shell === 'pty') ed.current.pty = true
        else if (m.shell === 'pipe') ed.current.pty = false
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
    const e = ed.current
    e.agent = !!agentMode
    e.buf = ''; e.cur = 0; e.hIdx = -1
    if (agentMode) termRef.current?.write(`${ESC}36m❯${ESC}0m `)
  }, [agentMode])

  useImperativeHandle(ref, () => ({
    send: (d: string) => sendRef.current(d),
    write: (d: string) => termRef.current?.write(d),
    setLine: (s: string) => {
      const e = ed.current
      if (e.agent || !e.pty) { const t = termRef.current; if (t) { e.buf = ''; e.cur = 0; e.hIdx = -1; setBufFor(s) } }
      else sendRef.current(s)
    },
    clear: () => termRef.current?.clear(),
    focus: () => termRef.current?.focus(),
    isLive: () => liveRef.current,
  }), [])

  // setLine helper needs the editor's redraw — declared via closure below
  // is impossible post-mount; keep a tiny indirection through a ref.
  const setBufFor = (s: string) => {
    const e = ed.current
    e.buf = s; e.cur = [...s].length
    const t = termRef.current
    if (!t) return
    t.write(`\r${ESC}K${e.agent ? `${ESC}36m❯${ESC}0m ` : `${ESC}32m❯${ESC}0m `}${hlCmd(s)}`)
  }

  return (
    <div
      ref={hostRef}
      className="absolute inset-0 overflow-hidden p-1.5 pl-2"
      style={{ display: active ? undefined : 'none' }}
    />
  )
})

export default TermSession
