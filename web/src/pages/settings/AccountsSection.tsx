import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, RefreshCw } from 'lucide-react'
import { adminFetch } from '@/lib/api'
import { Btn2, Section } from './atoms'

/* Accounts tab — multi-account rotation pool (SWE rate-limit failover).
 * Rows show plan/quota/expiry from /api/accounts; actions rotate / refresh /
 * clear-cooling via the account endpoints, one in flight at a time (accBusy). */

interface AccountInfo {
  email?: string; userName?: string; plan?: string
  dailyQuotaRemainingPercent?: number; weeklyQuotaRemainingPercent?: number
  overageBalanceUsd?: number; planEnd?: string
}
interface Account {
  name: string; current: boolean; picked: boolean
  cooling?: boolean; limitedUntil?: number; info?: AccountInfo
}

export function AccountsTab({ msg, setMsg }: { msg: string; setMsg: (m: string) => void }) {
  const { t } = useTranslation()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [accBusy, setAccBusy] = useState('')
  const [newKey, setNewKey] = useState('')
  const [addOpen, setAddOpen] = useState(false)

  const loadAccounts = () => {
    void adminFetch<{ accounts: Account[] }>('/api/accounts')
      .then((r) => setAccounts(r.accounts ?? []))
      .catch(() => {})
  }

  useEffect(() => {
    loadAccounts()
  }, [])

  const accAction = async (key: string, path: string, body: Record<string, unknown> = {}) => {
    if (accBusy) return
    setAccBusy(key)
    try {
      await adminFetch(path, { method: 'POST', body: JSON.stringify(body) })
      loadAccounts()
    } finally { setAccBusy('') }
  }
  const addAccount = async () => {
    const key = newKey.trim()
    if (!key || accBusy) return
    setAccBusy('add')
    try {
      await adminFetch('/api/accounts', { method: 'POST', body: JSON.stringify({ key }) })
      setNewKey(''); setAddOpen(false); loadAccounts()
    } catch { setMsg(t('set.addFail')) }
    finally { setAccBusy('') }
  }

  return (
    <Section title={t('set.accounts')}>
      {accounts.length === 0 && (
        <div className="px-[12px] py-[10px] text-[13px] text-muted-foreground">{t('set.noAccounts')}</div>
      )}
      {accounts.map((a) => {
        const info = a.info ?? {}
        const quota = [info.dailyQuotaRemainingPercent != null && `${t('set.daily')}${Math.round(info.dailyQuotaRemainingPercent)}%`,
          info.weeklyQuotaRemainingPercent != null && `${t('set.weekly')}${Math.round(info.weeklyQuotaRemainingPercent)}%`].filter(Boolean).join(' · ')
        return (
          <div key={a.name} className="flex min-h-[60px] flex-col justify-center gap-[14px] rounded-[6px] px-[12px] py-[10px]">
            <div className="flex flex-row flex-wrap items-center justify-between gap-2 md:flex-nowrap">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-tint-secondary text-[12px] font-medium text-foreground">
                  {(info.userName ?? a.name).slice(0, 1).toUpperCase()}
                </div>
                <div className="flex min-w-0 flex-col gap-[2px]">
                  <h4 className="flex items-center gap-2 text-[13px] font-normal text-foreground">
                    <span className="truncate">{info.email ?? a.name}</span>
                    {a.current && <span className="shrink-0 rounded-full bg-[#317CFF]/10 px-1.5 py-px text-[11px] font-medium text-[#317CFF]">{t('set.currentBadge')}</span>}
                    {a.cooling && <span className="shrink-0 rounded-full bg-amber-500/10 px-1.5 py-px text-[11px] font-medium text-amber-600">{t('set.coolingBadge')}</span>}
                  </h4>
                  <div className="text-[13px] text-muted-foreground">
                    {[info.plan, quota, info.planEnd && `${t('set.expiry')}${info.planEnd.slice(0, 10)}`].filter(Boolean).join(' · ')}
                  </div>
                </div>
              </div>
              <div className="relative flex items-center gap-1.5">
                {a.cooling && <Btn2 title={t('set.clearCooling')} disabled={!!accBusy} onClick={() => void accAction(`u:${a.name}`, '/api/accounts/unlimited', { name: a.name })}>{t('set.uncool')}</Btn2>}
                {!a.current && !a.cooling && <Btn2 title={t('set.rotateTo')} disabled={!!accBusy} onClick={() => void accAction(`r:${a.name}`, '/api/accounts/rotate', { target: a.name })}>{t('set.switch')}</Btn2>}
                <Btn2 title={t('set.refreshQuota')} disabled={!!accBusy} onClick={() => void accAction(`f:${a.name}`, '/api/accounts/refresh', { name: a.name })}><RefreshCw size={13} /></Btn2>
              </div>
            </div>
          </div>
        )
      })}
      <div className="flex min-h-[44px] items-center justify-between gap-2 rounded-[6px] px-[12px] py-[8px]">
        <span className="text-[13px] text-muted-foreground">{addOpen ? t('set.pasteToken') : t('set.addToken')}</span>
        {addOpen ? (
          <div className="flex items-center gap-1.5">
            <input
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="devin-session-token..."
              className="h-[28px] w-[220px] rounded-[6px] border border-border bg-transparent px-2 text-[13px] outline-none focus:border-foreground/30"
            />
            <Btn2 disabled={!!accBusy || !newKey.trim()} onClick={() => void addAccount()}>{t('set.add')}</Btn2>
            <Btn2 onClick={() => { setAddOpen(false); setNewKey('') }}>{t('common.cancel')}</Btn2>
          </div>
        ) : (
          <Btn2 onClick={() => setAddOpen(true)}><Plus size={13} /> {t('set.addAccount')}</Btn2>
        )}
      </div>
      {msg && <div className="px-[12px] pb-2 text-[12px] text-amber-600">{msg}</div>}
    </Section>
  )
}
