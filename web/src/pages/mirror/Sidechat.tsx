import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '@/i18n'
import { Loader2, Copy, Check, ArrowUp, Square, Link2, MessageSquarePlus, SquarePen, Brain, Wrench, Reply, ThumbsUp, ThumbsDown, Languages, GitFork, TextQuote } from 'lucide-react'
import { adminFetch } from '@/lib/api'
import { visibleInterval } from '@/lib/poll'
import Markdown from '@/components/Markdown'
import { Textarea, Select } from '@/components/ui'
import { cn } from '@/lib/utils'
import { FeedbackDialog } from './dialogs'
import { copyText } from '../../lib/clipboard'
import { translateText } from '@/lib/translate'

function MessageToolbar({ text, eid, ts, tab, onSideChat, onStartNewSession, onFork, onQuote, sessionId, onTranslated }: { text: string; eid: string; ts?: string; tab?: string; onSideChat?: () => void; onStartNewSession?: () => void; onFork?: () => void; onQuote?: () => void; sessionId?: string; onTranslated?: (t: string) => void }) {
  const { t } = useTranslation()
  const [done, setDone] = useState('')
  const [fb, setFb] = useState<'positive' | 'negative' | null>(null)
  const [sent, setSent] = useState<'positive' | 'negative' | null>(null)
  const [translating, setTranslating] = useState(false)
  const [trFail, setTrFail] = useState(false)
  const act = (k: string, v: string) => {
    copyText(v)
    setDone(k)
    setTimeout(() => setDone(''), 1200)
  }
  const btn = 'flex size-6 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground'
  return (
    <div data-testid="transcript-message-actions" data-find-exclude="true" data-quote-exclude="true" className="transcript-message-actions absolute -top-7 right-2 z-10 flex h-7 min-w-fit items-center gap-px whitespace-nowrap rounded-[8px] border border-border bg-card p-px opacity-0 shadow-shadow-L1 transition-opacity focus-visible:opacity-100 focus-within:opacity-100 group-hover:opacity-100 has-[:focus-visible]:opacity-100">
      {onStartNewSession && (
        <button aria-label={t('sc.newWithPrompt')} title={t('sc.newWithPrompt')} onClick={onStartNewSession} className={btn}>
          <SquarePen size={16} />
        </button>
      )}
      {onQuote && (
        <button aria-label={t('sc.quote')} title={t('sc.quote')} onClick={onQuote} className={btn}>
          <TextQuote size={16} />
        </button>
      )}
      {onFork && (
        <button aria-label={t('sc.forkHere')} title={t('sc.forkHere')} onClick={onFork} className={btn}>
          <GitFork size={16} />
        </button>
      )}
      {sessionId && (
        <>
          <button aria-label={t('sc.good')} title={t('sc.good')} onClick={() => setFb('positive')} className={cn(btn, sent && sent !== 'positive' && 'opacity-30', sent === 'positive' && 'text-foreground')}>
            <ThumbsUp size={16} fill={sent === 'positive' ? 'currentColor' : 'none'} />
          </button>
          <button aria-label={t('sc.bad')} title={t('sc.bad')} onClick={() => setFb('negative')} className={cn(btn, sent && sent !== 'negative' && 'opacity-30', sent === 'negative' && 'text-foreground')}>
            <ThumbsDown size={16} fill={sent === 'negative' ? 'currentColor' : 'none'} />
          </button>
        </>
      )}
      <button aria-label={t('sc.copy')} title={t('sc.copy')} onClick={() => act('copy', text)} className={btn}>
        {done === 'copy' ? <Check size={16} /> : <Copy size={16} />}
      </button>
      <button
        aria-label={t('sc.copyLink')}
        title={t('sc.copyLink')}
        onClick={() => {
          const link = new URL(location.pathname, location.origin)
          const tok = new URLSearchParams(location.search).get('t')
          if (tok) link.searchParams.set('t', tok)
          if (tab && tab !== 'worklog') link.searchParams.set('tab', tab)
          link.searchParams.set('ts', ts ? String(new Date(ts).getTime()) : eid)
          act('link', link.toString())
        }}
        className={btn}
      >
        {done === 'link' ? <Check size={16} /> : <Link2 size={16} />}
      </button>
      {onTranslated && text.trim() && (
        <button
          aria-label={t('sc.translate')}
          title={trFail ? t('sc.translateUnavailable') : translating ? t('sc.translating') : t('sc.translate')}
          disabled={translating}
          onClick={async () => {
            setTranslating(true)
            try {
              onTranslated(await translateText(text))
            } catch {
              setTrFail(true)
              setTimeout(() => setTrFail(false), 1500)
            } finally {
              setTranslating(false)
            }
          }}
          className={cn(btn, translating && 'animate-pulse', trFail ? 'text-red-500' : '')}
        >
          <Languages size={16} />
        </button>
      )}
      {onSideChat && (
        <button aria-label={t('sc.sidechat')} title={t('sc.sidechat')} onClick={onSideChat} className={btn}>
          <MessageSquarePlus size={16} />
        </button>
      )}
      {sessionId && (
        <>
          {fb && (
            <FeedbackDialog
              variant={fb}
              onClose={() => setFb(null)}
              onSubmit={async (comment, categories) => {
                const r = await adminFetch<{ ok: boolean; error: string | null }>(`/api/admin/session/${sessionId}/feedback`, {
                  method: 'POST',
                  body: JSON.stringify({ event_id: eid, feedback: fb, comment: comment || undefined, categories: categories.length ? categories : undefined }),
                })
                if (!r.ok) throw new Error(r.error || 'failed')
                setSent(fb)
              }}
            />
          )}
        </>
      )}
    </div>
  )
}

interface SidechainMessage {
  role: 'user' | 'assistant' | 'thinking' | 'action'
  content: string
  ts: string
  pending?: boolean
  durationMs?: number
  error?: boolean
}

interface SidechainThread {
  anchor_event_id: string
  anchor_ts: number
  label: string
  messages: SidechainMessage[]
  pending_request_id?: string
}

/**
 * Side chat: a thread anchored to a main-timeline event, letting you ask
 * questions without interrupting the main agent (official semantics: a
 * `sidechain_request` frame; replies arrive as sidechain subagent events).
 */
function SidechatPanel({ id, anchor, onStage }: { id: string; anchor: { id: string; ts: string } | null; onStage?: (f: { url: string; name: string; size: number }) => void }) {
  const { t } = useTranslation()
  const [threads, setThreads] = useState<SidechainThread[]>([])
  const [loaded, setLoaded] = useState(false)
  const [selected, setSelected] = useState<string | null>(anchor?.id ?? null)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [merging, setMerging] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => { if (anchor) setSelected(anchor.id) }, [anchor])

  useEffect(() => {
    let alive = true
    const load = () => adminFetch<{ threads: SidechainThread[]; error: string | null }>(`/api/admin/session/${id}/sidechains`)
      .then((r) => { if (alive) { setThreads(r.threads); setLoaded(true) } })
      .catch(() => { if (alive) setLoaded(true) })
    load()
    const stop = visibleInterval(load, 5000)
    return () => { alive = false; stop() }
  }, [id])

  const current = selected ? threads.find((t) => t.anchor_event_id === selected) : null
  const anchorId = selected ?? anchor?.id ?? null

  const cancel = async () => {
    if (!current?.pending_request_id) return
    setErr(null)
    try {
      const r = await adminFetch<{ ok: boolean; error: string | null }>(`/api/admin/session/${id}/sidechain/cancel`, {
        method: 'POST',
        body: JSON.stringify({ anchor_event_id: current.anchor_event_id, request_id: current.pending_request_id }),
      })
      if (!r.ok) setErr(r.error || 'cancel failed')
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  // Official "Merge into main chat": the side chat thread is exported as a
  // sidechat-<anchor>.md markdown transcript, uploaded, and staged in the main
  // composer as an attachment chip (sent with the next message, not auto-sent).
  const merge = async () => {
    if (!current || merging) return
    setMerging(true)
    setErr(null)
    try {
      const lines = [t('sc.transcriptTitle'), ``, `${t('sc.branched')}:`, ``, `> ${current.label}`, ``]
      for (const m of current.messages) {
        if (m.role === 'thinking' || m.role === 'action') continue
        lines.push(`## ${m.role === 'user' ? t('common.user') : 'Devin'}`, ``, m.content, ``)
      }
      const name = `sidechat-${current.anchor_event_id.replace(/^event-/, '').slice(-8)}.md`
      const r = await adminFetch<{ ok: boolean; url?: string; name?: string; size?: number; error?: string }>(`/api/admin/session/${id}/upload-stage?filename=${encodeURIComponent(name)}`, { method: 'POST', body: new File([lines.join('\n')], name, { type: 'text/markdown' }) })
      if (r.ok && r.url) onStage?.({ url: r.url, name: r.name || name, size: r.size || 0 })
      else setErr(r.error || t('sc.mergeFail'))
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setMerging(false)
    }
  }

  const send = async () => {
    const message = text.trim()
    if (!message || !anchorId || sending) return
    setSending(true)
    setErr(null)
    try {
      const r = await adminFetch<{ ok: boolean; error: string | null }>(`/api/admin/session/${id}/sidechain`, {
        method: 'POST',
        body: JSON.stringify({
          anchor_event_id: anchorId,
          anchor_ts: anchor && anchor.id === anchorId ? new Date(anchor.ts).getTime() : current?.anchor_ts || Date.now(),
          message,
        }),
      })
      if (!r.ok) setErr(r.error || 'send failed')
      else { setText(''); setSelected(anchorId) }
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setSending(false)
    }
  }

  if (!loaded) return <div className="p-3 text-[13px] text-muted-foreground">{t('common.loading')}</div>

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {!threads.length && !anchor && (
          <p className="text-[13px] leading-[18px] text-muted-foreground">
            No side chats yet. Hover a message in the timeline and choose “New side chat” to ask questions without interrupting the main agent.
          </p>
        )}
        {threads.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {threads.map((t) => (
              <button
                key={t.anchor_event_id}
                onClick={() => setSelected(t.anchor_event_id)}
                className={cn(
                  'max-w-full truncate rounded-md border px-2 py-1 text-left text-[12px] leading-[16px]',
                  selected === t.anchor_event_id ? 'border-foreground/30 bg-accent' : 'border-border text-muted-foreground hover:bg-accent',
                )}
              >
                {t.label.slice(0, 60) || i18n.t('sc.sidechat')}
              </button>
            ))}
          </div>
        )}
        {anchor && !current && (
          <p className="mb-2 text-[12px] leading-[16px] text-muted-foreground">New side chat · anchored to the selected message</p>
        )}
        {current && (
          <div className="mb-3 flex items-start gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground text-background">
              <MessageSquarePlus size={15} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] leading-[18px] font-medium">{t('sc.branched')}</p>
              <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap border-l-2 border-green-500 pl-2 text-[12px] leading-[17px] text-muted-foreground">{current.label}</p>
            </div>
            <button
              aria-label={t('sc.merge')}
              title={t('sc.merge')}
              onClick={() => void merge()}
              disabled={merging}
              className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
            >
              {merging ? <Loader2 size={14} className="animate-spin" /> : <Reply size={15} />}
            </button>
          </div>
        )}
        {current && (
          <div className="space-y-2">
            {current.messages.map((m, i) => (
              m.role === 'user' ? (
                <div key={i} className="ml-auto max-w-[85%] rounded-[4px_16px_16px_16px] bg-muted px-3 py-1.5 text-[13px] leading-[18px]">
                  {m.content}
                  {m.pending && <Loader2 size={11} className="ml-1 inline animate-spin text-muted-foreground" />}
                </div>
              ) : m.role === 'thinking' ? (
                <div key={i} className="flex items-start gap-1.5 text-[12px] leading-[16px] text-muted-foreground">
                  <Brain size={12} className="mt-0.5 shrink-0 text-violet-500" />
                  <span className="whitespace-pre-wrap">{m.content}</span>
                </div>
              ) : m.role === 'action' ? (
                <div key={i} className="flex items-start gap-1.5 text-[12px] leading-[16px] text-muted-foreground">
                  <Wrench size={12} className="mt-0.5 shrink-0" />
                  <span>{m.content}</span>
                </div>
              ) : (
                <div key={i} className={cn('text-[13px] leading-[18px]', m.error && 'text-red-500')}>
                  <Markdown text={m.content} />
                </div>
              )
            ))}
          </div>
        )}
      </div>
      <div className="border-t border-border p-2">
        {err && <p className="mb-1 text-[12px] text-red-500">{err}</p>}
        <div className="flex items-end gap-1.5">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
            placeholder={current?.messages.length ? t('sc.followUp') : anchorId ? t('sc.askQ') : t('sc.selectFirst')}
            disabled={!anchorId}
            rows={1}
            className="min-h-9 flex-1 resize-none text-[13px]"
          />
          {current?.pending_request_id ? (
            <button
              aria-label={t('composer.stop')}
              title={t('composer.stop')}
              onClick={cancel}
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background"
            >
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button
              aria-label={t('sc.send')}
              onClick={send}
              disabled={!anchorId || !text.trim() || sending}
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background disabled:opacity-40"
            >
              {sending ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={14} />}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}


export { MessageToolbar, type SidechainMessage, type SidechainThread, SidechatPanel };
