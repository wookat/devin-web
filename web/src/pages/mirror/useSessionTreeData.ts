/**
 * useSessionTreeData — the sidebar session-tree data cluster.
 * Owns the registry list + mirror tree (folder order/totals, archived page,
 * pagination cursor), the booted-gated fetch loops, the per-id set used to
 * detect pushes for unknown sessions, and the /ws `session_status` patching
 * (moved out of the timeline effect — a second subscriber on the same pub-sub
 * channel handles the tree's own events).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { adminFetch, type AdminSession } from '@/lib/api'
import { visibleInterval } from '@/lib/poll'
import { subscribeWs } from '@/lib/ws'
import { type TreePrefs, TREE_PREFS_KEY, DEFAULT_TREE_PREFS, buildFilterQ } from './SessionTree'
import { readTreeCache, type MirrorTreeSession, type TreeCachePayload, writeTreeCache } from './treeCache'

export function useSessionTreeData({ isVisitor, isDraft, id, booted }: { isVisitor: boolean; isDraft: boolean; id: string; booted: boolean }) {
  const cachedTree = useMemo(() => readTreeCache(), [])
  const [sessions, setSessions] = useState<AdminSession[]>([])
  const [tree, setTree] = useState<MirrorTreeSession[]>(() => cachedTree?.sessions || [])
  const [folderOrder, setFolderOrder] = useState<string[]>(() => cachedTree?.folder_order || [])
  const [folderTotals, setFolderTotals] = useState<Record<string, number>>(() => cachedTree?.folder_totals || {})
  const treeIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => { treeIdsRef.current = new Set(tree.map((s) => s.devin_id)) }, [tree])

  // Registry + sidebar tree only start once the first timeline page has landed, so
  // the large tree payload never competes with the conversation for the first paint.
  useEffect(() => {
    if (!booted || isVisitor) return
    const load = () => adminFetch<{ sessions: AdminSession[] }>('/api/admin/sessions').then((r) => setSessions(r.sessions)).catch(() => {})
    load()
    return visibleInterval(load, 30_000)
  }, [booted, isVisitor])

  const [treePrefs, setTreePrefs] = useState<TreePrefs>(() => {
    try {
      const raw = localStorage.getItem(TREE_PREFS_KEY)
      return raw ? { ...DEFAULT_TREE_PREFS, ...(JSON.parse(raw) as Partial<TreePrefs>) } : DEFAULT_TREE_PREFS
    } catch {
      return DEFAULT_TREE_PREFS
    }
  })
  const updateTreePrefs = useCallback((p: Partial<TreePrefs>) => setTreePrefs((prev) => {
    const next = { ...prev, ...p }
    try { localStorage.setItem(TREE_PREFS_KEY, JSON.stringify(next)) } catch { /* quota */ }
    return next
  }), [])
  const [archTree, setArchTree] = useState<MirrorTreeSession[]>([])
  const loadTree = useCallback(() => {
    const filterQ = buildFilterQ(treePrefs)
    adminFetch<{ sessions: MirrorTreeSession[]; folder_order?: string[]; folder_totals?: Record<string, number>; next_cursor?: string | null }>(`/api/admin/mirror/sessions?limit=60&order_by=${treePrefs.sort}${filterQ}`).then((r) => {
      const payload: TreeCachePayload = {
        sessions: r.sessions || [],
        folder_order: r.folder_order || [],
        folder_totals: r.folder_totals || {},
        next_cursor: r.next_cursor || null,
      }
      setTree(payload.sessions)
      setFolderOrder(payload.folder_order)
      setFolderTotals(payload.folder_totals)
      setTreeCursor(payload.next_cursor || '')
      writeTreeCache(payload)
    }).catch(() => {})
    if (treePrefs.showArchived) adminFetch<{ sessions: MirrorTreeSession[] }>(`/api/admin/mirror/sessions?limit=10&archived=true&order_by=${treePrefs.sort}${filterQ}`).then((r) => setArchTree(r.sessions || [])).catch(() => {})
  }, [treePrefs])
  const [treeCursor, setTreeCursor] = useState(() => cachedTree?.next_cursor || '')
  const [loadingMore, setLoadingMore] = useState(false)
  const loadMoreTree = useCallback(() => {
    if (!treeCursor || loadingMore) return
    setLoadingMore(true)
    adminFetch<{ sessions: MirrorTreeSession[]; next_cursor?: string | null }>(`/api/admin/mirror/sessions?limit=60&order_by=${treePrefs.sort}${buildFilterQ(treePrefs)}&cursor=${encodeURIComponent(treeCursor)}`)
      .then((r) => {
        setTree((prev) => {
          const seen = new Set(prev.map((s) => s.devin_id))
          return [...prev, ...(r.sessions || []).filter((s) => !seen.has(s.devin_id))]
        })
        setTreeCursor(r.next_cursor || '')
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false))
  }, [treeCursor, loadingMore, treePrefs])

  useEffect(() => {
    if (!booted || isVisitor) return
    loadTree()
    return visibleInterval(loadTree, 60_000)
  }, [loadTree, booted, isVisitor])
  const loadTreeRef = useRef(loadTree)
  loadTreeRef.current = loadTree

  // Sidebar status pushes — patch the matching tree row in place for ANY
  // session. Own subscription so the tree cluster handles its own events.
  // (Skipped in draft mode — the original handler lived inside the timeline
  // effect, which returns early for /admin/new.)
  useEffect(() => {
    if (isDraft) return
    let treeMissTimer: number | null = null
    const off = subscribeWs((ev) => {
      if (ev.type !== 'session_status' || typeof ev.sessionId !== 'string') return
      const sid = ev.sessionId
      const st = typeof ev.status === 'string' ? ev.status : 'blocked'
      setTree((prev) => prev.map((s) =>
        s.devin_id === sid && s.status_enum !== 'archived'
          ? { ...s, status_enum: st, activity_status: st === 'working' ? 'working' : 'idle' }
          : s,
      ))
      // Status for a session the tree doesn't list (created by another
      // client or beyond the loaded page) — one debounced list refresh.
      if (!treeIdsRef.current.has(sid)) {
        if (treeMissTimer == null) treeMissTimer = window.setTimeout(() => { treeMissTimer = null; loadTreeRef.current() }, 2000)
      }
    })
    return () => {
      off()
      if (treeMissTimer != null) clearTimeout(treeMissTimer)
    }
  }, [id, isDraft])

  return {
    sessions, tree, folderOrder, folderTotals, archTree,
    treeCursor, loadingMore, loadMoreTree, loadTree,
    treePrefs, updateTreePrefs,
  }
}
