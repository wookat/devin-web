import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { adminFetch } from '@/lib/api'

/**
 * Same-origin stand-in for official console session URLs:
 *   /admin/d/<hex> ≙ app.devin.ai/sessions/<hex>
 * Resolves to the local registration (sessions are registered on first visit)
 * and redirects into the shared mirror page. PR review links go straight to
 * the standalone /admin/review/<owner>/<repo>/pull/<n> page (ReviewPage).
 */
export default function MirrorResolvePage({ kind }: { kind: 'session' }) {
  const { t } = useTranslation()
  const params = useParams()
  const navigate = useNavigate()
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    const run = async () => {
      const hex = params.hex || ''
      const r = await adminFetch<{ id: string }>(`/api/admin/resolve/session/${encodeURIComponent(hex)}?register=1`)
      if (alive) navigate(`/admin/${r.id}`, { replace: true })
    }
    run().catch((e) => {
      if (!alive) return
      setErr((e as Error).message)
    })
    return () => { alive = false }
  }, [kind, params, navigate])
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 bg-background px-6 text-center text-[13px] text-muted-foreground">
      {err ? (
        <>
          <p className="text-foreground">{t('mr.cantOpen')}{err}</p>
          <Link to="/" className="text-blue-600 hover:underline">{t('mr.backToSessions')}</Link>
        </>
      ) : (
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
      )}
    </div>
  )
}
