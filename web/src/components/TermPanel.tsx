import { useEffect, useRef, useState } from 'react'
import { adminKey } from '@/lib/api'

/** Interactive shell — /ws/term spawns cmd/sh in the session cwd.
 * `run` optionally replaces the shell with `devin ssh`/`devin forward` args
 * (query-string fragment, e.g. `run=ssh&arg=<session>`). */
export default function TermPanel({ id, run }: { id: string; run?: string }) {
  const [lines, setLines] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [live, setLive] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const pendRef = useRef('')

  useEffect(() => {
    pendRef.current = ''
    setLines([])
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws/term?session=${encodeURIComponent(id)}${run ? `&${run}` : ''}${adminKey() ? `&key=${encodeURIComponent(adminKey())}` : ''}`)
    wsRef.current = ws
    ws.onopen = () => setLive(true)
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(String(e.data))
        if (m.exit !== undefined) { setLive(false); pendRef.current += `\r\n\x1b[90m[exited ${m.exit}]\x1b[0m\r\n` }
        else if (typeof m.d === 'string') pendRef.current += m.d
        // strip CSI/OSC so raw cmd.exe output stays readable
        const clean = pendRef.current.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
        if (clean.length > 400_000) pendRef.current = clean.slice(-200_000)
        setLines(clean.split('\n').slice(-2000))
      } catch { /* non-json */ }
    }
    ws.onclose = () => setLive(false)
    return () => { try { ws.send(JSON.stringify({ kill: true })); ws.close() } catch {} ; wsRef.current = null }
  }, [id, run])

  useEffect(() => { boxRef.current?.scrollTo(0, boxRef.current.scrollHeight) }, [lines])

  const send = (line: string) => {
    wsRef.current?.send(JSON.stringify({ d: line + '\r\n' }))
    setDraft('')
  }
  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0d0d0d] font-mono text-[12px]">
      <div className="flex items-center justify-between border-b border-white/10 px-2 py-1 text-[10px] text-neutral-500">
        <span>{live ? 'shell' : 'shell (closed)'}</span>
        <button type="button" className="rounded px-1.5 py-0.5 hover:bg-white/10" onClick={() => { pendRef.current = ''; setLines([]) }}>Clear</button>
      </div>
      <div ref={boxRef} className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-all px-2 py-1 text-neutral-200">
        {lines.map((l, i) => <div key={i}>{l}</div>)}
      </div>
      <div className="flex items-center gap-1 border-t border-white/10 px-2 py-1">
        <span className="text-neutral-500">{'>'}</span>
        <input
          className="min-w-0 flex-1 bg-transparent text-neutral-100 outline-none placeholder:text-neutral-600"
          placeholder={live ? 'type a command…' : 'disconnected'}
          disabled={!live}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send(draft)
            else if (e.key === 'c' && e.ctrlKey) { e.preventDefault(); wsRef.current?.send(JSON.stringify({ d: '\x03' })) }
          }}
        />
      </div>
    </div>
  )
}
