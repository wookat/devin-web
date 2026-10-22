import { type MutableRefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Workflow as WorkflowIcon, BookOpen } from 'lucide-react'
import { adminFetch } from '@/lib/api'
import { attachmentUrl, type ViewerCaps } from '@/lib/viewer'
import AttachmentCard from '@/components/AttachmentCard'
import CollapsibleBody from '@/components/CollapsibleBody'
import { type TimelineItem, STANDALONE_GIT_TYPES, CalloutCard } from '@/components/Timeline'
import { SecretRequestCard } from '@/components/StructuredCards'
import { PrCreatedCard, StandaloneGitRow, mergeLivePr } from '@/components/PrCards'
import Markdown from '@/components/Markdown'
import WakePersona from '@/components/WakePersona'
import ThinkingPersona from '@/components/ThinkingPersona'
import UserAttachments from '@/components/UserAttachments'
import { extractRepos } from '@/lib/repos'
import { type QuoteAttachment } from '../../../shared/quotes'
import { cn } from '@/lib/utils'
import { type SessionDetail } from './pageBits'
import { type Group } from './composerMeta'
import { type PanelKey, serializeOfficialTab } from './panelTabs'
import { time, rowClock, clock } from './timelineUtil'
import { type ReducedStatus, stText } from './statusReduce'
import { AwaitingInstructionsGlyph } from './glyphs'
import { PermissionCard } from './Permission'
import { EventRow, WorkGroup } from './TimelineRows'
import { splitAttachments, isOwnUserMessage } from './attachments'
import { ParticipantHeader } from './ViewerPanels'
import { MessageToolbar } from './Sidechat'

type SelQuote = { x: number; y: number; text: string; eventId: string; author: 'user' | 'devin'; tsMs?: number; expanded?: boolean; kind?: 'message' | 'worklog'; endEventId?: string; placement?: 'above' | 'below'; hidden?: boolean }

/* Timeline row dispatch — one element per groupItems() group: cards for
 * permissions/secrets/workflows/PRs/git events, EventRow for stray rows,
 * the message bubble branch for 'item' groups, WorkGroup for 'work'. */
function TimelineGroup({ g, isLast, id, isVisitor, isSub, caps, detail, status, panel, mediaTok, permResolved, secretProvided, provideSecret, wf, onOpenWfRun, onOpenPr, onOpenPermission, envSuperseded, messageHeaders, translations, onTranslated, onFileRef, openFileTab, jumpToQuote, onSelQuote, quoteGuardUntil, onControlMsg, onSideChat, onStepChanges, onOpenProgress, onOpenSubagent, worklogJump, tailThoughtId, urlPrs, urlFiles }: {
  g: Group
  isLast: boolean
  id: string
  isVisitor: boolean
  isSub: boolean
  caps: ViewerCaps
  detail: SessionDetail | null
  status: string
  panel: PanelKey | string
  mediaTok: string
  permResolved: Map<string, 'approved' | 'denied'>
  secretProvided: Set<string>
  provideSecret: (requestId: string, value: string) => Promise<void>
  wf: { status: Map<string, string>; agents: Map<string, Map<string, string>> }
  onOpenWfRun: (runId: string) => void
  onOpenPr: (prUrl: string) => void
  onOpenPermission: (it: TimelineItem) => void
  envSuperseded: Map<string, string>
  messageHeaders: Map<string, boolean>
  translations: Record<string, string>
  onTranslated: (itemId: string, text: string) => void
  onFileRef: (path: string) => void
  openFileTab: (href: string, name: string, raw?: boolean) => void
  jumpToQuote: (q: QuoteAttachment) => Promise<void>
  onSelQuote: (q: SelQuote) => void
  quoteGuardUntil: MutableRefObject<number>
  onControlMsg: (msg: string) => void
  onSideChat: (it: TimelineItem) => void
  onStepChanges: (it: TimelineItem) => void
  onOpenProgress: (it: TimelineItem) => void
  onOpenSubagent: (aid: string) => void
  worklogJump: string | null
  tailThoughtId: string | undefined
  urlPrs: { pr_url?: string; number?: number }[]
  urlFiles: { href: string; name: string }[]
}) {
  const { t } = useTranslation()
  const nav = useNavigate()
  const setSelQuote = onSelQuote
  const setControlMsg = onControlMsg
  const setPermSide = onOpenPermission
  const openPr = onOpenPr
  return (
    g.type === 'item' && g.item.kind === 'permission' ? (
      <PermissionCard
        item={g.item}
        sessionId={id}
        resolved={permResolved.get(g.item.permission?.requestId || '')}
        onOpenSidebar={() => setPermSide(g.item)}
      />
    ) : g.type === 'item' && g.item.kind === 'secret_request' ? (
      <SecretRequestCard
        item={g.item}
        provided={secretProvided.has(g.item.secretRequest?.requestId || '')}
        onProvide={caps.canProvideSecret ? provideSecret : undefined}
      />
    ) : g.type === 'item' && g.item.kind === 'workflow' ? (
      (() => {
        const it = g.item
        const runId = it.workflow?.runId || ''
        const running = wf.status.get(runId) === 'running'
        const agentMap = wf.agents.get(runId)
        const done = agentMap ? [...agentMap.values()].filter((s) => s !== 'running' && s !== 'queued').length : 0
        return (
          <div key={it.id} data-eid={it.id} data-testid="transcript-workflow-run" className="relative my-2.5 flex w-full flex-col overflow-hidden rounded-xl border border-border bg-card">
            <div className="flex items-center gap-1.5 px-2.5 py-2">
              <WorkflowIcon size={14} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-[12px] leading-[16px] text-muted-foreground">
                {running ? (it.workflow?.resumed ? t('tl.wfResuming') : t('tl.wfRunning')) : t('tl.wfRan')}
              </span>
              <div className="my-[-2px] flex shrink-0 items-center gap-px">
                <a
                  href="https://docs.devin.ai/work-with-devin/dynamic-workflows"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={t('ag.wfDoc')}
                  className="inline-flex size-6 shrink-0 items-center justify-center rounded-[6px] bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <BookOpen size={16} />
                </a>
                <span className="shrink-0 select-none text-[12px] text-muted-foreground">{time(it.ts)}</span>
              </div>
            </div>
            <button
              onClick={() => onOpenWfRun(runId)}
              className="flex w-full min-w-0 cursor-pointer flex-col gap-1 border-t border-border px-2.5 py-2 text-left"
            >
              <span className="truncate text-[13px] font-medium leading-[18px]">{it.workflow?.name || t('tl.wfRun')}</span>
              {!!agentMap?.size && (
                <span className="truncate text-[12px] leading-[16px] text-muted-foreground">{done}/{agentMap.size} agents</span>
              )}
            </button>
          </div>
        )
      })()
    ) : g.type === 'item' && g.item.raw_type === 'pr_created' && g.item.pr ? (
      <div data-eid={g.item.id} className="my-2.5 w-full min-w-0">
        <PrCreatedCard
          pr={mergeLivePr(g.item.pr, detail?.session.pull_requests)}
          onAnalyze={!isVisitor && caps.canAnalyzePr && g.item.pr.prUrl ? () => openPr(g.item.pr!.prUrl!) : undefined}
        />
      </div>
    ) : g.type === 'item' && STANDALONE_GIT_TYPES.has(g.item.raw_type || '') ? (
      <StandaloneGitRow item={g.item} timestamp={rowClock(g.item.ts)} />
    ) : g.type === 'row' ? (
      <div className="wg-time-host relative pb-2.5">
        <EventRow item={g.item} sessionId={id} mt={mediaTok} live={isLast && status === 'working' && g.item.kind === 'shell' && !g.item.exitCode} tempOpen={g.item.id === tailThoughtId} selected={g.item.id === worklogJump && panel === 'worklog'} standalone onStepChanges={onStepChanges} onOpenProgress={onOpenProgress} onOpenSubagent={onOpenSubagent} />
        <span className="wg-gutter-time pointer-events-none absolute right-0 top-0 hidden h-[18px] select-none items-center whitespace-nowrap bg-background pl-3 text-[12px] leading-[16px] text-muted-foreground md:flex proportional-nums">{rowClock(g.item.ts)}</span>
      </div>
    ) : g.type === 'item' && (g.item.kind === 'env_suggestion' || g.item.kind === 'bot_flag') ? (
      <EventRow item={g.item} sessionId={id} mt={mediaTok} envSupersededBy={envSuperseded.get(g.item.id)} onOpenSubagent={onOpenSubagent} />
    ) : g.type === 'item' && g.item.callout ? (
      <CalloutCard item={g.item} timestamp={rowClock(g.item.ts)} />
    ) : g.type === 'item' && g.item.kind === 'status' ? (
      <div data-eid={g.item.id} className="relative my-2.5 flex items-start gap-2 text-[13px] leading-[18px] text-muted-foreground">
        <span className="min-w-0 flex-1 break-words">{g.item.title}</span>
        <span className="shrink-0 text-[12px] leading-[16px]">{rowClock(g.item.ts)}</span>
      </div>
    ) : g.type === 'item' ? (() => {
      const parsed = splitAttachments(g.item.body || '', g.item.quoteMeta, g.item.quotes)
      const { text, quotes } = parsed
      const attachments = g.item.attachments?.length
        ? g.item.attachments.map((a) => ({ url: a.url, name: a.name ?? a.url.split('/').pop() ?? 'file' }))
        : parsed.attachments
      const isUser = g.item.role === 'user'
      const own = isOwnUserMessage(g.item)
      const showHeader = messageHeaders.get(g.item.id) === true
      const hasText = !isUser || !!text.trim() || !!g.item.answers?.length || !!(translations[g.item.id] || g.item.translation)
      // Official `ua`: repo pills only on the initial message; they join the file
      // attachments in one group stacked under the bubble.
      const repos = g.item.raw_type === 'initial_user_message' ? extractRepos(g.item.body || '', detail?.session.repos) : []
      return (
      <div data-eid={g.item.id} data-message-event-id={g.item.id} data-message-author={isUser ? 'user' : 'devin'} data-message-ts={g.item.ts ? String(new Date(g.item.ts).getTime()) : undefined} data-quotable-surface className={cn('group group/message-wrapper relative my-2.5 flex flex-col gap-1', own ? 'items-end' : 'items-start')}>
        {!own && showHeader ? (
          <ParticipantHeader kind={isUser ? 'user' : 'devin'} name={isUser ? (g.item.title || 'User') : undefined} ts={g.item.ts} />
        ) : null}
        {hasText && <div className={cn(
          'text-[14px] leading-[20px]',
          isUser
            ? cn('w-fit max-w-full overflow-hidden rounded-[16px] bg-tint-tertiary px-3.5 py-2', own ? 'rounded-tr-[4px]' : 'rounded-tl-[4px] self-start')
            : 'w-full',
        )} title={!isUser ? clock(g.item.ts) : undefined}>
          {(() => {
            const inner = (
              <>
                {g.item.answers?.length && g.item.questions?.[0]?.question ? (
                  <div className="flex flex-col gap-1">
                    {g.item.questions.map((q, qi) => (
                      <div key={qi} className="flex flex-col gap-0.5">
                        <p className="text-[13px] leading-[18px] text-muted-foreground">Q: {q.question}</p>
                        <p>{g.item.answers?.[qi] || ''}</p>
                      </div>
                    ))}
                  </div>
                ) : (translations[g.item.id] || g.item.translation) ? (
                  <div className="space-y-2">
                    <p className="text-[12px] leading-[16px] text-muted-foreground">{t('am.original')}</p>
                    <Markdown text={text} rewriteUrl={(u) => attachmentUrl(id, u, mediaTok)} onFileRef={onFileRef} />
                    <p className="text-[12px] leading-[16px] text-muted-foreground">{t('am.translation')}</p>
                    <Markdown text={translations[g.item.id] || g.item.translation || ''} rewriteUrl={(u) => attachmentUrl(id, u, mediaTok)} onFileRef={onFileRef} />
                  </div>
                ) : (
                  <Markdown text={text} rewriteUrl={(u) => attachmentUrl(id, u, mediaTok)} onFileRef={onFileRef} />
                )}
                {!isUser && attachments.length > 0 && (
                  <div className={cn('flex flex-col gap-2', text.trim() ? 'mt-[18px]' : '')}>
                    {attachments.map((a) => (
                      <AttachmentCard key={a.url} name={a.name} href={attachmentUrl(id, a.url, mediaTok)} ts={g.item.ts} onOpenTab={openFileTab} />
                    ))}
                  </div>
                )}
              </>
            )
            return isUser ? <CollapsibleBody>{inner}</CollapsibleBody> : inner
          })()}
        </div>}
        {isUser && (
          <UserAttachments
            attachments={attachments.map((a) => ({ name: a.name, href: attachmentUrl(id, a.url, mediaTok) }))}
            repos={repos}
            quotes={quotes.map((q) => (q.screenshot ? { ...q, screenshot: { ...q.screenshot, url: attachmentUrl(id, q.screenshot.url, mediaTok) } } : q))}
            secrets={g.item.secretsSent?.names}
            onQuoteNavigate={jumpToQuote}
            own={own}
            hasText={hasText}
            ts={g.item.ts}
            onOpenTab={openFileTab}
          />
        )}
        <MessageToolbar
          text={g.item.body || ''}
          eid={g.item.id}
          ts={g.item.ts}
          tab={typeof panel === 'string' ? serializeOfficialTab(panel, urlPrs, urlFiles) || undefined : undefined}
          onStartNewSession={g.item.role === 'user' && !isVisitor ? () => {
            try { localStorage.setItem('dw-new-session-draft', g.item.body || '') } catch { /* quota */ }
            nav('/admin/new')
          } : undefined}
          onQuote={!isVisitor && caps.canSendMessage && !isSub ? () => {
            // Whole-message quote — official's second entry point:
            // hover toolbar ❝ opens the same pill pre-expanded at
            // the message row's top edge.
            const host = document.querySelector(`[data-eid="${CSS.escape(g.item.id)}"]`)
            const r = host?.getBoundingClientRect()
            const bodyText = (g.item.body || '').replace(/<quoted_artifact[\s\S]*?<\/quoted_artifact>/g, '').trim().slice(0, 4000)
            if (!bodyText || !r) return
            quoteGuardUntil.current = Date.now() + 800
            setSelQuote({ x: Math.min(Math.max(r.left, 8), window.innerWidth - 8 - 360), y: r.top - 6, placement: 'above', text: bodyText, eventId: g.item.id, author: g.item.role === 'user' ? 'user' : 'devin', tsMs: g.item.ts ? Date.parse(g.item.ts) : undefined, expanded: true })
          } : undefined}
          onFork={!isVisitor && detail?.session.canFork && !isSub ? () => {
            void (async () => {
              const r = await adminFetch<{ ok: boolean; id?: string; error?: string }>(`/api/admin/session/${id}/fork`, { method: 'POST', body: JSON.stringify({ anchor: g.item.id }) }).catch(() => null)
              if (r?.ok && r.id) nav(`/admin/${r.id}`)
              else setControlMsg(r?.error || t('menu.forkFailed'))
            })()
          } : undefined}
          onSideChat={isVisitor ? undefined : () => onSideChat(g.item)}
          sessionId={g.item.role === 'user' || isVisitor ? undefined : id}
          onTranslated={isVisitor ? undefined : (tr) => onTranslated(g.item.id, tr)}
        />
      </div>
      )
    })() : (
      <WorkGroup
        items={g.items}
        seconds={g.seconds}
        sessionId={id}
        mt={mediaTok}
        defaultOpen
        live={isLast && status === 'working'}
        tailThoughtId={tailThoughtId}
        selectedId={panel === 'worklog' ? worklogJump ?? undefined : undefined}
        onStepChanges={onStepChanges}
        onOpenProgress={onOpenProgress}
      />
    )
  )
}

/* Status tail — the row after the last group: action-required / queued /
 * working / sleep persona lines (official's per-status tail variants). */
function StatusTail({ statusState, actionRequired, woke, controlling, onResume, isVisitor, detail }: {
  statusState: ReducedStatus
  actionRequired: string | null
  woke: boolean
  controlling: boolean
  onResume: () => void
  isVisitor: boolean
  detail: SessionDetail | null
}) {
  const { t } = useTranslation()
  return (
    statusState.enum === 'blocked' && actionRequired ? (
      <div className="mb-2 mt-5 flex flex-col gap-2 text-muted-foreground">
        <div className="flex items-start gap-[6px]">
          <WakePersona tone="action" />
          <span className="min-h-[17px] text-[13px] leading-[18px]">{actionRequired}</span>
        </div>
      </div>
    ) : ['initializing', 'resume_requested', 'resume_requested_frontend', 'suspend_requested', 'suspend_requested_frontend', 'paused', 'stopped', 'queued', 'waiting'].includes(statusState.enum) ? (
      <div className="mb-2 mt-5 flex items-start gap-[6px] text-muted-foreground">
        {statusState.persona === 'thinking' ? <ThinkingPersona /> : statusState.persona === 'sleep' ? <WakePersona /> : <span className="mt-1 size-2 shrink-0 rounded-full bg-orange-500" />}
        <span className="min-h-[17px] text-[13px] leading-[18px]">{stText(t, statusState.tailText)}</span>
      </div>
    ) : statusState.enum === 'blocked' ? (
      <div className="my-4 flex items-center gap-2 text-[13px] leading-[18px] text-muted-foreground">
        <AwaitingInstructionsGlyph className="size-4 shrink-0 text-orange-500" />
        {stText(t, statusState.tailText)}
      </div>
    ) : ['working', 'resumed', 'restored'].includes(statusState.enum) ? (
      // Official working-status row (DOM sampled 2026-08-31): 17px animated Devin
      // persona + 13px current-action line from latest_status_contents.message.
      <div className="mb-2 mt-5 flex flex-col gap-2 text-muted-foreground">
        <div className="flex items-start gap-[6px]">
          <ThinkingPersona />
          <span className="min-h-[17px] text-[13px] leading-[18px]">
            {stText(t, statusState.tailText)}
          </span>
        </div>
      </div>
    ) : statusState.isSleeping && (!woke || controlling) && !isVisitor && statusState.wakeable ? (
      <button
        type="button"
        aria-label={t('tl.wakeDevin')}
        disabled={controlling}
        onClick={onResume}
        className="group mt-5 mb-2 flex cursor-pointer items-start gap-[6px] text-left"
      >
        <WakePersona />
        <span className="grid min-h-[17px] overflow-hidden text-[13px] leading-[18px]">
          <span className="col-start-1 row-start-1 duration-200 group-hover:-translate-y-full motion-safe:transition-transform">{t('tl.wentSleep')}</span>
          <span className="col-start-1 row-start-1 translate-y-full duration-200 group-hover:translate-y-0 motion-safe:transition-transform">{controlling ? t('menu.connecting') : stText(t, statusState.wakeText)}</span>
        </span>
      </button>
    ) : statusState.isSleeping && !isVisitor && !statusState.wakeable ? (
      <div className="mb-2 mt-5 flex items-start gap-[6px] text-muted-foreground">
        <WakePersona />
        <div className="flex flex-col">
          <span className="min-h-[17px] text-[13px] leading-[18px]">{stText(t, statusState.shortMessage)}</span>
          {statusState.enum === 'crashed' && detail?.session.auto_recover ? (
            <span className="text-[12px] leading-[16px] text-muted-foreground">
              {t('menu.autoResumed', { n: detail.session.auto_recover.attempts })}
            </span>
          ) : null}
        </div>
      </div>
    ) : null
  )
}

export { TimelineGroup, StatusTail, type SelQuote }
