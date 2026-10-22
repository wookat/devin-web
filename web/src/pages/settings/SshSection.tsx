import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pencil, Plus, Server, Trash2 } from 'lucide-react'
import { Combo } from '@/components/ui'
import { adminFetch } from '@/lib/api'
import { Section } from './atoms'

/* ---- SSH hosts -------------------------------------------------------------
 * prefs.sshHosts management — the same records the draft page's 本地+SSH
 * picker consumes. Secrets are write-only: the API returns hasPassword /
 * hasPassphrase flags, and an empty secret field means "keep stored value".
 */
interface PubSshHost {
  name?: string; target: string; cwd?: string
  auth?: 'agent' | 'password' | 'key'; keyPath?: string
  hasPassword?: boolean; hasPassphrase?: boolean
}
interface SshForm {
  name: string; target: string; cwd: string
  auth: 'agent' | 'password' | 'key'
  password: string; keyPath: string; passphrase: string
}
const EMPTY_SSH_FORM: SshForm = { name: '', target: '', cwd: '', auth: 'agent', password: '', keyPath: '', passphrase: '' }

function SshPanel() {
  const { t } = useTranslation()
  const [hosts, setHosts] = useState<PubSshHost[] | null>(null)
  const [form, setForm] = useState<SshForm | null>(null)
  const [editTarget, setEditTarget] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [testing, setTesting] = useState('')
  const [testOut, setTestOut] = useState<Record<string, { ok: boolean; ms: number; whoami?: string; error?: string }>>({})

  const load = () => adminFetch<{ prefs: { sshHosts?: PubSshHost[] } }>('/api/admin/prefs')
    .then((r) => setHosts(r.prefs?.sshHosts ?? []))
  useEffect(() => { load().catch(() => setHosts([])) }, [])

  const save = async (next: Record<string, unknown>[]) => {
    if (busy) return
    setBusy(true); setErr('')
    try {
      const r = await adminFetch<{ prefs: { sshHosts?: PubSshHost[] } }>('/api/admin/prefs', {
        method: 'POST',
        body: JSON.stringify({ sshHosts: next }),
      })
      setHosts(r.prefs?.sshHosts ?? [])
      setForm(null)
    } catch { setErr(t('set.sshSaveFail')) }
    finally { setBusy(false) }
  }

  const submit = () => {
    if (!form || !form.target.trim()) return
    const rec: Record<string, unknown> = {
      target: form.target.trim(),
      ...(form.name.trim() ? { name: form.name.trim() } : {}),
      ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}),
      auth: form.auth,
      ...(form.keyPath.trim() ? { keyPath: form.keyPath.trim() } : {}),
      ...(form.password ? { password: form.password } : {}),
      ...(form.passphrase ? { passphrase: form.passphrase } : {}),
    }
    const prev = hosts ?? []
    const next = editTarget == null
      ? [...prev.filter((h) => h.target !== rec.target), rec]
      : prev.map((h) => (h.target === editTarget ? rec : h))
    void save(next as unknown as Record<string, unknown>[])
  }

  const remove = (target: string) => {
    const h = (hosts ?? []).find((x) => x.target === target)
    if (!h || !confirm(t('set.sshDelConfirm', { name: h.name || h.target }))) return
    void save((hosts ?? []).filter((x) => x.target !== target) as unknown as Record<string, unknown>[])
  }

  const test = async (target: string) => {
    setTesting(target)
    try {
      const r = await adminFetch<{ ok: boolean; ms: number; whoami?: string; error?: string }>('/api/admin/ssh/test', {
        method: 'POST', body: JSON.stringify({ target }),
      })
      setTestOut((o) => ({ ...o, [target]: r }))
    } catch (e) {
      setTestOut((o) => ({ ...o, [target]: { ok: false, ms: 0, error: (e as Error)?.message } }))
    } finally { setTesting('') }
  }

  const In = ({ value, onChange, ph, type }: { value: string; onChange: (v: string) => void; ph?: string; type?: string }) => (
    <input
      value={value}
      type={type ?? 'text'}
      onChange={(e) => onChange(e.target.value)}
      placeholder={ph}
      spellCheck={false}
      className="h-[28px] min-w-0 flex-1 rounded-[6px] border border-border bg-transparent px-2 text-[13px] outline-none placeholder:text-muted-foreground focus:border-foreground/30"
    />
  )

  if (hosts === null) return <p className="px-[12px] py-[10px] text-13 text-secondary">{t('common.loading')}</p>
  return (
    <div className="py-[4px]">
      {hosts.length === 0 && !form && (
        <p className="px-[12px] py-[8px] text-[13px] text-muted-foreground">{t('set.sshEmpty')}</p>
      )}
      {hosts.map((h) => {
        const tr = testOut[h.target]
        return (
          <div key={h.target} className="flex min-h-[52px] items-center justify-between gap-2 rounded-[6px] px-[12px] py-[8px]">
            <div className="flex min-w-0 flex-col gap-[2px]">
              <div className="flex items-center gap-2 text-[13px] text-foreground">
                <Server size={13} className="shrink-0 text-muted-foreground" />
                <span className="truncate font-medium">{h.name || h.target}</span>
                {h.name && <span className="truncate text-muted-foreground">{h.target}</span>}
                <span className="shrink-0 rounded-full bg-tint-secondary px-1.5 py-px text-[11px] text-muted-foreground">
                  {h.auth === 'password' ? t('set.sshAuthPassword') : h.auth === 'key' ? t('set.sshAuthKey') : t('set.sshAuthAgent')}
                </span>
              </div>
              <div className="flex items-center gap-2 pl-[21px] text-[12px] text-muted-foreground">
                {h.cwd && <span className="truncate">{h.cwd}</span>}
                {tr && (
                  <span className={tr.ok ? 'text-emerald-600' : 'text-red-500'}>
                    {tr.ok ? `${t('set.sshOk')}${tr.whoami ? ` · ${tr.whoami}` : ''} · ${tr.ms}ms` : `${t('set.sshFail')}: ${tr.error ?? ''}`}
                  </span>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button disabled={testing === h.target} onClick={() => void test(h.target)}
                className="h-[26px] cursor-pointer rounded-[6px] border border-border bg-card px-2 text-[12px] hover:bg-tint-tertiary disabled:opacity-50">
                {testing === h.target ? t('set.sshTesting') : t('set.sshTest')}
              </button>
              <button aria-label={t('set.sshEdit')} onClick={() => {
                setEditTarget(h.target)
                setForm({ name: h.name ?? '', target: h.target, cwd: h.cwd ?? '', auth: h.auth ?? 'agent', password: '', keyPath: h.keyPath ?? '', passphrase: '' })
              }}
                className="flex size-7 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-tertiary hover:text-foreground">
                <Pencil size={13} />
              </button>
              <button aria-label={t('set.sshDelete')} onClick={() => remove(h.target)}
                className="flex size-7 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-tertiary hover:text-red-500">
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        )
      })}
      {form ? (
        <div className="mx-[6px] my-[6px] flex flex-col gap-2 rounded-[6px] border border-border p-3">
          <div className="flex items-center gap-2">
            <span className="w-[88px] shrink-0 text-[12px] text-muted-foreground">{t('set.sshTarget')}</span>
            <In value={form.target} onChange={(v) => setForm({ ...form, target: v })} ph="user@host[:port]" />
          </div>
          <div className="flex items-center gap-2">
            <span className="w-[88px] shrink-0 text-[12px] text-muted-foreground">{t('set.sshName')}</span>
            <In value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
          </div>
          <div className="flex items-center gap-2">
            <span className="w-[88px] shrink-0 text-[12px] text-muted-foreground">{t('set.sshCwd')}</span>
            <In value={form.cwd} onChange={(v) => setForm({ ...form, cwd: v })} ph="~/projects" />
          </div>
          <div className="flex items-center gap-2">
            <span className="w-[88px] shrink-0 text-[12px] text-muted-foreground">{t('set.sshAuth')}</span>
            <Combo className="w-fit" value={form.auth} onPick={(v) => setForm({ ...form, auth: v as SshForm['auth'] })}
              options={[{ v: 'agent', l: t('set.sshAuthAgent') }, { v: 'password', l: t('set.sshAuthPassword') }, { v: 'key', l: t('set.sshAuthKey') }]} />
          </div>
          {form.auth === 'password' && (
            <div className="flex items-center gap-2">
              <span className="w-[88px] shrink-0 text-[12px] text-muted-foreground">{t('set.sshPassword')}</span>
              <In type="password" value={form.password} onChange={(v) => setForm({ ...form, password: v })}
                ph={editTarget && hosts.find((h) => h.target === editTarget)?.hasPassword ? t('set.sshPasswordKeep') : ''} />
            </div>
          )}
          {form.auth === 'key' && (
            <>
              <div className="flex items-center gap-2">
                <span className="w-[88px] shrink-0 text-[12px] text-muted-foreground">{t('set.sshKeyPath')}</span>
                <In value={form.keyPath} onChange={(v) => setForm({ ...form, keyPath: v })} ph="~/.ssh/id_rsa" />
              </div>
              <div className="flex items-center gap-2">
                <span className="w-[88px] shrink-0 text-[12px] text-muted-foreground">{t('set.sshPassphrase')}</span>
                <In type="password" value={form.passphrase} onChange={(v) => setForm({ ...form, passphrase: v })}
                  ph={editTarget && hosts.find((h) => h.target === editTarget)?.hasPassphrase ? t('set.sshPasswordKeep') : ''} />
              </div>
            </>
          )}
          {form.auth === 'agent' && (
            <p className="pl-[96px] text-[12px] text-muted-foreground">{t('set.sshAgentNote')}</p>
          )}
          {err && <p className="text-[12px] text-red-500">{err}</p>}
          <div className="flex items-center justify-end gap-1.5 pt-1">
            <button onClick={() => { setForm(null); setErr('') }}
              className="h-[28px] cursor-pointer rounded-[6px] px-2 text-[13px] text-muted-foreground hover:bg-tint-tertiary">
              {t('common.cancel')}
            </button>
            <button disabled={busy || !form.target.trim()} onClick={submit}
              className="h-[28px] cursor-pointer rounded-[6px] bg-primary px-2.5 text-[13px] text-primary-foreground hover:opacity-90 disabled:opacity-40">
              {t('set.sshSave')}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex min-h-[44px] items-center justify-between gap-2 rounded-[6px] px-[12px] py-[8px]">
          <span className="text-[13px] text-muted-foreground">{t('set.sshAddDesc')}</span>
          <button onClick={() => { setEditTarget(null); setForm({ ...EMPTY_SSH_FORM }); setErr('') }}
            className="flex h-[28px] cursor-pointer items-center gap-1 rounded-[6px] border border-border bg-card px-2 text-[13px] font-medium hover:bg-tint-tertiary">
            <Plus size={13} /> {t('set.sshAdd')}
          </button>
        </div>
      )}
    </div>
  )
}

/** SSH tab — prefs.sshHosts CRUD + connectivity test. */
export function SshTab() {
  const { t } = useTranslation()
  return (
    <Section title={t('set.ssh')}>
      <SshPanel />
    </Section>
  )
}
