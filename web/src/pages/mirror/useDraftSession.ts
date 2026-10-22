/**
 * useDraftSession — the /admin/new ("draft") landing state cluster.
 * Owns the workspace/target/agent picks plus the first-send create flow:
 * sendDraft POSTs /api/admin/sessions/new, replays draft config picks onto the
 * fresh session, then navigates in place (desktop-parity new-session flow).
 */
import { useCallback, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { adminFetch } from '@/lib/api'
import { type DraftTarget } from './LocalPicker'

export function useDraftSession({ draftFolder }: { draftFolder: string }) {
  const nav = useNavigate()
  // Draft workspace pick (desktop parity: new session lets you choose the repo).
  const [draftCwd, setDraftCwd] = useState('')
  // Draft run target — local or `本地+SSH` (agent CLI on a configured remote
  // host). Persisted like the desktop target pick; remote cwd is free text
  // (no remote fs browse).
  const [draftTarget, setDraftTargetState] = useState<DraftTarget>(() => {
    try {
      const p = JSON.parse(localStorage.getItem('dw-draft-target') ?? 'null')
      if (p?.kind === 'ssh' && typeof p.host?.target === 'string' && p.host.target) return p as DraftTarget
    } catch { /* unavailable */ }
    return { kind: 'local' }
  })
  const [draftSshCwd, setDraftSshCwd] = useState('')
  const setDraftTarget = useCallback((v: DraftTarget) => {
    setDraftTargetState(v)
    try { localStorage.setItem('dw-draft-target', JSON.stringify(v)) } catch { /* unavailable */ }
  }, [])
  const [draftAgent, setDraftAgent] = useState('devin')
  // Config picks made in draft mode — replayed onto the session right after
  // creation (the server also applies dw.json lastConfig on its own).
  const draftPicks = useRef<{ configId: string; value: string }[]>([])

  // The first send IS the session — create it with the text as the task,
  // replay draft config picks onto it, then swap in place (server also
  // applies lastConfig). onCreated fires just before the navigate so the
  // caller can clear composer state in the original order.
  const sendDraft = useCallback(async (
    text: string,
    attachments: { url: string; name: string; size: number }[],
    onCreated?: () => void,
  ) => {
    const task = text.startsWith('/queue ') ? text.slice(7).trim() : text
    const r = await adminFetch<{ ok: boolean; id?: string; error?: string }>('/api/admin/sessions/new', {
      method: 'POST',
      body: JSON.stringify({
        task,
        folder: draftFolder || undefined,
        // Local target → picked dir (empty = server default). SSH target →
        // the remote dir (text input falls back to the host's default).
        cwd: draftTarget.kind === 'ssh' ? (draftSshCwd.trim() || draftTarget.host.cwd || undefined) : (draftCwd || undefined),
        ssh: draftTarget.kind === 'ssh' ? draftTarget.host.target : undefined,
        agent: draftAgent,
        attachments,
      }),
    })
    if (!r.ok || !r.id) throw new Error(r.error || 'create failed')
    for (const pick of draftPicks.current) {
      void adminFetch(`/api/admin/session/${r.id}/config`, { method: 'POST', body: JSON.stringify(pick) }).catch(() => null)
    }
    draftPicks.current = []
    onCreated?.()
    nav(`/admin/${r.id}`, { replace: true })
  }, [draftFolder, draftTarget, draftSshCwd, draftCwd, draftAgent, nav])

  return {
    draftCwd, setDraftCwd,
    draftTarget, setDraftTarget,
    draftSshCwd, setDraftSshCwd,
    draftAgent, setDraftAgent,
    draftPicks, sendDraft,
  }
}
