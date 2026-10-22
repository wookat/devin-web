import { useTranslation } from 'react-i18next'
import { type TimelineItem } from '@/components/Timeline'
import { type PublicMessage, type DashboardData } from '@/lib/api'
import { attachmentUrl, type ViewerCaps } from '@/lib/viewer'
import Dashboard from '@/components/Dashboard'
import TermPanel from '@/components/TermPanel'
import { PanelPullRequestIcon } from '@/components/panelTabIcons'
import { type SessionDetail } from './pageBits'
import { type MirrorTreeSession } from './treeCache'
import { type PanelKey, PANELS, prNumber, type PanelIcon } from './panelTabs'
import { type ReducedStatus } from './statusReduce'
import { type WfAgentEventState, AgentsPanel } from './AgentsPanel'
import { PermissionSidebarPanel } from './Permission'
import { FileViewerPanel, ShellPanel, AttachmentsPanel } from './ViewerPanels'
import { SidechatPanel } from './Sidechat'
import { PrPanel } from './PrPanel'
import { ProgressPanel, WorklogPanel } from './ProgressPanels'
import { ChangesPanel } from './ChangesPanel'
import { ComputerPanel } from './ComputerPanel'
import { WorkspacePanel } from './WorkspacePanel'
import { ResourcesPanel, SubagentsPanel } from './ResourcePanels'

type WfState = {
  status: Map<string, string>
  agents: Map<string, Map<string, string>>
  runs: { runId: string; name?: string }[]
  agentEvents: Map<string, Map<string, WfAgentEventState>>
}

type PanelPr = { title?: string; state: string; pr_url: string; draft: boolean; number?: number; additions?: number; deletions?: number; authorLogin?: string }

function PanelContent({ panel, displayedPanelKeys, permSide, isVisitor, tabs, fileTabs, detailMsgs, id, mediaTok, items, allItems, status, statusState, stepChanges, onClearStep, focusFile, woke, control, openTab, openPr, worklogJump, caps, dashboard, scAnchor, onStage, wf, wfRunId, setWfRunId, detail, openTreeSession, panelPrs, openFileTab }: {
  panel: PanelKey | string
  displayedPanelKeys: (PanelKey | string)[]
  permSide: TimelineItem | null
  isVisitor: boolean
  tabs: PanelKey[]
  fileTabs: { href: string; name: string; raw?: boolean }[]
  detailMsgs: PublicMessage[]
  id: string
  mediaTok: string
  items: TimelineItem[]
  allItems: TimelineItem[]
  status: string
  statusState: ReducedStatus
  stepChanges: TimelineItem | null
  onClearStep: () => void
  focusFile: { path: string; n: number } | null
  woke: boolean
  control: (action: 'pause' | 'resume') => Promise<void> | void
  openTab: (key: PanelKey) => void
  openPr: (prUrl: string) => void
  worklogJump: string | null
  caps: ViewerCaps
  dashboard: { data: DashboardData | null; updatedAt?: string }
  scAnchor: { id: string; ts: string } | null
  onStage: (f: { url: string; name: string; size: number }) => void
  wf: WfState
  wfRunId: string | null
  setWfRunId: (v: string | null) => void
  detail: SessionDetail | null
  openTreeSession: (s: MirrorTreeSession) => void
  panelPrs: PanelPr[]
  openFileTab: (href: string, name: string, raw?: boolean) => void
}) {
  const { t } = useTranslation()
  function renderPanel(key: PanelKey | string) {
    if (key.startsWith('file:')) {
      const f = fileTabs.find((t) => `file:${t.href}` === key)
      if (!f) return null
      const vers: { href: string; ts: string }[] = []
      for (const m of detailMsgs) {
        for (const a of m.attachments || []) {
          if (a.name === f.name) vers.push({ href: attachmentUrl(id, a.url, mediaTok), ts: m.timestamp })
        }
      }
      return <FileViewerPanel href={f.href} name={f.name} initialRaw={f.raw} versions={vers} />
    }
    if (key.startsWith('pr:')) return isVisitor ? null : <PrPanel id={id} prUrl={key.slice(3)} />
    if (isVisitor && !tabs.includes(key as PanelKey)) return null
    switch (key as PanelKey) {
      case 'progress': return <ProgressPanel items={items} id={id} status={status} />
      case 'changes': return <ChangesPanel items={allItems} sessionId={id} step={stepChanges} onClearStep={onClearStep} focus={focusFile} />
      case 'computer': return <ComputerPanel
        id={id}
        items={allItems}
        mt={mediaTok}
        asleep={!woke && !(woke || ['working', 'running', 'resumed', 'restored', 'initializing', 'resume_requested', 'resume_requested_frontend'].includes(statusState.enum))}
        onWake={isVisitor ? undefined : () => void control('resume')}
        canControl={!isVisitor}
        showLiveDesktop={woke || ['working', 'running', 'resumed', 'restored', 'initializing', 'resume_requested', 'resume_requested_frontend'].includes(statusState.enum)}
      />
      case 'shell': return <ShellPanel items={items} />
      case 'term': return isVisitor ? null : <TermPanel id={id} />
      case 'worklog': return <WorklogPanel id={id} items={allItems} mt={mediaTok} onGoLive={() => openTab('computer')} onWake={isVisitor ? undefined : () => { void control('resume'); openTab('computer') }} jumpTo={worklogJump} finished={status === 'expired' || status === 'stopped'} asleep={(status === 'sleeping' || status === 'finished') && !woke} canLive={caps.showComputer && allItems.some((it) => it.kind === 'computer')} />
      case 'files': return <AttachmentsPanel messages={detailMsgs} sessionId={id} mt={mediaTok} onOpenTab={openFileTab} />
      case 'dashboard': return <div className="p-3"><Dashboard data={dashboard.data} updatedAt={dashboard.updatedAt} /></div>
      case 'sidechat': return isVisitor ? null : <SidechatPanel id={id} anchor={scAnchor} onStage={onStage} />
      case 'editor': return isVisitor ? null : <WorkspacePanel id={id} />
      case 'resources': return isVisitor ? null : <ResourcesPanel id={id} />
      case 'agents': return isVisitor ? null : wf.runs.length ? (
        <AgentsPanel
          runs={wf.runs}
          selected={wfRunId}
          onSelect={setWfRunId}
          agentEvents={wf.agentEvents}
          devinId={detail?.session.devin_session_id || ''}
          onOpenSession={(pid, title) => openTreeSession({ devin_id: pid, title } as MirrorTreeSession)}
        />
      ) : (
        <SubagentsPanel id={id} />
      )
    }
  }
  const computerAsleep = !woke && !(woke || ['working', 'running', 'resumed', 'restored', 'initializing', 'resume_requested', 'resume_requested_frontend'].includes(statusState.enum))
  const newestPr = [...panelPrs].sort((a, b) => Number(b.number ?? prNumber(b) ?? 0) - Number(a.number ?? prNumber(a) ?? 0))[0]
  const landingRows: { key: string; label: string; description: string; MenuIcon: PanelIcon; disabled?: boolean; onClick: () => void }[] = [
    { key: 'computer', label: t('panels.computer'), description: t('panels.computer_d'), MenuIcon: PANELS.computer.MenuIcon, onClick: () => openTab('computer') },
    { key: 'editor', label: t('panels.editor'), description: computerAsleep ? t('panels.editorWake') : t('panels.editor_d'), MenuIcon: PANELS.editor.MenuIcon, disabled: computerAsleep, onClick: () => openTab('editor') },
    { key: 'changes', label: t('panels.changes'), description: t('panels.changes_d'), MenuIcon: PANELS.changes.MenuIcon, onClick: () => openTab('changes') },
    { key: 'worklog', label: t('panels.worklog'), description: t('panels.worklog_d'), MenuIcon: PANELS.worklog.MenuIcon, onClick: () => openTab('worklog') },
    { key: 'agents', label: t('panels.agents'), description: t('panels.agents_d'), MenuIcon: PANELS.agents.MenuIcon, onClick: () => openTab('agents') },
    { key: 'sidechat', label: t('panels.sidechat'), description: t('panels.sidechat_d'), MenuIcon: PANELS.sidechat.MenuIcon, onClick: () => openTab('sidechat') },
    ...(newestPr ? [{ key: 'pull-requests', label: 'Pull requests', description: 'View proposed code changes', MenuIcon: PanelPullRequestIcon, onClick: () => openPr(newestPr.pr_url) }] : []),
  ]
  const showLanding = !isVisitor && displayedPanelKeys.length === 0
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
        {permSide ? <PermissionSidebarPanel item={permSide} /> : showLanding ? (
          <div className="flex flex-1 flex-col">
            <div className="flex flex-1 items-center justify-center pb-20">
              <div className="flex w-[320px] flex-col gap-px">
                {landingRows.map((row) => (
                  <button
                    key={row.key}
                    type="button"
                    disabled={row.disabled}
                    onClick={row.onClick}
                    className="group/menu-item text-foreground hover:bg-tint-secondary disabled:text-muted-foreground flex w-full cursor-pointer select-none items-start gap-2 rounded-md px-2 py-[7px] text-left outline-none disabled:cursor-default disabled:hover:bg-transparent"
                  >
                    <span className="text-muted-foreground group-enabled/menu-item:group-hover/menu-item:text-foreground flex size-[18px] flex-shrink-0 items-center justify-center"><row.MenuIcon size={18} /></span>
                    <div className="min-w-0 flex-1"><div className="text-[13px] leading-[18px]">{row.label}</div><div className="text-muted-foreground text-[12px] leading-[16px]">{row.description}</div></div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : renderPanel(panel)}
      </div>
    </div>
  )
}


export { PanelContent };
