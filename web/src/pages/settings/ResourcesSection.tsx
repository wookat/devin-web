import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpen, ChevronDown, ChevronRight, FileText } from 'lucide-react'
import { adminFetch } from '@/lib/api'
import { CodeEditor } from '@/pages/mirror/WorkspacePanel'
import { Section } from './atoms'

/* Agent resources — multi-level (project/global) rules + skills browser.
 * Entries open inline into the shared CodeEditor; save rides
 * /api/admin/resource-file (server confines writes to resource roots). */
interface ResEntry { scope: string; name: string; path: string; description?: string }

function AgentResources() {
  const { t } = useTranslation()
  const [data, setData] = useState<{ cwd: string; rules: ResEntry[]; skills: ResEntry[] } | null>(null)
  const [openPath, setOpenPath] = useState<string | null>(null)
  useEffect(() => {
    void adminFetch<{ cwd: string; rules: ResEntry[]; skills: ResEntry[] }>('/api/admin/resources')
      .then(setData).catch(() => setData({ cwd: '', rules: [], skills: [] }))
  }, [])
  if (!data) return <p className="px-[12px] py-[10px] text-13 text-secondary">{t('common.loading')}</p>
  const groups: { scope: 'project' | 'global'; label: string }[] = [
    { scope: 'project', label: t('set.resProject') },
    { scope: 'global', label: t('set.resGlobal') },
  ]
  const entry = (e: ResEntry, kind: 'rule' | 'skill') => {
    const open = openPath === e.path
    return (
      <div key={e.path}>
        <button onClick={() => setOpenPath(open ? null : e.path)}
          className="flex w-full cursor-pointer items-center gap-2 px-[12px] py-[8px] text-left hover:bg-tint-secondary">
          {open ? <ChevronDown size={13} className="shrink-0 text-muted-foreground" /> : <ChevronRight size={13} className="shrink-0 text-muted-foreground" />}
          {kind === 'skill' ? <BookOpen size={13} className="shrink-0 text-accent-primary" /> : <FileText size={13} className="shrink-0 text-muted-foreground" />}
          <span className="min-w-0 flex-1 truncate text-13">{e.name}</span>
          {e.description && <span className="hidden max-w-[40%] truncate text-12 text-secondary sm:block">{e.description}</span>}
          <span className="shrink-0 truncate text-11 text-muted-foreground">{e.path}</span>
        </button>
        {open && (
          <div className="mx-3 mb-2 h-[320px] overflow-hidden rounded-[8px] border border-border">
            <ResFileEditor filePath={e.path} name={e.name} />
          </div>
        )}
      </div>
    )
  }
  return (
    <div className="px-[6px] py-[6px]">
      {groups.map((g) => {
        const rules = data.rules.filter((r) => r.scope === g.scope)
        const skills = data.skills.filter((s) => s.scope === g.scope)
        return (
          <div key={g.scope} className="mb-2 last:mb-0">
            <div className="px-[12px] pb-1 pt-2 text-11 font-medium uppercase tracking-wide text-muted-foreground">
              {g.label}{g.scope === 'project' && data.cwd ? ` — ${data.cwd}` : ''}
            </div>
            {!rules.length && !skills.length
              ? <p className="px-[12px] pb-2 text-12 text-secondary">{t('set.resEmpty')}</p>
              : <>{rules.map((r) => entry(r, 'rule'))}{skills.map((s) => entry(s, 'skill'))}</>}
          </div>
        )
      })}
    </div>
  )
}

function ResFileEditor({ filePath, name }: { filePath: string; name: string }) {
  const [saved, setSaved] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    setSaved(null); setErr(null)
    void adminFetch<{ text: string }>('/api/admin/resource-file?path=' + encodeURIComponent(filePath))
      .then((d) => { if (alive) { setSaved(d.text); setText(d.text) } })
      .catch((e) => { if (alive) setErr((e as Error).message) })
    return () => { alive = false }
  }, [filePath])
  if (err) return <p className="p-3 text-12 text-red-500">{err}</p>
  if (saved === null) return <p className="p-3 text-12 text-secondary">…</p>
  return (
    <CodeEditor text={text} savedText={saved} name={name}
      onChange={setText}
      onSave={() => void adminFetch('/api/admin/resource-file', { method: 'POST', body: JSON.stringify({ path: filePath, text }) }).then(() => setSaved(text))}
      onDiscard={() => setText(saved)} />
  )
}

/** Resources tab — agent rules + skills browser for the local instance. */
export function ResourcesTab() {
  const { t } = useTranslation()
  return (
    <Section title={t('set.agentRes')}>
      <AgentResources />
    </Section>
  )
}
