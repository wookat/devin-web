import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { BookOpen, Loader2, Pin, PinOff, Plus, RefreshCw, Search, Send, Trash2, ArrowLeft, X } from 'lucide-react'

/** GitHub octocat mark (official renders the ServiceLogos provider glyph). */
const GitHubMark = ({ size = 24, className = '' }: { size?: number; className?: string }) => (
  <svg viewBox="0 0 16 16" width={size} height={size} className={className} fill="currentColor" aria-hidden="true">
    <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27s-1.36.09-2 .27c-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
  </svg>
)
import { OExpand } from '@/components/officialIcons'
import { adminFetch } from '@/lib/api'
import AppSidebar from '@/components/AppSidebar'
import Markdown from '@/components/Markdown'
import type { MirrorTreeSession } from './mirror/treeCache'

interface WikiRepo {
  repo: string
  pinned: boolean
  addedAt: number
  lastOpenedAt?: number
  indexed?: boolean
  topicCount?: number
  topics?: WikiTopic[]
}
interface WikiTopic { id: string; title: string; depth: number }

const fetchTree = (set: (s: MirrorTreeSession[]) => void) =>
  adminFetch<{ sessions: MirrorTreeSession[] }>('/api/admin/mirror/sessions')
    .then((r) => set(r.sessions ?? []))
    .catch(() => {})

/** Shared shell: real AppSidebar + the h-11 page header (same as StubPage). */
function Shell({ sideOpen, setSideOpen, tree, panel, children, activeDevinId = '', onRefreshTree }: {
  sideOpen: boolean
  setSideOpen: (b: boolean) => void
  tree: MirrorTreeSession[]
  panel?: React.ReactNode
  children: React.ReactNode
  activeDevinId?: string
  onRefreshTree?: () => void
}) {
  const { t } = useTranslation()
  const nav = useNavigate()
  return (
    <div className="flex h-screen bg-background text-foreground">
      <AppSidebar
        open={sideOpen}
        onToggle={setSideOpen}
        active="wiki"
        tree={tree.filter((s) => s.status_enum !== 'archived')}
        archivedTree={tree.filter((s) => s.status_enum === 'archived')}
        activeDevinId={activeDevinId}
        onOpen={(s) => nav(`/admin/${s.devin_id}`)}
        onRefresh={onRefreshTree}
        panel={panel}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border-secondary px-2 pr-[7px]">
          {!sideOpen && (
            <button
              onClick={() => setSideOpen(true)}
              className="flex size-7 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground"
              aria-label={t('sp.expandSb')}
              title={t('sp.expandSb')}
            >
              <OExpand size={16} />
            </button>
          )}
        </header>
        {children}
      </div>
    </div>
  )
}

/* ---------------- home: repo card grid (official "Wikis" page) ---------------- */

function WikiHome() {
  const { t } = useTranslation()
  const nav = useNavigate()
  const [sideOpen, setSideOpen] = useState(window.innerWidth >= 1024)
  const [tree, setTree] = useState<MirrorTreeSession[]>([])
  const [repos, setRepos] = useState<WikiRepo[] | null>(null)
  const [search, setSearch] = useState('')
  const [adding, setAdding] = useState(false)
  const [addVal, setAddVal] = useState('')
  const [addErr, setAddErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [spin, setSpin] = useState(0)

  const load = () => adminFetch<{ repos: WikiRepo[] }>('/api/admin/wiki/repos')
    .then((r) => setRepos(r.repos ?? []))
    .catch(() => setRepos([]))
  useEffect(() => { fetchTree(setTree); void load() }, [])

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (repos ?? []).filter((r) => !q || r.repo.includes(q))
  }, [repos, search])

  const addRepo = async () => {
    const repo = addVal.trim().toLowerCase().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '')
    if (!repo) return
    setBusy(true); setAddErr('')
    try {
      await adminFetch('/api/admin/wiki/repos', { method: 'POST', body: JSON.stringify({ repo }) })
      setAddVal(''); setAdding(false)
      await load()
    } catch (e) {
      setAddErr((e as Error).message || t('wiki.addFailed'))
    } finally { setBusy(false) }
  }

  const togglePin = async (r: WikiRepo) => {
    await adminFetch(`/api/admin/wiki/repos/${r.repo}/pin`, { method: 'POST', body: JSON.stringify({ pinned: !r.pinned }) }).catch(() => {})
    void load()
  }
  const removeRepo = async (r: WikiRepo) => {
    await adminFetch(`/api/admin/wiki/repos/${r.repo}`, { method: 'DELETE' }).catch(() => {})
    void load()
  }

  return (
    <Shell sideOpen={sideOpen} setSideOpen={setSideOpen} tree={tree} onRefreshTree={() => fetchTree(setTree)}>
      <div className="flex w-full flex-1 flex-col items-center overflow-y-auto py-4 sm:py-8">
        <div className="flex w-full max-w-[min(1200px,max(50vw,800px))] flex-col gap-6 px-4 pb-[12vh] sm:px-6">
          {/* toolbar — official: refetch + filter | search | add */}
          <div className="flex min-w-0 items-center gap-2">
            <button
              onClick={() => { setSpin((s) => s + 1); void load() }}
              className="flex size-7 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground"
              title={t('wiki.refetch')} aria-label={t('wiki.refetch')}
            >
              <RefreshCw size={16} className={spin ? 'animate-[spin_0.5s_ease-in-out_1]' : ''} key={spin} />
            </button>
            <div className="flex h-7 min-w-0 max-w-[400px] flex-1 items-center gap-1.5 rounded-[6px] border border-border-secondary bg-bg-elevated px-2">
              <Search size={14} className="shrink-0 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('wiki.search')}
                aria-label={t('wiki.search')}
                className="h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
              />
            </div>
            <div className="flex-1" />
            <button
              onClick={() => setAdding(true)}
              className="flex h-7 items-center gap-1 rounded-[6px] bg-accent-primary px-2.5 text-[13px] font-medium text-white hover:opacity-90"
            >
              <Plus size={14} />{t('wiki.addWiki')}
            </button>
          </div>

          <h2 className="mx-1 text-18 font-medium">{t('wiki.heading')}</h2>

          {/* add-repo inline dialog */}
          {adding && (
            <div className="mx-1 flex flex-col gap-2 rounded-[10px] border border-border-secondary bg-bg-elevated p-3">
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  value={addVal}
                  onChange={(e) => setAddVal(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void addRepo(); if (e.key === 'Escape') setAdding(false) }}
                  placeholder="owner/repo — e.g. facebook/react"
                  className="h-8 min-w-0 flex-1 rounded-[6px] border border-border-secondary bg-background px-2 text-[13px] outline-none placeholder:text-muted-foreground"
                />
                <button
                  onClick={() => void addRepo()}
                  disabled={busy || !addVal.trim()}
                  className="flex h-8 items-center gap-1.5 rounded-[6px] bg-accent-primary px-3 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}{t('wiki.add')}
                </button>
                <button onClick={() => setAdding(false)} className="flex size-8 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary">
                  <X size={14} />
                </button>
              </div>
              <div className="text-[12px] text-muted-foreground">{t('wiki.addHint')}</div>
              {addErr && <div className="text-[12px] text-red-500">{addErr}</div>}
            </div>
          )}

          {/* card grid — official: 1col → @[592px] 2col → @[816px] 3col */}
          {repos === null ? (
            <div className="col-span-full flex justify-center py-12"><Loader2 size={18} className="animate-spin text-muted-foreground" /></div>
          ) : shown.length === 0 ? (
            <div className="col-span-full py-12 text-center text-muted-foreground">
              <BookOpen size={28} className="mx-auto mb-3 opacity-50" />
              <div className="mb-1 text-[15px]">{repos.length === 0 ? t('wiki.empty') : t('wiki.noMatch')}</div>
              {repos.length === 0 && <div className="text-[13px]">{t('wiki.emptyHint')}</div>}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {shown.map((r) => {
                const short = r.repo.split('/')[1] ?? r.repo
                const owner = r.repo.split('/')[0]
                return (
                  <div
                    key={r.repo}
                    onClick={() => nav(`/admin/wiki/${r.repo}`)}
                    className="group relative flex cursor-pointer items-center gap-2.5 rounded-[10px] border border-border-secondary bg-bg-elevated p-3 hover:border-border hover:bg-tint-secondary"
                  >
                    <GitHubMark size={24} className="size-6 shrink-0 text-foreground" />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <div className="truncate text-[14px] font-medium">{short}</div>
                      <div className="truncate text-[12px] text-muted-foreground">
                        {owner}{r.topicCount ? ` · ${r.topicCount} ${t('wiki.topics')}` : ''}
                      </div>
                    </div>
                    <div className="absolute right-2 top-2 z-10 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        onClick={(e) => { e.stopPropagation(); void togglePin(r) }}
                        className="flex size-6 items-center justify-center rounded-[5px] text-muted-foreground hover:bg-background hover:text-foreground"
                        title={r.pinned ? t('wiki.unpin') : t('wiki.pin')}
                      >
                        {r.pinned ? <PinOff size={13} /> : <Pin size={13} />}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); void removeRepo(r) }}
                        className="flex size-6 items-center justify-center rounded-[5px] text-muted-foreground hover:bg-background hover:text-red-500"
                        title={t('wiki.remove')}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </Shell>
  )
}

/* ---------------- reader: TOC sidebar + article + ask ---------------- */

function WikiReader({ owner, repo }: { owner: string; repo: string }) {
  const { t } = useTranslation()
  const nav = useNavigate()
  const repoName = `${owner}/${repo}`
  const [params, setParams] = useSearchParams()
  const [sideOpen, setSideOpen] = useState(window.innerWidth >= 1024)
  const [tree, setTree] = useState<MirrorTreeSession[]>([])
  const [topics, setTopics] = useState<WikiTopic[] | null>(null)
  const [page, setPage] = useState<{ title: string; markdown: string } | null>(null)
  const [pageErr, setPageErr] = useState('')
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [asking, setAsking] = useState(false)
  const [answers, setAnswers] = useState<{ q: string; a: string }[]>([])
  const want = params.get('page') || '1'
  const articleRef = useRef<HTMLDivElement>(null)

  useEffect(() => { fetchTree(setTree) }, [])
  useEffect(() => {
    adminFetch<{ topics: WikiTopic[] }>(`/api/admin/wiki/structure?repo=${encodeURIComponent(repoName)}`)
      .then((r) => setTopics(r.topics ?? []))
      .catch(() => setTopics([]))
  }, [repoName])
  useEffect(() => {
    setLoading(true); setPageErr('')
    adminFetch<{ title: string; markdown: string }>(`/api/admin/wiki/page?repo=${encodeURIComponent(repoName)}&page=${encodeURIComponent(want)}`)
      .then((r) => { setPage(r); setLoading(false); articleRef.current?.scrollTo(0, 0) })
      .catch((e) => { setPage(null); setPageErr(e.message); setLoading(false) })
  }, [repoName, want])

  const ask = async () => {
    const question = q.trim()
    if (!question || asking) return
    setAsking(true)
    try {
      const r = await adminFetch<{ answer: string }>('/api/admin/wiki/ask', { method: 'POST', body: JSON.stringify({ repo: repoName, question }) })
      setAnswers((a) => [...a, { q: question, a: r.answer }])
      setQ('')
    } catch (e) {
      setAnswers((a) => [...a, { q: question, a: `*${t('wiki.askFailed')}:* ${(e as Error).message}` }])
    } finally { setAsking(false) }
  }

  const toc = (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-2 pb-1 pt-2">
        <div className="min-w-0 truncate text-[12px] font-medium text-muted-foreground">{repoName}</div>
        <Link to="/admin/wiki" className="flex shrink-0 items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-[12px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground">
          <ArrowLeft size={12} />{t('wiki.back')}
        </Link>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {(topics ?? []).map((tp) => (
          <button
            key={tp.id}
            onClick={() => setParams({ page: tp.id })}
            className={`flex w-full items-center rounded-[5px] px-2 py-1 text-left text-[13px] leading-[18px] hover:bg-tint-secondary ${want === tp.id ? 'bg-tint-secondary font-medium' : 'text-muted-foreground'}`}
            style={{ paddingLeft: `${8 + tp.depth * 12}px` }}
            title={tp.title}
          >
            <span className="truncate">{tp.title}</span>
          </button>
        ))}
        {topics === null && <div className="flex justify-center py-6"><Loader2 size={16} className="animate-spin text-muted-foreground" /></div>}
      </div>
    </div>
  )

  return (
    <Shell sideOpen={sideOpen} setSideOpen={setSideOpen} tree={tree} panel={toc} onRefreshTree={() => fetchTree(setTree)}>
      <div ref={articleRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[min(900px,100%-2rem)] px-4 py-6 sm:px-8">
          {loading ? (
            <div className="flex justify-center py-16"><Loader2 size={18} className="animate-spin text-muted-foreground" /></div>
          ) : pageErr ? (
            <div className="py-16 text-center text-[14px] text-muted-foreground">{pageErr}</div>
          ) : page ? (
            <article className="pb-10">
              <Markdown text={page.markdown} />
            </article>
          ) : null}

          {/* Ask — deepwiki "Ask Devin" equivalent */}
          {!loading && !pageErr && (
            <div className="border-t border-border-secondary pt-4">
              {answers.map((a, i) => (
                <div key={i} className="mb-4">
                  <div className="mb-1 text-[13px] font-medium text-foreground">{a.q}</div>
                  <Markdown text={a.a} />
                </div>
              ))}
              <div className="flex items-center gap-2 rounded-[10px] border border-border-secondary bg-bg-elevated p-2 pl-3">
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void ask() }}
                  placeholder={t('wiki.askPlaceholder', { repo: repoName })}
                  disabled={asking}
                  className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted-foreground"
                />
                <button
                  onClick={() => void ask()}
                  disabled={asking || !q.trim()}
                  className="flex size-8 items-center justify-center rounded-[7px] bg-accent-primary text-white hover:opacity-90 disabled:opacity-40"
                  aria-label={t('wiki.ask')}
                >
                  {asking ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Shell>
  )
}

export default function WikiPage() {
  const { owner, repo } = useParams()
  if (owner && repo) return <WikiReader owner={owner} repo={repo} />
  return <WikiHome />
}
