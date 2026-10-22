import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, ChevronRight, ChevronDown, SquareTerminal, Bot, CircleDashed, ArrowUpRight, Clock, Flag, Square } from 'lucide-react'
import { adminFetch } from '@/lib/api'
import { viewer, screenshotUrl } from '@/lib/viewer'
import { visibleInterval } from '@/lib/poll'
import { type TimelineItem, heading, fileRows, readLabel, fmtWorkedDur, RowDecor, SubagentActions, ScriptedChildren, SearchResultFiles, BrowserPreviewChip, CalloutCard } from '@/components/Timeline'
import { TodoSteps, NestedBody } from '@/components/StructuredCards'
import { PrRowText } from '@/components/PrCards'
import Markdown from '@/components/Markdown'
import { LightboxImage } from '@/components/Lightbox'
import EnvSuggestionCard from '@/components/EnvSuggestionCard'
import { cn, subProfileLabel } from '@/lib/utils'
import { editStats, time, rowClock, preview, FullTerminal, AnsiText } from './timelineUtil'
import { LiveOutputTail } from './ResourcePanels'

const EventRow = memo(function EventRow({ item, sessionId, mt, onStepChanges, onOpenProgress, onOpenSubagent, live, envSupersededBy, tempOpen, selected, standalone }: { item: TimelineItem; sessionId: string; mt: string; onStepChanges?: (item: TimelineItem) => void; onOpenProgress?: (item: TimelineItem) => void; onOpenSubagent?: (agentId: string) => void; live?: boolean; envSupersededBy?: string; tempOpen?: boolean; selected?: boolean; standalone?: boolean }) {
  const { t } = useTranslation()
  const shots = item.screenshotKeys || []
  const [liveDismissed, setLiveDismissed] = useState(false)
  const hasBody = (!!item.body || !!item.output) && item.kind !== 'todo' && !(item.kind === 'shell_done' && item.terminal)
    && !(item.startupCommand && !item.output)
  const subRun = item.subagent && ((item.subagent.actions?.length ?? 0) > 0 || item.subagent.finished) ? item.subagent : undefined
  const nested = !!item.nested?.length
  const searchFiles = item.resultFiles?.length ? item.resultFiles : undefined
  const hasDetail = hasBody || !!item.terminal || !!shots.length || !!subRun || nested || !!searchFiles
    || (item.kind === 'todo' && !!item.todos?.length)
    || (item.kind === 'edit' && !!item.fileUpdates?.length)
    || !!item.mcp
  // Official disclosure: an explicit user toggle wins; otherwise `temporaryExpanded`
  // (the trailing thought) is a live fallback that collapses once the row is no longer last.
  // Thought rows carry the thinking text — show it inline like the cloud worklog;
  // a bare "Thoughts" title with no body reads as missing content.
  const [userOpen, setUserOpen] = useState<boolean | undefined>(undefined)
  const open = userOpen ?? (!!tempOpen || item.kind === 'thought')
  const setOpen = setUserOpen
  const [fixMenu, setFixMenu] = useState(false)
  const [fixState, setFixState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [afState, setAfState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle')
  const stats = editStats(item)
  const shellProgress = item.kind === 'shell' && !!onOpenProgress
  const mcpProgress = !!item.mcp && !!onOpenProgress
  const rowInteractive = hasDetail || shellProgress || mcpProgress || item.kind === 'read'
  const rowClick = () => (item.kind === 'read' || item.kind === 'edit' || (item.kind === 'message' && item.role === 'user')) && onOpenProgress
    ? onOpenProgress(item)
    : item.kind === 'read'
      ? onStepChanges?.(item)
    : mcpProgress || shellProgress
      ? onOpenProgress?.(item)
      : hasDetail && setOpen(!open)
  const rowKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    rowClick()
  }
  const Row = rowInteractive ? 'button' : 'div'
  const rowCls = cn('flex w-full items-start gap-2 text-left text-[13px] leading-[18px]', selected ? 'text-foreground' : 'text-muted-foreground')
  if (item.raw_type === 'browser_preview') return <BrowserPreviewChip item={item} />
  if (item.callout) return <CalloutCard item={item} timestamp={time(item.ts)} />
  if (item.kind === 'computer' && item.actions?.length) {
    // Official `computer_use` / `browser_current_state`: one worklog row per action;
    // clicking a row opens the Computer state, the first row carries the screenshot toggle.
    const openState = () => { if (onOpenProgress && shots.length) onOpenProgress(item); else if (shots.length) setOpen(!open) }
    return (
      <div className="group wg-time-host relative flex gap-2 pb-2" data-eid={item.id} data-quote-anchor={item.id}>
        <div className="min-w-0 flex-1">
          {item.actions.map((a, i) => (
            <button key={i} type="button" title={time(item.ts)} onClick={openState} data-testid="transcript-worklog-row" className={cn(rowCls, shots.length ? 'cursor-pointer hover:text-foreground' : 'cursor-default')}>
              <span className="min-w-0 flex-1 break-words">{a}</span>
              {i === 0 && shots.length > 0 && (
                <span role="button" tabIndex={0} aria-label={t('tl.showShots')} aria-expanded={open} onClick={(e) => { e.stopPropagation(); setOpen(!open) }} onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setOpen(!open) } }} className="mt-px flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center">
                  <ChevronRight size={16} className={cn('shrink-0 text-muted-foreground/60 transition-transform duration-200 ease-out group-hover:text-foreground', open && 'rotate-90')} />
                </span>
              )}
            </button>
          ))}
          {open && mt && shots.map((k) => (
            <LightboxImage key={k} src={screenshotUrl(sessionId, k, mt)} alt={t('tl.shotAlt')} className="mt-1.5 max-h-64 rounded-md border border-border" />
          ))}
        </div>
        {!standalone && (
          <span className="wg-gutter-time pointer-events-none absolute right-0 top-0 hidden h-[18px] select-none items-center whitespace-nowrap pl-3 text-[12px] leading-[16px] text-muted-foreground md:flex proportional-nums">{rowClock(item.ts)}</span>
        )}
      </div>
    )
  }
  if (item.kind === 'edit' && item.fileUpdates?.length) {
    // Official `multi_edit_result`: one row per (file, action) with summed +/− counts
    // ("Created x.ts +40", "Edited y.md +4 −4", "Deleted z", "Renamed w").
    const rows = fileRows(item.fileUpdates)
    return (
      <div className="group wg-time-host relative flex gap-2 pb-2" data-eid={item.id} data-quote-anchor={item.id}>
        <div className="min-w-0 flex-1">
          {rows.map((r) => (
            <div
              key={`${r.filePath}\u0000${r.actionType}`}
              role="button"
              tabIndex={0}
              title={r.filePath}
              onClick={() => onOpenProgress ? onOpenProgress(item) : onStepChanges?.(item)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return
                e.preventDefault()
                if (onOpenProgress) onOpenProgress(item)
                else onStepChanges?.(item)
              }}
              data-testid="transcript-worklog-row"
              className={cn(rowCls, 'cursor-pointer hover:text-foreground')}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span className="min-w-0 truncate">{r.label}</span>
                {(r.added > 0 || r.removed > 0) && (
                  <span className="inline-flex shrink-0 select-none gap-1 text-nowrap">
                    {r.added > 0 && <span className="text-text-green">+{r.added}</span>}
                    {r.removed > 0 && <span className="text-text-red">−{r.removed}</span>}
                  </span>
                )}
              </span>
              {onOpenProgress && (
                <span role="button" tabIndex={0} title={t('tl.viewProgress')} aria-label={t('tl.viewProgress')} onClick={(e) => { e.stopPropagation(); onOpenProgress(item) }} onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onOpenProgress(item) } }} className="shrink-0 cursor-pointer rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100 focus-visible:opacity-100">
                  <CircleDashed size={11} className="text-muted-foreground" />
                </span>
              )}
            </div>
          ))}
        </div>
        {!standalone && (
          <span className="wg-gutter-time pointer-events-none absolute right-0 top-0 hidden h-[18px] select-none items-center whitespace-nowrap pl-3 text-[12px] leading-[16px] text-muted-foreground md:flex proportional-nums">{rowClock(item.ts)}</span>
        )}
      </div>
    )
  }
  if (item.kind === 'env_suggestion') {
    const es = item.envSuggestion
    const approve = async () => {
      if (afState === 'sending' || afState === 'done') return
      setAfState('sending')
      try {
        const r = await adminFetch<{ ok: boolean; error: string | null }>(`/api/admin/session/${sessionId}/env-suggestion-accept`, {
          method: 'POST',
          body: JSON.stringify({ event_id: item.id, sink: es?.sink, repo: es?.repo, title: item.title, summary: es?.summary, contents_key: es?.contentsKey, old_contents_key: es?.oldContentsKey }),
        })
        setAfState(r.ok ? 'done' : 'error')
      } catch {
        setAfState('error')
      }
    }
    return <EnvSuggestionCard item={item} supersededBy={envSupersededBy} onApprove={viewer().role === 'admin' ? approve : undefined} approveState={afState} />
  }
  if (item.kind === 'bot_flag') {
    // Official card (sampled): orange flag + title button, secondary line, split
    // button "Enable auto-fix" + More actions dropdown whose single item is
    // "Fix for this PR only" (POST sessions/{id}/retrigger-pr-comment, protocol
    // from official bundle source). Enable auto-fix proxies
    // PUT pr-review/settings/auto-fix-findings (bundle source). Title toggles the ignored comment body inline (official opens a Progress step).
    const bf = item.botFlag
    const canFix = !!bf?.prUrl && fixState !== 'sent'
    const enableAutoFix = async () => {
      if (afState === 'sending' || afState === 'done') return
      setAfState('sending')
      try {
        const r = await adminFetch<{ ok: boolean; error: string | null; auto_fix_findings: boolean | null }>('/api/admin/review/auto-fix', {
          method: 'PUT',
          body: JSON.stringify({ auto_fix_findings: true }),
        })
        setAfState(r.ok && r.auto_fix_findings === true ? 'done' : 'error')
      } catch {
        setAfState('error')
      }
    }
    const retrigger = async () => {
      if (!bf?.prUrl || fixState === 'sending' || fixState === 'sent') return
      setFixMenu(false)
      setFixState('sending')
      try {
        const r = await adminFetch<{ ok: boolean; error: string | null }>(`/api/admin/session/${sessionId}/pr-retrigger`, {
          method: 'POST',
          body: JSON.stringify({
            pr_url: bf.prUrl,
            source_event_id: item.id,
            comments: [{ comment_body: bf.commentBody || '', comment_url: bf.commentUrl, bot_username: bf.botUsername }],
          }),
        })
        setFixState(r.ok ? 'sent' : 'error')
      } catch {
        setFixState('error')
      }
    }
    const splitBtn = 'inline-flex h-7 items-center justify-center border border-border bg-card px-2.5 text-[13px] font-medium disabled:opacity-50'
    return (
      <div className="flex min-w-0 flex-col gap-1.5 pb-2" data-eid={item.id} data-quote-anchor={item.id}>
        <div className="flex items-center gap-1.5">
          <Flag size={15} className="shrink-0 text-orange-500" />
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="cursor-pointer text-left text-[13px] leading-[18px] text-foreground">{item.title}</button>
        </div>
        <p className="text-[13px] leading-[18px] text-muted-foreground">
          {fixState === 'sent'
            ? t('tl.fixingReview')
            : item.title === 'Devin Review findings ignored'
              ? t('tl.reviewFound')
              : t('tl.botCommentIgnored', { bot: bf?.botUsername || t('tl.aBot') })}
        </p>
        {fixState === 'error' && <p className="text-[12px] text-red-500">{t('tl.retriggerFail')}</p>}
        {afState === 'error' && <p className="text-[12px] text-red-500">{t('tl.settingFail')}</p>}
        {fixState !== 'sent' && viewer().role === 'admin' && <div role="presentation" className="mt-0.5 flex w-fit items-center">
          <button type="button" disabled={afState === 'sending' || afState === 'done'} onClick={enableAutoFix} className={cn(splitBtn, 'rounded-l-[6px]', afState !== 'sending' && afState !== 'done' && 'cursor-pointer hover:bg-accent')}>{afState === 'sending' ? t('tl.enabling') : afState === 'done' ? t('tl.autoFixOn') : t('tl.enableAutoFix')}</button>
          <div className="relative">
            <button type="button" aria-label={t('tl.moreActions')} aria-expanded={fixMenu} onClick={() => setFixMenu((v) => !v)} className={cn(splitBtn, 'cursor-pointer rounded-r-[6px] border-l-0 px-1.5 hover:bg-accent')}><ChevronDown size={16} /></button>
            {fixMenu && (
              <div role="menu" className="absolute left-0 top-8 z-20 min-w-[180px] overflow-hidden rounded-[10px] border border-border bg-popover py-1 shadow-lg">
                <button role="menuitem" disabled={!canFix || fixState === 'sending'} onClick={retrigger} title={canFix ? undefined : t('tl.noLinkedPr')} className={cn('flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px]', canFix && fixState !== 'sending' ? 'cursor-pointer hover:bg-accent' : 'opacity-50')}>{fixState === 'sending' ? t('tl.fixing') : t('tl.fixThisPr')}</button>
              </div>
            )}
          </div>
        </div>}
        {open && bf?.commentBody && (
          <div className="mt-1 rounded-md border border-border bg-muted/40 px-3 py-2 text-[13px]">
            <Markdown text={bf.commentBody} />
            {bf.commentUrl && (
              <a href={bf.commentUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:underline">
                {t('tl.viewGithub')} <ArrowUpRight size={12} />
              </a>
            )}
          </div>
        )}
      </div>
    )
  }
  // Local ACP subagent card: a bordered activity card whose header opens the
  // child session page — its events are filtered out of the parent's feed.
  const sub = item.subagent
  if (sub?.agentId) {
    return <SubagentCard item={item} sub={sub} sessionId={sessionId} onOpenSubagent={onOpenSubagent} />
  }
  return (
    <div className="group wg-time-host relative flex gap-2 pb-2" data-eid={item.id} data-quote-anchor={item.id}>
      {standalone && (
        <span className="mt-px flex h-4 w-4 shrink-0 items-center justify-center">
          {hasDetail && item.kind !== 'todo' && !shellProgress && (
            <ChevronRight size={16} className={cn('shrink-0 text-muted-foreground transition-transform duration-200 ease-out group-hover:text-foreground', open && 'rotate-90')} />
          )}
          {(shellProgress || !hasDetail) && (item.kind === 'shell' || item.kind === 'shell_done') && (
            <SquareTerminal size={16} className="shrink-0 text-muted-foreground" />
          )}
          {!hasDetail && item.raw_type === 'wait_command_start' && (
            <Clock size={16} className="shrink-0 text-muted-foreground" />
          )}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <Row
          {...(rowInteractive ? { onClick: rowClick, role: 'button' as const, tabIndex: 0, onKeyDown: rowKeyDown, type: 'button' as const } : {})}
          aria-expanded={rowInteractive ? (shellProgress ? false : hasDetail ? open : undefined) : undefined}
          title={item.kind === 'shell' ? (item.body || heading(item)) : time(item.ts)}
          className={cn(rowCls, 'items-center', rowInteractive ? 'cursor-pointer hover:text-foreground' : 'cursor-default')}
        >
          {item.kind === 'shell' ? (
            // Official row: the derived command label (quoted strings / heredocs
            // collapsed, startup commands titled by purpose), no icon, clamped to
            // 3 lines; the running command gets a shine sweep.
            <span className={cn('min-w-0 flex-1 whitespace-pre-wrap [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:3] overflow-hidden', live && !open && 'wg-shine')}>
              {heading(item)}
              {live && <span className="sr-only">{t('tl.inProgress')}</span>}
            </span>
          ) : item.kind === 'read' ? (
            <span className="min-w-0 select-none break-words">
              Read{' '}
              {(item.fileUpdates || []).map((f, i) => (
                <span key={i}>
                  {i > 0 && ', '}
                  <span title={f.file_path}>{readLabel(f)}</span>
                </span>
              ))}
            </span>
          ) : item.kind === 'git' && item.pr ? (
            <span className="min-w-0 flex-1 break-words"><PrRowText item={item} /></span>
          ) : (
            <span className="min-w-0 break-words">{heading(item)}<RowDecor item={item} /></span>
          )}
          {item.kind !== 'shell' && preview(item) && <span className="truncate font-mono text-[12px] text-muted-foreground">{preview(item)}</span>}
          {stats && (
            <span
              role="button"
              tabIndex={0}
              title={t('tl.viewStepChanges')}
              aria-label={t('tl.viewStepChangesStats', { added: stats.added, removed: stats.removed })}
              onClick={(e) => { e.stopPropagation(); if (onOpenProgress) onOpenProgress(item); else onStepChanges?.(item) }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); if (onOpenProgress) onOpenProgress(item); else onStepChanges?.(item) } }}
              className="flex shrink-0 cursor-pointer items-center gap-1 rounded px-1 text-[13px] hover:bg-accent"
            >
              <span className="text-text-green">+{stats.added}</span>
              <span className="text-text-red">−{stats.removed}</span>
            </span>
          )}
          {onOpenProgress && !shellProgress && (item.kind === 'edit' || (item.kind === 'computer' && !!item.screenshotKeys?.length)) && (
            <span
              role="button"
              tabIndex={0}
              title={t('tl.viewProgress')}
              aria-label={t('tl.viewProgress')}
              onClick={(e) => { e.stopPropagation(); onOpenProgress(item) }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onOpenProgress(item) } }}
              className="shrink-0 cursor-pointer rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100 focus-visible:opacity-100"
            >
              <CircleDashed size={11} className="text-muted-foreground" />
            </span>
          )}
          {hasDetail && item.kind !== 'todo' && !shellProgress && !standalone && (
            <span className="mt-px flex h-4 w-4 shrink-0 items-center justify-center">
              <ChevronRight size={16} className={cn('shrink-0 text-muted-foreground/60 transition-transform duration-200 ease-out group-hover:text-foreground', open && 'rotate-90')} />
            </span>
          )}
        </Row>
        {live && !open && !liveDismissed && item.kind === 'shell' && item.terminal && (
          <div
            role="presentation"
            onPointerUp={(e) => {
              if (e.button !== 0) return
              const sel = window.getSelection()
              if (sel && !sel.isCollapsed) return
              setLiveDismissed(true)
            }}
            className="mt-1 cursor-pointer overflow-hidden rounded-[10px] border border-border bg-card"
          >
            <LiveOutputTail text={item.terminal} />
          </div>
        )}
        {open && hasBody && (
          item.kind === 'thought' ? (
            <div className="mt-1"><Markdown text={item.body || ''} variant="thoughts" /></div>
          ) : item.kind === 'shell' || item.kind === 'shell_done' ? (
            <div className="mt-1 overflow-hidden rounded-[10px] border border-border bg-card">
              {!item.startupCommand && (
                <div className="max-h-[300px] overflow-y-auto whitespace-pre-wrap break-all border-b border-border px-2.5 py-2 font-mono text-[12px] text-muted-foreground">{item.body}</div>
              )}
              {item.output && (
                <pre className="m-0 max-h-[300px] overflow-y-auto whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-[12px] text-muted-foreground"><AnsiText text={item.output} /></pre>
              )}
            </div>
          ) : (
            <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted px-2.5 py-1.5 font-sans text-[11px] leading-relaxed">{item.body}</pre>
          )
        )}
        {open && subRun && <SubagentActions run={subRun} time={time} />}
        {open && nested && <ScriptedChildren item={item} time={time} />}
        {open && searchFiles && (
          <NestedBody onCollapse={() => setOpen(false)}>
            <SearchResultFiles files={searchFiles} />
          </NestedBody>
        )}
        {open && item.kind === 'todo' && item.todos && (
          <NestedBody onCollapse={() => setOpen(false)}>
            <TodoSteps todos={item.todos} />
          </NestedBody>
        )}
        {open && item.kind === 'edit' && item.fileUpdates && (
          <ul className="mt-1 space-y-0.5 rounded-md bg-muted px-2.5 py-1.5 font-mono text-[11px]">
            {item.fileUpdates.map((f, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className="truncate">{f.file_path.split('/').slice(-2).join('/')}</span>
                <span className="text-text-green">+{f.lines_added ?? 0}</span>
                <span className="text-text-red">−{f.lines_removed ?? 0}</span>
              </li>
            ))}
          </ul>
        )}
        {open && item.terminal && <FullTerminal item={item} />}
        {open && mt && shots.map((k) => (
          <LightboxImage
            key={k}
            src={screenshotUrl(sessionId, k, mt)}
            alt={t('tl.shotAlt')}
            className="mt-1.5 max-h-64 rounded-md border border-border"
          />
        ))}
        {item.image && (
          <LightboxImage
            src={`/api/admin/session/${sessionId}/file-raw?path=${encodeURIComponent(item.image.path)}`}
            alt={item.image.path}
            className="mt-1.5 max-h-64 rounded-md border border-border"
          />
        )}
        {!standalone && (
          <span className="wg-gutter-time pointer-events-none absolute right-0 top-0 hidden h-[18px] select-none items-center whitespace-nowrap pl-3 text-[12px] leading-[16px] text-muted-foreground md:flex proportional-nums">{rowClock(item.ts)}</span>
        )}
      </div>
    </div>
  )
})

type SubInfo = NonNullable<TimelineItem['subagent']>

/** Feed label for one row of a subagent's own timeline — message rows get a
 * text snippet (bare "Devin"/"User" headings carry no signal), tool rows
 * reuse the same wording as the main worklog. */
function subFeedLabel(it: TimelineItem): string {
  if (it.kind === 'message') return (it.body || '').split('\n')[0].slice(0, 140)
  return heading(it) || it.title || ''
}

/**
 * The subagent card's activity feed: `sub.actions` (the official mirror's
 * aggregated projection) when present; otherwise the sub's own timeline is
 * fetched from the admin endpoint — local acp runs never fill `actions`.
 * Polls only while the run is live; a finished run fetches once.
 */
function useSubagentFeed(root: string, agentId: string, enabled: boolean, running: boolean): { label: string; ts: string }[] {
  const [items, setItems] = useState<TimelineItem[] | null>(null)
  useEffect(() => {
    if (!enabled) { setItems(null); return }
    let alive = true
    const load = () => adminFetch<{ items: TimelineItem[] }>(`/api/admin/session/${root}/subagent/${encodeURIComponent(agentId)}/timeline`)
      .then((r) => { if (alive) setItems(r.items ?? []) })
      .catch(() => {})
    load()
    if (!running) return () => { alive = false }
    const stop = visibleInterval(load, 5000)
    return () => { alive = false; stop() }
  }, [enabled, root, agentId, running])
  return useMemo(() =>
    (items ?? [])
      .filter((it) => it.kind !== 'other' && it.kind !== 'status')
      .slice(-40)
      .map((it) => ({ label: subFeedLabel(it), ts: it.ts }))
      .filter((r) => !!r.label),
  [items])
}

/**
 * Local subagent activity card (official style): a bordered card — header row
 * (bot icon, title, profile/model + status chips, a stop control while the
 * run is live) that opens the child session page, over a scrollable recent-
 * activity feed pinned to the tail while the agent is working.
 */
function SubagentCard({ item, sub, sessionId, onOpenSubagent }: { item: TimelineItem; sub: SubInfo; sessionId: string; onOpenSubagent?: (agentId: string) => void }) {
  const { t } = useTranslation()
  const agentId = sub.agentId ?? ''
  // `spawn:<toolCallId>` placeholders were never claimed by a subagent_started
  // update — there's no live handle to poll or cancel.
  const liveHandle = !!agentId && !agentId.startsWith('spawn:')
  const isAdmin = viewer().role === 'admin'
  // `sub:` pages keep ops on the ROOT session — its id hosts the subagent routes.
  const root = sessionId.startsWith('sub:') ? sessionId.split(':')[1] : sessionId
  const running = !sub.finished
  const fetched = useSubagentFeed(root, agentId, isAdmin && liveHandle && !(sub.actions?.length), running)
  const actions = sub.actions?.length ? sub.actions : fetched
  const [ctl, setCtl] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const feedRef = useRef<HTMLOListElement>(null)
  const pinned = useRef(true)
  useEffect(() => {
    const el = feedRef.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [actions.length])
  const onFeedScroll = () => {
    const el = feedRef.current
    if (el) pinned.current = el.scrollHeight - el.clientHeight - el.scrollTop <= 24
  }
  const stop = async () => {
    if (ctl === 'sending' || ctl === 'sent') return
    setCtl('sending')
    try {
      const r = await adminFetch<{ ok: boolean; error?: string }>(`/api/admin/session/${root}/subagent/${encodeURIComponent(agentId)}/control`, {
        method: 'POST',
        body: JSON.stringify({ action: 'cancel' }),
      })
      setCtl(r.ok ? 'sent' : 'error')
    } catch {
      setCtl('error')
    }
  }
  const profile = [subProfileLabel(sub.profile ?? ''), sub.model].filter(Boolean).join(' · ')
  const openSub = () => onOpenSubagent?.(agentId)
  return (
    <div className="group relative flex gap-2 pb-2" data-eid={item.id} data-quote-anchor={item.id}>
      <div className="min-w-0 flex-1 overflow-hidden rounded-lg border border-border bg-card">
        <div
          role="button"
          tabIndex={0}
          title={t('tl.openSub', { defaultValue: 'Open subagent session' })}
          onClick={openSub}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return
            e.preventDefault()
            openSub()
          }}
          className="flex w-full min-w-0 cursor-pointer items-center gap-2 px-3 py-2 text-left hover:bg-tint-secondary"
        >
          <Bot size={15} className="shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-[13px] leading-[18px]">{sub.title || item.title}</span>
          {profile && <span className="shrink-0 truncate rounded-[4px] bg-muted px-1.5 text-[11px] font-medium leading-[18px] text-muted-foreground">{profile}</span>}
          {sub.isBackground && <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{t('lib.prof.bg')}</span>}
          {sub.finished
            ? sub.failed
              ? <span className="shrink-0 rounded-[4px] bg-red-500/10 px-1.5 text-[11px] font-medium leading-[18px] text-red-600 dark:text-red-400">{t('tl.failed')}</span>
              : <span className="shrink-0 rounded-[4px] bg-emerald-500/10 px-1.5 text-[11px] font-medium leading-[18px] text-emerald-600 dark:text-emerald-400">{t('tl.done')}</span>
            : <span className="inline-flex shrink-0 items-center gap-1 rounded-[4px] bg-muted px-1.5 text-[11px] leading-[18px] text-muted-foreground"><Loader2 size={11} className="animate-spin" />{t('tl.inProgress')}</span>}
          {running && isAdmin && liveHandle && ctl !== 'sent' && (
            <span
              role="button"
              tabIndex={0}
              title={ctl === 'error' ? t('tl.subStopFail', { defaultValue: 'Couldn’t stop the subagent — click to retry' }) : t('tl.stopSub', { defaultValue: 'Stop subagent' })}
              aria-label={ctl === 'error' ? t('tl.subStopFail', { defaultValue: 'Couldn’t stop the subagent — click to retry' }) : t('tl.stopSub', { defaultValue: 'Stop subagent' })}
              onClick={(e) => { e.stopPropagation(); void stop() }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); void stop() } }}
              className={cn('flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground', ctl === 'error' && 'text-red-500 hover:text-red-500')}
            >
              {ctl === 'sending' ? <Loader2 size={12} className="animate-spin" /> : <Square size={11} className="fill-current" />}
            </span>
          )}
          <ChevronRight size={14} className="shrink-0 text-muted-foreground" />
        </div>
        {(actions.length > 0 || running || sub.truncated) && (
          <ol ref={feedRef} onScroll={onFeedScroll} className="max-h-[180px] overflow-y-auto border-t border-border px-3 py-1.5 text-[12px] leading-[18px] text-muted-foreground">
            {actions.map((a, i) => (
              <li key={i} className="flex items-start gap-2 py-0.5">
                <span className="min-w-0 flex-1 break-words">{a.label}</span>
                {a.ts && <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground/70">{time(a.ts)}</span>}
              </li>
            ))}
            {!actions.length && <li className="py-0.5 text-[11px] text-muted-foreground/70">{running ? t('tl.subWorking', { defaultValue: 'Subagent is working…' }) : t('tl.subNoActions', { defaultValue: 'No recorded activity' })}</li>}
            {sub.truncated && <li className="py-0.5 text-[11px] text-muted-foreground/70">{t('ti.earlier')}</li>}
          </ol>
        )}
        {sub.finished && !!sub.summary && (
          <p className="border-t border-border px-3 py-1.5 text-[12px] leading-[18px] text-muted-foreground">{sub.summary}</p>
        )}
      </div>
    </div>
  )
}

/**
 * Expanded work-group body: 400px capped scroll area with official-style
 * scroll-position-driven fade masks (up to 40px) at the top/bottom edges.
 */
function WgScrollBody({ children, live, itemCount }: { children: ReactNode; live?: boolean; itemCount: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  const initialized = useRef(false)
  const sync = useCallback(() => {
    const el = ref.current
    if (!el) return
    if (initialized.current) nearBottom.current = el.scrollHeight - el.clientHeight - el.scrollTop <= 24
    else initialized.current = true
    const top = Math.min(40, el.scrollTop)
    const bottom = Math.min(40, el.scrollHeight - el.clientHeight - el.scrollTop)
    el.style.setProperty('--wg-fade-top', `${Math.max(0, top)}px`)
    el.style.setProperty('--wg-fade-bottom', `${Math.max(0, bottom)}px`)
  }, [])
  useEffect(() => {
    if (!live || !nearBottom.current) return
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [itemCount, live])
  useEffect(() => { sync() }, [sync])
  useEffect(() => {
    if (!live) return
    const el = ref.current
    const inner = innerRef.current
    if (!el || !inner) return
    const frame = requestAnimationFrame(() => {
      if (!nearBottom.current) return
      el.scrollTop = el.scrollHeight
      sync()
    })
    return () => cancelAnimationFrame(frame)
  }, [live, sync])
  useEffect(() => {
    if (!live) return
    const el = ref.current
    const inner = innerRef.current
    if (!el || !inner) return
    const observer = new ResizeObserver(() => {
      if (!nearBottom.current) return
      el.scrollTop = el.scrollHeight
      sync()
    })
    observer.observe(inner)
    return () => observer.disconnect()
  }, [live, sync])
  return (
    <div
      ref={ref}
      onScroll={sync}
      className="max-h-[400px] min-w-0 flex-1 overflow-y-scroll pl-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [mask-image:linear-gradient(to_bottom,transparent,black_var(--wg-fade-top,0px),black_calc(100%-var(--wg-fade-bottom,0px)),transparent)]"
    >
      <div ref={innerRef}>{children}</div>
    </div>
  )
}

const WorkGroup = memo(function WorkGroup({ items, seconds, sessionId, mt, defaultOpen, live, onStepChanges, onOpenProgress, tailThoughtId, selectedId }: { items: TimelineItem[]; seconds: number; sessionId: string; mt: string; defaultOpen: boolean; live?: boolean; onStepChanges?: (item: TimelineItem) => void; onOpenProgress?: (item: TimelineItem) => void; tailThoughtId?: string; selectedId?: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(defaultOpen)
  let added = 0
  let removed = 0
  for (const it of items) {
    const s = editStats(it)
    if (s) { added += s.added; removed += s.removed }
  }
  const rows = items
  const lastShellId = live ? [...rows].reverse().find((r) => r.kind === 'shell' && !r.exitCode)?.id : undefined
  const firstTs = items[0]?.ts
  const gutterTime = firstTs
    ? new Date(firstTs).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).replace(/ [AP]M$/, '')
    : ''
  return (
    <div className="group/wg relative pb-5">
      <div className="wg-time-host relative">
      <div
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen(!open)
          }
        }}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        className="relative flex cursor-pointer select-none items-start gap-2 text-[13px] leading-[18px] text-muted-foreground hover:text-foreground"
      >
        <span className="mt-px flex h-4 w-4 shrink-0 items-center justify-center">
          <ChevronRight size={16} className={cn('shrink-0 transition-transform duration-200 ease-out', open && 'rotate-90')} />
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2 whitespace-nowrap">
          <span className="min-w-0 truncate">
            {`${live ? 'Working' : 'Worked'} for `}
            <span className="normal-nums">{fmtWorkedDur(seconds * 1000)}</span>
          </span>
          {(added > 0 || removed > 0) && (
            <button
              type="button"
              title={t('tl.viewStepChanges')}
              aria-label={t('tl.viewStepChangesStats', { added, removed })}
              onClick={(e) => {
                e.stopPropagation()
                const it = [...items].reverse().find((x) => editStats(x))
                if (it) onStepChanges?.(it)
              }}
              className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded px-1 hover:bg-muted"
            >
              <span className="text-text-green">+{added}</span><span className="text-text-red">−{removed}</span>
            </button>
          )}
          {gutterTime && (
            <span className="wg-gutter-time pointer-events-none ml-auto hidden h-[18px] shrink-0 select-none items-center whitespace-nowrap pl-3 text-[12px] leading-[16px] text-muted-foreground md:flex proportional-nums">
              {gutterTime}
            </span>
          )}
        </span>
      </div>
      </div>
      {open && (
        <div className="flex pt-2">
          <div
            role="presentation"
            aria-hidden
            onClick={() => setOpen(false)}
            className="group/rail relative z-10 flex w-4 shrink-0 cursor-pointer justify-center"
          >
            <div className="w-px bg-border group-hover/rail:bg-muted-foreground" />
          </div>
          <WgScrollBody live={live} itemCount={rows.length}>
            {rows.map((it) => <EventRow key={it.id} item={it} sessionId={sessionId} mt={mt} live={it.id === lastShellId} tempOpen={it.id === tailThoughtId} selected={it.id === selectedId} onStepChanges={onStepChanges} onOpenProgress={onOpenProgress} />)}
          </WgScrollBody>
        </div>
      )}
    </div>
  )
})

/**
 * Command approval card. Official wording: "Allow this action?", Approve /
 * Approve and always allow / Deny, resolved "{title} — approved/denied",
 * "This request is no longer open"; POST /api/permission-response with
 * request_id, approved, bypass_all_future.
 */

export { EventRow, WgScrollBody, WorkGroup };
