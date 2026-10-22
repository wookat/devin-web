import { useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, X } from 'lucide-react'
import { FileIcon } from '@/lib/fileIcon'
import { attachmentUrl, type ViewerCaps } from '@/lib/viewer'
import { type TimelineItem } from '@/components/Timeline'
import { type QuoteAttachment } from '../../../shared/quotes'
import ComposerEditor, { type ComposerEditorHandle } from '@/components/ComposerEditor'
import BeardBand from '@/components/BeardBand'
import { LightboxImage } from '@/components/Lightbox'
import QuoteChip from '@/components/QuoteChip'
import { IMAGE_RE } from '@/components/UserAttachments'
import { cn } from '@/lib/utils'
import { type SessionDetail, type LocalCfg, type LocalCfgOption } from './pageBits'
import { type ComposerMetaT, type SuggestItem, QueuePlaceholder } from './composerMeta'
import { stText, type ReducedStatus } from './statusReduce'
import { QuotePill } from './QuotePill'
import { type DraftTarget } from './LocalPicker'
import { ComposerChin } from './ComposerChin'
import { ComposerBands } from './ComposerBands'
import { ComposerPopovers } from './ComposerPopovers'
import { ComposerToolbar } from './ComposerToolbar'

type QuoteSel = { text: string; eventId: string; author: 'user' | 'devin'; tsMs?: number; kind?: 'message' | 'worklog'; endEventId?: string }
type DraftQuote = QuoteAttachment & { author: 'user' | 'devin'; endEventId?: string }
type SelQuote = { x: number; y: number; text: string; eventId: string; author: 'user' | 'devin'; tsMs?: number; expanded?: boolean; kind?: 'message' | 'worklog'; endEventId?: string; placement?: 'above' | 'below'; hidden?: boolean }
type LocalCfgGroup = NonNullable<LocalCfg['options']>[number]

  const isStagedImage = (file: { name: string; url: string }) => {
    if (IMAGE_RE.test(file.name)) return true
    try {
      const basename = new URL(file.url, window.location.origin).pathname.split('/').filter(Boolean).pop() || ''
      return IMAGE_RE.test(basename)
    } catch {
      return false
    }
  }

/** The composer footer: scroll-to-bottom jump button, BeardBand card holding
 *  the chin banner stack (send error / interrupted turn / dead subagent /
 *  control message / persona / env-suggestion / draft run-target row), the
 *  queue + pending-question band, suggestion + coach-findings popovers, the
 *  editor itself, and the toolbar (attach menu, mode/model pills, context
 *  meter, voice, stop, send + send-options). Owns all menu/popup state that
 *  only the footer uses; the session-level send/queue/config machinery stays
 *  in AdminMirror and arrives via props. */
function ComposerFooter({
  effShowPanel, showJump, onScrollBottom,
  isDraft, isVisitor, id, caps,
  sendErr, send, interrupted, resumeInterrupted, dismissInterrupted, subDead, respawnSub,
  controlMsg, persona, personaBusy, cyclePersonaMode, askPersonaNow,
  envBannerGone, items, dismissEnvBanner,
  draftTarget, setDraftTarget, draftSshCwd, setDraftSshCwd, draftCwd, setDraftCwd, recentCwds,
  composerMeta, setComposerMeta, draftAgent, setDraftAgent,
  queued, setQueued, queueOpReq, queueReorder, queueEditStart, queueOp, queueSend, queueEditSubmit, editingQ,
  pending, answerQuestion, setDismissedQ, sending,
  suggestions, atCat, setAtCat, trigger, sugIdx, setSugIdx, applySuggestion, openMention,
  findings, setFindings, scanState, setScanState, confirmSendOpen, setConfirmSendOpen,
  confirmedDraftRef, autoSendRef, setAutoSendTick, setSelectedVersion,
  modeOpen, setModeOpen, sModeOpen, setSModeOpen,
  input, setInput, mode,
  draftQuotes, setDraftQuotes, staged, removeStaged, mediaTok,
  editorRef, statusState, upload, uploading, sendWith, workSend,
  status, control, controlling,
  localModeGroup, localModeOpt, localModeCurrent, modelPillLabel, cfgFetched, pillVersion,
  localCfg, effortGroup, speedGroup, extraGroups, chooseLocalOption, chooseLocalOptions,
  detail, sessionAgent,
  selQuote, setSelQuote, stageQuoteDraft, quoteDraftFrom,
  nav,
}: {
  effShowPanel: boolean
  showJump: boolean
  onScrollBottom?: () => void
  isDraft: boolean
  isVisitor: boolean
  id: string
  caps: ViewerCaps
  sendErr: string | null
  send: (preset?: string, extraQuotes?: DraftQuote[]) => void
  interrupted: { text: string; ts: number; kind?: 'continue' | 'resend'; attachments?: { url: string; name?: string; size?: number; mime?: string }[] } | null
  resumeInterrupted: () => void
  dismissInterrupted: () => void
  subDead: boolean
  respawnSub: () => void
  controlMsg: string | null
  persona: { mode: string; escalated: boolean } | null
  personaBusy: boolean
  cyclePersonaMode: () => void
  askPersonaNow: () => void
  envBannerGone: boolean
  items: TimelineItem[]
  dismissEnvBanner: (eid: string) => void
  draftTarget: DraftTarget
  setDraftTarget: (v: DraftTarget) => void
  draftSshCwd: string
  setDraftSshCwd: Dispatch<SetStateAction<string>>
  draftCwd: string
  setDraftCwd: Dispatch<SetStateAction<string>>
  recentCwds: string[]
  composerMeta: ComposerMetaT | null
  setComposerMeta: Dispatch<SetStateAction<ComposerMetaT | null>>
  draftAgent: string
  setDraftAgent: Dispatch<SetStateAction<string>>
  queued: { id: string; text: string }[]
  setQueued: Dispatch<SetStateAction<{ id: string; text: string }[]>>
  queueOpReq: (payload: { op: string; id?: string; ids?: string[]; held?: boolean; message?: string }) => Promise<boolean>
  queueReorder: (fromId: string, toId: string) => void
  queueEditStart: (qid: string, text: string) => void
  queueOp: (op: 'remove' | 'send_now', qid: string) => void
  queueSend: (text: string) => void
  queueEditSubmit: (qid: string, text: string) => void
  editingQ: string | null
  pending: TimelineItem | null
  answerQuestion: (answers: string[][]) => void
  setDismissedQ: (v: string) => void
  sending: boolean
  suggestions: SuggestItem[]
  atCat: string | null
  setAtCat: Dispatch<SetStateAction<string | null>>
  trigger: { char: '/' | '@'; query: string } | null
  sugIdx: number
  setSugIdx: Dispatch<SetStateAction<number>>
  applySuggestion: (s: SuggestItem) => void
  openMention: (cat: string) => void
  findings: { finding_type: string; explanation: string }[]
  setFindings: Dispatch<SetStateAction<{ finding_type: string; explanation: string }[]>>
  scanState: 'idle' | 'busy' | 'sent' | 'error'
  setScanState: Dispatch<SetStateAction<'idle' | 'busy' | 'sent' | 'error'>>
  confirmSendOpen: boolean
  setConfirmSendOpen: Dispatch<SetStateAction<boolean>>
  confirmedDraftRef: { current: string | null }
  autoSendRef: { current: string | null }
  setAutoSendTick: Dispatch<SetStateAction<number>>
  setSelectedVersion: (v: string | null) => void
  modeOpen: boolean
  setModeOpen: Dispatch<SetStateAction<boolean>>
  sModeOpen: boolean
  setSModeOpen: Dispatch<SetStateAction<boolean>>
  input: string
  setInput: Dispatch<SetStateAction<string>>
  mode: string
  draftQuotes: DraftQuote[]
  setDraftQuotes: Dispatch<SetStateAction<DraftQuote[]>>
  staged: { url: string; name: string; size: number; preview?: string }[]
  removeStaged: (url: string) => void
  mediaTok: string
  editorRef: RefObject<ComposerEditorHandle>
  statusState: ReducedStatus
  upload: (file: File) => void
  uploading: boolean
  sendWith: 'enter' | 'ctrlenter'
  workSend: 'queue' | 'interrupt'
  status: string
  control: (action: 'pause' | 'resume') => void
  controlling: boolean
  localModeGroup: LocalCfgGroup | undefined
  localModeOpt: LocalCfgOption | undefined
  localModeCurrent: string | null | undefined
  modelPillLabel: string | null
  cfgFetched: boolean
  pillVersion: string
  localCfg: LocalCfg | null
  effortGroup: LocalCfgGroup | undefined
  speedGroup: LocalCfgGroup | undefined
  extraGroups: LocalCfgGroup[]
  chooseLocalOption: (configId: string, value: string) => void
  chooseLocalOptions: (pairs: { configId: string; value: string }[]) => void
  detail: SessionDetail | null
  sessionAgent: string
  selQuote: SelQuote | null
  setSelQuote: Dispatch<SetStateAction<SelQuote | null>>
  stageQuoteDraft: (q: QuoteSel, caption: string) => void
  quoteDraftFrom: (q: QuoteSel, caption: string) => DraftQuote
  nav: (path: string) => void
}) {
  const { t } = useTranslation()
  // Card element for portaling popups that must paint above the card — the
  // card is `overflow-hidden` AND lives under the BeardBand `relative z-30`
  // stacking context, so any in-tree popup is both clipped and out-z'd.
  const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null)

  return (
        <footer className={cn('relative max-md:z-20', effShowPanel && 'max-md:hidden')}>
          {showJump && (
            <button
              aria-label={t('am.scrollBottom')}
              onClick={onScrollBottom}
              className="absolute -top-11 left-1/2 z-30 flex h-7 w-9 -translate-x-1/2 cursor-pointer items-center justify-center rounded-full bg-[rgba(31,31,31,0.94)] text-white/90 shadow-[0_1px_3px_0_rgba(0,0,0,0.25),0_1px_2px_0_rgba(0,0,0,0.06)] transition-colors hover:bg-[rgba(51,51,51,0.94)]"
            >
              <ChevronDown size={20} />
            </button>
          )}
          <BeardBand
            cardRef={setCardEl}
            wrapClassName={isDraft ? 'max-w-[692px]' : undefined}
            bareCard={isDraft}
            chin={isDraft || interrupted || subDead || sendErr || controlMsg || (persona && !isVisitor && !isDraft && (persona.mode !== 'off' || persona.escalated)) || (() => {
              if (isVisitor || envBannerGone) return false
              const sug = items.find((it) => it.kind === 'env_suggestion')
              if (!sug || sug.envSuggestion?.dismissed) return false
              try { return localStorage.getItem(`env-banner-dismissed:${sug.id}`) !== '1' } catch { return true }
            })() ? (
              <ComposerChin
                sendErr={sendErr} send={send} interrupted={interrupted} resumeInterrupted={resumeInterrupted} dismissInterrupted={dismissInterrupted} subDead={subDead} respawnSub={respawnSub} controlMsg={controlMsg} persona={persona} personaBusy={personaBusy} cyclePersonaMode={cyclePersonaMode} askPersonaNow={askPersonaNow} isVisitor={isVisitor} isDraft={isDraft} envBannerGone={envBannerGone} items={items} dismissEnvBanner={dismissEnvBanner} id={id} draftTarget={draftTarget} setDraftTarget={setDraftTarget} draftSshCwd={draftSshCwd} setDraftSshCwd={setDraftSshCwd} draftCwd={draftCwd} setDraftCwd={setDraftCwd} recentCwds={recentCwds} composerMeta={composerMeta} setComposerMeta={setComposerMeta} draftAgent={draftAgent} setDraftAgent={setDraftAgent}
              />
            ) : undefined}
            band={queued.length > 0 || (pending && pending.questions?.length && caps.canAnswerQuestion) ? (
              <ComposerBands
                queued={queued} setQueued={setQueued} queueOpReq={queueOpReq} queueReorder={queueReorder} queueEditStart={queueEditStart} queueOp={queueOp} editingQ={editingQ} pending={pending} caps={caps} answerQuestion={answerQuestion} setDismissedQ={setDismissedQ} sending={sending}
              />
            ) : undefined}
          >
            <ComposerPopovers
              cardEl={cardEl} suggestions={suggestions} atCat={atCat} trigger={trigger} sugIdx={sugIdx} setSugIdx={setSugIdx} applySuggestion={applySuggestion} findings={findings} setFindings={setFindings} mode={mode} input={input} setInput={setInput} setSelectedVersion={setSelectedVersion} scanState={scanState} setScanState={setScanState} confirmSendOpen={confirmSendOpen} setConfirmSendOpen={setConfirmSendOpen} confirmedDraftRef={confirmedDraftRef} autoSendRef={autoSendRef} setAutoSendTick={setAutoSendTick} nav={nav} send={send}
            />
            {draftQuotes.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-1 pt-1">
                {draftQuotes.map((q, i) => (
                  <div key={i} className="group/draft-quote relative">
                    <QuoteChip quote={q} />
                    <button
                      aria-label={t('quote.remove')}
                      onClick={() => setDraftQuotes((d) => d.filter((_, j) => j !== i))}
                      className="absolute right-[-5px] top-[-5px] z-10 flex size-[18px] items-center justify-center rounded-full bg-foreground text-background opacity-0 focus-visible:opacity-100 group-hover/draft-quote:opacity-100 [@media(pointer:coarse)]:opacity-100"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {staged.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-1 pt-1">
                {staged.map((f) => (
                  isStagedImage(f) ? (
                    <div key={f.url} className="group/attachment relative size-9 shrink-0">
                      <LightboxImage
                        src={f.preview || attachmentUrl(id, f.url, mediaTok)}
                        alt={f.name}
                        className="size-9 rounded-[6px] object-cover"
                      />
                      <button
                        aria-label={t('composer.removeAtt')}
                        onClick={() => removeStaged(f.url)}
                        className="absolute right-[-5px] top-[-5px] flex size-[18px] items-center justify-center rounded-full bg-foreground text-background opacity-0 focus-visible:opacity-100 group-hover/attachment:opacity-100 [@media(pointer:coarse)]:opacity-100"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ) : (
                    <div key={f.url} className="flex items-center gap-2 rounded-lg border border-border bg-background px-2 py-1.5">
                      <FileIcon path={f.name} size={16} className="shrink-0" />
                      <div className="min-w-0">
                        <div className="max-w-[180px] truncate text-[12px] leading-[16px]">{f.name}</div>
                        <div className="text-[11px] leading-[14px] text-muted-foreground">{f.size < 1024 ? `${f.size} B` : `${(f.size / 1024).toFixed(1)} KB`}</div>
                      </div>
                      <button aria-label={t('composer.removeAtt')} onClick={() => removeStaged(f.url)} className="cursor-pointer text-muted-foreground hover:text-foreground">
                        <X size={13} />
                      </button>
                    </div>
                  )
                ))}
              </div>
            )}
            {/* Draft is two layers only: the gray wax + this one inner surface
                (the outer card renders bare via BeardBand bareCard). */}
            <div className={cn(isDraft && 'rounded-[14px] border border-border bg-background p-1.5')}>
            {caps.canSendMessage ? (<>
            <ComposerEditor
              ref={editorRef}
              className={cn('bg-transparent', isDraft && 'min-h-[44px]')}
              disabled={statusState.inputDisabled || sending}
              placeholder={pending ? t('composer.respondPending') : isDraft ? t('draft.message') : stText(t, statusState.placeholder)}
              placeholderNode={!pending && statusState.enum === 'working' && !isVisitor ? <QueuePlaceholder /> : undefined}
              value={input}
              onChange={setInput}
              onFiles={(files) => { for (const f of files) void upload(f) }}
              onKeyDown={(e) => {
                if (suggestions.length > 0 && !e.nativeEvent.isComposing) {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setSugIdx((i) => (i + 1) % suggestions.length); return }
                  if (e.key === 'ArrowUp') { e.preventDefault(); setSugIdx((i) => (i - 1 + suggestions.length) % suggestions.length); return }
                  if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applySuggestion(suggestions[sugIdx]); return }
                  if (e.key === 'Escape') { e.preventDefault(); setAtCat(null); setInput((v) => v.replace(/[/!@$][\w\u4e00-\u9fff-]*$/, '')); return }
                }
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && editingQ && input.trim()) {
                  e.preventDefault()
                  const text = input.trim()
                  setInput('')
                  void queueEditSubmit(editingQ, text)
                  return
                }
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing && statusState.enum === 'working' && input.trim()) {
                  e.preventDefault()
                  const text = input.trim()
                  setInput('')
                  // workSend 'interrupt': Ctrl+Enter sends NOW (cancels the live
                  // turn, settle→flush fires it); 'queue' parks it (default).
                  if (workSend === 'interrupt') void queueOpReq({ op: 'send_now', message: text })
                  else void queueSend(text)
                  return
                }
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  const mod = e.ctrlKey || e.metaKey
                  // sendWith 'ctrlenter': Enter inserts a newline, Ctrl+Enter sends.
                  if (sendWith === 'ctrlenter' ? mod : !mod) {
                    e.preventDefault()
                    // workSend 'interrupt' reroutes the normal send to send_now
                    // while a turn is live (plain /message would auto-queue).
                    if (statusState.enum === 'working' && workSend === 'interrupt' && input.trim()) {
                      const text = input.trim()
                      setInput('')
                      void queueOpReq({ op: 'send_now', message: text })
                    } else void send()
                  }
                }
              }}
            />
            <ComposerToolbar
              isVisitor={isVisitor} caps={caps} uploading={uploading} upload={upload} isDraft={isDraft} openMention={openMention}
              localModeGroup={localModeGroup} localModeOpt={localModeOpt} localModeCurrent={localModeCurrent}
              sModeOpen={sModeOpen} setSModeOpen={setSModeOpen} modeOpen={modeOpen} setModeOpen={setModeOpen}
              modelPillLabel={modelPillLabel} cfgFetched={cfgFetched} pillVersion={pillVersion} localCfg={localCfg}
              effortGroup={effortGroup} speedGroup={speedGroup} extraGroups={extraGroups}
              chooseLocalOption={chooseLocalOption} chooseLocalOptions={chooseLocalOptions}
              detail={detail} sessionAgent={sessionAgent} composerMeta={composerMeta}
              sending={sending} statusState={statusState} status={status} control={control} controlling={controlling}
              input={input} setInput={setInput} send={send} queueOpReq={queueOpReq} queueSend={queueSend}
            />
            </>) : (
              <p className="flex min-h-7 items-center px-1 text-[13px] leading-[16px] text-muted-foreground">{t('menu.readonlyBanner')}</p>
            )}
            </div>
            {/* Floating quote form over a text selection inside a message —
                official SelectionQuoteAffordance mini-form: [✏ Add caption]
                [⏎ Add to chat]; typing while open starts a caption, Enter
                commits. mousedown+preventDefault keeps the selection alive. */}
            {selQuote && caps.canSendMessage && (
              <QuotePill
                x={selQuote.x}
                y={selQuote.y}
                placement={selQuote.placement}
                hidden={selQuote.hidden}
                startExpanded={selQuote.expanded}
                quoteText={selQuote.text}
                onCommit={(caption) => {
                  stageQuoteDraft(selQuote, caption)
                  setSelQuote(null)
                }}
                onSend={caps.canSendMessage ? (caption) => {
                  // Official "Send immediately" — commit + dispatch in one go.
                  const q = quoteDraftFrom(selQuote, caption)
                  const merged = draftQuotes.some((x) => x.eventId === q.eventId && x.text === q.text) ? draftQuotes : [...draftQuotes, q]
                  setDraftQuotes(merged)
                  setSelQuote(null)
                  window.getSelection()?.removeAllRanges()
                  void send(undefined, merged)
                } : undefined}
                onClose={() => setSelQuote(null)}
              />
            )}
          </BeardBand>
        </footer>
  )
}


export { ComposerFooter, type DraftQuote, type SelQuote };
