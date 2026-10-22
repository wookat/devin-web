import { useCallback, useRef, useState, type Dispatch, type SetStateAction, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { ArrowUp, ChevronDown, Circle, Loader2, Plus, Settings2, Sparkles, Square } from 'lucide-react'
import { type ViewerCaps } from '@/lib/viewer'
import { cn } from '@/lib/utils'
import { type LocalCfg, type LocalCfgOption, type SessionDetail, LOCAL_MODE_ICONS, VERSION_LABEL } from './pageBits'
import { type ComposerMetaT } from './composerMeta'
import { type ReducedStatus } from './statusReduce'
import { OfficialGlyph } from './glyphs'
import { ATTACH_MENU_ICONS, MODE_CHECK_ICON } from '@/lib/officialMenuIcons'
import ModelPicker from './ModelPicker'
import { VoiceButton } from './VoiceButton'
import { useCollapseLevel } from './useCollapseLevel'
import { type DraftQuote } from './ComposerFooter'

type LocalCfgGroup = NonNullable<LocalCfg['options']>[number]

/** Official toolbar row (sampled live 2026-09-01): min-h-7, 28px round icon buttons with 18px
 *  glyphs, mode pill h-7 rounded-full 1px border px-1.5 13/18, right cluster gap-1 with mic +
 *  a rounded-full foreground send group (opacity .5 when disabled) whose ⌄ split segment only
 *  expands once there is text. Left cluster = "+" attach/mention menu (+ hidden
 *  file inputs); right cluster = pill group (session-mode + model pills +
 *  context meter — they overflow into the "+" menu at pillTier≥2/3), agent
 *  chip, voice, stop, and the send group + "More send options" menu. */
function ComposerToolbar({ isVisitor, caps, uploading, upload, isDraft, openMention, localModeGroup, localModeOpt, localModeCurrent, sModeOpen, setSModeOpen, modeOpen, setModeOpen, modelPillLabel, cfgFetched, pillVersion, localCfg, effortGroup, speedGroup, extraGroups, chooseLocalOption, chooseLocalOptions, detail, sessionAgent, composerMeta, sending, statusState, status, control, controlling, input, setInput, send, queueOpReq, queueSend }: {
  isVisitor: boolean
  caps: ViewerCaps
  uploading: boolean
  upload: (file: File) => void
  isDraft: boolean
  openMention: (cat: string) => void
  localModeGroup: LocalCfgGroup | undefined
  localModeOpt: LocalCfgOption | undefined
  localModeCurrent: string | null | undefined
  sModeOpen: boolean
  setSModeOpen: Dispatch<SetStateAction<boolean>>
  modeOpen: boolean
  setModeOpen: Dispatch<SetStateAction<boolean>>
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
  composerMeta: ComposerMetaT | null
  sending: boolean
  statusState: ReducedStatus
  status: string
  control: (action: 'pause' | 'resume') => void
  controlling: boolean
  input: string
  setInput: Dispatch<SetStateAction<string>>
  send: (preset?: string, extraQuotes?: DraftQuote[]) => void
  queueOpReq: (payload: { op: string; id?: string; ids?: string[]; held?: boolean; message?: string }) => Promise<boolean>
  queueSend: (text: string) => void
}) {
  const { t } = useTranslation()
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

  return (
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
  )
}

export { ComposerToolbar };
