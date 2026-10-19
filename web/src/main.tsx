import { StrictMode, Suspense, lazy, useEffect, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import './index.css'

const AdminSessionPage = lazy(() => import('./pages/AdminSession'))
const AdminMirrorPage = lazy(() => import('./pages/AdminMirror'))
const MirrorResolvePage = lazy(() => import('./pages/MirrorResolve'))
const SettingsPage = lazy(() => import('./pages/Settings'))
const SessionsPage = lazy(() => import('./pages/SessionsPage'))
import { initTheme } from './lib/theme'
import { initScrollReveal } from './lib/scrollReveal'
import { prefetchAdmin, prefetchShare } from './lib/api'

initTheme()
initScrollReveal()

// Kick off the session's first-paint requests in parallel with the route chunk download.
const mirrorMatch = /^\/admin\/([\w-]+)(?:\/mirror)?\/?$/.exec(location.pathname)
// 'new' is the draft sentinel and 'sessions' the management page — prefetching
// session endpoints for either would 404.
if (mirrorMatch && mirrorMatch[1] !== 'new' && mirrorMatch[1] !== 'sessions') {
  const id = mirrorMatch[1]
  // peek=1 must match AdminMirror's first timeline fetch exactly — a non-peek
  // prefetch would start a session/load server-side and bump the session's
  // updatedAt, defeating the lazy-browse design.
  prefetchAdmin(`/api/admin/session/${id}/timeline?limit=300&peek=1&boot=1`)
  prefetchAdmin(`/api/admin/session/${id}?slim=1&boot=1`)
  prefetchAdmin(`/api/admin/session/${id}/todos`)
}
const shareMatch = /^\/s\/([\w-]+)\/?$/.exec(location.pathname)
const shareTok = new URLSearchParams(location.search).get('t')
if (shareMatch && shareTok) {
  prefetchShare(shareMatch[1], shareTok, '/meta')
  prefetchShare(shareMatch[1], shareTok, '/timeline?limit=300&boot=1')
  prefetchShare(shareMatch[1], shareTok, '/todos')
}

// Resolve the landing route's chunk before the first render: committing the
// Suspense fallback first would make React hold the real content for its
// ~300ms fallback throttle even though the chunk arrives in ~40ms.
type RouteModule = { default: ComponentType }

// Last-page memory: reopening the workbench lands on whatever was open when
// it closed (session, draft, settings) —底层行为, no toggle. Only '/' is
// restored from; share links and the /admin/d/ resolver never overwrite it.
function RouteTracker() {
  const loc = useLocation()
  useEffect(() => {
    const p = loc.pathname + loc.search
    if (p === '/' || p.startsWith('/s/') || p.startsWith('/admin/d/')) return
    try { localStorage.setItem('wb2-last-route', p) } catch { /* unavailable */ }
  }, [loc.pathname, loc.search])
  return null
}

function LastOrNew() {
  let last: string | null = null
  try { last = localStorage.getItem('wb2-last-route') } catch { /* unavailable */ }
  return <Navigate to={last || '/admin/new'} replace />
}

// The visitor share page renders the same AdminMirror component with a visitor viewer.
const bootImport: Promise<RouteModule> | null =
  (shareMatch && shareTok) || mirrorMatch || location.pathname === '/' ? import('./pages/AdminMirror')
  : null

function mount(boot: RouteModule | null) {
  const Mirror = boot && (mirrorMatch || shareMatch || location.pathname === '/') ? boot.default : AdminMirrorPage
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <BrowserRouter>
        <Suspense fallback={<div className="flex h-screen items-center justify-center bg-background"><div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" /></div>}>
        <RouteTracker />
        <Routes>
          <Route path="/" element={<LastOrNew />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/admin/d/:hex" element={<MirrorResolvePage kind="session" />} />
          <Route path="/admin/review/:owner/:repo/pull/:number" element={<MirrorResolvePage kind="review" />} />
          <Route path="/admin/sessions" element={<SessionsPage />} />
          <Route path="/admin/:id" element={<Mirror />} />
          <Route path="/admin/:id/mirror" element={<Mirror />} />
          <Route path="/admin/:id/classic" element={<AdminSessionPage />} />
          <Route path="/s/:id" element={<Mirror />} />
        </Routes>
        </Suspense>
      </BrowserRouter>
    </StrictMode>,
  )
}

if (bootImport) bootImport.then(mount, () => mount(null))
else mount(null)
