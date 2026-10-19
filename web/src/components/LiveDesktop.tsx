import { useEffect, useRef, useState } from 'react'
import { Boxes } from 'lucide-react'

type LiveDesktopQuality = 'auto' | 'sharp' | 'saver'

type LiveDesktopProps = {
  fetchLink: () => Promise<{ link: string | null; error: string | null }>
  quality?: LiveDesktopQuality
  frameless?: boolean
}

function qualitySettings(quality: LiveDesktopQuality): { qualityLevel: number; compressionLevel: number } {
  if (quality === 'sharp') return { qualityLevel: 9, compressionLevel: 0 }
  if (quality === 'saver') return { qualityLevel: 3, compressionLevel: 9 }
  return { qualityLevel: 6, compressionLevel: 2 }
}

/**
 * Real interactive desktop: asks the Worker for a short-lived VNC link to the
 * session's browser, then noVNC speaks RFB over that WebSocket. The Worker
 * gates who may obtain the link (admin, or visitors on an allowed share tier).
 */
export default function LiveDesktop({ fetchLink, quality = 'auto', frameless = false }: LiveDesktopProps) {
  const host = useRef<HTMLDivElement>(null)
  const rfbRef = useRef<{ disconnect(): void; compressionLevel?: number; qualityLevel?: number } | null>(null)
  const qualityRef = useRef<LiveDesktopQuality>(quality)
  const [error, setError] = useState('')
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    qualityRef.current = quality
    const rfb = rfbRef.current
    if (!rfb) return
    const settings = qualitySettings(quality)
    rfb.qualityLevel = settings.qualityLevel
    rfb.compressionLevel = settings.compressionLevel
  }, [quality])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    // The official client keeps re-requesting the link every few seconds until
    // the session's interactive browser comes up; mirror that retry loop here.
    const attempt = async () => {
      if (cancelled) return
      const retry = () => {
        if (cancelled) return
        timer = setTimeout(() => { void attempt().catch(() => retry()) }, 3500)
      }
      const res = await fetchLink()
      if (cancelled) return
      if (!res.link) {
        setError(res.error || 'unavailable')
        retry()
        return
      }
      const { default: RFB } = await import('@novnc/novnc')
      if (cancelled || !host.current) return
      // The desktop speaks RFB with security type 2 (VNC auth) and the fixed
      // client-side password the official client uses; real access control is
      // the short-lived token in the link. The upstream WS endpoint rejects
      // the default 'binary' subprotocol.
      const conn = new RFB(host.current, res.link, {
        shared: true,
        credentials: { password: 'devin' },
        wsProtocols: [],
      })
      conn.scaleViewport = true
      conn.showDotCursor = true
      const settings = qualitySettings(qualityRef.current)
      conn.qualityLevel = settings.qualityLevel
      conn.compressionLevel = settings.compressionLevel
      conn.background = 'transparent'
      conn.addEventListener('connect', () => setConnected(true))
      conn.addEventListener('credentialsrequired', () => setError('credentials_required'))
      conn.addEventListener('securityfailure', (e) => setError(`security: ${(e as CustomEvent).detail?.reason ?? ''}`))
      conn.addEventListener('disconnect', (e) => {
        setConnected(false)
        setError((e as CustomEvent).detail?.clean ? 'disconnected' : 'connection_failed')
        if (rfbRef.current === conn) { rfbRef.current = null; retry() }
      })
      rfbRef.current = conn
    }
    void attempt().catch(() => setError('failed'))

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      rfbRef.current?.disconnect()
      rfbRef.current = null
    }
  }, [fetchLink])

  return (
    <div className={frameless ? 'relative min-h-0 flex-1 overflow-hidden' : 'relative min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-black'}>
      <div ref={host} className="size-full" />
      {!connected && (
        <div className={`absolute inset-0 flex flex-col items-center justify-center gap-2 text-[13px] ${frameless ? 'text-muted-foreground' : 'text-white/70'}`}>
          {error === 'unavailable' || error === 'mirror_not_configured' || error === 'forbidden'
            ? <span>Live desktop unavailable ({error})</span>
            : <>
                <Boxes size={28} className={frameless ? 'text-muted-foreground' : 'text-white/50'} />
                <span>Reconnecting...</span>
              </>}
        </div>
      )}
    </div>
  )
}
