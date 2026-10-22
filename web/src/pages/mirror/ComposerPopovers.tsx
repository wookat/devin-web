import { type Dispatch, type SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { Info } from 'lucide-react'
import { adminFetch } from '@/lib/api'
import { cn } from '@/lib/utils'
import { type SuggestItem, AT_CATEGORIES } from './composerMeta'
import { COACH_RECOMMENDATIONS, COACH_ACTIONS } from './timelineUtil'
import { type DraftQuote } from './ComposerFooter'

/** The composer overlays that float above the BeardBand card: the // and @
 *  suggestion listbox, the coach-finding pill (with its per-finding action),
 *  and the warning_and_modal confirm-send dialog. The first two portal to
 *  body anchored on cardEl; the dialog is an in-tree fixed overlay. */
function ComposerPopovers({ cardEl, suggestions, atCat, trigger, sugIdx, setSugIdx, applySuggestion, findings, setFindings, mode, input, setInput, setSelectedVersion, scanState, setScanState, confirmSendOpen, setConfirmSendOpen, confirmedDraftRef, autoSendRef, setAutoSendTick, nav, send }: {
  cardEl: HTMLDivElement | null
  suggestions: SuggestItem[]
  atCat: string | null
  trigger: { char: '/' | '@'; query: string } | null
  sugIdx: number
  setSugIdx: Dispatch<SetStateAction<number>>
  applySuggestion: (s: SuggestItem) => void
  findings: { finding_type: string; explanation: string }[]
  setFindings: Dispatch<SetStateAction<{ finding_type: string; explanation: string }[]>>
  mode: string
  input: string
  setInput: Dispatch<SetStateAction<string>>
  setSelectedVersion: (v: string | null) => void
  scanState: 'idle' | 'busy' | 'sent' | 'error'
  setScanState: Dispatch<SetStateAction<'idle' | 'busy' | 'sent' | 'error'>>
  confirmSendOpen: boolean
  setConfirmSendOpen: Dispatch<SetStateAction<boolean>>
  confirmedDraftRef: { current: string | null }
  autoSendRef: { current: string | null }
  setAutoSendTick: Dispatch<SetStateAction<number>>
  nav: (path: string) => void
  send: (preset?: string, extraQuotes?: DraftQuote[]) => void
}) {
  const { t } = useTranslation()
  return (
    <>
            {(suggestions.length > 0 || (atCat && trigger?.char === '@')) && cardEl && createPortal(
              <div role="listbox" style={{ bottom: window.innerHeight - cardEl.getBoundingClientRect().top + 4, left: cardEl.getBoundingClientRect().left, maxHeight: Math.min(400, cardEl.getBoundingClientRect().top - 12) }} className="fixed z-50 w-[300px] overflow-y-auto rounded-[10px] border border-border bg-card p-1 shadow-lg">
                {atCat && trigger?.char === '@' && (
                  <div className="flex items-baseline justify-between gap-2 px-2 py-1">
                    <span className="text-[12px] font-medium text-muted-foreground">
                      {t(AT_CATEGORIES.find((c) => c.cat === atCat)?.title || 'common.none')}
                    </span>
                    <span className="truncate text-[11px] text-muted-foreground/70">
                      {t(AT_CATEGORIES.find((c) => c.cat === atCat)?.sub || 'common.none')}
                    </span>
                  </div>
                )}
                {suggestions.map((s, i) => (
                  <div
                    key={s.key}
                    role="option"
                    aria-selected={i === sugIdx}
                    onMouseDown={(e) => { e.preventDefault(); applySuggestion(s) }}
                    onMouseEnter={() => setSugIdx(i)}
                    className={cn('flex cursor-pointer select-none flex-col gap-0.5 rounded-[6px] px-2 py-1.5 text-[13px]', i === sugIdx && 'bg-accent')}
                  >
                    <span className="truncate">{s.title}</span>
                    {s.sub && <span className="truncate text-[12px] text-muted-foreground">{s.sub}</span>}
                  </div>
                ))}
              </div>,
              document.body,
            )}
            {findings.length > 0 && suggestions.length === 0 && !(atCat && trigger?.char === '@') && cardEl && createPortal(
              <div className="pointer-events-none fixed z-50 flex flex-col items-center gap-2 px-2" style={{ bottom: window.innerHeight - cardEl.getBoundingClientRect().top + 8, left: cardEl.getBoundingClientRect().left, width: cardEl.getBoundingClientRect().width }}>
                <div className="pointer-events-auto flex max-w-full items-center gap-1.5 rounded-full bg-foreground px-3 py-1.5 text-background shadow-lg">
                  <span className="flex min-w-0 items-center gap-1">
                    <span className="truncate text-[12px] leading-4">
                      {findings[0].finding_type === 'parallelizable_prompt'
                        ? t('composer.findSplit')
                        : findings[0].finding_type === 'overkill_devin_mode'
                          ? t('composer.findMode', { mode })
                          : findings[0].finding_type === 'no_plan_before_impl'
                            ? t('composer.findPlan')
                            : findings[0].finding_type === 'non_work_usage'
                              ? t('composer.findIrrelevant')
                              : findings[0].finding_type === 'unrelated_followup_new_session'
                                ? t('composer.findUnrelated')
                                : findings[0].finding_type === 'use_code_scan'
                                  ? t('menu.codeScanFit')
                                  : findings[0].explanation}
                    </span>
                    <button type="button" aria-label={t('composer.findDetails')} title={findings[0].explanation} className="flex shrink-0 cursor-default items-center opacity-70">
                      <Info size={14} />
                    </button>
                  </span>
                  {findings[0].finding_type === 'overkill_devin_mode' ? (
                    <button
                      type="button"
                      onClick={() => { setSelectedVersion('devin-2-5'); setFindings([]) }}
                      className="shrink-0 cursor-pointer text-[12px] leading-4 text-blue-400 hover:underline"
                    >
                      {t('composer.coachMode')}
                    </button>
                  ) : findings[0].finding_type === 'parallelizable_prompt' ? (
                    /* Official click (sampled via route capture): appends this sentence to the draft — no network write. */
                    <button
                      type="button"
                      onClick={() => {
                        setInput((v) => `${v.trimEnd()}\n${t('composer.appendSplit')}`)
                        setFindings([])
                      }}
                      className="shrink-0 cursor-pointer text-[12px] leading-4 text-blue-400 hover:underline"
                    >
                      {t('composer.coachParallel')}
                    </button>
                  ) : findings[0].finding_type === 'no_plan_before_impl' ? (
                    <button
                      type="button"
                      onClick={() => {
                        setInput((v) => `${v.trimEnd()}\n${t('composer.appendPlan')}`)
                        setFindings([])
                      }}
                      className="shrink-0 cursor-pointer text-[12px] leading-4 text-blue-400 hover:underline"
                    >
                      {t('composer.coachPlan')}
                    </button>
                  ) : findings[0].finding_type === 'non_work_usage' ? (
                    <button
                      type="button"
                      onClick={() => { setInput(''); setFindings([]) }}
                      className="shrink-0 cursor-pointer text-[12px] leading-4 text-blue-400 hover:underline"
                    >
                      {t('composer.coachClear')}
                    </button>
                  ) : findings[0].finding_type === 'unrelated_followup_new_session' ? (
                    /* Official (route-captured): plain <a> navigation to the org new-session page carrying
                       the draft — no session-creation write. Mirror navigates to the console new-session
                       dialog with the draft prefilled. */
                    <Link
                      to="/admin/new"
                      onClick={() => { try { localStorage.setItem('dw-new-session-draft', input) } catch { /* quota */ } setFindings([]) }}
                      className="shrink-0 text-[12px] leading-4 text-blue-400 hover:underline"
                    >
                      {t('composer.coachNewSession')}
                    </Link>
                  ) : findings[0].finding_type === 'use_code_scan' ? (
                    /* Official (route-captured): POST /api/sessions with user_message
                       "Start a code scan to: <draft>" and additional_args.code_scan_builder, then
                       navigates to the new session. Mirror routes the same prompt through the
                       console child-session derivation flow instead of creating a top-level session. */
                    <button
                      type="button"
                      disabled={scanState === 'busy' || scanState === 'sent'}
                      onClick={() => {
                        setScanState('busy')
                        adminFetch<{ ok: boolean; note: string }>('/api/admin/sessions/new', {
                          method: 'POST',
                          body: JSON.stringify({ task: `Start a code scan to: ${input.trim()}` }),
                        })
                          .then(() => { setScanState('sent'); setInput(''); window.setTimeout(() => { setFindings([]); setScanState('idle') }, 1500) })
                          .catch(() => setScanState('error'))
                      }}
                      className={cn('shrink-0 text-[12px] leading-4 text-blue-400', scanState === 'busy' || scanState === 'sent' ? 'cursor-default opacity-60' : 'cursor-pointer hover:underline')}
                    >
                      {scanState === 'busy' ? t('menu.starting') : scanState === 'sent' ? t('menu.scanSent') : scanState === 'error' ? t('menu.retryScan') : t('menu.startScan')}
                    </button>
                  ) : null}
                </div>
              </div>,
              document.body,
            )}
            {confirmSendOpen && (
              /* Official (bundle-sampled): warning_and_modal precheck mode opens a confirm
                 dialog before send — title/labels from the official locale, description =
                 first finding's recommendation. Back cancels; Send confirms once per draft. */
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setConfirmSendOpen(false)}>
                <div role="dialog" className="w-full max-w-sm rounded-xl border border-border bg-background p-4 shadow-lg" onClick={(e) => e.stopPropagation()}>
                  <p className="text-[14px] font-medium leading-[20px]">{t('am.confirmSend')}</p>
                  <p className="mt-2 text-[13px] leading-[18px] text-muted-foreground">
                    {findings[0] ? (COACH_RECOMMENDATIONS[findings[0].finding_type] ? t(COACH_RECOMMENDATIONS[findings[0].finding_type]) : findings[0].explanation || '') : ''}
                  </p>
                  <div className="mt-4 flex items-center justify-end gap-2">
                    <button
                      className="cursor-pointer rounded-md px-3 py-1.5 text-[13px] text-muted-foreground hover:bg-muted"
                      onClick={() => setConfirmSendOpen(false)}
                    >
                      {t('pal.backTxt')}
                    </button>
                    {findings[0] && COACH_ACTIONS[findings[0].finding_type] && (
                      /* Official tertiaryAction: the finding's action button. applyAndSend
                         applies the action then sends; cancelAndApply closes and applies. */
                      <button
                        className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-[13px] hover:bg-muted"
                        onClick={() => {
                          const ft = findings[0].finding_type
                          setConfirmSendOpen(false)
                          if (ft === 'no_plan_before_impl' || ft === 'parallelizable_prompt') {
                            const sentence = ft === 'no_plan_before_impl'
                              ? 'Before implementing anything, investigate and propose a plan for me to review first.'
                              : 'These tasks are independent: split them into separate child sessions and run them in parallel.'
                            const next = `${input.trimEnd()}\n${sentence}`
                            confirmedDraftRef.current = next.trim()
                            autoSendRef.current = next
                            setFindings([])
                            setInput(next)
                          } else if (ft === 'overkill_devin_mode') {
                            setSelectedVersion('devin-2-5')
                            confirmedDraftRef.current = input.trim()
                            autoSendRef.current = input
                            setFindings([])
                            setAutoSendTick((t) => t + 1)
                          } else if (ft === 'non_work_usage') {
                            setInput('')
                            setFindings([])
                          } else if (ft === 'unrelated_followup_new_session') {
                            try { localStorage.setItem('dw-new-session-draft', input) } catch { /* quota */ }
                            setFindings([])
                            nav('/admin/new')
                          } else if (ft === 'use_code_scan') {
                            setScanState('busy')
                            adminFetch<{ ok: boolean; note: string }>('/api/admin/sessions/new', {
                              method: 'POST',
                              body: JSON.stringify({ task: `Start a code scan to: ${input.trim()}` }),
                            })
                              .then(() => { setScanState('sent'); setInput(''); window.setTimeout(() => { setFindings([]); setScanState('idle') }, 1500) })
                              .catch(() => setScanState('error'))
                          }
                        }}
                      >
                        {t(COACH_ACTIONS[findings[0].finding_type])}
                      </button>
                    )}
                    <button
                      className="cursor-pointer rounded-md bg-primary px-3 py-1.5 text-[13px] text-primary-foreground hover:opacity-90"
                      onClick={() => {
                        confirmedDraftRef.current = input.trim()
                        setConfirmSendOpen(false)
                        void send()
                      }}
                    >
                      {t('composer.send')}
                    </button>
                  </div>
                </div>
              </div>
            )}
    </>
  )
}

export { ComposerPopovers };
