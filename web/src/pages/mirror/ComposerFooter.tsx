import { useCallback, useRef, useState, type Dispatch, type RefObject, type SetStateAction, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowUp, Check, ChevronDown, Circle, FileText, Info, Lightbulb, Loader2, Pencil, Plus, Settings2, Sparkles, Square, X } from 'lucide-react'
import { adminFetch } from '@/lib/api'
import { attachmentUrl, type ViewerCaps } from '@/lib/viewer'
import { type TimelineItem } from '@/components/Timeline'
import { type QuoteAttachment } from '../../../shared/quotes'
import ComposerEditor, { type ComposerEditorHandle } from '@/components/ComposerEditor'
import QuestionPanel from '@/components/QuestionPanel'
import BeardBand, { BandItem } from '@/components/BeardBand'
import { LightboxImage } from '@/components/Lightbox'
import QuoteChip from '@/components/QuoteChip'
import { IMAGE_RE } from '@/components/UserAttachments'
import { ATTACH_MENU_ICONS, MODE_CHECK_ICON } from '@/lib/officialMenuIcons'
import { cn } from '@/lib/utils'
import { type SessionDetail, type LocalCfg, type LocalCfgOption, LOCAL_MODE_ICONS, VERSION_LABEL } from './pageBits'
import { COACH_RECOMMENDATIONS, COACH_ACTIONS } from './timelineUtil'
import { type ComposerMetaT, type SuggestItem, AT_CATEGORIES, QUEUE_DASHED_SVG, QUEUE_DRAG_SVG, QUEUE_PLACEHOLDER } from './composerMeta'
import { stText, type ReducedStatus } from './statusReduce'
import { OfficialGlyph } from './glyphs'
import { QuotePill } from './QuotePill'
import { VoiceButton } from './VoiceButton'
import ModelPicker from './ModelPicker'
import DirPicker from './DirPicker'
import LocalPicker, { type DraftTarget } from './LocalPicker'
import { useCollapseLevel } from './useCollapseLevel'

type QuoteSel = { text: string; eventId: string; author: 'user' | 'devin'; tsMs?: number; kind?: 'message' | 'worklog'; endEventId?: string }
type DraftQuote = QuoteAttachment & { author: 'user' | 'devin'; endEventId?: string }
type SelQuote = { x: number; y: number; text: string; eventId: string; author: 'user' | 'devin'; tsMs?: number; expanded?: boolean; kind?: 'message' | 'worklog'; endEventId?: string; placement?: 'above' | 'below'; hidden?: boolean }
type LocalCfgGroup = NonNullable<LocalCfg['options']>[number]

/** Queue-row preview: stored queue text is the raw wire string — it can carry
 *  <quoted_artifact …> XML wrappers, ATTACHMENT:"url" marker lines and multi-line
 *  bodies. Render a readable one-line summary instead of raw markup. */
function queuePreview(raw: string): string {
  let s = raw
  s = s.replace(/<quoted_artifact\b[^>]*>([\s\S]*?)<\/quoted_artifact>/g, (_m, inner: string) => {
    const cap = inner.match(/<caption>([\s\S]*?)<\/caption>/)?.[1]?.trim()
    const body = inner.match(/<content>([\s\S]*?)<\/content>/)?.[1]?.trim()
    const excerpt = (cap || body || '').split('\n')[0].slice(0, 60)
    return excerpt ? `❝${excerpt}❞` : ''
  })
  s = s.replace(/^ATTACHMENT:"?([^"\n]+)"?\s*$/gm, '[附件] $1')
  s = s.replace(/<[^>]+>/g, '')
  return s.replace(/\s+/g, ' ').trim()
}

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
  effShowPanel, showJump, scrollRef, setBandH,
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
  scrollRef: RefObject<HTMLDivElement>
  setBandH: (h: number) => void
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
  const [agentMenuOpen, setAgentMenuOpen] = useState(false)
    const [envSaveState, setEnvSaveState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle')
    const [sendOptOpen, setSendOptOpen] = useState(false)
    const [voiceRecording, setVoiceRecording] = useState(false)
    const [attachOpen, setAttachOpen] = useState(false)
  const attachMenuRef = useRef<HTMLDivElement | null>(null)
  // Composer pill collapse — official overflow-hysteresis (see useCollapseLevel):
  //   0 full labels · 1 icons only · 2 mode+model move into the "+" menu ·
  //   3 context meter joins them too (mirrors the mobile "+" menu).
  const [pillRowEl, setPillRowEl] = useState<HTMLDivElement | null>(null)
  const [pillGroupEl, setPillGroupEl] = useState<HTMLDivElement | null>(null)
  const pillTier = useCollapseLevel(pillRowEl, pillGroupEl, 3)
  const attachBtnRef = useRef<HTMLButtonElement | null>(null)
  // Pill menus portal to body (the pill group clips overflow for collapse
  // measurement, so in-tree absolute menus would be cut off).
  const sModeBtnRef = useRef<HTMLButtonElement | null>(null)
  const modelBtnRef = useRef<HTMLButtonElement | null>(null)
  const sendOptBtnRef = useRef<HTMLButtonElement | null>(null)
  const agentBtnRef = useRef<HTMLButtonElement | null>(null)
  // Card element for portaling popups that must paint above the card — the
  // card is `overflow-hidden` AND lives under the BeardBand `relative z-30`
  // stacking context, so any in-tree popup is both clipped and out-z'd.
  const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null)

  // Official keyboard semantics (sampled live): menu container takes focus on
  // open; Up/Down cycle menuitems; Right on "Actions" opens the submenu and
  // focuses its first item; Left returns to "Actions"; Escape closes the whole
  // menu and refocuses the trigger button.
  const attachMenuKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    const root = attachMenuRef.current
    if (!root) return
    const sub = root.querySelector<HTMLElement>('[data-submenu]')
    const active = document.activeElement as HTMLElement | null
    const inSub = !!(sub && active && sub.contains(active))
    const items = [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].filter(
      (b) => !b.disabled && (sub ? sub.contains(b) === inSub : true),
    )
    const idx = active ? items.indexOf(active as HTMLButtonElement) : -1
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      items[(idx + 1) % items.length]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      items[(idx - 1 + items.length) % items.length]?.focus()
    } else if (e.key === 'Home') {
      e.preventDefault()
      items[0]?.focus()
    } else if (e.key === 'End') {
      e.preventDefault()
      items[items.length - 1]?.focus()
    } else if (e.key === 'Tab') {
      // Official: Tab closes the menu and moves focus to the next control after
      // the trigger; Shift+Tab closes and refocuses the trigger itself.
      setAttachOpen(false)
      attachBtnRef.current?.focus()
      if (e.shiftKey) e.preventDefault()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setAttachOpen(false)
      attachBtnRef.current?.focus()
    } else if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Official: letter typeahead focuses the next matching menuitem.
      const ch = e.key.toLowerCase()
      const matches = items.filter((b) => (b.textContent || '').trim().toLowerCase().startsWith(ch))
      if (matches.length) {
        e.preventDefault()
        const cur = active ? matches.indexOf(active as HTMLButtonElement) : -1
        matches[(cur + 1) % matches.length]?.focus()
      }
    }
  }, [])
    const dragQ = useRef<string | null>(null)
    const anyRef = useRef<HTMLInputElement>(null)
  const imgRef = useRef<HTMLInputElement>(null)
  
  // Model pill — toolbar right cluster (collapse tiers drive icon/text). The
  // menu is driven exclusively by the agent's advertised config: when no real
  // model group exists there is nothing to pick, so the pill hides instead of
  // painting stale cloud capability rows; while the fetch is in flight it
  // shows "…".
  const modelPillEl = (alwaysText: boolean) => {
    if (cfgFetched && !localCfg?.model) return null
    const iconMode = !alwaysText && pillTier >= 1
    return (
      <div className="relative">
        <button
          ref={modelBtnRef}
          onClick={() => { setModeOpen((v) => !v); setSModeOpen(false) }}
          aria-label="Select mode"
          title={modelPillLabel ?? (cfgFetched ? (VERSION_LABEL[pillVersion] ?? pillVersion) : '…')}
          className={cn('flex h-7 cursor-pointer items-center overflow-hidden whitespace-nowrap rounded-full text-[13px] leading-[18px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground', iconMode ? 'size-7 justify-center' : 'max-w-[240px] gap-[3px] px-[6px]', modeOpen && 'bg-tint-secondary text-foreground')}
        >
          {iconMode && <Sparkles size={18} className="shrink-0" />}
          {!iconMode && <span className="min-w-0 truncate">{modelPillLabel ?? (cfgFetched ? (VERSION_LABEL[pillVersion] ?? pillVersion) : '…')}</span>}
        </button>
        {modeOpen && <div className="fixed inset-0 z-10" onClick={() => setModeOpen(false)} />}
        {modeOpen && modelBtnRef.current && createPortal(
          <div role="menu" style={{ bottom: window.innerHeight - modelBtnRef.current.getBoundingClientRect().top + 6, right: window.innerWidth - modelBtnRef.current.getBoundingClientRect().right, maxHeight: modelBtnRef.current.getBoundingClientRect().top - 14 }} className={cn('fixed z-50 flex flex-col overflow-hidden rounded-[10px] bg-[rgba(255,255,255,0.94)] shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)] outline outline-1 outline-black/[0.06] backdrop-blur-[8px] dark:bg-[#1f1f1f]/[0.94] dark:outline-white/[0.06] [transition:transform_40ms_cubic-bezier(0.76,0,0.24,1),scale_40ms_cubic-bezier(0.76,0,0.24,1),opacity_40ms_cubic-bezier(0.76,0,0.24,1)]', localCfg?.model ? 'w-[248px] max-h-[70vh]' : 'w-[220px]')}>
            <div className={cn('min-h-0 flex-1', localCfg?.model ? 'overflow-y-auto' : 'overflow-hidden p-1')}>
            {localCfg?.model ? (
              <ModelPicker
                model={localCfg.model}
                effortGroup={effortGroup}
                speedGroup={speedGroup}
                extraGroups={extraGroups}
                onPick={chooseLocalOption}
                onPickMulti={chooseLocalOptions}
                onClose={() => setModeOpen(false)}
              />
            ) : (
              <div className="flex h-[30px] items-center px-3 text-[13px] text-muted-foreground">{t('common.loading')}</div>
            )}
            </div>
          </div>,
          document.body,
        )}
      </div>
    )
  }

  // Draft agent picker — the outermost layer's bottom-right control (chin),
  // chromeless like the model pill per the official text-button treatment.
  const agentPillEl = isDraft && !isVisitor ? (
    <div className="relative shrink-0">
      <button
        ref={agentBtnRef}
        onClick={() => setAgentMenuOpen((v) => !v)}
        title={t('draft.agentPick')}
        className={cn('flex h-7 shrink-0 cursor-pointer items-center gap-[3px] overflow-hidden whitespace-nowrap rounded-full px-[6px] text-[13px] leading-[18px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground', agentMenuOpen && 'bg-tint-secondary text-foreground')}
      >
        <Sparkles size={14} className="shrink-0" />{composerMeta?.agents?.find((a) => a.id === draftAgent)?.label ?? draftAgent}
        <ChevronDown size={11} className="shrink-0 opacity-60" />
      </button>
      {agentMenuOpen && agentBtnRef.current && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setAgentMenuOpen(false)} />
          {createPortal(
            <div role="menu" style={{ bottom: window.innerHeight - agentBtnRef.current.getBoundingClientRect().top + 8, right: window.innerWidth - agentBtnRef.current.getBoundingClientRect().right, maxHeight: agentBtnRef.current.getBoundingClientRect().top - 14 }} className="fixed z-50 w-[220px] overflow-y-auto rounded-[10px] bg-card shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1)] outline outline-1 outline-black/[0.06] dark:outline-white/[0.06]">
            <div className="p-1">
              {(composerMeta?.agents ?? [{ id: 'devin', label: 'Devin Local' }]).map((a) => (
                <button
                  key={a.id}
                  role="menuitem"
                  onClick={() => { setDraftAgent(a.id); setAgentMenuOpen(false) }}
                  className="flex w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] hover:bg-accent"
                >
                  <Sparkles size={13} className="text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{a.label}</span>
                  {a.id === draftAgent && <Check size={13} className="shrink-0" />}
                </button>
              ))}
            </div>
            <p className="border-t border-border/40 px-3 py-1.5 text-[11px] leading-[14px] text-muted-foreground">
              {t('draft.agentHint')}
            </p>
          </div>,
          document.body,
          )}
        </>
      )}
    </div>
  ) : null

  return (
        <footer className={cn('relative max-md:z-20', effShowPanel && 'max-md:hidden')}>
          {showJump && (
            <button
              aria-label={t('am.scrollBottom')}
              onClick={() => {
                const el = scrollRef.current
                if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
              }}
              className="absolute -top-11 left-1/2 z-30 flex h-7 w-9 -translate-x-1/2 cursor-pointer items-center justify-center rounded-full bg-[rgba(31,31,31,0.94)] text-white/90 shadow-[0_1px_3px_0_rgba(0,0,0,0.25),0_1px_2px_0_rgba(0,0,0,0.06)] transition-colors hover:bg-[rgba(51,51,51,0.94)]"
            >
              <ChevronDown size={20} />
            </button>
          )}
          <BeardBand
            onBandHeight={setBandH}
            cardRef={setCardEl}
            wrapClassName={isDraft ? 'max-w-[692px]' : undefined}
            bareCard={isDraft}
            chin={isDraft || interrupted || subDead || sendErr || controlMsg || (persona && !isVisitor && !isDraft && (persona.mode !== 'off' || persona.escalated)) || (() => {
              if (isVisitor || envBannerGone) return false
              const sug = items.find((it) => it.kind === 'env_suggestion')
              if (!sug || sug.envSuggestion?.dismissed) return false
              try { return localStorage.getItem(`env-banner-dismissed:${sug.id}`) !== '1' } catch { return true }
            })() ? (
              <>
                {sendErr && (
                  <BandItem slot="chin">
                    <div className="flex min-h-7 items-center gap-2 pl-3 pr-1 text-red-500">
                      <AlertTriangle size={12} className="shrink-0" />
                      <span className="min-w-0 flex-1 truncate text-[12px] leading-[16px]" title={sendErr}>{sendErr}</span>
                      <button
                        onClick={() => void send()}
                        className="shrink-0 cursor-pointer rounded-[6px] px-1.5 py-0.5 text-[12px] font-medium hover:bg-accent"
                      >
                        {t('common.retry')}
                      </button>
                    </div>
                  </BandItem>
                )}
                {interrupted && (
                  <BandItem slot="chin">
                    <div className="flex min-h-7 items-center gap-2 pl-3 pr-1 text-amber-600 dark:text-amber-400">
                      <AlertTriangle size={12} className="shrink-0" />
                      <span className="min-w-0 flex-1 truncate text-[12px] leading-[16px]" title={interrupted.text}>{t('composer.resumeTurn')}</span>
                      <button
                        onClick={() => void resumeInterrupted()}
                        className="shrink-0 cursor-pointer rounded-[6px] px-1.5 py-0.5 text-[12px] font-medium hover:bg-accent"
                      >
                        {interrupted.kind === 'resend' ? t('common.resend') : t('common.continue')}
                      </button>
                      <button
                        onClick={dismissInterrupted}
                        aria-label={t('composer.resumeDismiss')}
                        title={t('composer.resumeDismiss')}
                        className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-[6px] hover:bg-accent"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  </BandItem>
                )}
                {subDead && (
                  <BandItem slot="chin">
                    <div className="flex min-h-7 items-center gap-2 pl-3 pr-1 text-muted-foreground">
                      <AlertTriangle size={12} className="shrink-0" />
                      <span className="min-w-0 flex-1 truncate text-[12px] leading-[16px]">{t('tree.handleDead')}</span>
                      <button
                        onClick={() => void respawnSub()}
                        className="shrink-0 cursor-pointer rounded-[6px] px-1.5 py-0.5 text-[12px] font-medium hover:bg-accent"
                      >
                        {t('menu.spawnSuccessor')}
                      </button>
                    </div>
                  </BandItem>
                )}
                {controlMsg && (
                  <BandItem slot="chin">
                    <div className="flex min-h-7 items-center gap-2 pl-3 pr-1 text-muted-foreground">
                      <span className="min-w-0 flex-1 truncate text-[12px] leading-[16px]" title={controlMsg}>{controlMsg}</span>
                    </div>
                  </BandItem>
                )}
                {persona && !isVisitor && !isDraft && (persona.mode !== 'off' || persona.escalated) && (
                  <BandItem slot="chin">
                    <div className="flex min-h-7 items-center gap-2 pl-3 pr-1 text-muted-foreground">
                      <button
                        onClick={() => void cyclePersonaMode()}
                        title={t('persona.cycleTip')}
                        className="shrink-0 cursor-pointer rounded-full border border-border px-2 py-0.5 text-[12px] leading-[16px] hover:bg-tint-secondary"
                      >
                        🎭 {t('persona.label')} · {t(`persona.${persona.mode}`)}
                      </button>
                      {persona.escalated && (
                        <span className="flex min-w-0 items-center gap-1 text-amber-600 dark:text-amber-400">
                          <AlertTriangle size={13} className="shrink-0" />
                          <span className="truncate text-[12px] leading-[16px]">{t('persona.escalated')}</span>
                        </span>
                      )}
                      {persona.mode === 'semi' && !persona.escalated && (
                        <button
                          onClick={() => void askPersonaNow()}
                          disabled={personaBusy}
                          className="shrink-0 cursor-pointer text-[12px] underline hover:opacity-80 disabled:opacity-50"
                        >
                          {personaBusy ? t('persona.asking') : t('persona.ask')}
                        </button>
                      )}
                    </div>
                  </BandItem>
                )}
                {(() => {
                  if (isVisitor || envBannerGone) return null
                  const sug = items.find((it) => it.kind === 'env_suggestion')
                  if (!sug || sug.envSuggestion?.dismissed) return null
                  let dismissed = false
                  try { dismissed = localStorage.getItem(`env-banner-dismissed:${sug.id}`) === '1' } catch { /* unavailable */ }
                  if (dismissed) return null
                  return (
                    <BandItem slot="chin">
                      <div className="flex min-h-7 items-center gap-2 pl-3 pr-1">
                        <Lightbulb size={13} className="shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-[12px] leading-[16px]">
                          <span className="sm:hidden">{t('am.envSuggested')}</span>
                          <span className="hidden sm:inline">{t('am.envSuggestedLong')}</span>
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            const node = document.querySelector(`[data-eid="${CSS.escape(sug.id)}"]`)
                            node?.scrollIntoView({ block: 'center', behavior: 'smooth' })
                          }}
                          className="shrink-0 cursor-pointer rounded-[6px] px-1.5 py-0.5 text-[12px] font-medium text-blue-500 hover:bg-accent"
                        >
                          Review
                        </button>
                        <button
                          type="button"
                          disabled={!sug.envSuggestion?.contentsKey || envSaveState === 'sending' || envSaveState === 'done'}
                          title={sug.envSuggestion?.contentsKey ? undefined : t('panel.eventNoContents')}
                          onClick={() => {
                            const es = sug.envSuggestion
                            if (!es?.contentsKey || envSaveState === 'sending' || envSaveState === 'done') return
                            setEnvSaveState('sending')
                            adminFetch<{ ok: boolean; error: string | null }>(`/api/admin/session/${id}/env-suggestion-accept`, {
                              method: 'POST',
                              body: JSON.stringify({ event_id: sug.id, sink: es.sink, repo: es.repo, title: sug.title, summary: es.summary, contents_key: es.contentsKey, old_contents_key: es.oldContentsKey }),
                            }).then((r) => setEnvSaveState(r.ok ? 'done' : 'error')).catch(() => setEnvSaveState('error'))
                          }}
                          className={cn('shrink-0 rounded-[6px] px-1.5 py-0.5 text-[12px] font-medium', envSaveState === 'error' ? 'cursor-pointer text-red-500 hover:bg-accent' : 'text-blue-500', sug.envSuggestion?.contentsKey && envSaveState === 'idle' ? 'cursor-pointer hover:bg-accent' : envSaveState !== 'error' && 'opacity-50')}
                        >
                          {envSaveState === 'sending' ? t('common.saving') : envSaveState === 'done' ? t('menu.savedEnv') : envSaveState === 'error' ? t('menu.retrySaveEnv') : <>{t('common.save')}<span className="hidden sm:inline"> {t('menu.saveToEnvSuffix')}</span></>}
                        </button>
                        <button
                          type="button"
                          aria-label="Dismiss"
                          onClick={() => dismissEnvBanner(sug.id)}
                          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-accent hover:text-foreground"
                        >
                          <X size={13} />
                        </button>
                      </div>
                    </BandItem>
                  )
                })()}
                {isDraft && !isVisitor && (
                  // Draft chin row — official Ask-page bottom strip: run target
                  // (本地 / SSH host) + workspace picker | agent pill. Lives in
                  // the wax area, not inside the card (no divider).
                  <BandItem slot="chin">
                    <div className="flex min-h-7 w-full min-w-0 items-center gap-2 pl-2 pr-0.5">
                      <LocalPicker
                        target={draftTarget}
                        hosts={composerMeta?.ssh_hosts ?? []}
                        onChange={setDraftTarget}
                        onHosts={(h) => setComposerMeta((m) => (m ? { ...m, ssh_hosts: h } : m))}
                      />
                      {draftTarget.kind === 'ssh' ? (
                        <DirPicker
                          ssh={draftTarget.host.target}
                          value={draftSshCwd}
                          onChange={setDraftSshCwd}
                          repos={[]}
                          recents={[]}
                          primaryCwd={draftTarget.host.cwd || '~'}
                        />
                      ) : (
                        <DirPicker
                          value={draftCwd}
                          onChange={setDraftCwd}
                          repos={composerMeta?.repos ?? []}
                          recents={recentCwds}
                          primaryCwd={composerMeta?.primary_cwd}
                        />
                      )}
                      <div className="ml-auto flex shrink-0 items-center">{agentPillEl}</div>
                    </div>
                  </BandItem>
                )}
              </>
            ) : undefined}
            band={queued.length > 0 || (pending && pending.questions?.length && caps.canAnswerQuestion) ? (
              <>
          {queued.length > 0 && (
            // Official queue band (sampled 2026-09-01): summary row h-8 "N message(s) queued" + Clear all icon;
            // sortable rows min-h-9 rounded-xl, clock icon, hover icon actions Edit / Remove from queue / Send now.
            <BandItem>
              <div className="flex h-8 items-center justify-between gap-2 py-1 pl-3.5 pr-1">
                <span className="truncate text-[12px] text-muted-foreground">{queued.length} message{queued.length > 1 ? 's' : ''} queued</span>
                <button
                  onClick={() => { void queueOpReq({ op: 'clear' }).then((ok) => { if (ok) setQueued([]) }) }}
                  aria-label="Clear all"
                  title="Clear all"
                  className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X size={16} />
                </button>
              </div>
              <ol className="flex max-h-60 flex-col overflow-y-auto">
                {queued.map((q) => (
                  <li
                    key={q.id}
                    draggable
                    role="button"
                    aria-roledescription="sortable"
                    onDragStart={() => { dragQ.current = q.id }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => { if (dragQ.current && dragQ.current !== q.id) void queueReorder(dragQ.current, q.id); dragQ.current = null }}
                    className={`group flex min-h-9 cursor-grab items-center gap-2 rounded-xl py-1.5 pl-3 pr-1.5 text-[13px] leading-[18px] opacity-80 hover:bg-accent hover:opacity-100 active:cursor-grabbing ${editingQ === q.id ? 'opacity-50' : ''}`}
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground group-hover:hidden" dangerouslySetInnerHTML={{ __html: QUEUE_DASHED_SVG }} />
                    <span className="hidden size-6 shrink-0 items-center justify-center text-muted-foreground group-hover:flex" dangerouslySetInnerHTML={{ __html: QUEUE_DRAG_SVG }} />
                    <span className="min-w-0 flex-1 truncate">{queuePreview(q.text)}</span>
                    <button
                      onClick={() => void queueEditStart(q.id, q.text)}
                      aria-label="Edit message"
                      title="Edit message"
                      className="hidden size-6 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-muted hover:text-foreground group-hover:flex"
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      onClick={() => void queueOp('remove', q.id)}
                      aria-label="Remove from queue"
                      title="Remove from queue"
                      className="hidden size-6 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-muted hover:text-foreground group-hover:flex"
                    >
                      <X size={16} />
                    </button>
                    <button
                      onClick={() => void queueOp('send_now', q.id)}
                      aria-label="Send now"
                      title="Send now"
                      className="hidden size-6 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-muted hover:text-foreground group-hover:flex"
                    >
                      <ArrowUp size={16} />
                    </button>
                  </li>
                ))}
              </ol>
            </BandItem>
          )}
          {pending && pending.questions?.length && caps.canAnswerQuestion ? (
            <BandItem>
              <QuestionPanel
                key={pending.id}
                questions={pending.questions}
                onSubmit={(answers) => void answerQuestion(answers)}
                onDismiss={() => setDismissedQ(pending.id)}
                disabled={sending}
              />
            </BandItem>
          ) : null}
              </>
            ) : undefined}
          >
            {(suggestions.length > 0 || (atCat && trigger?.char === '@')) && cardEl && createPortal(
              <div role="listbox" style={{ bottom: window.innerHeight - cardEl.getBoundingClientRect().top + 4, left: cardEl.getBoundingClientRect().left, maxHeight: Math.min(400, cardEl.getBoundingClientRect().top - 12) }} className="fixed z-50 w-[300px] overflow-y-auto rounded-[10px] border border-border bg-card p-1 shadow-lg">
                {atCat && trigger?.char === '@' && (
                  <div className="flex items-baseline justify-between gap-2 px-2 py-1">
                    <span className="text-[12px] font-medium text-muted-foreground">
                      {AT_CATEGORIES.find((c) => c.cat === atCat)?.title || ''}
                    </span>
                    <span className="truncate text-[11px] text-muted-foreground/70">
                      {AT_CATEGORIES.find((c) => c.cat === atCat)?.sub || ''}
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
                        ? 'This draft looks like several independent tasks'
                        : findings[0].finding_type === 'overkill_devin_mode'
                          ? `${mode} may be more than this task needs`
                          : findings[0].finding_type === 'no_plan_before_impl'
                            ? 'Consider asking Devin for a plan before implementing'
                            : findings[0].finding_type === 'non_work_usage'
                              ? 'Your prompt seems irrelevant to work use-cases'
                              : findings[0].finding_type === 'unrelated_followup_new_session'
                                ? 'This task looks unrelated to the current session'
                                : findings[0].finding_type === 'use_code_scan'
                                  ? t('menu.codeScanFit')
                                  : findings[0].explanation}
                    </span>
                    <button type="button" aria-label="Show finding details" title={findings[0].explanation} className="flex shrink-0 cursor-default items-center opacity-70">
                      <Info size={14} />
                    </button>
                  </span>
                  {findings[0].finding_type === 'overkill_devin_mode' ? (
                    <button
                      type="button"
                      onClick={() => { setSelectedVersion('devin-2-5'); setFindings([]) }}
                      className="shrink-0 cursor-pointer text-[12px] leading-4 text-blue-400 hover:underline"
                    >
                      Switch mode
                    </button>
                  ) : findings[0].finding_type === 'parallelizable_prompt' ? (
                    /* Official click (sampled via route capture): appends this sentence to the draft — no network write. */
                    <button
                      type="button"
                      onClick={() => {
                        setInput((v) => `${v.trimEnd()}\nThese tasks are independent: split them into separate child sessions and run them in parallel.`)
                        setFindings([])
                      }}
                      className="shrink-0 cursor-pointer text-[12px] leading-4 text-blue-400 hover:underline"
                    >
                      Split into child sessions
                    </button>
                  ) : findings[0].finding_type === 'no_plan_before_impl' ? (
                    <button
                      type="button"
                      onClick={() => {
                        setInput((v) => `${v.trimEnd()}\nBefore implementing anything, investigate and propose a plan for me to review first.`)
                        setFindings([])
                      }}
                      className="shrink-0 cursor-pointer text-[12px] leading-4 text-blue-400 hover:underline"
                    >
                      Create plan
                    </button>
                  ) : findings[0].finding_type === 'non_work_usage' ? (
                    <button
                      type="button"
                      onClick={() => { setInput(''); setFindings([]) }}
                      className="shrink-0 cursor-pointer text-[12px] leading-4 text-blue-400 hover:underline"
                    >
                      Clear prompt
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
                      Start new session
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
                    {findings[0] ? COACH_RECOMMENDATIONS[findings[0].finding_type] || findings[0].explanation || '' : ''}
                  </p>
                  <div className="mt-4 flex items-center justify-end gap-2">
                    <button
                      className="cursor-pointer rounded-md px-3 py-1.5 text-[13px] text-muted-foreground hover:bg-muted"
                      onClick={() => setConfirmSendOpen(false)}
                    >
                      Back
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
                        {COACH_ACTIONS[findings[0].finding_type]}
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
                      Send
                    </button>
                  </div>
                </div>
              </div>
            )}
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
                        aria-label="Remove attachment"
                        onClick={() => removeStaged(f.url)}
                        className="absolute right-[-5px] top-[-5px] flex size-[18px] items-center justify-center rounded-full bg-foreground text-background opacity-0 focus-visible:opacity-100 group-hover/attachment:opacity-100 [@media(pointer:coarse)]:opacity-100"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ) : (
                    <div key={f.url} className="flex items-center gap-2 rounded-lg border border-border bg-background px-2 py-1.5">
                      <FileText size={16} className="shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <div className="max-w-[180px] truncate text-[12px] leading-[16px]">{f.name}</div>
                        <div className="text-[11px] leading-[14px] text-muted-foreground">{f.size < 1024 ? `${f.size} B` : `${(f.size / 1024).toFixed(1)} KB`}</div>
                      </div>
                      <button aria-label="Remove attachment" onClick={() => removeStaged(f.url)} className="cursor-pointer text-muted-foreground hover:text-foreground">
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
              placeholderNode={!pending && statusState.enum === 'working' && !isVisitor ? QUEUE_PLACEHOLDER : undefined}
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
            {/* Official toolbar row (sampled live 2026-09-01): min-h-7, 28px round icon buttons with 18px
                glyphs, mode pill h-7 rounded-full 1px border px-1.5 13/18, right cluster gap-1 with mic +
                a rounded-full foreground send group (opacity .5 when disabled) whose ⌄ split segment only
                expands once there is text. */}
            <div ref={setPillRowEl} className="relative flex min-h-7 items-center justify-between gap-2">
              <div className={cn('flex shrink-0 items-center gap-px', voiceRecording && 'invisible')}>
              {!isVisitor && <div className="relative">
                <button
                  ref={attachBtnRef}
                  onClick={() => setAttachOpen((v) => !v)}
                  disabled={uploading}
                  aria-label="Attach or mention"
                  title="Attach or mention"
                  className="flex size-7 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-tint-secondary hover:text-foreground disabled:opacity-50"
                >
                  {uploading ? <Loader2 size={18} className="animate-spin" /> : <Plus size={18} />}
                </button>
                {attachOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setAttachOpen(false)} />
                    {attachBtnRef.current && createPortal(
                    <div
                      role="menu"
                      tabIndex={-1}
                      ref={(el) => { attachMenuRef.current = el; el?.focus() }}
                      onKeyDown={attachMenuKeyDown}
                      style={{ bottom: window.innerHeight - attachBtnRef.current.getBoundingClientRect().top + 6, left: attachBtnRef.current.getBoundingClientRect().left, maxHeight: Math.min(400, attachBtnRef.current.getBoundingClientRect().top - 14) }}
                      className="fixed z-50 flex w-[220px] flex-col overflow-hidden rounded-[10px] bg-[rgba(255,255,255,0.94)] shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)] outline outline-1 outline-black/[0.06] backdrop-blur-[8px] focus:outline-none dark:bg-[#1f1f1f]/[0.94] dark:outline-white/[0.06] [transition:transform_40ms_cubic-bezier(0.76,0,0.24,1),scale_40ms_cubic-bezier(0.76,0,0.24,1),opacity_40ms_cubic-bezier(0.76,0,0.24,1)]"
                    >
                      <div className="min-h-0 flex-1 overflow-hidden p-1">
                        {/* Official Attach or mention menu (sampled live 2026-08-31): Upload attachment + 8 mention categories. */}
                        {!isDraft && <><button
                          role="menuitem"
                          onClick={() => { setAttachOpen(false); anyRef.current?.click() }}
                          className="flex w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] outline-none hover:bg-tint-secondary [&>svg]:size-4 [&>svg]:shrink-0"
                        >
                          <OfficialGlyph svg={ATTACH_MENU_ICONS['Upload attachment']} className="text-muted-foreground" />
                          Upload attachment
                        </button>
                        <div role="separator" className="mx-2 h-[9px] bg-border bg-clip-content py-1" /></>}
                        {([
                          // Local attach menu — every entry must resolve against
                          // local data (composer-meta: workspaces/skills/sessions
                          // are real; playbooks/secrets/macros/plugins are always
                          // empty locally and are deliberately NOT listed).
                          ['Workspaces', 'repos', 'Repositories'],
                          ['Files', 'files', 'Files'],
                          ['Skills', 'skills', 'Skills'],
                          ['Sessions', 'sessions', 'Devin sessions'],
                        ] as [string, string, string][]).map(([label, cat, iconKey]) => (
                          <button
                            key={label}
                            role="menuitem"
                            onClick={() => { setAttachOpen(false); openMention(cat) }}
                            className="flex w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] outline-none hover:bg-tint-secondary [&>svg]:size-4 [&>svg]:shrink-0"
                          >
                            <OfficialGlyph svg={ATTACH_MENU_ICONS[iconKey]} className="text-muted-foreground" />
                            {label}
                          </button>
                        ))}
                        {/* When the pills collapse into this menu (narrow composer
                            — pillTier≥2, or any sub-md width) their entries open
                            the same dropdowns from here. */}
                        {pillTier >= 2 && <div role="separator" className="mx-2 h-[9px] bg-border bg-clip-content py-1" />}
                        {pillTier >= 2 && localModeGroup && (localModeGroup.options?.length ?? 0) > 0 && (
                          <button
                            role="menuitem"
                            onClick={() => { setAttachOpen(false); setSModeOpen(true) }}
                            className="flex w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] outline-none hover:bg-tint-secondary [&>svg]:size-4 [&>svg]:shrink-0"
                          >
                            <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                              {LOCAL_MODE_ICONS[String(localModeOpt?._meta?.['cognition.ai/icon'] ?? '')] ?? <Settings2 size={16} />}
                            </span>
                            Session mode
                            <span className="ml-auto truncate text-[11px] text-muted-foreground">{localModeOpt?.name ?? localModeCurrent}</span>
                          </button>
                        )}
                        {pillTier >= 2 && (!cfgFetched || localCfg?.model) && (
                          <button
                            role="menuitem"
                            onClick={() => { setAttachOpen(false); setModeOpen(true) }}
                            className="flex w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] outline-none hover:bg-tint-secondary [&>svg]:size-4 [&>svg]:shrink-0"
                          >
                            <Sparkles size={16} className="text-muted-foreground" />
                            Model
                            <span className="ml-auto truncate text-[11px] text-muted-foreground">{modelPillLabel ?? (cfgFetched ? (VERSION_LABEL[pillVersion] ?? pillVersion) : '…')}</span>
                          </button>
                        )}
                        {pillTier >= 3 && detail?.session.context_usage?.used != null && detail.session.context_usage.size ? (
                          <div className="flex w-full select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] text-muted-foreground">
                            <span className="inline-block h-1.5 w-8 shrink-0 overflow-hidden rounded-full bg-muted">
                              <span className="block h-full rounded-full bg-emerald-500" style={{ width: `${Math.min(100, Math.round((detail.session.context_usage.used! / detail.session.context_usage.size!) * 100))}%` }} />
                            </span>
                            Context
                            <span className="ml-auto truncate text-[11px] text-muted-foreground">{detail.session.context_usage.used!.toLocaleString()}/{detail.session.context_usage.size!.toLocaleString()}</span>
                          </div>
                        ) : null}
                      </div>
                    </div>,
                    document.body,
                    )}
                  </>
                )}
                <input
                  ref={anyRef}
                  type="file"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = '' }}
                />
                <input
                  ref={imgRef}
                  type="file"
                  accept=".png,.jpg,.jpeg,.gif,.webp"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = '' }}
                />
              </div>}
              {isVisitor && caps.canUpload && (
                <div className="relative">
                  <button
                    onClick={() => anyRef.current?.click()}
                    disabled={uploading}
                    aria-label="Upload attachment"
                    title="Upload attachment"
                    className="flex size-7 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-tint-secondary hover:text-foreground disabled:opacity-50"
                  >
                    {uploading ? <Loader2 size={18} className="animate-spin" /> : <Plus size={18} />}
                  </button>
                  <input
                    ref={anyRef}
                    type="file"
                    className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = '' }}
                  />
                </div>
              )}
              </div>
              <div className="flex min-w-0 items-center gap-1">
                <div ref={setPillGroupEl} className="flex min-w-0 items-center gap-px overflow-hidden [&>*]:!shrink-0">
              {!isVisitor && localModeGroup && (localModeGroup.options?.length ?? 0) > 0 && pillTier < 2 && (
                <div className="relative">
                  <button
                    ref={sModeBtnRef}
                    onClick={() => { setSModeOpen((v) => !v); setModeOpen(false) }}
                    aria-label="Session mode"
                    title={localModeOpt?.name ?? localModeCurrent ?? 'Session mode'}
                    className={cn('flex h-7 cursor-pointer items-center overflow-hidden whitespace-nowrap rounded-full text-[13px] leading-[18px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground', pillTier >= 1 ? 'size-7 justify-center' : 'max-w-[220px] gap-1 px-[6px]', sModeOpen && 'bg-tint-secondary text-foreground')}
                  >
                    {pillTier >= 1 ? (
                      <span className="flex size-[18px] shrink-0 items-center justify-center">
                        {LOCAL_MODE_ICONS[String(localModeOpt?._meta?.['cognition.ai/icon'] ?? '')] ?? <Settings2 size={18} />}
                      </span>
                    ) : (
                      <span className="min-w-0 truncate">{localModeOpt?.name ?? localModeCurrent ?? 'Mode'}</span>
                    )}
                  </button>
                  {sModeOpen && <div className="fixed inset-0 z-10" onClick={() => setSModeOpen(false)} />}
                  {sModeOpen && sModeBtnRef.current && createPortal(
                    <div role="menu" style={{ bottom: window.innerHeight - sModeBtnRef.current.getBoundingClientRect().top + 6, right: window.innerWidth - sModeBtnRef.current.getBoundingClientRect().right, maxHeight: sModeBtnRef.current.getBoundingClientRect().top - 14 }} className="fixed z-50 flex w-[260px] flex-col overflow-hidden rounded-[10px] bg-[rgba(255,255,255,0.94)] shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)] outline outline-1 outline-black/[0.06] backdrop-blur-[8px] dark:bg-[#1f1f1f]/[0.94] dark:outline-white/[0.06]">
                      <div className="min-h-0 flex-1 overflow-y-auto p-1">
                        <div className="px-2 py-[5px] text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{localModeGroup.name ?? 'Session Mode'}</div>
                        {localModeGroup.options!.map((opt) => {
                          const cur = localModeCurrent === opt.value
                          return (
                            <button
                              key={opt.value}
                              role="menuitemradio"
                              aria-checked={cur}
                              onClick={() => chooseLocalOption(String(localModeGroup.id), opt.value)}
                              className="flex w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-[6px] text-[13px] outline-none hover:bg-tint-secondary"
                            >
                              <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                                {LOCAL_MODE_ICONS[String(opt._meta?.['cognition.ai/icon'] ?? '')] ?? <Circle size={14} />}
                              </span>
                              <span className="flex min-w-0 flex-1 flex-col text-left">
                                <span className="flex items-center gap-2">
                                  <span className="truncate">{opt.name || opt.value}</span>
                                  {cur && <OfficialGlyph svg={MODE_CHECK_ICON} className="ml-auto shrink-0 text-muted-foreground" />}
                                </span>
                                {opt.description && <span className="truncate text-[11px] text-muted-foreground">{opt.description}</span>}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    </div>,
                    document.body,
                  )}
                </div>
              )}
              {!isVisitor && pillTier < 2 && modelPillEl(false)}
              {/* Context window fill — latest root-chain usage_update. Collapses
                  to the bare bar at tier≥1 and leaves the row at tier 3 (it then
                  shows inside the "+" menu instead). */}
              {detail?.session.context_usage?.used != null && detail.session.context_usage.size && pillTier < 3 ? (() => {
                const cu = detail.session.context_usage
                const pctUse = Math.min(100, Math.round(((cu.used ?? 0) / cu.size!) * 100))
                const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n))
                return (
                  <span
                    className="inline-flex h-7 shrink-0 cursor-default items-center gap-1 rounded-full px-[6px] text-[11px] tabular-nums text-muted-foreground"
                    title={t('visitor.contextTip', { used: cu.used!.toLocaleString(), size: cu.size!.toLocaleString(), pct: pctUse, input: cu.inputTokens?.toLocaleString() ?? '—', output: cu.outputTokens?.toLocaleString() ?? '—', cached: cu.cachedReadTokens?.toLocaleString() ?? '—' })}
                  >
                    <span className="inline-block h-1.5 w-8 overflow-hidden rounded-full bg-muted">
                      <span
                        className={`block h-full rounded-full ${pctUse > 85 ? 'bg-red-500' : pctUse > 60 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                        style={{ width: `${pctUse}%` }}
                      />
                    </span>
                    {pillTier < 1 && `${fmt(cu.used!)}/${fmt(cu.size!)}`}
                  </span>
                )
              })() : null}
                </div>
                {/* Open sessions show their owning agent read-only (desktop
                    parity) — the pick happens at draft time only. */}
                {!isDraft && !isVisitor && sessionAgent !== 'devin' && (
                  <span
                    title={t('draft.agentPick')}
                    className="mr-0.5 flex h-7 shrink-0 items-center gap-1 rounded-full border border-border px-2 text-[12px] leading-[16px] text-muted-foreground"
                  >
                    <Sparkles size={13} />{composerMeta?.agents?.find((a) => a.id === sessionAgent)?.label ?? sessionAgent}
                  </span>
                )}
                {!isVisitor && <VoiceButton onText={(t) => setInput((v) => (v ? `${v} ${t}` : t))} onRecordingChange={setVoiceRecording} disabled={sending || statusState.inputDisabled} />}
                {status === 'working' && !isVisitor ? (
                  <button
                    onClick={() => void control('pause')}
                    disabled={controlling}
                    aria-label="Stop Devin"
                    title="Stop Devin"
                    className={cn('flex size-7 cursor-pointer items-center justify-center rounded-full bg-foreground text-background disabled:opacity-50', voiceRecording && 'invisible')}
                  >
                    {controlling ? <Loader2 size={16} className="animate-spin" /> : <Square size={12} fill="currentColor" />}
                  </button>
                ) : null}
                {(status !== 'working' || input.trim().length > 0) && <div className={cn('relative flex shrink-0 items-stretch', voiceRecording && 'invisible')}>
                  <div role="group" className={cn(
                    'inline-flex shrink-0 items-stretch overflow-hidden rounded-full transition-colors',
                    input.trim() ? 'bg-foreground text-background' : 'bg-tint-secondary text-muted-foreground',
                  )}>
                    <button
                      onClick={() => void send()}
                      disabled={sending || statusState.inputDisabled || !input.trim()}
                      aria-label="Send"
                      className="flex size-7 cursor-pointer items-center justify-center py-[5px] disabled:cursor-not-allowed"
                    >
                      {sending ? <Loader2 size={16} className="animate-spin" /> : <ArrowUp size={18} />}
                    </button>
                    {/* Queue affordances exist only while a turn runs — idle
                        sends go straight through, so the split menu hides. */}
                    {!isVisitor && statusState.enum === 'working' && <div className={cn('flex items-stretch overflow-hidden transition-[width,opacity] duration-150', input.trim() ? 'w-[26px] opacity-100' : 'w-0 opacity-0')}>
                      <span className="w-px shrink-0 self-stretch bg-white/[0.08]" />
                      <button
                        ref={sendOptBtnRef}
                        onClick={() => setSendOptOpen((v) => !v)}
                        disabled={!input.trim()}
                        tabIndex={input.trim() ? 0 : -1}
                        aria-label="More send options"
                        title="More send options"
                        className={cn('flex w-[25px] shrink-0 cursor-pointer items-center justify-center hover:bg-white/10', sendOptOpen && 'bg-white/10')}
                      >
                        <ChevronDown size={14} />
                      </button>
                    </div>}
                  </div>
                  {sendOptOpen && <div className="fixed inset-0 z-10" onClick={() => setSendOptOpen(false)} />}
                  {sendOptOpen && sendOptBtnRef.current && createPortal(
                    <div role="menu" style={{ bottom: window.innerHeight - sendOptBtnRef.current.getBoundingClientRect().top + 6, right: window.innerWidth - sendOptBtnRef.current.getBoundingClientRect().right, maxHeight: sendOptBtnRef.current.getBoundingClientRect().top - 14 }} className="fixed z-50 w-[270px] overflow-y-auto rounded-[10px] bg-[rgba(255,255,255,0.94)] shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)] outline outline-1 outline-black/[0.06] backdrop-blur-[8px] dark:bg-[#1f1f1f]/[0.94] dark:outline-white/[0.06] [transition:transform_40ms_cubic-bezier(0.76,0,0.24,1),scale_40ms_cubic-bezier(0.76,0,0.24,1),opacity_40ms_cubic-bezier(0.76,0,0.24,1)]">
                      <div className="p-1">
                        {/* Official More send options menu (sampled live): Add to queue · Ctrl ⏎; width w-[270px] per bundle */}
                        {/* Working-session escape: interrupts the live turn and
                            sends now (server cancels → settle flush fires it). */}
                        {statusState.enum === 'working' && (
                          <button
                            role="menuitem"
                            onClick={() => {
                              const text = input.trim()
                              setSendOptOpen(false)
                              if (text) { setInput(''); void queueOpReq({ op: 'send_now', message: text }) }
                            }}
                            className="flex w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-[13px] outline-none hover:bg-tint-secondary"
                          >
                            {t('composer.sendNow')}
                          </button>
                        )}
                        <button
                          role="menuitem"
                          onClick={() => {
                            const text = input.trim()
                            setSendOptOpen(false)
                            if (text) { setInput(''); void queueSend(text) }
                          }}
                          className="flex w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-[13px] outline-none hover:bg-tint-secondary"
                        >
                          {t('composer.addToQueue')}
                          <span className="ml-auto text-[11px] text-muted-foreground">Ctrl ⏎</span>
                        </button>
                      </div>
                    </div>,
                    document.body,
                  )}
                </div>}
              </div>
            </div>
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
