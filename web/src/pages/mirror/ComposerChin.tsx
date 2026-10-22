import { useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { AlertTriangle, Check, ChevronDown, Lightbulb, Sparkles, X } from 'lucide-react'
import { adminFetch } from '@/lib/api'
import { type TimelineItem } from '@/components/Timeline'
import { BandItem } from '@/components/BeardBand'
import { cn } from '@/lib/utils'
import { type ComposerMetaT } from './composerMeta'
import DirPicker from './DirPicker'
import LocalPicker, { type DraftTarget } from './LocalPicker'
import { type DraftQuote } from './ComposerFooter'

/** The BeardBand chin stack: send-error retry · interrupted-turn resume · dead
 *  subagent respawn · control message · persona banner · env-suggestion · and
 *  the draft run-target row (LocalPicker + DirPicker + agent pill). Rendered
 *  only when the parent's chin condition holds; each row self-hides. */
function ComposerChin({ sendErr, send, interrupted, resumeInterrupted, dismissInterrupted, subDead, respawnSub, controlMsg, persona, personaBusy, cyclePersonaMode, askPersonaNow, isVisitor, isDraft, envBannerGone, items, dismissEnvBanner, id, draftTarget, setDraftTarget, draftSshCwd, setDraftSshCwd, draftCwd, setDraftCwd, recentCwds, composerMeta, setComposerMeta, draftAgent, setDraftAgent }: {
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
  isVisitor: boolean
  isDraft: boolean
  envBannerGone: boolean
  items: TimelineItem[]
  dismissEnvBanner: (eid: string) => void
  id: string
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
}) {
  const { t } = useTranslation()
  const [agentMenuOpen, setAgentMenuOpen] = useState(false)
    const [envSaveState, setEnvSaveState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle')
  const agentBtnRef = useRef<HTMLButtonElement | null>(null)

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
  )
}

export { ComposerChin };
