import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, RotateCcw } from 'lucide-react'
import { Combo } from '@/components/ui'
import { adminFetch, adminKey, setAdminKey } from '@/lib/api'
import { Btn2, Row, Section, fmtUptime, useSuperStatus } from './atoms'

/* ---- service status / logs / about panels -------------------------------
 * These ride the SUPERVISOR's own /api/_super/* endpoints (served even while
 * the backend is dead). In unmanaged dev mode they degrade to a note row. */

/** Whether the server actually enforces the admin key — /api/health
 * reports keyRequired so the row shows real state, not a guess. */
function KeyState() {
  const { t } = useTranslation()
  const [req, setReq] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    void fetch('/api/health').then((r) => r.json())
      .then((j) => alive && setReq(!!j.keyRequired))
      .catch(() => alive && setReq(null))
    return () => { alive = false }
  }, [])
  if (req === null) return null
  return (
    <span className={req
      ? 'rounded-full bg-tint-green px-2 py-px text-[11px] text-green'
      : 'rounded-full bg-tint-secondary px-2 py-px text-[11px] text-muted-foreground'}>
      {req ? t('set.keyOn') : t('set.keyOff')}
    </span>
  )
}

function ServiceStatus() {
  const { t } = useTranslation()
  const st = useSuperStatus()
  if (st === 'down') return <div className="px-[12px] py-[10px] text-[13px] text-muted-foreground">{t('set.svcUnmanaged')}</div>
  if (!st) return <div className="px-[12px] py-[10px] text-[13px] text-muted-foreground">…</div>
  const stateLabel = st.state === 'up' ? t('set.svcStateUp') : st.state === 'down' ? t('set.svcStateDown')
    : st.state === 'starting' ? t('set.svcStateStarting') : t('set.svcStateRestarting')
  const dot = st.state === 'up' ? 'bg-emerald-500' : 'bg-amber-500'
  const Item = ({ k, v }: { k: string; v: React.ReactNode }) => (
    <div className="flex items-center justify-between gap-2 px-[12px] py-[6px]">
      <span className="text-[12px] text-muted-foreground">{k}</span>
      <span className="font-mono text-[12px] text-foreground">{v}</span>
    </div>
  )
  return (
    <div className="rounded-[6px] px-0 py-[4px]">
      <div className="flex items-center gap-2 px-[12px] py-[6px]">
        <span className={`size-2 rounded-full ${dot}`} />
        <span className="text-[13px] font-medium text-foreground">{t('set.svcStatus')}</span>
        <span className="text-[12px] text-muted-foreground">{stateLabel}</span>
      </div>
      <Item k={t('set.svcSupervisor')} v={`pid ${st.supervisorPid}`} />
      <Item k={t('set.svcBackend')} v={st.pid ? `pid ${st.pid} :${st.backendPort}` : '—'} />
      <Item k={t('set.svcPorts')} v={st.publicPort ? `:${st.publicPort} → :${st.backendPort}` : `:${st.backendPort}`} />
      <Item k={t('set.svcUptime')} v={fmtUptime(st.uptime)} />
      <Item k={t('set.svcExits')} v={st.recentExits} />
    </div>
  )
}

function LogsPanel() {
  const { t } = useTranslation()
  const [file, setFile] = useState('supervisor')
  const [tail, setTail] = useState('300')
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const load = () => {
    setLoading(true)
    void fetch(`/api/_super/log?file=${file}&tail=${tail}`)
      .then((r) => r.text()).then(setText)
      .catch(() => setText(t('set.logMissing')))
      .finally(() => setLoading(false))
  }
  useEffect(load, [file, tail]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="px-[6px] py-[6px]">
      <div className="flex items-center gap-2 px-[6px] pb-2">
        <Combo className="w-fit" value={file} onPick={setFile}
          options={[{ v: 'supervisor', l: 'supervisor.log' }, { v: 'server', l: 'server.log' }]} />
        <Combo className="w-fit" value={tail} onPick={setTail}
          options={[{ v: '100', l: '100' }, { v: '300', l: '300' }, { v: '1000', l: '1000' }]} />
        <button onClick={load} disabled={loading}
          className="flex h-[28px] cursor-pointer items-center gap-1 rounded-[6px] border border-border bg-card px-2 text-[13px] font-medium text-foreground hover:bg-tint-tertiary disabled:opacity-50">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> {t('set.logRefresh')}
        </button>
      </div>
      <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap break-all rounded-[8px] border border-border bg-background p-3 font-mono text-[11px] leading-[1.5] text-foreground">
        {text || '…'}
      </pre>
    </div>
  )
}

/** Service tab — supervisor status + access key + restart controls + logs. */
export function ServiceTab({ setMsg }: { setMsg: (m: string) => void }) {
  const { t } = useTranslation()
  return (
    <>
      <Section title={t('set.service')}>
        <ServiceStatus />
        <Row title={t('set.accessKey')} desc={t('set.accessKeyDesc')}>
          <span className="flex items-center gap-2">
            <input
              type="password"
              defaultValue={adminKey()}
              placeholder={t('set.accessKeyPh')}
              onBlur={(e) => setAdminKey(e.target.value.trim())}
              className="h-7 w-[220px] rounded-[6px] border border-border bg-background px-2 text-[12px] outline-none focus:ring-1 focus:ring-ring"
            />
            <KeyState />
          </span>
        </Row>
        <Row title={t('set.restart')} desc={t('set.restartDesc')}>
          <Btn2 onClick={() => {
            if (!confirm(t('set.restartConfirm'))) return
            void adminFetch('/api/admin/restart', { method: 'POST', body: JSON.stringify({}) })
              .then(() => {
                setMsg(t('set.restarting'))
                // Poll health until the new backend answers — never a
                // fixed sleep (restart is fast, build isn't).
                const t0 = Date.now()
                const tick = () => fetch('/api/health').then(r => {
                  if (r.ok) location.reload()
                  else if (Date.now() - t0 < 120_000) setTimeout(tick, 1500)
                }).catch(() => { if (Date.now() - t0 < 120_000) setTimeout(tick, 1500) })
                setTimeout(tick, 1500)
              })
              .catch(() => setMsg(t('set.restartFail')))
          }}><RotateCcw size={13} /> {t('set.restartBtn')}</Btn2>
        </Row>
        <Row title={t('set.rebuild')} desc={t('set.rebuildDesc')}>
          <Btn2 onClick={() => {
            if (!confirm(t('set.redeployConfirm'))) return
            void adminFetch('/api/admin/redeploy', { method: 'POST', body: JSON.stringify({}) })
              .then(() => setMsg(t('set.building')))
              .catch(() => setMsg(t('set.buildFail')))
          }}><RefreshCw size={13} /> {t('set.rebuildBtn')}</Btn2>
        </Row>
        <Row title={t('set.svcHardRestart')} desc={t('set.svcHardRestartDesc')}>
          <Btn2 onClick={() => {
            if (!confirm(t('set.svcHardConfirm'))) return
            void fetch('/api/_super/restart', { method: 'POST' })
              .then(() => setMsg(t('set.svcHardSent')))
              .catch(() => setMsg(t('set.restartFail')))
          }}><RotateCcw size={13} /> {t('set.svcHardBtn')}</Btn2>
        </Row>
        <Row title={t('set.svcStop')} desc={t('set.svcStopDesc')}>
          <Btn2 onClick={() => {
            if (!confirm(t('set.svcStopConfirm'))) return
            void fetch('/api/_super/stop', { method: 'POST' })
              .then(() => setMsg(t('set.svcStopSent')))
              .catch(() => setMsg(t('set.restartFail')))
          }}>{t('set.svcStopBtn')}</Btn2>
        </Row>
      </Section>

      <Section title={t('set.logs')}>
        <LogsPanel />
      </Section>
    </>
  )
}

function AboutPanel() {
  const { t } = useTranslation()
  const st = useSuperStatus()
  const Item = ({ k, v }: { k: string; v: React.ReactNode }) => (
    <div className="flex items-center justify-between gap-4 px-[12px] py-[8px]">
      <span className="shrink-0 text-[13px] text-muted-foreground">{k}</span>
      <span className="min-w-0 truncate text-right font-mono text-[12px] text-foreground">{v}</span>
    </div>
  )
  const down = st === 'down' || !st
  return (
    <div className="py-[4px]">
      <Item k="devin-web" v={down ? '—' : `v${st.version}`} />
      <Item k={t('set.aboutRuntime')} v={down ? '—' : `Node ${st.node} · ${st.platform}`} />
      {!down && <Item k={t('set.aboutRepo')} v={st.repoRoot} />}
      {!down && <Item k={t('set.aboutData')} v={st.dataDir} />}
      <Item k={t('set.aboutDev')} v={t('set.aboutDevDesc')} />
    </div>
  )
}

/** About tab — version/runtime/repo/data-dir rows off the supervisor status. */
export function AboutTab() {
  const { t } = useTranslation()
  return (
    <Section title={t('set.about')}>
      <AboutPanel />
    </Section>
  )
}
