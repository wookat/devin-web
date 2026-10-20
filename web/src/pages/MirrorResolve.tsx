import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { adminFetch } from '@/lib/api'

/**
 * Same-origin stand-ins for official console URLs:
 *   /admin/d/<hex>                       ≙ app.devin.ai/sessions/<hex>
 *   /admin/review/<owner>/<repo>/pull/<n> ≙ app.devin.ai/review/<owner>/<repo>/pull/<n>
 * Both resolve to the local registration (sessions are registered on first
 * visit) and redirect into the shared mirror page.
 */
export default function MirrorResolvePage({ kind }: { kind: 'session' | 'review' }) {
  const { t } = useTranslation()
  const params = useParams()
  const navigate = useNavigate()
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    const run = async () => {
      if (kind === 'session') {
        const hex = params.hex || ''
        const r = await adminFetch<{ id: string }>(`/api/admin/resolve/session/${encodeURIComponent(hex)}?register=1`)
        if (alive) navigate(`/admin/${r.id}`, { replace: true })
        return
      }
      const prUrl = `https://github.com/${params.owner}/${params.repo}/pull/${params.number}`
      const r = await adminFetch<{ id: string; pr_url: string }>(`/api/admin/resolve/pr?url=${encodeURIComponent(prUrl)}`)
      if (alive) navigate(`/admin/${r.id}?pr=${encodeURIComponent(r.pr_url)}`, { replace: true })
    }
    run().catch((e) => {
      if (!alive) return
      const msg = (e as Error).message
      setErr(msg === 'unauthorized' ? t('mr.needLogin') : msg)
    })
    return () => { alive = false }
  }, [kind, params, navigate])
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 bg-background px-6 text-center text-[13px] text-muted-foreground">
      {err ? (
        <>
          <p className="text-foreground">{t('mr.cantOpen')}{err}</p>
          {kind === 'review' && (
            <a href={`https://github.com/${params.owner}/${params.repo}/pull/${params.number}`} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
              {t('mr.openOnGithub')}
            </a>
          )}
          <Link to="/" className="text-blue-600 hover:underline">{t('mr.backToSessions')}</Link>
        </>
      ) : (
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
      )}
    </div>
  )
}
