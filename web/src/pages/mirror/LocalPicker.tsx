import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, Laptop, Plus, Server } from 'lucide-react'
import { adminFetch } from '@/lib/api'
import { cn } from '@/lib/utils'

export interface SshHost {
  name?: string
  target: string
  cwd?: string
  /** agent →本机 OpenSSH；password/key → ssh2（服务端连接）。Secrets are
   *  write-only — the API echoes hasPassword/hasPassphrase, never values. */
  auth?: 'agent' | 'password' | 'key'
  keyPath?: string
  hasPassword?: boolean
  hasPassphrase?: boolean
}

export type DraftTarget = { kind: 'local' } | { kind: 'ssh'; host: SshHost }

const hostLabel = (h: SshHost) => h.name || h.target

/** Draft-page run-target picker — desktop's local/cloud switch, except we
 * have no cloud: the alternate lane is `本地+SSH`, running the agent CLI on a
 * configured remote host (stdio bridged through `ssh <target> devin acp`).
 * Hosts live in dw.json prefs.sshHosts — sessions/new only accepts targets
 * from that list, so the unauthenticated web can't be aimed at arbitrary
 * machines. */
export default function LocalPicker({ target, hosts, onChange, onHosts }: {
  target: DraftTarget
  hosts: SshHost[]
  onChange: (t: DraftTarget) => void
  onHosts: (hosts: SshHost[]) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ name: '', target: '', cwd: '' })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node) && !menuRef.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const pick = (v: DraftTarget) => { onChange(v); setOpen(false); setAdding(false); setErr(null) }

  const addHost = async () => {
    const target0 = form.target.trim()
    if (!target0 || saving) return
    setSaving(true); setErr(null)
    try {
      const next = [...hosts.filter((h) => h.target !== target0), { name: form.name.trim() || undefined, target: target0, cwd: form.cwd.trim() || undefined }]
      const r = await adminFetch<{ prefs?: { sshHosts?: SshHost[] } }>('/api/admin/prefs', {
        method: 'POST',
        body: JSON.stringify({ sshHosts: next }),
      })
      const saved = r.prefs?.sshHosts ?? next
      onHosts(saved)
      onChange({ kind: 'ssh', host: saved.find((h) => h.target === target0) ?? { target: target0 } })
      setOpen(false); setAdding(false); setForm({ name: '', target: '', cwd: '' })
    } catch {
      setErr(t('draft.sshSaveFail'))
    } finally {
      setSaving(false)
    }
  }

  const itemCls = 'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] leading-[18px] hover:bg-accent'
  const isSsh = target.kind === 'ssh'

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        ref={btnRef}
        onClick={() => {
          if (!open && btnRef.current) {
            const r = btnRef.current.getBoundingClientRect()
            const w = Math.min(320, window.innerWidth - 16)
            setAnchor({ left: Math.max(8, Math.min(r.left, window.innerWidth - w - 8)), top: r.bottom + 4 })
          }
          setOpen((v) => !v); setAdding(false); setErr(null)
        }}
        className={cn('flex h-7 max-w-[240px] cursor-pointer items-center gap-[3px] overflow-hidden whitespace-nowrap rounded-full px-[6px] text-[13px] leading-[18px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground', open && 'bg-tint-secondary text-foreground')}
        title={isSsh ? `ssh ${target.host.target}` : t('draft.local')}
      >
        {isSsh
          ? <Server size={14} className="shrink-0" />
          : <Laptop size={14} className="shrink-0" />}
        <span className="min-w-0 truncate">{isSsh ? hostLabel(target.host) : t('draft.local')}</span>
        <ChevronDown size={11} className="shrink-0 opacity-60" />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="menu-in fixed z-50 overflow-y-auto rounded-[10px] bg-white/[.94] p-1 text-popover-foreground shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)] outline outline-1 outline-black/[.08] backdrop-blur-[8px] dark:bg-[#1f1f1f]/[.94] dark:outline-white/[.04] dark:-outline-offset-1"
          style={{
            left: anchor?.left ?? 8,
            top: anchor?.top ?? 8,
            width: Math.min(320, window.innerWidth - 16),
            maxHeight: anchor ? window.innerHeight - anchor.top - 8 : '70vh',
          }}
        >
          <button className={itemCls} onClick={() => pick({ kind: 'local' })}>
            <span className="flex w-[13px] shrink-0 justify-center">{!isSsh && <Check size={13} />}</span>
            <Laptop size={13} className="shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-left">{t('draft.local')}</span>
          </button>
          <p className="px-2 pb-0.5 pt-1.5 text-[11px] leading-[16px] text-muted-foreground">SSH</p>
          {hosts.map((h) => (
            <button key={h.target} className={itemCls} onClick={() => pick({ kind: 'ssh', host: h })} title={h.target}>
              <span className="flex w-[13px] shrink-0 justify-center">{isSsh && target.host.target === h.target && <Check size={13} />}</span>
              <Server size={13} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-left">{hostLabel(h)}<span className="text-muted-foreground"> — {h.target}</span></span>
            </button>
          ))}
          {!hosts.length && !adding && (
            <p className="px-2 py-1 text-[12px] leading-[16px] text-muted-foreground">{t('draft.sshNone')}</p>
          )}
          {adding ? (
            <div className="flex flex-col gap-1 px-1 py-1">
              <input
                autoFocus
                value={form.target}
                onChange={(e) => setForm((f) => ({ ...f, target: e.target.value }))}
                placeholder={t('draft.sshTargetPh')}
                spellCheck={false}
                className="h-7 rounded-md border border-border bg-background px-2 text-[12px] leading-[16px] outline-none placeholder:text-muted-foreground"
              />
              <input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder={t('draft.sshNamePh')}
                spellCheck={false}
                className="h-7 rounded-md border border-border bg-background px-2 text-[12px] leading-[16px] outline-none placeholder:text-muted-foreground"
              />
              <input
                value={form.cwd}
                onChange={(e) => setForm((f) => ({ ...f, cwd: e.target.value }))}
                placeholder={t('draft.sshCwdPh')}
                spellCheck={false}
                className="h-7 rounded-md border border-border bg-background px-2 text-[12px] leading-[16px] outline-none placeholder:text-muted-foreground"
              />
              <p className="px-1 pt-0.5 text-[11px] leading-[15px] text-muted-foreground">{t('draft.sshAuthHint')}</p>
              {err && <p className="px-1 text-[11px] leading-[16px] text-red-500">{err}</p>}
              <div className="flex items-center justify-end gap-1.5 pt-0.5">
                <button onClick={() => { setAdding(false); setErr(null) }} className="cursor-pointer rounded-md px-2 py-1 text-[12px] leading-[16px] text-muted-foreground hover:bg-accent">
                  {t('common.cancel')}
                </button>
                <button
                  disabled={!form.target.trim() || saving}
                  onClick={() => void addHost()}
                  className="cursor-pointer rounded-md bg-primary px-2 py-1 text-[12px] leading-[16px] text-primary-foreground hover:opacity-90 disabled:opacity-40"
                >
                  {saving ? '…' : t('draft.sshAdd')}
                </button>
              </div>
            </div>
          ) : (
            <button className={itemCls} onClick={() => setAdding(true)}>
              <span className="flex w-[13px] shrink-0 justify-center" />
              <Plus size={13} className="shrink-0 text-muted-foreground" />
              <span className="flex-1 text-left">{t('draft.sshAddHost')}</span>
            </button>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}
