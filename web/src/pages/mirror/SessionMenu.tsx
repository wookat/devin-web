import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { ChevronRight, Check, ArrowUpRight, Square, Link2, X, RotateCcw, Laptop, Folder as FolderIcon, Pencil, Share2, GitFork } from 'lucide-react'
import { OArchive } from '../../components/officialIcons'
import { adminFetch, type AdminSession } from '@/lib/api'
import { Combo } from '@/components/ui'
import { cn } from '@/lib/utils'
import { type MirrorTreeSession } from './treeCache'
import { type SessionDetail } from './pageBits'
import { SessionSettingsGlyph, HeaderMenuPortal } from './glyphs'

const settingsRowCls = 'text-foreground text-[13px] leading-[18px] flex w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 outline-none [&>svg]:mx-px [&>svg]:size-4 [&>svg]:shrink-0 hover:bg-tint-secondary'
const settingsSeparatorCls = 'mx-2 h-[9px] bg-border bg-clip-content py-1'

/* Header gear menu — session-scoped actions only (app prefs live in
 * /settings, service ops in the sidebar org menu / LocalDock gear). Owns the
 * whole open/sub-menu/position state cluster. */
function SessionMenu({ detail, id, isSub, isDevinSession, current, treeNode, folderOrder, userMsgCount, reloadDetail, loadTree, onControlMsg }: {
  detail: SessionDetail | null
  id: string
  isSub: boolean
  isDevinSession: boolean
  current: AdminSession | undefined
  treeNode: MirrorTreeSession | null
  folderOrder: string[]
  userMsgCount: number
  reloadDetail: () => void
  loadTree: () => void
  onControlMsg: (msg: string) => void
}) {
  const { t } = useTranslation()
  const nav = useNavigate()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSub, setSettingsSub] = useState<'none' | 'folder' | 'rename' | 'send'>('none')
  const [renameDraft, setRenameDraft] = useState('')
  const [copied, setCopied] = useState(false)
  const [folderSubPos, setFolderSubPos] = useState<{ left: number; top: number } | null>(null)
  const settingsButtonRef = useRef<HTMLButtonElement>(null)
  const headerMenuAnchorRef = useRef<HTMLButtonElement | null>(null)
  const [headerMenuPos, setHeaderMenuPos] = useState({ left: 5, top: 0, width: 280 })
  const setControlMsg = onControlMsg
  const updateHeaderMenuPosition = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return
    const rect = button.getBoundingClientRect()
    const width = Math.min(280, window.innerWidth - 10)
    setHeaderMenuPos({
      left: Math.max(5, Math.min(rect.right - width, window.innerWidth - 5 - width)),
      top: rect.bottom + 2,
      width,
    })
  }, [])
  const closeHeaderMenus = useCallback(() => {
    setSettingsOpen(false)
    setSettingsSub('none')
    requestAnimationFrame(() => headerMenuAnchorRef.current?.focus())
  }, [])
  const toggleHeaderMenu = useCallback(() => {
    const button = settingsButtonRef.current
    headerMenuAnchorRef.current = button
    if (settingsOpen) {
      closeHeaderMenus()
      return
    }
    setSettingsOpen(true)
    setSettingsSub('none')
    updateHeaderMenuPosition(button)
  }, [closeHeaderMenus, settingsOpen, updateHeaderMenuPosition])
  useEffect(() => {
    if (!settingsOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      closeHeaderMenus()
    }
    const reposition = () => updateHeaderMenuPosition(headerMenuAnchorRef.current)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [closeHeaderMenus, settingsOpen, updateHeaderMenuPosition])
  return (
    <div className="relative flex items-center gap-px">
      <button
        ref={settingsButtonRef}
        type="button"
        aria-label="Session settings"
        aria-expanded={settingsOpen}
        onClick={() => toggleHeaderMenu()}
        className={cn('flex size-7 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-[18px]', settingsOpen && 'bg-accent')}
      >
        <SessionSettingsGlyph />
      </button>
      {settingsOpen && detail && (
        <HeaderMenuPortal open pos={headerMenuPos} onClose={closeHeaderMenus}>
        <div
          role="menu"
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); closeHeaderMenus() } }}
          className="absolute right-0 top-8 z-20 w-[280px] max-w-[calc(100vw-10px)] overflow-hidden rounded-[10px] bg-[rgba(255,255,255,0.94)] p-0 text-[13px] leading-[18px] outline outline-1 outline-black/[.06] shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)] backdrop-blur-[8px] dark:bg-[#1f1f1f]/[.94]"
        >
          {/* Session-scoped actions only — app prefs live in /settings,
              service ops in the sidebar org menu / LocalDock gear. */}
          <div className="p-1">
          {settingsSub === 'rename' ? (
            <input
              autoFocus
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === 'Escape') { setSettingsSub('none'); return }
                if (e.key === 'Enter' && renameDraft.trim()) {
                  const title = renameDraft.trim()
                  setSettingsOpen(false); setSettingsSub('none')
                  await adminFetch('/api/admin/mirror/session-title', { method: 'POST', body: JSON.stringify({ devin_id: detail.session.devin_session_id, title }) }).catch(() => null)
                  reloadDetail(); loadTree()
                }
              }}
              className="mb-0.5 h-[30px] w-full rounded-md border border-border bg-transparent px-2 text-[13px] outline-none"
            />
          ) : (
            <button
              role="menuitem"
              onMouseEnter={() => setSettingsSub('none')}
              onClick={() => { setRenameDraft(current?.title || current?.devin_title || ''); setSettingsSub('rename') }}
              className={settingsRowCls}
            >
              <Pencil size={14} className="text-muted-foreground" /> Rename
            </button>
          )}
          {!isSub && <div className="relative">
            <button
              role="menuitem"
              aria-haspopup="menu"
              onMouseEnter={(e) => {
                setSettingsSub('folder')
                const r = e.currentTarget.getBoundingClientRect()
                setFolderSubPos({ left: Math.max(8, r.left - 226), top: Math.min(r.top, Math.max(8, window.innerHeight - 296)) })
              }}
              className={settingsRowCls}
            >
              <FolderIcon size={14} className="text-muted-foreground" /> Folder
              {treeNode?.folder && <span className="ml-auto max-w-24 truncate text-[12px] text-muted-foreground">{treeNode.folder}</span>}
              <ChevronRight size={13} className={cn('text-muted-foreground', !treeNode?.folder && 'ml-auto')} />
            </button>
            {settingsSub === 'folder' && folderSubPos && createPortal(
              <div role="menu" style={{ left: folderSubPos.left, top: folderSubPos.top }} onMouseLeave={() => setSettingsSub('none')} className="fixed z-50 max-h-72 w-56 overflow-y-auto rounded-[10px] border border-border bg-card p-1 shadow-lg">
                {folderOrder.map((f) => (
                  <button
                    key={f}
                    role="menuitem"
                    onClick={async () => {
                      setSettingsOpen(false); setSettingsSub('none')
                      await adminFetch('/api/admin/mirror/session-folder', { method: 'POST', body: JSON.stringify({ devin_id: detail.session.devin_session_id, folder: f }) }).catch(() => null)
                      loadTree()
                    }}
                    className={settingsRowCls}
                  >
                    <FolderIcon size={13} className="shrink-0 text-muted-foreground" />
                    <span className="truncate">{f}</span>
                    {treeNode?.folder === f && <Check size={13} className="ml-auto shrink-0" />}
                  </button>
                ))}
                {treeNode?.folder && (
                  <button
                    role="menuitem"
                    onClick={async () => {
                      setSettingsOpen(false); setSettingsSub('none')
                      await adminFetch('/api/admin/mirror/session-folder', { method: 'POST', body: JSON.stringify({ devin_id: detail.session.devin_session_id, folder: null }) }).catch(() => null)
                      loadTree()
                    }}
                    className={settingsRowCls}
                  >
                    <X size={13} className="text-muted-foreground" /> Remove from folder
                  </button>
                )}
                {folderOrder.length === 0 && <p className="px-2 py-1.5 text-[12px] text-muted-foreground">{t('tree.noFolders')}</p>}
              </div>,
              document.body,
            )}
          </div>}
            {!isSub && <button
            role="menuitem"
            onMouseEnter={() => setSettingsSub('none')}
            onClick={async () => {
              setSettingsOpen(false)
              const nowArchived = !detail.session.archived
              await adminFetch(`/api/admin/session/${id}/archive`, {
                method: 'POST',
                body: JSON.stringify({ archived: nowArchived }),
              })
              // An archived session leaves the sidebar — land on the
              // management page where the 已归档 group shows it.
              if (nowArchived) nav('/admin/sessions')
              else reloadDetail()
            }}
            className={settingsRowCls}
          >
            {detail.session.archived ? <><OArchive size={14} className="text-muted-foreground" /> {t('sp.unarchive')}</> : <><OArchive size={14} className="text-muted-foreground" /> {t('sp.archive')}</>}
          </button>}
          <div className={settingsSeparatorCls} />
          <button
            role="menuitem"
            onClick={() => {
              // share_url is null until the link is enabled — enabling
              // happens lazily here (opt-in is the point).
              void adminFetch<{ enabled: boolean; url: string | null }>(`/api/admin/session/${id}/share-link`, { method: 'POST', body: JSON.stringify({ enabled: true }) }).then((r) => {
                navigator.clipboard.writeText(window.location.origin + (r.url || `/admin/${id}`))
                reloadDetail()
              }).catch(() => navigator.clipboard.writeText(window.location.origin + `/admin/${id}`))
              setCopied(true); setTimeout(() => setCopied(false), 1500)
              setSettingsOpen(false); setSettingsSub('none')
            }}
            className={settingsRowCls}
          >
            {copied ? <Check size={13} /> : <Link2 size={13} className="text-muted-foreground" />} Copy session link
          </button>
          {/* Verified live on local acp: uploads the transcript to
              Cognition and returns an app.devin.ai share URL. Devin-private
              extension — hidden for sessions owned by other agents. */}
          {!isSub && isDevinSession && <button
            role="menuitem"
            onClick={async () => {
              setSettingsOpen(false); setSettingsSub('none')
              if (!confirm(t('menu.shareToCloudConfirm'))) return
              const r = await adminFetch<{ ok: boolean; url?: string; error?: string }>(`/api/admin/session/${id}/share`, { method: 'POST', body: JSON.stringify({}) }).catch(() => null)
              if (r?.ok && r.url) { navigator.clipboard.writeText(r.url); setControlMsg(t('menu.sharedOk', { url: r.url })) }
              else setControlMsg(r?.error || 'Share failed')
            }}
            className={settingsRowCls}
          >
            <Share2 size={13} className="text-muted-foreground" /> {t('menu.shareToCloud')}
          </button>}
          {/* Fork — native session/fork on agents that advertise it
              (opencode), transcript-seed fallback on devin. Dedicated
              agents report canFork:false and the item hides. */}
          {!isSub && detail.session.canFork && <button
            role="menuitem"
            onClick={async () => {
              setSettingsOpen(false); setSettingsSub('none')
              const r = await adminFetch<{ ok: boolean; id?: string; error?: string }>(`/api/admin/session/${id}/fork`, { method: 'POST', body: JSON.stringify({}) }).catch(() => null)
              if (r?.ok && r.id) nav(`/admin/${r.id}`)
              else setControlMsg(r?.error || t('menu.forkFailed'))
            }}
            className={settingsRowCls}
          >
            <GitFork size={13} className="text-muted-foreground" /> {t('menu.forkSession')}
          </button>}
          {/* Desktop "Open in new window" — each session can live in its
              own browser window. */}
          <button
            role="menuitem"
            onMouseEnter={() => setSettingsSub('none')}
            onClick={() => { setSettingsOpen(false); setSettingsSub('none'); window.open(`${window.location.origin}/admin/${id}`, '_blank', 'noopener') }}
            className={settingsRowCls}
          >
            <ArrowUpRight size={13} className="text-muted-foreground" /> {t('menu.openNewWindow')}
          </button>
          {!isSub && <div className="mt-1 border-t border-border px-2 pb-1 pt-2">
            <p className="mb-1 text-[12px] text-muted-foreground">{t('visitor.permission')}</p>
            <Combo
              className="w-full"
              value={detail.session.permission}
              onPick={async (v) => {
                await adminFetch(`/api/admin/session/${id}/permission`, { method: 'POST', body: JSON.stringify({ permission: v }) })
                reloadDetail()
              }}
              options={[
                { v: 'detailed', l: t('visitor.permDetailed') },
                { v: 'full', l: t('visitor.permChatFile') },
                { v: 'chat', l: t('visitor.permChat') },
                { v: 'readonly', l: t('visitor.permReadonly') },
              ]}
            />
          </div>}
          <div className={settingsSeparatorCls} />
          {/* Subagent (child session) controls: foreground/background +
              cancel — the desktop subagent semantics. */}
          {isSub && detail.session.subagent?.live && (
            <button
              role="menuitem"
              onClick={async () => {
                setSettingsOpen(false); setSettingsSub('none')
                const action = detail.session.subagent?.isBackground ? 'foreground' : 'background'
                const r = await adminFetch<{ ok: boolean; error?: string }>(`/api/admin/session/${id}/control`, { method: 'POST', body: JSON.stringify({ action }) }).catch(() => null)
                setControlMsg(r?.ok ? `Subagent → ${action}` : r?.error || 'Control failed')
                reloadDetail()
              }}
              className={settingsRowCls}
            >
              <Laptop size={13} className="text-muted-foreground" /> {detail.session.subagent.isBackground ? 'Bring to foreground' : 'Send to background'}
            </button>
          )}
          {!isSub && (
            <>
          {/* Kill the hosting acp process; next op respawns + replays
              session/load — the local analog of cloud "reboot VM". */}
          <button
            role="menuitem"
            onClick={async () => {
              setSettingsOpen(false); setSettingsSub('none')
              if (!confirm(t('menu.restartAgentConfirm'))) return
              const r = await adminFetch<{ ok: boolean }>(`/api/admin/session/${id}/restart`, { method: 'POST', body: JSON.stringify({}) }).catch(() => null)
              setControlMsg(r?.ok ? t('menu.agentRestarting') : t('menu.agentRestartFailed'))
            }}
            className={settingsRowCls}
          >
            <RotateCcw size={13} className="text-muted-foreground" /> {t('menu.restartAgent')}
          </button>
            </>
          )}
          {/* Verified live: {_cognition.ai/session/end} → dispatched.
              For a sub session the server maps end → subagent cancel.
              Devin-private extension — hidden on other agents' sessions. */}
          {(isSub || isDevinSession) && <button
            role="menuitem"
            onClick={async () => {
              setSettingsOpen(false); setSettingsSub('none')
              if (!confirm(isSub ? t('menu.endSubagentConfirm') : t('menu.endSessionConfirm'))) return
              const r = await adminFetch<{ ok: boolean; error: string }>(`/api/admin/session/${id}/end`, { method: 'POST', body: JSON.stringify({}) }).catch(() => null)
              setControlMsg(r?.ok ? (isSub ? t('menu.subagentCancelled') : t('menu.sessionEndSent')) : r?.error || t('menu.endFailed'))
              reloadDetail()
            }}
            className={settingsRowCls}
          >
            <Square size={13} className="text-muted-foreground" /> {isSub ? t('menu.endSubagent') : t('menu.endSession')}
          </button>}
          <div className={settingsSeparatorCls} />
          <div className="px-2 pb-1 pt-1.5 text-[12px] leading-[18px] text-muted-foreground">
            <div className="flex justify-between"><span>{t('am.userMsgs')}</span><span className="text-foreground">{userMsgCount}</span></div>
            {detail.session.platform && <div className="flex justify-between"><span>{t('am.platform')}</span><span className="text-foreground">{detail.session.platform}</span></div>}
            {detail.session.subagent && <div className="flex justify-between"><span>{t('am.subagent')}</span><span className="text-foreground">{[detail.session.subagent.profile, detail.session.subagent.model].filter(Boolean).join(' · ') || detail.session.subagent.agentId}</span></div>}
            {detail.dashboard_url && <p className="break-all pt-1 text-[11px] leading-[15px]">{t('tabs.dashboardPush')}：POST {window.location.origin}{detail.dashboard_url}</p>}
          </div>
          </div>
        </div>
        </HeaderMenuPortal>
      )}
    </div>
  )
}

export { SessionMenu }
