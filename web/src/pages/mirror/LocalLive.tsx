import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Expand, Shrink, Monitor, Globe, Loader2, Power, ArrowRight, Eye } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * LocalLive — the local replacement for the cloud noVNC LiveDesktop.
 *  桌面:   read-only MJPEG of the real host screen (/api/admin/screen/live).
 *  浏览器: dedicated Edge/Chrome driven over /ws/browser — CDP screencast
 *          frames in, pointer/keyboard events back out (Input.dispatch*).
 */

const VK: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, Escape: 27,
  PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Insert: 45, Delete: 46,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
  F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
}
const BTN = ['left', 'middle', 'right'] as const
const modsOf = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
  (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)

function LocalBrowser() {
  const [running, setRunning] = useState<boolean | null>(null)
  const [exeOk, setExeOk] = useState(true)
  const [frame, setFrame] = useState('')
  const [url, setUrl] = useState('')
  const [err, setErr] = useState('')
  const wsRef = useRef<WebSocket | null>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const lastClickAt = useRef(0)
  const lastMoveAt = useRef(0)
  const pressed = useRef(new Set<number>())

  const send = useCallback((o: Record<string, unknown>) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o))
  }, [])

  useEffect(() => {
    let dead = false
    let ws: WebSocket | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    const connect = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/browser`)
      wsRef.current = ws
      ws.onmessage = (ev) => {
        let o: { t?: string; running?: boolean; exe?: boolean; url?: string; d?: string; error?: string }
        try { o = JSON.parse(String(ev.data)) } catch { return }
        if (o.t === 'status') { setRunning(!!o.running); setExeOk(o.exe !== false); if (o.url) setUrl(o.url) }
        else if (o.t === 'frame' && typeof o.d === 'string') { setFrame(`data:image/jpeg;base64,${o.d}`); setRunning(true); setErr('') }
        else if (o.t === 'nav' && o.url) setUrl(o.url)
        else if (o.t === 'closed') { setRunning(false); setFrame('') }
        else if (o.t === 'error' && o.error) setErr(o.error)
      }
      ws.onclose = () => { if (!dead) retry = setTimeout(connect, 2500) }
    }
    connect()
    return () => { dead = true; if (retry) clearTimeout(retry); ws?.close(); wsRef.current = null }
  }, [])

  // wheel is passive by default — bind non-passive so the page behind doesn't scroll
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    const stop = (e: WheelEvent) => e.preventDefault()
    el.addEventListener('wheel', stop, { passive: false })
    return () => el.removeEventListener('wheel', stop)
  }, [running])

  useEffect(() => { if (running) inputRef.current?.focus() }, [running])

  // Normalize into the letterboxed image area (object-contain draws the
  // frame inside the img box — the img box itself includes the bars).
  const pos = (e: { clientX: number; clientY: number }) => {
    const img = imgRef.current
    if (!img || !img.naturalWidth) return null
    const r = img.getBoundingClientRect()
    const scale = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight)
    const w = img.naturalWidth * scale
    const h = img.naturalHeight * scale
    const ox = r.left + (r.width - w) / 2
    const oy = r.top + (r.height - h) / 2
    const u = (e.clientX - ox) / w
    const v = (e.clientY - oy) / h
    if (u < 0 || u > 1 || v < 0 || v > 1) return null
    return { u, v }
  }

  const go = (e: FormEvent) => {
    e.preventDefault()
    if (url.trim()) send({ t: 'navigate', url: url.trim() })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <form onSubmit={go} className="flex items-center gap-1.5">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={!running}
          placeholder="输入网址，回车访问"
          className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-[13px] outline-none placeholder:text-muted-foreground/60 disabled:opacity-50"
        />
        <button type="submit" disabled={!running} className="flex h-8 items-center gap-1 rounded-lg border border-border px-3 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40">
          <ArrowRight size={14} />访问
        </button>
        {running && (
          <button type="button" onClick={() => send({ t: 'close' })} title="关闭浏览器" className="flex h-8 items-center gap-1 rounded-lg border border-border px-3 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground">
            <Power size={13} />
          </button>
        )}
      </form>
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-black">
        {frame && (
          <img ref={imgRef} src={frame} alt="browser" draggable={false}
            className="absolute inset-0 h-full w-full select-none object-contain" />
        )}
        {running && (
          <textarea
            ref={inputRef}
            autoCapitalize="off" autoComplete="off" autoCorrect="off" spellCheck={false}
            className="absolute inset-0 z-10 h-full w-full cursor-text resize-none bg-transparent opacity-0"
            onContextMenu={(e) => e.preventDefault()}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
              inputRef.current?.focus()
              const p = pos(e); if (!p) return
              const now = Date.now()
              const clickCount = now - lastClickAt.current < 400 ? 2 : 1
              lastClickAt.current = now
              send({ t: 'mouse', type: 'mousePressed', ...p, button: BTN[e.button] ?? 'left', clickCount, mods: modsOf(e) })
            }}
            onPointerUp={(e) => {
              const p = pos(e); if (!p) return
              send({ t: 'mouse', type: 'mouseReleased', ...p, button: BTN[e.button] ?? 'left', mods: modsOf(e) })
            }}
            onPointerMove={(e) => {
              const now = Date.now()
              if (now - lastMoveAt.current < 33) return
              lastMoveAt.current = now
              const p = pos(e); if (!p) return
              send({ t: 'mouse', type: 'mouseMoved', ...p, button: 'none', mods: modsOf(e) })
            }}
            onWheel={(e) => {
              const p = pos(e); if (!p) return
              const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 800 : 1
              send({ t: 'wheel', ...p, dx: e.deltaX * k, dy: e.deltaY * k, mods: modsOf(e) })
            }}
            onKeyDown={(e) => {
              const vk = VK[e.key]
              const chord = (e.ctrlKey || e.metaKey) && e.key.length === 1 && e.key.toLowerCase() !== 'v'
              if (vk != null || chord) {
                e.preventDefault()
                const code = vk ?? e.key.toUpperCase().charCodeAt(0)
                pressed.current.add(code)
                send({ t: 'key', type: 'rawKeyDown', key: e.key, code: e.code, vk: code, mods: modsOf(e) })
              }
              // printable keys / ctrl+v fall through → onInput / onPaste
            }}
            onKeyUp={(e) => {
              const vk = VK[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase().charCodeAt(0) : -1)
              if (vk >= 0 && pressed.current.delete(vk)) {
                send({ t: 'key', type: 'keyUp', key: e.key, code: e.code, vk, mods: modsOf(e) })
              }
            }}
            onInput={(e) => {
              const v = e.currentTarget.value
              if (v) { send({ t: 'text', text: v }); e.currentTarget.value = '' }
            }}
            onPaste={(e) => {
              e.preventDefault()
              const t = e.clipboardData.getData('text')
              if (t) send({ t: 'text', text: t })
            }}
          />
        )}
        {running === null && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-[13px] text-white/60">
            <Loader2 size={14} className="animate-spin" /> 连接中…
          </div>
        )}
        {running === false && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-background p-4 text-center">
            {exeOk ? (
              <>
                <Globe size={28} className="text-muted-foreground" />
                <button
                  onClick={() => send({ t: 'open', url: url.trim() || 'about:blank' })}
                  className="h-9 rounded-lg bg-foreground px-4 text-[13px] font-medium text-background hover:opacity-90"
                >
                  启动浏览器
                </button>
                <span className="max-w-[320px] text-[12px] leading-[18px] text-muted-foreground">
                  会在本机打开一个专属 Edge/Chrome 窗口（独立 profile），这里可实时看到页面并远程操作
                </span>
              </>
            ) : (
              <span className="text-[13px] text-muted-foreground">未找到 Edge / Chrome，无法启动</span>
            )}
            {err && <span className="text-[12px] text-red-500">{err}</span>}
          </div>
        )}
      </div>
    </div>
  )
}

export function LocalLive() {
  const [mode, setMode] = useState<'desktop' | 'browser'>('desktop')
  const [full, setFull] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onFs = () => setFull(document.fullscreenElement === rootRef.current)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  return (
    <div ref={rootRef} className="flex h-full flex-col gap-2 bg-background p-3">
      <div className="flex items-center gap-1 self-start rounded-lg border border-border bg-muted/40 p-0.5">
        {([['desktop', '桌面', Monitor], ['browser', '浏览器', Globe]] as const).map(([k, label, Icon]) => (
          <button
            key={k}
            onClick={() => setMode(k)}
            className={cn(
              'flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-3 text-[13px] transition-colors',
              mode === k ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon size={14} />{label}
          </button>
        ))}
        <span className="ml-2 hidden items-center gap-1 pr-2 text-[12px] text-muted-foreground sm:flex">
          {mode === 'desktop' ? <><Eye size={12} />本机屏幕 · 只读</> : '专属浏览器 · 可交互'}
        </span>
        <button
          onClick={() => (full ? void document.exitFullscreen() : void rootRef.current?.requestFullscreen())}
          aria-label={full ? '退出全屏' : '全屏'}
          className="ml-1 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {full ? <Shrink size={13} /> : <Expand size={13} />}
        </button>
      </div>
      {mode === 'desktop' ? (
        <img
          src="/api/admin/screen/live"
          alt="host desktop"
          draggable={false}
          className="min-h-0 flex-1 select-none rounded-lg border border-border bg-black object-contain"
        />
      ) : (
        <LocalBrowser />
      )}
    </div>
  )
}
