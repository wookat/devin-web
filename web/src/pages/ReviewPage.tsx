import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { GitPullRequest, ArrowLeft } from 'lucide-react'
import { PrPanel } from './mirror/PrPanel'

/**
 * Standalone PR review (official /review ≙ /admin/review): paste a GitHub PR
 * URL → full PrPanel. The panel's backend ignores the session id segment, so
 * the "review" sentinel works without any session association.
 */
const PR_URL_RE = /^https?:\/\/(www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i
const SHORT_RE = /^([^/\s]+)\/([^/\s]+?)\/pull\/(\d+)$/i
const NUM_RE = /^([^/\s]+)\/([^/\s]+?)#(\d+)$/

export default function ReviewPage() {
  const { t } = useTranslation()
  const { owner, repo, number } = useParams()
  const navigate = useNavigate()
  const [url, setUrl] = useState('')
  const [err, setErr] = useState('')

  if (owner && repo && number) {
    const prUrl = `https://github.com/${owner}/${repo}/pull/${number}`
    return (
      <div className="flex h-screen flex-col bg-background text-foreground">
        <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-4 text-[13px]">
          <Link to="/admin/review" className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
            <ArrowLeft size={13} /> {t('rv.back')}
          </Link>
          <GitPullRequest size={13} className="text-muted-foreground" />
          <span className="text-muted-foreground">
            {owner}/{repo} <span className="font-medium text-foreground">#{number}</span>
          </span>
        </header>
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto max-w-[1200px]">
            <PrPanel id="review" prUrl={prUrl} />
          </div>
        </div>
      </div>
    )
  }

  const go = () => {
    const v = url.trim()
    const gh = v.match(PR_URL_RE)
    const m = gh ? [gh[2], gh[3], gh[4]] : (v.match(SHORT_RE) || v.match(NUM_RE))?.slice(1)
    if (m) {
      navigate(`/admin/review/${m[0]}/${m[1].replace(/\.git$/, '')}/pull/${m[2]}`)
      return
    }
    setErr(t('rv.bad'))
  }
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-5 bg-background px-6 text-foreground">
      <GitPullRequest size={28} className="text-muted-foreground" />
      <h1 className="text-[17px] font-medium">{t('rv.title')}</h1>
      <div className="flex w-full max-w-md gap-2">
        <input
          autoFocus
          value={url}
          onChange={(e) => { setUrl(e.target.value); setErr('') }}
          onKeyDown={(e) => { if (e.key === 'Enter') go() }}
          placeholder={t('rv.ph')}
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none placeholder:text-muted-foreground focus:border-ring"
        />
        <button onClick={go} className="cursor-pointer rounded-md bg-primary px-3 py-2 text-[13px] font-medium text-primary-foreground hover:opacity-90">
          {t('rv.go')}
        </button>
      </div>
      {err && <p className="text-[12px] text-red-500">{err}</p>}
    </div>
  )
}
