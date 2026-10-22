import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { adminFetch } from '@/lib/api'
import { fmtDur, clock } from '@/pages/mirror/timelineUtil'
import type { TimelineItem } from '@/components/Timeline'

/** Official terminal-panel command-history table (命令 | 时长 | 开始).
 * Rows come from the session's shell/exec timeline items (peek poll — no
 * session/load is triggered), merged with commands the terminal agent
 * ran this view (`local`). Collapsible section pinned below the xterm. */
interface HistRow { cmd: string; dur?: number; ts: string }

export default function TermHistory({ sid, local }: { sid: string; local: { cmd: string; ts: string }[] }) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<HistRow[]>([])
  const [open, setOpen] = useState(true)

  useEffect(() => {
    if (!open) return
    let alive = true
    const load = () => adminFetch<{ items?: TimelineItem[] }>(`/api/admin/session/${sid}/timeline?peek=1&limit=300`)
      .then((r) => {
        if (!alive) return
        const items = (r.items ?? []).filter((it) => it.kind === 'shell' || it.kind === 'shell_done')
        setRows(items.map((it) => ({
          cmd: (it.body || it.title || '').split('\n')[0],
          dur: it.durationMs,
          ts: it.ts,
        })))
      })
      .catch(() => {})
    load()
    const iv = setInterval(load, 5000)
    return () => { alive = false; clearInterval(iv) }
  }, [sid, open])

  const all = [...local.map((l) => ({ cmd: l.cmd, ts: l.ts } as HistRow)), ...rows]
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, 30)

  return (
    <div className="shrink-0 border-t border-border font-sans">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer items-center gap-1 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
        aria-expanded={open}
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        {t('tm.history')}
      </button>
      {open && (
        <div className="max-h-36 overflow-y-auto px-2 pb-1">
          <table className="w-full table-fixed text-[11px] leading-[16px]">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="font-normal">{t('tm.colCmd')}</th>
                <th className="w-16 font-normal">{t('tm.colDur')}</th>
                <th className="w-14 font-normal">{t('tm.colStart')}</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {all.map((r, i) => (
                <tr key={i} className="text-foreground/90">
                  <td className="truncate pr-2" title={r.cmd}>{r.cmd}</td>
                  <td className="text-muted-foreground">{r.dur != null ? fmtDur(Math.max(0, Math.round(r.dur / 1000))) : '—'}</td>
                  <td className="text-muted-foreground">{clock(r.ts)}</td>
                </tr>
              ))}
              {!all.length && (
                <tr><td colSpan={3} className="py-1 text-muted-foreground">{t('tm.noHist')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
