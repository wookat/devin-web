import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Send, RotateCcw, Archive, ArchiveRestore, Copy, Check, Loader2, LayoutDashboard, MessageSquare, Activity } from 'lucide-react'
import { adminFetch, type PublicMessage, type DashboardData } from '@/lib/api'
import ChatView from '@/components/ChatView'
import Timeline, { type TimelineItem } from '@/components/Timeline'
import Dashboard from '@/components/Dashboard'
import { Button, Textarea, StatusDot, statusLabel, Combo, Card } from '@/components/ui'
import { cn } from '@/lib/utils'

interface Detail {
  session: {
    id: string
    devin_session_id: string
    title: string
    devin_title: string
    permission: string
    archived: number
    status: string
    pull_request?: { url?: string } | null
  }
  messages: PublicMessage[]
  share_url: string
  media_token?: string
  dashboard_token: string
  dashboard_url: string
}

export default function AdminSessionPage() {
  const { t } = useTranslation()
  const { id = '' } = useParams()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState('')
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [copied, setCopied] = useState(false)
  const [tab, setTab] = useState<'chat' | 'dashboard' | 'timeline'>('chat')
  const [dashboard, setDashboard] = useState<{ data: DashboardData | null; updatedAt?: string }>({ data: null })
  const [timeline, setTimeline] = useState<{ items: TimelineItem[]; error: string | null; loaded: boolean }>({ items: [], error: null, loaded: false })

  const load = useCallback(async () => {
    try {
      const d = await adminFetch<Detail>(`/api/admin/session/${id}`)
      setDetail(d)
      setError('')
    } catch (e) { setError((e as Error).message) }
  }, [id])

  useEffect(() => {
    load()
    const iv = setInterval(load, 5000)
    return () => clearInterval(iv)
  }, [load])

  useEffect(() => {
    if (tab !== 'dashboard' || !detail) return
    const shareUrl = new URL(detail.share_url, location.origin)
    const token = shareUrl.searchParams.get('t') || ''
    const shareId = detail.session.id
    const fetchDash = () =>
      fetch(`/api/share/${shareId}/dashboard?t=${encodeURIComponent(token)}`)
        .then((r) => r.json())
        .then((r: { dashboard: DashboardData | null; updated_at?: string }) => setDashboard({ data: r.dashboard, updatedAt: r.updated_at }))
        .catch(() => {})
    fetchDash()
    const iv = setInterval(fetchDash, 3000)
    return () => clearInterval(iv)
  }, [tab, detail?.share_url, detail?.session.id])

  useEffect(() => {
    if (tab !== 'timeline') return
    const fetchTimeline = () =>
      adminFetch<{ items: TimelineItem[]; error: string | null }>(`/api/admin/session/${id}/timeline?limit=100`)
        .then((r) => setTimeline({ items: r.items, error: r.error, loaded: true }))
        .catch((e) => setTimeline((prev) => ({ ...prev, error: (e as Error).message, loaded: true })))
    fetchTimeline()
    const iv = setInterval(fetchTimeline, 5000)
    return () => clearInterval(iv)
  }, [tab, id])

  async function send() {
    const text = input.trim()
    if (!text || sending) return
    setSending(true)
    try {
      await adminFetch(`/api/admin/session/${id}/message`, {
        method: 'POST',
        body: JSON.stringify({ message: text }),
      })
      setInput('')
      setTimeout(load, 800)
    } catch (e) { setError((e as Error).message) } finally { setSending(false) }
  }

  async function resetToken() {
    if (!confirm(t('as.resetConfirm'))) return
    await adminFetch(`/api/admin/session/${id}/reset-token`, { method: 'POST', body: JSON.stringify({}) })
    load()
  }

  async function toggleArchive() {
    if (!detail) return
    await adminFetch(`/api/admin/session/${id}/archive`, {
      method: 'POST',
      body: JSON.stringify({ archived: !detail.session.archived }),
    })
    load()
  }

  async function setPermission(p: string) {
    await adminFetch(`/api/admin/session/${id}/permission`, { method: 'POST', body: JSON.stringify({ permission: p }) })
    load()
  }

  function copyShare() {
    if (!detail) return
    // Enable the share link lazily on copy (opt-in model — share_url is
    // null until the admin share-link endpoint flags the session).
    void adminFetch<{ enabled: boolean; url: string | null }>(`/api/admin/session/${id}/share-link`, { method: 'POST', body: JSON.stringify({ enabled: true }) })
      .then((r) => { navigator.clipboard.writeText(location.origin + (r.url ?? detail.share_url ?? `/admin/${id}`)); load() })
      .catch(() => navigator.clipboard.writeText(location.origin + `/admin/${id}`))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const attachmentUrl = useCallback((url: string) => {
    if (!detail?.media_token) return '#'
    return `/api/media/${detail.session.id}/attachment?url=${encodeURIComponent(url)}&mt=${encodeURIComponent(detail.media_token)}`
  }, [detail])

  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center">
        {error ? <p className="text-sm text-red-600">{error}</p> : <Loader2 className="animate-spin text-muted-foreground" />}
      </div>
    )
  }

  const s = detail.session
  return (
    <div className="flex h-full flex-col max-w-3xl mx-auto">
      <header className="border-b border-border bg-card/80 backdrop-blur px-4 py-3 sticky top-0 z-10">
        <div className="flex items-center gap-2.5">
          <Link to="/" className="text-muted-foreground hover:text-foreground"><ArrowLeft size={18} /></Link>
          <StatusDot status={s.status} />
          <div className="min-w-0 flex-1">
            <h1 className="text-sm font-semibold truncate">{s.title || s.devin_title}</h1>
            <p className="text-[11px] text-muted-foreground truncate">{s.devin_session_id} · {statusLabel(s.status)}</p>
          </div>
          <div className="flex rounded-lg bg-muted p-0.5">
            <button onClick={() => setTab('chat')} className={cn('rounded-md px-2.5 py-1.5 cursor-pointer', tab === 'chat' ? 'bg-card shadow-sm' : 'text-muted-foreground')} aria-label={t('as.chat')}>
              <MessageSquare size={15} />
            </button>
            <button onClick={() => setTab('dashboard')} className={cn('rounded-md px-2.5 py-1.5 cursor-pointer', tab === 'dashboard' ? 'bg-card shadow-sm' : 'text-muted-foreground')} aria-label={t('as.dashboard')}>
              <LayoutDashboard size={15} />
            </button>
            <button onClick={() => setTab('timeline')} className={cn('rounded-md px-2.5 py-1.5 cursor-pointer', tab === 'timeline' ? 'bg-card shadow-sm' : 'text-muted-foreground')} aria-label={t('as.mirror')}>
              <Activity size={15} />
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2 mt-2.5 flex-wrap">
          <Button variant="outline" size="sm" onClick={copyShare}>
            {copied ? <Check size={12} /> : <Copy size={12} />} {t('as.shareLink')}
          </Button>
          <Combo
            value={s.permission}
            onPick={(v) => setPermission(v)}
            options={[
              { v: 'detailed', l: t('as.detailed') },
              { v: 'full', l: t('as.full') },
              { v: 'chat', l: t('as.chatOnly') },
              { v: 'readonly', l: t('as.readonly') },
            ]}
          />
          <Button variant="outline" size="sm" onClick={resetToken}><RotateCcw size={12} /> {t('common.reset')}链接</Button>
          <Button variant="outline" size="sm" onClick={toggleArchive}>
            {s.archived ? <><ArchiveRestore size={12} /> {t('as.restore')}</> : <><Archive size={12} /> {t('menu.archive')}</>}
          </Button>
          <Link to={`/admin/${id}`} className="text-xs text-primary underline">{t('as.back')}</Link>
          {s.pull_request?.url && (
            <a href={s.pull_request.url} target="_blank" rel="noopener noreferrer" className="text-xs text-primary underline">PR</a>
          )}
        </div>
      </header>

      {error && <div className="bg-red-50 text-red-700 text-xs px-4 py-2">{error}</div>}

      <main className="flex-1 overflow-y-auto px-4 py-4">
        {tab === 'chat' && <ChatView messages={detail.messages} attachmentUrl={attachmentUrl} showRoleLabels />}
        {tab === 'dashboard' && (
          <div className="space-y-3">
            <Dashboard data={dashboard.data} updatedAt={dashboard.updatedAt} />
            <Card className="p-3 text-[11px] text-muted-foreground break-all">
              {t('as.dashPush')}{location.origin}{detail.dashboard_url}
            </Card>
          </div>
        )}
        {tab === 'timeline' && (
          !timeline.loaded
            ? <Loader2 className="animate-spin text-muted-foreground" />
            : <Timeline items={timeline.items} error={timeline.error} />
        )}
      </main>

      <footer className="border-t border-border bg-card px-3 py-2.5 sticky bottom-0">
        <div className="flex items-end gap-2">
          <Textarea
            rows={1}
            className="max-h-32 min-h-9 py-2"
            placeholder={t('as.adminPh')}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
              }
            }}
          />
          <Button size="icon" onClick={send} disabled={sending || !input.trim()} aria-label={t('common.send')}>
            {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          </Button>
        </div>
      </footer>
    </div>
  )
}
