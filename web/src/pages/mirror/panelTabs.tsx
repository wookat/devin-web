import { useEffect, useRef, type ReactNode } from 'react'
import { LayoutDashboard, Terminal, SquareTerminal, BookOpen } from 'lucide-react'
import { type TimelineItem } from '@/components/Timeline'
import { PanelAgentsIcon, PanelAttachmentsIcon, PanelChangesIcon, PanelComputerIcon, PanelDiffIcon, PanelEditorIcon, PanelProgressIcon, PanelSidechatIcon, PanelShellIcon, PanelTasksIcon, PanelWorklogIcon, type PanelIconProps } from '@/components/panelTabIcons'

type PanelKey = 'progress' | 'changes' | 'computer' | 'shell' | 'term' | 'worklog' | 'files' | 'dashboard' | 'sidechat' | 'editor' | 'agents' | 'resources'

const OFFICIAL_TAB_ID: Record<PanelKey, string | null> = {
  computer: 'browser',
  editor: 'vscode',
  changes: 'diff',
  shell: 'shell',
  term: 'term',
  worklog: 'worklog',
  agents: 'agents',
  progress: 'todo',
  sidechat: 'sidechain',
  files: 'attachments',
  dashboard: 'dashboard',
  resources: null,
}

const MIRROR_TAB_ID: Record<string, PanelKey | null> = Object.fromEntries(
  Object.entries(OFFICIAL_TAB_ID)
    .filter(([, official]) => official)
    .map(([mirror, official]) => [official, mirror]),
) as Record<string, PanelKey | null>

function useUrlParamSync(name: string, value: string | null, defaultValue: string | null, options: { enabled?: boolean; initialized?: boolean } = {}): void {
  const { enabled = true, initialized = true } = options
  const pathnameRef = useRef<string | null>(null)
  useEffect(() => {
    if (!enabled || !initialized) {
      pathnameRef.current = null
      return
    }
    if (pathnameRef.current === null) pathnameRef.current = window.location.pathname
    if (window.location.pathname !== pathnameRef.current) return
    const url = new URL(window.location.href)
    if (value && value !== defaultValue) url.searchParams.set(name, value)
    else url.searchParams.delete(name)
    if (url.toString() !== window.location.href) {
      window.history.replaceState(window.history.state, '', url.toString())
    }
  }, [defaultValue, enabled, initialized, name, value])
}

/** Searchable text of a timeline item for Ctrl+F (lowercased). */
function findItemText(it: TimelineItem): string {
  const parts: (string | undefined)[] = [
    it.title, it.body, it.output, it.terminal, it.suffix,
    ...(it.actions ?? []), ...(it.answers ?? []),
    ...(it.questions ?? []).map((q) => q.question),
    ...(it.resultFiles ?? []),
    ...(it.nested ?? []).map((n) => n.label),
    ...(it.fileUpdates ?? []).map((f) => f.file_path),
    ...(it.subagent?.actions ?? []).map((a) => a.label),
    it.mcp?.toolName, it.mcp?.input, it.mcp?.output,
    it.todos?.map((t) => t.content).join(' '),
  ]
  return parts.filter(Boolean).join('\n').toLowerCase()
}

function prNumber(pr: { pr_url?: string; number?: number }): string | null {
  if (pr.number !== undefined && Number.isFinite(pr.number)) return String(pr.number)
  const match = pr.pr_url?.match(/\/pull\/(\d+)(?:[/?#]|$)/)
  return match?.[1] || null
}

function serializeOfficialTab(panel: string, prs: { pr_url?: string; number?: number }[], files: { href: string; name: string }[]): string | null {
  if (panel.startsWith('pr:')) {
    const url = panel.slice(3)
    const pr = prs.find((item) => item.pr_url === url)
    const number = pr && prNumber(pr)
    return number ? `pr:${number}` : null
  }
  if (panel.startsWith('file:')) {
    const href = panel.slice(5)
    return files.find((file) => file.href === href)?.name || null
  }
  return OFFICIAL_TAB_ID[panel as PanelKey] || null
}

function parseOfficialTab(
  value: string,
  prs: { pr_url?: string; number?: number }[],
  files: { href: string; name: string; raw?: boolean }[],
): { panel: string; file?: { href: string; name: string; raw?: boolean } } | null {
  const fixed = MIRROR_TAB_ID[value] || (value === 'progress' ? 'worklog' : null)
  if (fixed) return { panel: fixed }
  if (value === 'pr' || value.startsWith('pr:')) {
    const wanted = value.startsWith('pr:') ? value.slice(3) : null
    const pr = prs.find((item) => !wanted || prNumber(item) === wanted)
    return pr?.pr_url ? { panel: `pr:${pr.pr_url}` } : null
  }
  const file = files.find((item) => item.name.toLowerCase() === value.toLowerCase())
  return file ? { panel: `file:${file.href}`, file } : null
}

// Official Add tab menu order (sampled live): Computer, Editor, Changes, Shell, Progress, Agents, Tasks, Side chat, Attachments
type PanelIcon = (props: PanelIconProps) => ReactNode
const PANELS: Record<PanelKey, { label: string; desc: string; Icon: PanelIcon; MenuIcon: PanelIcon }> = {
  computer: { label: 'Computer', desc: "Watch and control Devin's Computer", Icon: PanelComputerIcon, MenuIcon: PanelComputerIcon },
  editor: { label: 'Editor', desc: "Full control of Devin's machine", Icon: PanelEditorIcon, MenuIcon: PanelEditorIcon },
  changes: { label: 'Changes', desc: "See Devin's file edits", Icon: PanelDiffIcon, MenuIcon: PanelChangesIcon },
  shell: { label: 'Shell', desc: "View Devin's command history", Icon: PanelShellIcon, MenuIcon: PanelShellIcon },
  term: { label: 'Terminal', desc: 'Interactive shell in the workspace', Icon: SquareTerminal, MenuIcon: SquareTerminal },
  worklog: { label: 'Progress', desc: "Step through Devin's work", Icon: PanelWorklogIcon, MenuIcon: PanelProgressIcon },
  agents: { label: 'Agents', desc: "Manage this session's child sessions", Icon: PanelAgentsIcon, MenuIcon: PanelAgentsIcon },
  progress: { label: 'Tasks', desc: "View Devin's latest task list", Icon: PanelTasksIcon, MenuIcon: PanelTasksIcon },
  sidechat: { label: 'Side chat', desc: 'Ask questions without interrupting main agent', Icon: PanelSidechatIcon, MenuIcon: PanelSidechatIcon },
  files: { label: 'Attachments', desc: 'Files Devin creates like markdown', Icon: PanelAttachmentsIcon, MenuIcon: PanelAttachmentsIcon },
  dashboard: { label: '看板', desc: '子会话上报的看板数据', Icon: LayoutDashboard, MenuIcon: LayoutDashboard },
  resources: { label: 'Resources', desc: 'Agent 规则 / Skills / 计划 / 配置', Icon: BookOpen, MenuIcon: BookOpen },
}
const ADD_TAB_ORDER: PanelKey[] = ['computer', 'editor', 'changes', 'shell', 'term', 'worklog', 'agents', 'progress', 'sidechat', 'dashboard', 'files', 'resources']


export { type PanelKey, OFFICIAL_TAB_ID, MIRROR_TAB_ID, useUrlParamSync, findItemText, prNumber, serializeOfficialTab, parseOfficialTab, type PanelIcon, PANELS, ADD_TAB_ORDER };
