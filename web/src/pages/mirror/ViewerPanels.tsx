import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, ChevronDown, Copy, Check, Link2, Code2, Search, Download } from 'lucide-react'
import { type PublicMessage } from '@/lib/api'
import { attachmentUrl } from '@/lib/viewer'
import AttachmentCard from '@/components/AttachmentCard'
import CodeView from '@/components/CodeView'
import { type TimelineItem } from '@/components/Timeline'
import Markdown from '@/components/Markdown'
import DwMark from '@/components/DwMark'
import { cn } from '@/lib/utils'
import { headerClock, time, useFullTerminal, TerminalBlock } from './timelineUtil'
import { AVATAR_HUES } from './attachments'

function BotMark() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 16 16" fill="none" className="text-text-purple">
      <path
        d="M4.45605 1.11269C4.55981 1.05352 4.68722 1.05364 4.79102 1.11269L7.2627 2.52383C7.36778 2.584 7.43244 2.69571 7.43262 2.8168V3.60586C7.43262 4.32382 7.81792 4.98717 8.44141 5.34316L8.55469 5.40762C9.17212 5.76015 9.93011 5.75813 10.5459 5.40273L11.1709 5.04238C11.2754 4.98204 11.4043 4.98204 11.5088 5.04238L13.9482 6.45059C14.0527 6.51092 14.1172 6.62288 14.1172 6.74355V9.56094C14.117 9.68144 14.0526 9.79266 13.9482 9.85293L11.5088 11.2621C11.4044 11.3223 11.2753 11.3223 11.1709 11.2621L10.3232 10.7719C9.72949 10.4289 8.9977 10.4277 8.40234 10.768C7.80216 11.1111 7.43173 11.7494 7.43164 12.4408V13.1547C7.43164 13.276 7.36696 13.3884 7.26172 13.4486L4.79102 14.8588C4.6872 14.918 4.5599 14.918 4.45605 14.8588L1.98535 13.4486C1.87995 13.3885 1.81445 13.2761 1.81445 13.1547V10.3412C1.81446 10.2198 1.87995 10.1074 1.98535 10.0473L4.45605 8.63711C4.55987 8.57798 4.68724 8.57787 4.79102 8.63711L6.20898 9.4457C6.29055 9.49224 6.37613 9.52815 6.46289 9.55898C6.69299 9.64758 6.94611 9.69766 7.21094 9.69766C8.13834 9.69755 8.89056 8.95246 8.89062 8.03359C8.89062 7.11462 8.14628 6.35586 7.21875 6.35586C6.93968 6.35586 6.69674 6.38713 6.48633 6.44277C6.45404 6.45071 6.4225 6.46121 6.39062 6.47109C6.36028 6.48071 6.33064 6.49063 6.30176 6.50137C6.2672 6.51425 6.23307 6.52811 6.19922 6.54336C6.17069 6.55604 6.14317 6.56956 6.11621 6.5834C6.09598 6.59389 6.07459 6.6023 6.05469 6.61367L4.79102 7.33633C4.6872 7.39541 4.55983 7.39553 4.45605 7.33633L1.98535 5.92519C1.88002 5.86506 1.8146 5.75349 1.81445 5.63223V2.8168C1.81463 2.69556 1.88004 2.58395 1.98535 2.52383L4.45605 1.11269Z"
        fill="currentColor"
      />
    </svg>
  )
}

/** Official participant header (sampled 2026-08-31): baseline row of
 *  14px/500 name + 12px secondary clock, gap 5px, with the avatar in the left gutter. */
function ParticipantHeader({ kind, name, ts }: { kind: 'devin' | 'user'; name?: string; ts: string }) {
  const { t } = useTranslation()
  const displayName = kind === 'devin' ? 'Devin' : name || 'User'
  const isBot = kind === 'user' && /\bbot\b$/i.test(displayName)
  let h = 0
  for (const ch of displayName) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  return (
    <>
      <div className="flex select-none items-baseline gap-[5px]">
      <span className="text-[14px] font-medium leading-[20px] text-foreground">{displayName}</span>
      <span className="shrink-0 select-none text-[12px] leading-[16px] text-muted-foreground">{headerClock(ts)}</span>
      </div>
      <span role="img" aria-label={displayName} className="absolute left-[-44px] top-[3px] flex h-[32px] w-[32px] select-none items-center justify-center rounded-full">
        {kind === 'devin' ? (
          <span className="flex size-7 items-center justify-center rounded-[6px] bg-bg-accent-neutral"><DwMark size={20} /></span>
        ) : isBot ? (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-tint-secondary">
            <BotMark />
          </span>
        ) : (
          <span className={cn('flex size-7 items-center justify-center rounded-full text-[11px] font-semibold leading-none text-white', AVATAR_HUES[h % AVATAR_HUES.length])}>
            {displayName.trim().charAt(0).toUpperCase()}
          </span>
        )}
      </span>
    </>
  )
}


function FileViewerPanel({ href: href0, name, initialRaw, versions }: { href: string; name: string; initialRaw?: boolean; versions?: { href: string; ts: string }[] }) {
  const { t } = useTranslation()
  const [ver, setVer] = useState(-1)
  const [verOpen, setVerOpen] = useState(false)
  const vlist = versions && versions.length > 1 ? versions : null
  const href = vlist && ver >= 0 ? vlist[ver].href : href0
  const [text, setText] = useState<string | null>(null)
  const [err, setErr] = useState(false)
  const [raw, setRaw] = useState(!!initialRaw)
  const [done, setDone] = useState('')
  const isPdf = /\.pdf$/i.test(name)
  const isMd = /\.md$/i.test(name)
  const isImg = /\.(png|jpe?g|gif|webp|svg)$/i.test(name)
  const isVideo = /\.(mp4|webm|mov)$/i.test(name)
  useEffect(() => {
    if (isPdf || isImg || isVideo) return
    fetch(href).then((r) => (r.ok ? r.text() : Promise.reject())).then(setText).catch(() => setErr(true))
  }, [href, isPdf, isImg, isVideo])
  const flash = (k: string) => { setDone(k); setTimeout(() => setDone(''), 1200) }
  const abtn = 'inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50'
  const body = () => {
    if (isImg) return <div className="flex h-full items-center justify-center p-4"><img loading="lazy" decoding="async" src={href} alt={name} className="max-h-full max-w-full object-contain" /></div>
    if (isVideo) return <div className="flex h-full items-center justify-center p-4"><video src={href} controls className="max-h-full max-w-full" /></div>
    if (isPdf) return <iframe src={href} title={name} className="h-full w-full" />
    if (err) return <p className="p-4 text-xs text-muted-foreground">{t('vp.cantLoad', { name })}</p>
    if (text === null) return <div className="flex items-center gap-1.5 p-4 text-[13px] text-muted-foreground"><Loader2 size={14} className="animate-spin" /> Loading…</div>
    return isMd && !raw
      ? <div className="p-4"><Markdown text={text} /></div>
      : <CodeView text={text} name={name} />
  }
  const curIdx = vlist ? (ver >= 0 ? ver : vlist.length - 1) : 0
  return (
    <div className="flex h-full min-h-0 flex-col">
      {vlist && (
        <div className="relative flex h-[44px] shrink-0 items-center gap-2 border-b border-border px-3">
          <button
            onClick={() => setVerOpen(!verOpen)}
            className="flex h-[28px] cursor-pointer items-center gap-1 rounded-[6px] border border-border pl-2 pr-1.5 text-[13px] text-foreground hover:bg-accent"
          >
            v{curIdx + 1}{curIdx === vlist.length - 1 ? ' (latest)' : ''}
            <ChevronDown size={13} className="text-muted-foreground" />
          </button>
          <span className="text-[13px] text-muted-foreground">
            {(() => {
              const d = new Date(vlist[curIdx].ts)
              return Number.isNaN(d.getTime())
                ? ''
                : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
            })()}
          </span>
          {verOpen && (
            <div className="absolute left-3 top-[40px] z-20 min-w-[140px] rounded-[8px] border border-border bg-popover p-1 shadow-md" role="listbox">
              {vlist.map((v, i) => (
                <div
                  key={v.href}
                  role="option"
                  aria-selected={i === curIdx}
                  onClick={() => { setVer(i); setVerOpen(false); setText(null); setErr(false) }}
                  className="flex cursor-pointer items-center justify-between gap-2 rounded-[6px] px-2 py-1.5 text-[13px] text-foreground hover:bg-accent"
                >
                  v{i + 1}{i === vlist.length - 1 ? ' (latest)' : ''}
                  {i === curIdx && <Check size={13} className="text-muted-foreground" />}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {/* Official file header bar: name left, View code / Copy content / Copy link / Download right */}
      <div className="sticky top-0 z-10 flex h-[42px] shrink-0 items-center gap-1.5 border-b border-border bg-card px-2 pl-4">
        <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{name}</span>
        <div className="flex shrink-0 items-center gap-px">
          {isMd && (
            <button aria-label={raw ? t('vp.previewMd') : t('vp.viewCode')} title={raw ? t('vp.previewMd') : t('vp.viewCode')} onClick={() => setRaw(!raw)} className={cn(abtn, raw && 'bg-accent text-foreground')}>
              <Code2 size={16} />
            </button>
          )}
          {!isPdf && !isImg && !isVideo && (
            <button aria-label={t('vp.copyContent')} title={t('vp.copyContent')} disabled={text === null} onClick={() => { if (text !== null) { navigator.clipboard.writeText(text); flash('content') } }} className={abtn}>
              {done === 'content' ? <Check size={16} /> : <Copy size={16} />}
            </button>
          )}
          <button
            aria-label={t('vp.copyLink')}
            title={t('vp.copyLink')}
            onClick={() => { navigator.clipboard.writeText(new URL(href, location.origin).toString()); flash('link') }}
            className={abtn}
          >
            {done === 'link' ? <Check size={16} /> : <Link2 size={16} />}
          </button>
          <a aria-label={t('vp.download')} title={t('vp.download')} href={href} download={name} className={abtn}>
            <Download size={16} />
          </a>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{body()}</div>
    </div>
  )
}

function AttachmentsPanel({ messages, sessionId, mt, onOpenTab }: { messages: PublicMessage[]; sessionId: string; mt: string; onOpenTab?: (href: string, name: string) => void }) {
  const { t } = useTranslation()
  const files = useMemo(() => {
    const seen = new Set<string>()
    const out: { url: string; name: string; ts: string; role: string }[] = []
    for (const m of messages) {
      for (const a of m.attachments || []) {
        if (seen.has(a.url)) continue
        seen.add(a.url)
        out.push({ url: a.url, name: a.name, ts: m.timestamp, role: m.role })
      }
    }
    return out.reverse()
  }, [messages])
  const [q, setQ] = useState('')
  const shown = q ? files.filter((f) => f.name.toLowerCase().includes(q.toLowerCase())) : files
  if (!files.length) return <p className="p-4 text-xs text-muted-foreground">{t('vp.noFiles')}</p>
  return (
    <div className="space-y-3 p-3">
      <div className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5">
        <Search size={13} className="shrink-0 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('vp.search')}
          className="w-full bg-transparent text-[13px] leading-[18px] outline-none placeholder:text-muted-foreground"
        />
      </div>
      {!shown.length && <p className="px-1 text-xs text-muted-foreground">{t('common.noResults')}</p>}
      {shown.map((f) => (
        <div key={f.url}>
          <p className="mb-1 text-[10px] text-muted-foreground">{f.role === 'user' ? t('vp.roleUser') : 'Devin'} · {time(f.ts)}</p>
          <AttachmentCard name={f.name} href={attachmentUrl(sessionId, f.url, mt)} ts={f.ts} onOpenTab={onOpenTab} />
        </div>
      ))}
    </div>
  )
}

/** One executed command in the Shell panel's history (official split layout). */
interface ShellCmd {
  id: string
  cmd: string
  ts: string
  shellId: string
  exitCode?: string
  durationMs?: number
  terminal?: string
  item: TimelineItem
}

function fmtDuration(ms?: number): string {
  if (ms === undefined || ms < 0) return '--:--'
  const s = Math.round(ms / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function fmtStart(ts: string): string {
  const d = new Date(ts)
  const now = new Date()
  const day = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const days = Math.floor((day(now) - day(d)) / 86_400_000)
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (days >= 0 && days <= 6) return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  }) + `, ${time}`
}

/**
 * Shell tab, official split layout: shell-session chips + terminal output of the
 * selected command on top, searchable command-history table (status dot,
 * Duration, Start) below.
 */
function ShellPanel({ items }: { items: TimelineItem[] }) {
  const { t } = useTranslation()
  const cmds = useMemo(() => {
    const list: ShellCmd[] = []
    const byPid = new Map<string, ShellCmd>()
    for (const it of items) {
      if (it.kind === 'shell' && it.processId) {
        const c: ShellCmd = {
          id: it.id,
          cmd: (it.body || '').split('\n')[0],
          ts: it.ts,
          shellId: (it.shellId || it.processId).slice(0, 6),
          terminal: it.terminal,
          item: it,
        }
        byPid.set(it.processId, c)
        list.push(c)
      } else if (it.kind === 'shell_done' && it.processId) {
        const c = byPid.get(it.processId)
        if (c) {
          c.exitCode = it.exitCode
          c.durationMs = new Date(it.ts).getTime() - new Date(c.ts).getTime()
          if (it.terminal) c.terminal = it.terminal
          else if (!c.terminal && it.body) c.terminal = it.body
          c.item = {
            ...c.item,
            terminal: c.terminal,
            terminalMore: it.terminalMore ?? c.item.terminalMore,
            pageCursor: it.pageCursor ?? c.item.pageCursor,
          }
        }
      }
    }
    return list
  }, [items])
  const shellIds = useMemo(() => [...new Set(cmds.map((c) => c.shellId))], [cmds])
  // Official terminal tabs carry friendly names — raw ACP exec ids never leak.
  const shellLabel = useMemo(() => {
    const m = new Map<string, string>()
    shellIds.forEach((sid, i) => m.set(sid, `${t('vp.terminalN', { n: i + 1 })}`))
    return m
  }, [shellIds, t])
  const [q, setQ] = useState('')
  const [selId, setSelId] = useState<string | null>(null)
  const sel = (selId && cmds.find((c) => c.id === selId)) || cmds[cmds.length - 1]
  const fullTerminal = useFullTerminal(sel?.item)
  const filtered = useMemo(
    () => cmds.filter((c) => !q || c.cmd.toLowerCase().includes(q.toLowerCase())).slice(-200),
    [cmds, q],
  )
  if (!cmds.length) return <div className="flex h-full items-center justify-center"><span className="text-[13px] leading-[18px] text-muted-foreground">{t('vp.noCmds')}</span></div>
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto px-2 py-1">
        {shellIds.map((sid) => (
          <button
            key={sid}
            onClick={() => {
              const last = [...cmds].reverse().find((c) => c.shellId === sid)
              if (last) setSelId(last.id)
            }}
            title={sid}
            className={cn(
              'shrink-0 cursor-pointer rounded-md px-2 py-1 text-[12px] leading-[16px]',
              sel?.shellId === sid ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {shellLabel.get(sid) ?? sid}
          </button>
        ))}
      </div>
      <div className="relative flex min-h-0 flex-1 overflow-hidden border-t border-b border-border bg-card px-3 py-2 shell-app--xterm-container">
        <div className="h-full w-full overflow-auto">
          {sel?.terminal
            ? <TerminalBlock fill text={fullTerminal ?? sel.terminal} className="mt-0 h-full min-h-0 rounded-none border-0 bg-transparent" />
            : <p className="font-mono text-[12px] text-muted-foreground">{sel ? t('vp.noOutput') : ''}</p>}
        </div>
      </div>
      <div className="flex h-[45%] shrink-0 flex-col">
        <div className="sticky top-0 z-10 shrink-0 border-b border-border bg-card">
          <div
            className="mx-1 grid gap-x-3 px-1 py-1.5 text-[14px] leading-[20px]"
            style={{ gridTemplateColumns: 'minmax(67%,1fr) minmax(0px,60px) minmax(0px,85px)' }}
          >
            <div className="flex items-center text-start">
              <div className="flex h-fit w-full items-center gap-2 pl-1">
                <Search size={14} className="opacity-80" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={t('vp.searchCmds')}
                  className="h-7 min-w-0 flex-1 bg-transparent text-[14px] leading-[20px] outline-none placeholder:text-muted-foreground"
                />
              </div>
            </div>
            <div className="ml-1 flex items-center text-start opacity-60">{t('vp.duration')}</div>
            <div className="ml-1 flex items-center text-start opacity-60">{t('vp.start')}</div>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-0.5">
          {filtered.map((c) => (
            <div
              key={c.id}
              role="button"
              tabIndex={0}
              onClick={() => setSelId(c.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setSelId(c.id)
                }
              }}
              className={cn(
                'shell-history-row relative mx-1 grid h-[26px] cursor-pointer gap-x-3 rounded-sm px-1 py-1 text-[12px] leading-[18px] hover:bg-tint-secondary transition-colors',
                sel?.id === c.id && 'bg-black/[.06]',
              )}
              style={{ gridTemplateColumns: 'minmax(67%,1fr) minmax(0px,60px) minmax(0px,85px)' }}
            >
              <div className="flex min-w-0 items-center justify-between pl-1">
                <div className="flex-1 overflow-hidden whitespace-nowrap pl-1 font-mono [mask-image:linear-gradient(to_right,black_calc(100%-24px),transparent)]">{c.cmd}</div>
                <span
                  className={cn(
                    'size-[10px] shrink-0 rounded-full',
                    c.exitCode === undefined ? 'bg-blue-400' : c.exitCode === '0' ? 'bg-emerald-500' : 'bg-red-500',
                  )}
                />
              </div>
              <div className="overflow-hidden truncate whitespace-nowrap pl-1 opacity-75" title={fmtDuration(c.durationMs)}>{fmtDuration(c.durationMs)}</div>
              <div className="overflow-hidden whitespace-nowrap pl-1 opacity-75" title={new Date(c.ts).toLocaleString()}>{fmtStart(c.ts)}</div>
            </div>
          ))}
          {!filtered.length && <p className="p-3 text-[12px] text-muted-foreground">{t('common.noResults')}</p>}
        </div>
      </div>
    </div>
  )
}


export { BotMark, ParticipantHeader, FileViewerPanel, AttachmentsPanel, type ShellCmd, fmtDuration, fmtStart, ShellPanel };
