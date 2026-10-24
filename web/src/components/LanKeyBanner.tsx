import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { ShieldAlert, X } from 'lucide-react'

const DISMISS_KEY = 'dw-lan-open-dismissed'

/** Amber nudge shown once when the UI is reached over a non-loopback host
 *  while the backend has no DEVIN_WEB_ADMIN_KEY — anyone on the LAN can
 *  then drive sessions. Localhost access stays silent (that's the normal
 *  single-user case). */
export default function LanKeyBanner() {
  const { t } = useTranslation()
  const [show, setShow] = useState(false)
  useEffect(() => {
    try { if (localStorage.getItem(DISMISS_KEY) === '1') return } catch { /* private mode */ }
    const h = location.hostname
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]') return
    fetch('/api/health').then((r) => r.json())
      .then((j) => { if (!j.keyRequired) setShow(true) })
      .catch(() => {})
  }, [])
  if (!show) return null
  return (
    <div className="fixed bottom-4 left-1/2 z-[70] flex w-[min(92vw,560px)] -translate-x-1/2 items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 shadow-lg backdrop-blur">
      <ShieldAlert size={18} className="mt-0.5 shrink-0 text-amber-500" />
      <div className="min-w-0 flex-1 text-[12.5px] leading-[18px]">
        <div className="font-medium text-amber-600 dark:text-amber-400">{t('lanOpen.title')}</div>
        <div className="mt-0.5 text-muted-foreground">
          {t('lanOpen.body')}{' '}
          <Link to="/settings/service" className="font-medium text-amber-600 underline underline-offset-2 hover:opacity-80 dark:text-amber-400">{t('lanOpen.fix')}</Link>
        </div>
      </div>
      <button
        aria-label={t('lanOpen.dismiss')}
        className="shrink-0 cursor-pointer rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={() => { try { localStorage.setItem(DISMISS_KEY, '1') } catch { /* ignore */ } setShow(false) }}
      >
        <X size={15} />
      </button>
    </div>
  )
}
