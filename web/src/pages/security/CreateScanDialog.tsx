import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, X } from 'lucide-react'
import { adminFetch } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { Profile } from './atoms'

/* ---------- create-scan sheet (official: target + configuration) ---------- */

export function CreateScanDialog({ profiles, onClose, onCreated }: {
  profiles: Profile[]
  onClose: () => void
  onCreated: () => void
}) {
  const { t } = useTranslation()
  const [cwd, setCwd] = useState('')
  const [workspaces, setWorkspaces] = useState<{ name: string; org: string }[]>([])
  const [effort, setEffort] = useState<'lite' | 'standard'>('lite')
  const [profileId, setProfileId] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => {
    adminFetch<{ repos: { name: string; org: string }[] }>('/api/admin/composer-meta')
      .then((r) => setWorkspaces(r.repos ?? [])).catch(() => {})
  }, [])
  const submit = async () => {
    setBusy(true); setErr('')
    try {
      await adminFetch('/api/admin/security/scans', {
        method: 'POST',
        body: JSON.stringify({ cwd: cwd.trim(), effort, profile_id: profileId || undefined }),
      })
      onCreated(); onClose()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/60" onClick={onClose}>
      <div className="w-[min(596px,calc(100vw-2rem))] rounded-[12px] border border-border-secondary bg-background shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 pb-2 pt-5">
          <h3 className="text-[15px] font-medium">{t('sec.createScan')}</h3>
          <button onClick={onClose} className="flex size-7 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary"><X size={15} /></button>
        </div>
        <div className="flex flex-col gap-4 px-5 pb-5">
          {/* official sheet section: Target */}
          <div className="flex flex-col gap-2">
            <div className="text-[13px] font-medium">{t('sec.target')}</div>
            <div className="rounded-[12px] bg-bg-elevated p-3">
              <input
                value={cwd} onChange={(e) => setCwd(e.target.value)}
                placeholder={t('sec.cwdPlaceholder')}
                className="h-9 w-full rounded-[8px] border border-border-secondary bg-background px-3 text-[13px] outline-none placeholder:text-muted-foreground"
              />
              {workspaces.length > 0 && (
                <div className="mt-2 flex max-h-[120px] flex-col gap-0.5 overflow-y-auto">
                  {workspaces.slice(0, 12).map((w) => (
                    <button key={w.org} onClick={() => setCwd(w.org)} className={cn('shrink-0 truncate rounded-[5px] px-2 py-1 text-left text-[12px] hover:bg-tint-secondary', cwd === w.org && 'bg-tint-secondary font-medium')}>
                      {w.name} <span className="text-muted-foreground">· {w.org}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          {/* official sheet section: Configuration */}
          <div className="flex flex-col gap-2">
            <div className="text-[13px] font-medium">{t('sec.config')}</div>
            <div className="flex flex-col gap-3 rounded-[12px] bg-bg-elevated p-3">
              <div className="flex items-center gap-2">
                <span className="w-20 shrink-0 text-[12px] text-muted-foreground">{t('sec.effort')}</span>
                <div className="flex rounded-[6px] border border-border-secondary bg-background p-0.5">
                  {(['lite', 'standard'] as const).map((e2) => (
                    <button key={e2} onClick={() => setEffort(e2)} className={cn('rounded-[5px] px-2.5 py-1 text-[12px] capitalize', effort === e2 ? 'bg-tint-secondary font-medium' : 'text-muted-foreground')}>{e2}</button>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-20 shrink-0 text-[12px] text-muted-foreground">{t('sec.profile')}</span>
                <select value={profileId} onChange={(e) => setProfileId(e.target.value)} className="h-8 flex-1 rounded-[6px] border border-border-secondary bg-background px-2 text-[13px]">
                  <option value="">{t('sec.noProfile')}</option>
                  {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            </div>
          </div>
          {err && <div className="text-[12px] text-red-500">{err}</div>}
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} className="h-8 rounded-[6px] px-3 text-[13px] text-muted-foreground hover:bg-tint-secondary">{t('sec.cancel')}</button>
            <button onClick={() => void submit()} disabled={busy || !cwd.trim()} className="flex h-8 items-center gap-1.5 rounded-[6px] bg-accent-primary px-3 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50">
              {busy ? <Loader2 size={14} className="animate-spin" /> : null}{t('sec.startScan')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
