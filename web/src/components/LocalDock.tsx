import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, Copy, ExternalLink, Plus, RefreshCw, Repeat, Trash2, X } from 'lucide-react'
import { adminFetch } from '@/lib/api'
import { copyText } from '../lib/clipboard'

/**
 * Account pool strip — a persistent section pinned to the bottom of the
 * session sidebar. Shows every configured account with live quota/plan info
 * (GetUserStatus), the active pick, cooldowns, manual rotate, add-account
 * (browser PKCE flow or token paste), and remove.
 */

interface AccountInfo {
  email: string | null
  userName: string | null
  plan: string | null
  tier: string | null
  dailyQuotaRemainingPercent: number | null
  weeklyQuotaRemainingPercent: number | null
  availablePromptCredits: number | null
  monthlyPromptCredits: number | null
  overageBalanceUsd: number | null
  planEnd: string | null
  dailyResetAt: number | null
  weeklyResetAt: number | null
}

interface AccountRow {
  name: string
  current?: boolean
  picked?: boolean
  cooldownUntil?: number | null
  limitedUntil?: number | null
  cooling?: boolean
  info?: AccountInfo | null
}

interface AccountsResp {
  accounts: AccountRow[]
  current: string | null
  nextRecoveryAt?: number | null
}

function cooldownLeft(until?: number | null): string | null {
  if (!until) return null
  const s = Math.max(0, Math.ceil(until - Date.now() / 1000))
  if (!s) return null
  return s >= 3600
    ? `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60) ? `${Math.floor((s % 3600) / 60)}m` : ''}`
    : s >= 60
      ? `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ''}`
      : `${s}s`
}

function pct(p: number | null | undefined): string {
  return p == null ? '—' : `${Math.round(p)}%`
}

function QuotaBar({ label, value }: { label: string; value: number | null | undefined }) {
  const { t } = useTranslation()
  const v = value ?? null
  const color = v == null ? 'bg-muted-foreground/30' : v > 40 ? 'bg-emerald-500' : v > 10 ? 'bg-amber-500' : 'bg-red-500'
  return (
    <div className="flex items-center gap-1.5" title={`${label}${t('dock.pctLeft', { p: pct(v) })}`}>
      <span className="w-7 shrink-0 text-[10px] text-muted-foreground">{label}</span>
      <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.max(0, Math.min(100, v ?? 0))}%` }} />
      </div>
      <span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">{pct(v)}</span>
    </div>
  )
}

export default function LocalDock() {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [adding, setAdding] = useState(false)
  const [accounts, setAccounts] = useState<AccountsResp | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // add-account form state
  const [mode, setMode] = useState<'browser' | 'token'>('browser')
  const [pkceId, setPkceId] = useState<string | null>(null)
  const [pkceUrl, setPkceUrl] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [tokName, setTokName] = useState('')
  const [tokKey, setTokKey] = useState('')

  const pollAccounts = useCallback(() => {
    adminFetch<AccountsResp>('/api/accounts').then(setAccounts).catch(() => {})
  }, [])

  useEffect(() => {
    pollAccounts()
    const t = setInterval(pollAccounts, 5000)
    return () => clearInterval(t)
  }, [pollAccounts])

  const rotate = async (target?: string) => {
    setBusy(true)
    setErr(null)
    try {
      await adminFetch('/api/accounts/rotate', {
        method: 'POST',
        body: JSON.stringify(target ? { target } : {}),
      })
      pollAccounts()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const clearCooldown = async (name: string) => {
    try {
      await adminFetch('/api/accounts/unlimited', { method: 'POST', body: JSON.stringify({ name }) })
      pollAccounts()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const refreshQuota = async (name?: string) => {
    try {
      await adminFetch('/api/accounts/refresh', {
        method: 'POST',
        body: JSON.stringify(name ? { name } : {}),
      })
      pollAccounts()
    } catch { /* keep stale */ }
  }

  const remove = async (name: string) => {
    if (!window.confirm(`${t('dock.confirmRemove', { name })}`)) return
    try {
      await adminFetch(`/api/accounts/${encodeURIComponent(name)}`, { method: 'DELETE' })
      pollAccounts()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const startLogin = async () => {
    setErr(null)
    try {
      const r = await adminFetch<{ url: string; id: string }>('/api/accounts/login/start', { method: 'POST', body: '{}' })
      setPkceId(r.id)
      setPkceUrl(r.url)
      window.open(r.url, '_blank', 'noopener')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const finishLogin = async () => {
    if (!pkceId || !code.trim()) return
    setBusy(true)
    setErr(null)
    try {
      await adminFetch('/api/accounts/login/finish', {
        method: 'POST',
        body: JSON.stringify({ id: pkceId, code: code.trim() }),
      })
      setAdding(false)
      setPkceId(null)
      setPkceUrl(null)
      setCode('')
      pollAccounts()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const addToken = async () => {
    if (!tokName.trim() || !tokKey.trim()) return
    setBusy(true)
    setErr(null)
    try {
      await adminFetch('/api/accounts', {
        method: 'POST',
        body: JSON.stringify({ name: tokName.trim(), key: tokKey.trim() }),
      })
      setAdding(false)
      setTokName('')
      setTokKey('')
      pollAccounts()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const rows = accounts?.accounts ?? []
  const cur = accounts?.current ?? rows.find((a) => a.current)?.name ?? null
  const curRow = rows.find((a) => a.name === cur)
  const curCooling = !!(curRow && cooldownLeft(curRow.cooldownUntil ?? curRow.limitedUntil))
  const coolingCount = rows.filter((a) => cooldownLeft(a.cooldownUntil ?? a.limitedUntil)).length
  const recovery = accounts?.nextRecoveryAt ? cooldownLeft(accounts.nextRecoveryAt) : null

  return (
    <div className="shrink-0 border-t border-border bg-background text-[12px] leading-[18px]">
      <div className="flex items-center gap-1.5 px-3 py-1.5">
        <span
          className={`inline-block size-2 shrink-0 rounded-full ${curCooling ? 'bg-amber-500' : cur ? 'bg-emerald-500' : 'bg-muted-foreground'}`}
          title={curCooling ? t('dock.curCooling') : cur ? t('dock.healthy') : t('dock.none')}
        />
        <span className="min-w-0 flex-1 truncate" title={curRow?.info?.email ?? cur ?? undefined}>
          {curRow?.info?.email ?? cur ?? t('dock.noAccount')}
          {curRow?.info?.plan && <span className="ml-1 text-[10px] text-muted-foreground">{curRow.info.plan}</span>}
          {coolingCount > 0 && <span className="ml-1 text-[10px] text-amber-600">{coolingCount} {t('dock.coolingN')}</span>}
        </span>
        <button
          className="flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          disabled={busy}
          onClick={() => void rotate()}
          title={t('dock.rotateTip')}
        >
          <Repeat size={11} /> {t('dock.rotate')}
        </button>
        <button
          className="flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => { setAdding((v) => !v); setExpanded(true) }}
          title={t('dock.addTip')}
        >
          <Plus size={11} /> {t('dock.add')}
        </button>
        <button
          className="flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={expanded ? t('dock.collapse') : t('dock.expand')}
          title={expanded ? t('dock.collapse') : t('dock.expand')}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
        </button>
      </div>

      {expanded && (
        <div className="border-t border-border/50 px-3 py-1.5">
          {!cur && rows.length > 0 && (
            <div className="mb-1.5 rounded bg-amber-500/10 px-2 py-1 text-[11px] text-amber-600">
              {t('dock.allCooling')}{recovery ? `${t('dock.earliest', { t: recovery })}` : ''}
            </div>
          )}
          <ul className="max-h-48 space-y-1.5 overflow-y-auto">
            {rows.map((a) => {
              const left = cooldownLeft(a.cooldownUntil ?? a.limitedUntil)
              const isCur = a.name === cur || a.current
              const info = a.info
              return (
                <li key={a.name} className="rounded-md border border-border/60 px-2 py-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className={`inline-block size-1.5 shrink-0 rounded-full ${left ? 'bg-amber-500' : 'bg-emerald-500'}`} />
                    <span className="min-w-0 flex-1 truncate font-medium" title={info?.email ?? a.name}>
                      {info?.email ?? a.name}
                    </span>
                    {isCur && <span className="rounded bg-emerald-500/15 px-1 text-[10px] text-emerald-600">{t('set.currentBadge')}</span>}
                    {info?.plan && <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{info.plan}</span>}
                    {left ? (
                      <>
                        <span className="shrink-0 text-[10px] text-amber-600">{t('dock.coolingLeft', { t: left })}</span>
                        <button
                          className="cursor-pointer text-[10px] text-muted-foreground underline hover:text-foreground"
                          title={t('dock.clearCooling')}
                          onClick={() => void clearCooldown(a.name)}
                        >
                          {t('dock.clear')}
                        </button>
                      </>
                    ) : (
                      !isCur && (
                        <button
                          className="cursor-pointer text-[10px] text-muted-foreground underline hover:text-foreground disabled:opacity-40"
                          title={`${t('dock.switchTo', { name: a.name })}`}
                          disabled={busy}
                          onClick={() => void rotate(a.name)}
                        >
                          {t('dock.switch')}
                        </button>
                      )
                    )}
                    <button
                      className="cursor-pointer text-muted-foreground hover:text-foreground"
                      title={t('dock.refreshQuota')}
                      onClick={() => void refreshQuota(a.name)}
                    >
                      <RefreshCw size={10} />
                    </button>
                    <button
                      className="cursor-pointer text-muted-foreground hover:text-red-500"
                      title={t('dock.removeAcc')}
                      onClick={() => void remove(a.name)}
                    >
                      <Trash2 size={10} />
                    </button>
                  </div>
                  {info ? (
                    <div className="mt-1 space-y-0.5 pl-3">
                      <QuotaBar label={t('dock.day')} value={info.dailyQuotaRemainingPercent} />
                      <QuotaBar label={t('dock.week')} value={info.weeklyQuotaRemainingPercent} />
                      {(info.overageBalanceUsd != null && Math.abs(info.overageBalanceUsd) >= 0.01) && (
                        <div className="text-[10px] text-muted-foreground">
                          {info.overageBalanceUsd < 0 ? t('dock.credit') : t('dock.overage')} ${Math.abs(info.overageBalanceUsd).toFixed(2)}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="mt-0.5 pl-3 text-[10px] text-muted-foreground">{t('dock.quotaLoading')}</div>
                  )}
                </li>
              )
            })}
            {!rows.length && <li className="text-muted-foreground">{t('dock.noAccounts')}</li>}
          </ul>

          {err && <div className="mt-1.5 rounded bg-red-500/10 px-2 py-1 text-[11px] text-red-600">{err}</div>}

          {adding ? (
            <div className="mt-2 rounded-md border border-border px-2 py-1.5">
              <div className="mb-1.5 flex items-center justify-between">
                <div className="flex gap-1 text-[11px]">
                  <button
                    className={`cursor-pointer rounded px-1.5 py-0.5 ${mode === 'browser' ? 'bg-accent text-foreground' : 'text-muted-foreground'}`}
                    onClick={() => setMode('browser')}
                  >
                    {t('dock.browserLogin')}
                  </button>
                  <button
                    className={`cursor-pointer rounded px-1.5 py-0.5 ${mode === 'token' ? 'bg-accent text-foreground' : 'text-muted-foreground'}`}
                    onClick={() => setMode('token')}
                  >
                    {t('dock.pasteToken')}
                  </button>
                </div>
                <button className="cursor-pointer text-muted-foreground hover:text-foreground" onClick={() => setAdding(false)}>
                  <X size={12} />
                </button>
              </div>
              {mode === 'browser' ? (
                <div className="space-y-1.5">
                  {!pkceUrl ? (
                    <button
                      className="flex w-full cursor-pointer items-center justify-center gap-1 rounded bg-primary px-2 py-1 text-[11px] text-primary-foreground hover:opacity-90"
                      onClick={() => void startLogin()}
                    >
                      <ExternalLink size={11} /> {t('dock.genLink')}
                    </button>
                  ) : (
                    <>
                      <div className="flex items-center gap-1">
                        <a
                          className="flex min-w-0 flex-1 items-center gap-1 truncate rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                          href={pkceUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <ExternalLink size={9} className="shrink-0" /> {t('dock.opened')}
                        </a>
                        <button
                          className="cursor-pointer rounded p-0.5 text-muted-foreground hover:text-foreground"
                          title={t('dock.copyLink')}
                          onClick={() => void copyText(pkceUrl)}
                        >
                          <Copy size={10} />
                        </button>
                      </div>
                      <input
                        className="w-full rounded border border-border bg-background px-1.5 py-1 text-[11px] outline-none focus:border-primary"
                        placeholder={t('dock.authCodePh')}
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                      />
                      <button
                        className="w-full cursor-pointer rounded bg-primary px-2 py-1 text-[11px] text-primary-foreground hover:opacity-90 disabled:opacity-40"
                        disabled={busy || !code.trim()}
                        onClick={() => void finishLogin()}
                      >
                        {t('dock.finishLogin')}
                      </button>
                    </>
                  )}
                </div>
              ) : (
                <div className="space-y-1.5">
                  <input
                    className="w-full rounded border border-border bg-background px-1.5 py-1 text-[11px] outline-none focus:border-primary"
                    placeholder={t('dock.accNamePh')}
                    value={tokName}
                    onChange={(e) => setTokName(e.target.value)}
                  />
                  <input
                    className="w-full rounded border border-border bg-background px-1.5 py-1 text-[11px] outline-none focus:border-primary"
                    placeholder="devin-session-token$…"
                    type="password"
                    value={tokKey}
                    onChange={(e) => setTokKey(e.target.value)}
                  />
                  <button
                    className="w-full cursor-pointer rounded bg-primary px-2 py-1 text-[11px] text-primary-foreground hover:opacity-90 disabled:opacity-40"
                    disabled={busy || !tokName.trim() || !tokKey.trim()}
                    onClick={() => void addToken()}
                  >
                    {t('dock.addAccount')}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="mt-1.5 flex justify-end gap-2">
              <button
                className="flex cursor-pointer items-center gap-1 rounded px-1 text-[10px] text-muted-foreground hover:text-foreground"
                onClick={() => void refreshQuota()}
                title={t('dock.refreshAll')}
              >
                <RefreshCw size={10} /> {t('dock.refreshBtn')}
              </button>
              <button
                className="flex cursor-pointer items-center gap-1 rounded px-1 text-[10px] text-muted-foreground hover:text-foreground"
                onClick={() => setAdding(true)}
              >
                <Plus size={10} /> {t('dock.addAccount')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
