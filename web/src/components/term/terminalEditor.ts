// The pipe-shell editor, independent of React/xterm so input chunk boundaries,
// routing, and display lifecycle can be regression-tested without a backend.
const CSI = '\x1b['
const MAX_LINE = 64 * 1024 - 1 // reserve the outgoing newline
const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const chars = (s: string) => Array.from(segments.segment(s), (x) => x.segment)
const clean = (s: string) => s.replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f-\x9f]/g, '')

/** Terminal cells, not JS string length (combining marks occupy no extra cell). */
export function cellWidth(s: string): number {
  let n = 0
  for (const c of s) {
    const p = c.codePointAt(0)!
    if (/\p{Mark}/u.test(c) || p === 0x200d || p === 0xfe0f) continue
    n += p >= 0x1100 && (p <= 0x115f || p === 0x2329 || p === 0x232a
      || (p >= 0x2e80 && p <= 0xa4cf && p !== 0x303f)
      || (p >= 0xac00 && p <= 0xd7a3) || (p >= 0xf900 && p <= 0xfaff)
      || (p >= 0xfe10 && p <= 0xfe19) || (p >= 0xfe30 && p <= 0xfe6f)
      || (p >= 0xff00 && p <= 0xff60) || (p >= 0xffe0 && p <= 0xffe6)
      || (p >= 0x20000 && p <= 0x3fffd)) ? 2 : 1
  }
  return n
}

interface EditorIO {
  write(data: string): void
  send(data: string): void
  interrupt(): void
  interruptHint?(): string
  agentLine(line: string): void
  cancelAgent(): void
  cols(): number
  rows?(): number
  highlight?(line: string): string
}

export class TerminalEditor {
  buf = ''
  cur = 0 // grapheme index
  fromAgent = false
  agent = false
  shell: 'pipe' | 'pty' | null = null
  live = false
  private hist: { text: string; command: boolean }[] = []
  private hIdx = -1
  private stash = { text: '', command: false }
  private esc = ''
  private paste = false
  private skipLF = false
  private awaitingAgent = false
  private drawn = false
  private cursorRow = 0
  private endRow = 0
  private viewStart = 0
  private outputEnded = true
  private idle: ReturnType<typeof setTimeout> | undefined

  private io: EditorIO
  constructor(io: EditorIO) { this.io = io }

  private get local() { return this.live && (this.agent || this.shell === 'pipe') }
  private unarm() { clearTimeout(this.idle); this.idle = undefined }
  private erase() {
    if (this.drawn) this.io.write(`\r${this.cursorRow ? `${CSI}${this.cursorRow}A` : ''}${CSI}J`)
    this.drawn = false
    this.cursorRow = 0
  }
  private reset() {
    this.buf = ''; this.cur = 0; this.fromAgent = false
    this.hIdx = -1; this.stash = { text: '', command: false }
    this.esc = ''; this.paste = false; this.skipLF = false
    this.awaitingAgent = false
    this.viewStart = 0
  }
  connection(live: boolean, shell: 'pipe' | 'pty' | null = this.shell) {
    this.unarm()
    this.erase()
    if (!live) { this.reset(); this.io.cancelAgent() }
    this.live = live; this.shell = shell
    if (this.local) this.redraw()
  }
  mode(agent: boolean) {
    if (this.agent === agent) return
    this.unarm(); this.erase(); this.reset(); this.io.cancelAgent()
    this.agent = agent
    if (this.local) this.redraw()
  }
  dispose() { this.unarm(); this.live = false }
  hideForResize() { this.erase() }
  agentSettled() { this.awaitingAgent = false }

  // Own the entire wrapped draft, not just its current physical row. Explicit
  // wraps reserve the last column to avoid xterm's pending-wrap cursor state.
  // Only drafts longer than the screen use a bounded, cursor-following view.
  redraw() {
    this.unarm()
    if (!this.local) return
    const a = chars(this.buf)
    const cols = Math.max(4, this.io.cols())
    const budget = Math.max(0, (cols - 2) * Math.max(1, (this.io.rows?.() ?? 24) - 1) - 2)
    let start = cellWidth(this.buf) <= budget ? 0 : Math.min(this.viewStart, this.cur)
    let before = cellWidth(a.slice(start, this.cur).join(''))
    while (start < this.cur && before > budget) before -= cellWidth(a[start++])
    this.viewStart = start
    let end = start, used = 0
    while (end < a.length && used + cellWidth(a[end]) <= budget) used += cellWidth(a[end++])
    this.erase()
    if (!this.drawn && !this.outputEnded) this.io.write('\r\n')
    const prompt = `${CSI}${this.agent ? 36 : 32}m❯${CSI}0m `
    const lines = ['']
    let row = 0, col = 2, cursor = { row: 0, col: 2 }
    for (let i = start; i < end; i++) {
      const w = cellWidth(a[i])
      if (col + w > cols - 1) { lines.push(''); row++; col = 0 }
      if (i === this.cur) cursor = { row, col }
      lines[row] += a[i]; col += w
    }
    if (this.cur === end) cursor = { row, col }
    this.io.write(`\r${CSI}J${prompt}${lines.map((s) => this.io.highlight?.(s) ?? s).join('\r\n')}`)
    // Reposition by ROW and CELL, never by codepoint count across a wrap.
    this.io.write(`\r${row > cursor.row ? `${CSI}${row - cursor.row}A` : ''}${cursor.col ? `${CSI}${cursor.col}C` : ''}`)
    this.cursorRow = cursor.row
    this.endRow = row
    this.drawn = true
    this.outputEnded = true
  }

  output(data: string) {
    if (!data) return
    // PTY streams are opaque: no CR normalization, editor clearing or timer.
    if (!this.local) { this.io.write(data); return }
    this.unarm(); this.erase()
    this.io.write(data)
    this.outputEnded = /[\r\n]$/.test(data)
    this.idle = setTimeout(() => { this.idle = undefined; this.redraw() }, 450)
  }

  setLine(text: string) {
    if (!this.local) {
      if (this.live && this.shell === 'pty') this.io.send(clean(text).slice(0, MAX_LINE))
      return
    }
    this.buf = clean(text).slice(0, MAX_LINE)
    this.awaitingAgent = false
    this.cur = chars(this.buf).length; this.hIdx = -1; this.fromAgent = true
    this.redraw()
  }

  private setHistory(text: string, command: boolean) {
    this.buf = text; this.cur = chars(text).length; this.fromAgent = command
    this.redraw()
  }
  private submit() {
    const line = this.buf, command = this.fromAgent
    const toAgent = this.agent && !command
    this.unarm()
    if (!this.drawn) this.redraw()
    this.io.write(`${this.endRow > this.cursorRow ? `${CSI}${this.endRow - this.cursorRow}B` : ''}\r\n`)
    this.drawn = false; this.cursorRow = 0
    // Do not reset parser state here: CRLF and bracketed paste may span chunks.
    this.buf = ''; this.cur = 0; this.hIdx = -1; this.fromAgent = false
    this.stash = { text: '', command: false }
    if (line.trim()) this.hist = [{ text: line, command }, ...this.hist].slice(0, 50)
    if (toAgent) { this.awaitingAgent = true; this.io.agentLine(line) }
    else this.io.send(line + (this.shell === 'pty' ? '\r' : '\n'))
    this.redraw()
  }
  private key(tok: string) {
    const wasAwaitingAgent = this.awaitingAgent
    this.awaitingAgent = false
    this.io.cancelAgent() // invalidate an outstanding suggestion after new input
    const a = chars(this.buf)
    if (tok === '\r' || tok === '\n') { this.submit(); return }
    if (tok === '\x03') {
      const hadDraft = !!this.buf
      this.unarm(); this.erase(); this.reset(); this.io.cancelAgent()
      this.io.write('^C\r\n')
      // Agent mode changes input routing, NOT ownership of a running shell.
      // Cancel a pending revision locally first; otherwise an empty Ctrl+C
      // interrupts the actual child (pipe recovery / raw remote PTY signal).
      if (!hadDraft && !wasAwaitingAgent && this.shell === 'pipe') this.io.interrupt()
      else {
        if (!hadDraft && !wasAwaitingAgent && this.shell === 'pty') this.io.send('\x03')
        if (hadDraft && this.shell === 'pipe' && this.io.interruptHint) {
          this.io.write(`${CSI}2m[${this.io.interruptHint()}]${CSI}0m\r\n`)
        }
        this.redraw()
      }
      return
    }
    if (tok === '\x7f' || tok === '\b') {
      if (this.cur) { a.splice(--this.cur, 1); this.buf = a.join('') }
    } else if (tok === '\x15') {
      a.splice(0, this.cur); this.buf = a.join(''); this.cur = 0
    } else if (tok === '\x01' || /^(?:\x1b\[H|\x1bOH|\x1b\[(?:1|7)~)$/.test(tok)) this.cur = 0
    else if (tok === '\x05' || /^(?:\x1b\[F|\x1bOF|\x1b\[(?:4|8)~)$/.test(tok)) this.cur = a.length
    else if (tok === `${CSI}D`) this.cur = Math.max(0, this.cur - 1)
    else if (tok === `${CSI}C`) this.cur = Math.min(a.length, this.cur + 1)
    else if (tok === `${CSI}3~`) { a.splice(this.cur, 1); this.buf = a.join('') }
    else if (tok === `${CSI}A`) {
      if (!this.hist.length || this.hIdx >= this.hist.length - 1) return
      if (this.hIdx < 0) this.stash = { text: this.buf, command: this.fromAgent }
      const h = this.hist[++this.hIdx]; this.setHistory(h.text, h.command); return
    } else if (tok === `${CSI}B`) {
      if (this.hIdx < 0) return
      const h = --this.hIdx < 0 ? this.stash : this.hist[this.hIdx]
      this.setHistory(h.text, h.command); return
    } else {
      if (tok.startsWith('\x1b')) return
      const text = clean(tok).slice(0, Math.max(0, MAX_LINE - this.buf.length))
      if (!text) return
      a.splice(this.cur, 0, ...chars(text)); this.buf = a.join('')
      this.cur = chars(a.slice(0, this.cur).join('') + text).length
      this.hIdx = -1
    }
    // Edits to an ask suggestion remain commands until submit/cancel/mode flip.
    if (!this.buf) this.fromAgent = false
    this.redraw()
  }

  feed(data: string) {
    if (!this.live || !this.shell) return // zero-length preconnect/reconnect queue
    if (!this.local) { this.io.send(data); return }
    let s = this.esc + data
    this.esc = ''
    while (s) {
      if (s[0] === '\x1b') {
        // CSI final bytes start AFTER ESC[. ESC[2 is incomplete, not ESC[ + "2".
        const m = /^(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1bO[@-~]|\x1b[^\[O])/.exec(s)
        if (!m) { this.esc = s.slice(0, 64); return }
        const tok = m[0]; s = s.slice(tok.length)
        if (tok === `${CSI}200~`) this.paste = true
        else if (tok === `${CSI}201~`) this.paste = false
        else if (!this.paste) this.key(tok)
        continue
      }
      if (this.paste) {
        const i = s.indexOf('\x1b'), text = i < 0 ? s : s.slice(0, i)
        this.key(clean(text)); s = s.slice(text.length); continue
      }
      const printable = /^[^\x00-\x1f\x7f-\x9f]+/u.exec(s)
      if (printable) {
        this.skipLF = false
        this.key(printable[0]); s = s.slice(printable[0].length); continue
      }
      const c = [...s][0]; s = s.slice(c.length)
      if (c === '\n' && this.skipLF) { this.skipLF = false; continue }
      this.skipLF = c === '\r'
      this.key(c)
    }
  }
}

/** A clean exit is terminal; transport loss alone is reconnectable. */
export class TerminalLifecycle {
  private ended = false
  exit(interrupted = false) { this.ended = !interrupted }
  shouldReconnect(disposed: boolean) { return !disposed && !this.ended }
}
