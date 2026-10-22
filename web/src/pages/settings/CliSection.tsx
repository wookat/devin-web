import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SquareTerminal, X } from 'lucide-react'
import { adminFetch } from '@/lib/api'
import TermPanel from '@/components/TermPanel'
import { ExtConsole } from '@/pages/mirror/ResourcePanels'
import { Section } from './atoms'

/* Devin CLI tools — moved out of the sidebar LocalDock (the session page only
 * needs account/add-account). Runs `devin.exe` verbs through
 * /api/admin/cli/run; cloud ssh / port-forward tunnels ride the shared
 * /ws/term transport. */

type CliResult = { ok: boolean; code: number | null; output?: string; error?: string }

const CLI_CMDS: { cmd: string; label: string; arg?: string; write?: boolean; desc: string }[] = [
  { cmd: 'version', label: 'version', desc: 'CLI 版本' },
  { cmd: 'auth-status', label: 'auth status', desc: '登录态' },
  { cmd: 'doctor', label: 'doctor', desc: '环境诊断' },
  { cmd: 'models', label: 'models list', desc: '全量模型目录（含定价/上下文）' },
  { cmd: 'rules', label: 'rules list', desc: 'Agent 规则' },
  { cmd: 'rules-paths', label: 'rules paths', desc: '规则目录位置' },
  { cmd: 'skills', label: 'skills list', desc: 'Skills 清单' },
  { cmd: 'skills-paths', label: 'skills paths', desc: 'Skills 目录位置' },
  { cmd: 'plugins', label: 'plugins list', desc: '已装插件' },
  { cmd: 'sessions', label: 'ls --json', desc: '当前目录会话（CLI 视角）' },
  { cmd: 'sandbox-setup', label: 'sandbox setup', desc: '沙箱前置条件' },
  { cmd: 'rule-show', label: 'rules show', arg: 'name', desc: '规则详情' },
  { cmd: 'skill-show', label: 'skills show', arg: 'name', desc: 'Skill 详情' },
  { cmd: 'plugin-info', label: 'plugins info', arg: 'name', desc: '插件详情' },
  { cmd: 'plugin-install', label: 'plugins install', arg: 'source', write: true, desc: '安装插件（source/repo）' },
  { cmd: 'plugin-update', label: 'plugins update', arg: 'name', write: true, desc: '更新插件到最新 HEAD' },
  { cmd: 'plugin-remove', label: 'plugins remove', arg: 'name', write: true, desc: '卸载插件' },
  { cmd: 'migrate-hooks', label: 'migrate hooks', write: true, desc: 'Windsurf hooks → Devin hooks' },
  { cmd: 'migrate-workflows', label: 'migrate workflows', write: true, desc: 'workflow 文件 → skills' },
  { cmd: 'update', label: 'update', write: true, desc: '检查并安装 CLI 更新' },
  { cmd: 'desktop', label: 'desktop', desc: '启动 Devin Desktop' },
]

export function CliTab() {
  const { t } = useTranslation()
  const [cliArg, setCliArg] = useState('')
  const [cliOut, setCliOut] = useState<string | null>(null)
  const [cliBusy, setCliBusy] = useState<string | null>(null)
  const [sshTarget, setSshTarget] = useState('')
  const [fwdPorts, setFwdPorts] = useState('')
  const [remoteRun, setRemoteRun] = useState<string | null>(null)

  const runCli = async (cmd: string, arg?: string, write?: boolean) => {
    if (cliBusy) return
    if (write && !window.confirm(`${t('dock.confirmWrite', { cmd })}`)) return
    setCliBusy(cmd); setCliOut(null)
    try {
      const r = await adminFetch<CliResult>('/api/admin/cli/run', { method: 'POST', body: JSON.stringify({ cmd, arg }) })
      setCliOut(r.ok ? (r.output || t('dock.noOutput')) : `exit ${r.code} — ${r.error || r.output || '失败'}`)
    } catch (e) { setCliOut((e as Error).message) } finally { setCliBusy(null) }
  }

  return (
    <>
      <Section title={t('dock.cliBin')}>
        <div className="flex flex-col gap-[10px] rounded-[6px] px-[12px] py-[10px]">
          <p className="text-[13px] text-muted-foreground">{t('set.cliDesc')}</p>
          <input
            className="h-[30px] w-full rounded-[6px] border border-border-secondary bg-card px-2 text-[13px] outline-none placeholder:text-muted-foreground focus:border-accent-primary"
            placeholder={t('dock.argPh')}
            value={cliArg}
            onChange={(e) => setCliArg(e.target.value)}
          />
          <div className="flex flex-wrap gap-1.5">
            {CLI_CMDS.map((c) => (
              <button
                key={c.cmd}
                disabled={!!cliBusy || (!!c.arg && !cliArg.trim())}
                title={t('dock.cmd.' + c.cmd, { defaultValue: c.desc }) + (c.arg ? `${t('dock.needsArg', { a: c.arg })}` : '') + (c.write ? t('dock.writeOp') : '')}
                onClick={() => void runCli(c.cmd, c.arg ? cliArg.trim() : undefined, c.write)}
                className={`cursor-pointer rounded-[6px] border px-2 py-1 text-[12px] disabled:opacity-40 ${c.write ? 'border-amber-500/40 text-amber-600 hover:bg-amber-500/10' : 'border-border hover:bg-accent'}`}
              >
                {cliBusy === c.cmd ? '…' : c.label}
              </button>
            ))}
          </div>
          {cliOut !== null && (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-[6px] border border-border bg-tint-secondary p-2 font-mono text-[12px] leading-snug">{cliOut}</pre>
          )}
        </div>
      </Section>

      <Section title={t('dock.cloudSsh')}>
        <div className="flex flex-col gap-[10px] rounded-[6px] px-[12px] py-[10px]">
          <p className="text-[13px] text-muted-foreground">{t('set.cliSshDesc')}</p>
          <input
            className="h-[30px] w-full rounded-[6px] border border-border-secondary bg-card px-2 text-[13px] outline-none placeholder:text-muted-foreground focus:border-accent-primary"
            placeholder={t('dock.sidPh')}
            value={sshTarget}
            onChange={(e) => setSshTarget(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <input
              className="h-[30px] min-w-0 flex-1 rounded-[6px] border border-border-secondary bg-card px-2 text-[13px] outline-none placeholder:text-muted-foreground focus:border-accent-primary"
              placeholder={t('dock.portPh')}
              value={fwdPorts}
              onChange={(e) => setFwdPorts(e.target.value)}
            />
            <button
              disabled={!sshTarget.trim() || !!remoteRun}
              onClick={() => setRemoteRun(`run=ssh&arg=${encodeURIComponent(sshTarget.trim())}`)}
              className="flex h-[28px] cursor-pointer items-center gap-1 rounded-[6px] border border-border bg-card px-2 text-[13px] font-medium hover:bg-tint-tertiary disabled:opacity-40"
            >
              <SquareTerminal size={13} /> ssh
            </button>
            <button
              disabled={!sshTarget.trim() || !fwdPorts.trim() || !!remoteRun}
              onClick={() => setRemoteRun(`run=forward&arg=${encodeURIComponent(sshTarget.trim())}&ports=${encodeURIComponent(fwdPorts.trim())}`)}
              className="flex h-[28px] cursor-pointer items-center gap-1 rounded-[6px] border border-border bg-card px-2 text-[13px] font-medium hover:bg-tint-tertiary disabled:opacity-40"
            >{t('dock.forward')}</button>
          </div>
          {remoteRun && (
            <div className="relative h-64 overflow-hidden rounded-[6px] border border-border">
              <button
                onClick={() => setRemoteRun(null)}
                title={t('dock.disconnect')}
                className="absolute right-1.5 top-1.5 z-10 flex items-center gap-1 rounded bg-black/50 px-1.5 py-0.5 text-[11px] text-neutral-200 hover:bg-black/70"
              >
                <X size={11} /> {t('dock.disconnectBtn')}
              </button>
              <TermPanel id="" run={remoteRun} />
            </div>
          )}
        </div>
      </Section>

      <Section title={t('set.extConsole')}>
        <div className="rounded-[6px] px-[12px] py-[10px]">
          <p className="mb-2 text-[13px] text-muted-foreground">{t('set.extConsoleDesc')}</p>
          <ExtConsole id="" />
        </div>
      </Section>
    </>
  )
}
