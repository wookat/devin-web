import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Mic } from 'lucide-react'
import { adminFetch } from '@/lib/api'
import { time } from './timelineUtil'

const PREFERRED_LANG = navigator.language?.toLowerCase().startsWith('zh') ? 'Chinese' : 'English'

/**
 * Voice input mic button (official: records via MediaRecorder, then `POST
 * /api/transcribe-audio` and inserts the transcription into the input box).
 */
function Waveform({ volumeRef }: { volumeRef: React.MutableRefObject<number> }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const samplesRef = useRef<number[]>([])
  const smoothedRef = useRef<number[]>([])

  useEffect(() => {
    const interval = window.setInterval(() => {
      samplesRef.current = [...samplesRef.current.slice(-199), Math.min(100, Math.max(0, volumeRef.current))]
    }, 50)
    return () => window.clearInterval(interval)
  }, [volumeRef])

  useEffect(() => {
    let frame = 0
    const draw = () => {
      const canvas = canvasRef.current
      if (canvas) {
        const rect = canvas.getBoundingClientRect()
        const dpr = window.devicePixelRatio || 1
        const canvasWidth = Math.max(0, Math.floor(rect.width * dpr))
        const canvasHeight = Math.max(0, Math.floor(rect.height * dpr))
        if (canvas.width !== canvasWidth) canvas.width = canvasWidth
        if (canvas.height !== canvasHeight) canvas.height = canvasHeight

        const context = canvas.getContext('2d')
        if (context) {
          context.clearRect(0, 0, canvasWidth, canvasHeight)
          const barWidth = 1 * dpr
          const gap = 2 * dpr
          const barCount = Math.floor((canvasWidth + gap) / (barWidth + gap))
          const visibleSamples = samplesRef.current.slice(-barCount)
          const computed = getComputedStyle(canvas)
          const color = computed.getPropertyValue('--text-accent-primary').trim() || '49 124 255'
          const sensitivity = Number(computed.getPropertyValue('--composer-waveform-sensitivity')) || 1.5
          context.fillStyle = `rgb(${color})`
          const minHeight = 1 * dpr
          const maxHeight = Math.min(canvasHeight * 0.9, 14 * dpr)

          if (smoothedRef.current.length !== barCount) {
            const previous = smoothedRef.current
            smoothedRef.current = previous.length < barCount
              ? [...Array(barCount - previous.length).fill(0), ...previous]
              : previous.slice(-barCount)
          }
          for (let index = 0; index < barCount; index += 1) {
            const sampleIndex = visibleSamples.length - barCount + index
            const target = sampleIndex >= 0
              ? Math.min(1, ((visibleSamples[sampleIndex] ?? 0) / 100) * sensitivity)
              : 0
            const previous = smoothedRef.current[index] ?? 0
            smoothedRef.current[index] = previous + (target - previous) * 0.25
            const barHeight = Math.max(minHeight, smoothedRef.current[index] * maxHeight)
            context.beginPath()
            context.roundRect(
              index * (barWidth + gap),
              canvasHeight / 2 - barHeight / 2,
              barWidth,
              barHeight,
              barWidth / 2,
            )
            context.fill()
          }
        }
      }
      frame = window.requestAnimationFrame(draw)
    }
    frame = window.requestAnimationFrame(draw)
    return () => window.cancelAnimationFrame(frame)
  }, [])

  return <canvas ref={canvasRef} className="block min-w-0 flex-1 h-7 max-md:h-6" />
}

function OfficialStopIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" className="size-[18px]">
      <path d="M17.0804 3H6.91957C6.38542 2.99999 5.93956 2.99998 5.57533 3.02974C5.19545 3.06078 4.83879 3.12789 4.50153 3.29973C3.98408 3.56338 3.56338 3.98408 3.29973 4.50153C3.12789 4.83879 3.06078 5.19545 3.02974 5.57533C2.99998 5.93956 2.99999 6.38541 3 6.91956V17.0804C2.99999 17.6146 2.99998 18.0604 3.02974 18.4247C3.06078 18.8046 3.12789 19.1612 3.29973 19.4985C3.56338 20.0159 3.98408 20.4366 4.50153 20.7003C4.83879 20.8721 5.19545 20.9392 5.57533 20.9703C5.93956 21 6.3854 21 6.91955 21H17.0805C17.6146 21 18.0604 21 18.4247 20.9703C18.8046 20.9392 19.1612 20.8721 19.4985 20.7003C20.0159 20.4366 20.4366 20.0159 20.7003 19.4985C20.8721 19.1612 20.9392 18.8046 20.9703 18.4247C21 18.0604 21 17.6146 21 17.0805V6.91955C21 6.3854 21 5.93956 20.9703 5.57533C20.9392 5.19545 20.8721 4.83879 20.7003 4.50153C20.4366 3.98408 20.0159 3.56338 19.4985 3.29973C19.1612 3.12789 18.8046 3.06078 18.4247 3.02974C18.0604 2.99998 17.6146 2.99999 17.0804 3Z" fill="currentColor" />
    </svg>
  )
}

function VoiceButton({ onText, onRecordingChange, disabled }: { onText: (t: string) => void; onRecordingChange?: (rec: boolean) => void; disabled?: boolean }) {
  const { t } = useTranslation()
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const [micError, setMicError] = useState(false)
  const micErrTimer = useRef(0)
  const [elapsed, setElapsed] = useState(0)
  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const startRef = useRef(new Date())
  const audioCtxRef = useRef<AudioContext | null>(null)
  const rafRef = useRef(0)
  const timerRef = useRef(0)
  const volumeRef = useRef(0)

  const stop = () => {
    recRef.current?.stop()
    recRef.current?.stream.getTracks().forEach((t) => t.stop())
    cancelAnimationFrame(rafRef.current)
    window.clearInterval(timerRef.current)
    volumeRef.current = 0
    void audioCtxRef.current?.close().catch(() => {})
    audioCtxRef.current = null
    setRecording(false)
    onRecordingChange?.(false)
  }

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream)
      chunksRef.current = []
      startRef.current = new Date()
      rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data) }
      rec.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' })
        if (!blob.size) return
        setBusy(true)
        try {
          const form = new FormData()
          const ext = (blob.type.split(';')[0].split('/')[1] || 'webm')
          form.append('audio_file', blob, `recording.${ext}`)
          form.append('start_time', startRef.current.toISOString())
          const r = await adminFetch<{ text: string | null; error: string | null }>('/api/admin/mirror/transcribe', { method: 'POST', body: form })
          if (r.text) onText(r.text)
        } finally {
          setBusy(false)
        }
      }
      rec.start()
      recRef.current = rec
      setElapsed(0)
      timerRef.current = window.setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current.getTime()) / 1000)), 250)
      // Live scrolling waveform (official recording bar shows amplitude bars).
      const ctx = new AudioContext()
      audioCtxRef.current = ctx
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      ctx.createMediaStreamSource(stream).connect(analyser)
      const data = new Uint8Array(analyser.frequencyBinCount)
      let lastSampleTime = 0
      const sample = (time: number) => {
        if (time - lastSampleTime >= 50) {
          lastSampleTime = time
          analyser.getByteFrequencyData(data)
          const average = data.reduce((sum, value) => sum + value, 0) / data.length
          volumeRef.current = (average / 128) ** 0.7 * 100
        }
        rafRef.current = requestAnimationFrame(sample)
      }
      rafRef.current = requestAnimationFrame(sample)
      setRecording(true)
      onRecordingChange?.(true)
    } catch {
      setRecording(false)
      onRecordingChange?.(false)
      setMicError(true)
      window.clearTimeout(micErrTimer.current)
      micErrTimer.current = window.setTimeout(() => setMicError(false), 4000)
    }
  }

  return (
    <>
      {micError ? (
        <div
          role="status"
          className="fixed bottom-4 right-4 z-50 flex w-[356px] items-start gap-2 rounded-lg border border-border bg-popover p-4 text-[13px] text-foreground shadow-lg"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" className="mt-0.5 shrink-0" aria-hidden="true">
            <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span className="flex-1">{t('vb.micFail')}</span>
          <button aria-label={t('common.close')} className="shrink-0 text-muted-foreground hover:text-foreground" onClick={() => setMicError(false)}>
            ×
          </button>
        </div>
      ) : null}
      <button
        onClick={() => (recording ? stop() : void start())}
        disabled={disabled || busy}
        aria-label={t('vb.record')}
        title={t('vb.record')}
        className="flex size-7 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        {busy ? <Loader2 size={18} className="animate-spin" /> : <Mic size={18} />}
      </button>
      {recording && (
        <div
          className="absolute inset-0 z-10 flex w-full min-w-0 items-center gap-3 overflow-hidden bg-card voice-row-in"
          style={{ '--composer-waveform-sensitivity': '1.5' } as React.CSSProperties}
        >
          <span className="ml-1 w-10 shrink-0 text-[13px] leading-[18px] tabular-nums text-muted-foreground">
            {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
          </span>
          <Waveform volumeRef={volumeRef} />
          <button
            onClick={stop}
            aria-label={t('vb.send')}
            title={t('vb.send')}
            className="inline-flex size-7 shrink-0 select-none items-center justify-center rounded-full border border-black/[0.08] bg-[#363636] text-white hover:brightness-[.92] disabled:opacity-50 [&_svg]:size-[18px]"
          >
            <OfficialStopIcon />
          </button>
        </div>
      )}
    </>
  )
}

/** Hover toolbar under a message, official-style (size-6 icon buttons). */

export { PREFERRED_LANG, Waveform, OfficialStopIcon, VoiceButton };
