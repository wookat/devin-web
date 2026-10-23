import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminFetch } from '@/lib/api'
import { Card } from '@/components/ui'
import { RefreshCw, Plus, CheckCircle2, XCircle, Trash2 } from 'lucide-react'

interface AgentCheckInfo { installed: boolean; version: string | null; authed: boolean; detail: string }
interface AgentRow {
  id: string; label: string; command: string; args: string[]
  multiSession: boolean; versionArgs: string[]; env?: Record<string, string>
  shell: boolean; custom: boolean; enabled: boolean
  check: AgentCheckInfo | null
}

/** Settings → Agents: every registry entry (builtin + user) with install/auth
 *  probe status. Toggle/add rewrites the user layer (agents.json) wholesale —
 *  a builtin override is the same entry shape with enabled:false. */
export function AgentsTab() {
  const { t } = useTranslation()
  const [rows, setRows] = useState<AgentRow[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [add, setAdd] = useState({ id: '', label: '', command: '', args: '' })

  const load = (probe: boolean) => {
    setBusy(true)
    void adminFetch<{ agents: AgentRow[] }>(`/api/admin/agents${probe ? '?probe=1' : ''}`)
      .then((r) => setRows(r.agents))
      .catch((e) => setMsg(String(e?.message ?? e)))
      .finally(() => setBusy(false))
  }
  useEffect(() => { load(true) }, [])

  const save = (next: AgentRow[]) => {
    setBusy(true); setMsg('')
    const agents = next.map((a) => ({
      id: a.id, label: a.label, command: a.command, args: a.args,
      multiSession: a.multiSession, versionArgs: a.versionArgs,
      env: a.env, shell: a.shell, enabled: a.enabled,
    }))
    void adminFetch('/api/admin/agents', { method: 'PUT', body: JSON.stringify({ agents }) })
      .then(() => { setRows(next); setMsg(t('ag.saved')) })
      .catch((e) => setMsg(String(e?.message ?? e)))
      .finally(() => setBusy(false))
  }

  const toggle = (id: string) => { if (rows) save(rows.map((a) => (a.id === id ? { ...a, enabled: !a.enabled } : a))) }
  const remove = (id: string) => { if (rows) save(rows.filter((a) => a.id !== id)) }
  const addRow = () => {
    if (!rows || !add.id.trim() || !add.command.trim()) return
    save([...rows, {
      id: add.id.trim(), label: add.label.trim() || add.id.trim(), command: add.command.trim(),
      args: add.args.trim() ? add.args.trim().split(/\s+/) : [], multiSession: false,
      versionArgs: ['--version'], shell: true, custom: true, enabled: true, check: null,
    }])
    setAdd({ id: '', label: '', command: '', args: '' })
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-muted-foreground">{t('ag.intro')}</p>
        <button onClick={() => load(true)} disabled={busy}
          className="flex h-7 cursor-pointer items-center gap-1.5 rounded-[6px] px-2 text-[12px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground disabled:opacity-50">
          <RefreshCw size={13} className={busy ? 'animate-spin' : ''} /> {t('ag.reprobe')}
        </button>
      </div>
      <Card className="divide-y divide-black/[.06] dark:divide-white/[.06]">
        {(rows ?? []).map((a) => (
          <div key={a.id} className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-foreground">{a.label}</span>
                {a.custom && <span className="rounded-[4px] bg-tint-secondary px-1.5 py-px text-[10px] text-muted-foreground">{t('ag.custom')}</span>}
                {!a.enabled && <span className="rounded-[4px] bg-tint-secondary px-1.5 py-px text-[10px] text-muted-foreground">{t('ag.disabledTag')}</span>}
              </div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{a.command} {a.args.join(' ')}</div>
              <div className="mt-1 flex items-center gap-1.5 text-[11px]">
                {a.check == null ? (
                  <span className="text-muted-foreground">{t('ag.noProbe')}</span>
                ) : a.check.installed ? (
                  <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 size={13} /> {t('ag.installed')}{a.check.version ? ` · ${a.check.version}` : ''}
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-red-500">
                    <XCircle size={13} /> {t('ag.missing')}
                  </span>
                )}
                {a.check && !a.check.installed && a.check.detail && (
                  <span className="truncate text-muted-foreground" title={a.check.detail}>— {a.check.detail}</span>
                )}
              </div>
            </div>
            {a.custom && (
              <button onClick={() => remove(a.id)} disabled={busy} aria-label={t('ag.remove')} title={t('ag.remove')}
                className="cursor-pointer rounded-[6px] p-1.5 text-muted-foreground hover:bg-tint-secondary hover:text-red-500 disabled:opacity-50">
                <Trash2 size={14} />
              </button>
            )}
            <button role="switch" aria-checked={a.enabled} onClick={() => toggle(a.id)} disabled={busy}
              className={`relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors disabled:opacity-50 ${a.enabled ? 'bg-emerald-500' : 'bg-muted'}`}>
              <span className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-transform ${a.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
            </button>
          </div>
        ))}
        {rows == null && <div className="px-4 py-6 text-center text-[13px] text-muted-foreground">{t('common.loading')}</div>}
      </Card>
      <Card className="p-4">
        <div className="mb-2 text-[13px] font-medium text-foreground">{t('ag.addTitle')}</div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(['id', 'label', 'command', 'args'] as const).map((k) => (
            <input key={k} value={add[k]} onChange={(e) => setAdd({ ...add, [k]: e.target.value })}
              placeholder={t(`ag.add_${k}`)}
              className="h-8 rounded-[6px] border border-black/[.08] bg-transparent px-2 text-[12px] outline-none placeholder:text-muted-foreground focus:border-black/25 dark:border-white/[.08] dark:focus:border-white/25" />
          ))}
        </div>
        <button onClick={addRow} disabled={busy || !add.id.trim() || !add.command.trim()}
          className="mt-2 flex h-7 cursor-pointer items-center gap-1.5 rounded-[6px] bg-tint-secondary px-3 text-[12px] text-foreground hover:opacity-80 disabled:opacity-40">
          <Plus size={13} /> {t('ag.add')}
        </button>
      </Card>
      {msg && <div className="text-[12px] text-muted-foreground">{msg}</div>}
    </div>
  )
}
