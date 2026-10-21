import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { adminFetch } from '@/lib/api'
import CodeView from '@/components/CodeView'

/* Draft-page project explorer — browse the picked workspace before the
 * session exists (fs/list + fs/file; read-only CodeView preview). */
function DraftExplorer({ root }: { root: string }) {
  const { t } = useTranslation()
  const [dirs, setDirs] = useState<Record<string, { name: string; dir: boolean }[] | 'loading'>>({})
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [file, setFile] = useState<{ path: string; text: string | null; binary?: boolean } | null>(null)
  const load = (p: string) => {
    setDirs((m) => ({ ...m, [p]: 'loading' }))
    void adminFetch<{ entries: { name: string; dir: boolean }[] }>(`/api/admin/fs/list?path=${encodeURIComponent(p)}`)
      .then((d) => setDirs((m) => ({ ...m, [p]: d.entries })))
      .catch(() => setDirs((m) => ({ ...m, [p]: [] })))
  }
  useEffect(() => { setDirs({}); setOpen({}); setFile(null); load(root) }, [root]) // eslint-disable-line react-hooks/exhaustive-deps
  const renderDir = (p: string, depth: number): React.ReactNode => {
    const es = dirs[p]
    if (!es || es === 'loading') return null
    return es.map((e) => {
      const fp = `${p.replace(/[\\/]+$/, '')}\\${e.name}`
      const isOpen = !!open[fp]
      return (
        <div key={fp}>
          <button
            className="flex w-full cursor-pointer items-center gap-1.5 rounded px-1.5 py-[3px] text-left text-[12px] hover:bg-tint-secondary"
            style={{ paddingLeft: 6 + depth * 14 }}
            onClick={() => {
              if (e.dir) { setOpen((m) => ({ ...m, [fp]: !m[fp] })); if (!dirs[fp]) load(fp) }
              else {
                void adminFetch<{ text: string | null; binary: boolean }>(`/api/admin/fs/file?path=${encodeURIComponent(fp)}`)
                  .then((d) => setFile({ path: fp, ...d })).catch(() => {})
              }
            }}
          >
            {e.dir ? (isOpen ? <ChevronDown size={12} className="shrink-0 text-muted-foreground" /> : <ChevronRight size={12} className="shrink-0 text-muted-foreground" />) : <span className="w-3 shrink-0" />}
            <span className="min-w-0 flex-1 truncate">{e.name}</span>
          </button>
          {e.dir && isOpen && renderDir(fp, depth + 1)}
        </div>
      )
    })
  }
  return (
    <div className="mt-3 flex h-[300px] w-full max-w-[720px] overflow-hidden rounded-[10px] border border-border bg-card text-left">
      <div className="w-[240px] shrink-0 overflow-auto border-r border-border p-1.5">
        <div className="px-1.5 pb-1 text-[11px] font-medium text-muted-foreground">{root.replace(/[\\/]+$/, '').split(/[\\/]/).pop()}</div>
        {renderDir(root, 0)}
      </div>
      <div className="min-w-0 flex-1 overflow-auto bg-background">
        {file
          ? file.binary || file.text === null
            ? <p className="p-4 text-[12px] text-muted-foreground">{t('ws.binary')}</p>
            : <CodeView text={file.text} name={file.path} />
          : <p className="p-4 text-[12px] text-muted-foreground">{t('draft.pickFile')}</p>}
      </div>
    </div>
  )
}

export { DraftExplorer }
