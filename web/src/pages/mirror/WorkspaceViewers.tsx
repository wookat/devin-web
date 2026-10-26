import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, WrapText, Search, X } from 'lucide-react'
import CodeView, { useShikiTokens, type Tok } from '@/components/CodeView'
import Markdown from '@/components/Markdown'
import { cn } from '@/lib/utils'
import { type FileResp, ext, kindOf, ErrBox, Fallback, EditBar, useSaver } from './WsShared'
import { ImageEditor, DocxView, XlsxView } from './WorkspaceMedia'

/* ---------------- viewers / editors ---------------- */

/** In-file find (Ctrl+F): live match count; Enter/↑↓ jump by moving the
 *  textarea selection, which also scrolls the match into view. */
function useFind(text: string, taRef: () => HTMLTextAreaElement | null) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const hits = useMemo(() => {
    if (!q) return [] as number[]
    const T = text.toLowerCase(), Q = q.toLowerCase()
    const out: number[] = []
    let i = T.indexOf(Q)
    while (i >= 0 && out.length < 5000) { out.push(i); i = T.indexOf(Q, i + 1) }
    return out
  }, [text, q])
  const jump = useCallback((i: number) => {
    if (!hits.length) return
    const k = ((i % hits.length) + hits.length) % hits.length
    setIdx(k)
    const ta = taRef()
    if (ta) { ta.focus(); ta.setSelectionRange(hits[k], hits[k] + q.length) }
  }, [hits, q, taRef])
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); setOpen(true) }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])
  useEffect(() => { if (!open) setQ('') }, [open])
  useEffect(() => { setIdx(-1) }, [q])
  return { open, setOpen, q, setQ, hits, idx, jump }
}

function FindBar({ find }: { find: ReturnType<typeof useFind> }) {
  const { t } = useTranslation()
  if (!find.open) return null
  const n = find.hits.length
  return (
    <div className="absolute right-3 top-2 z-20 flex items-center gap-1 rounded-[8px] border border-border bg-card/95 px-2 py-1 shadow-md backdrop-blur">
      <Search size={12} className="shrink-0 text-muted-foreground" />
      <input
        autoFocus
        value={find.q}
        onChange={(e) => find.setQ(e.target.value)}
        placeholder={t('ws.findPh')}
        className="w-40 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground"
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); find.jump(find.idx + (e.shiftKey ? -1 : 1)) }
          if (e.key === 'Escape') { e.preventDefault(); find.setOpen(false) }
        }}
      />
      <span className="w-12 text-right text-[11px] text-muted-foreground">{n ? `${find.idx + 1}/${n}` : t('ws.noMatches')}</span>
      <button className="flex size-5 cursor-pointer items-center justify-center rounded hover:bg-tint-secondary" onClick={() => find.jump(find.idx - 1)} aria-label="prev"><ChevronUp size={12} /></button>
      <button className="flex size-5 cursor-pointer items-center justify-center rounded hover:bg-tint-secondary" onClick={() => find.jump(find.idx + 1)} aria-label="next"><ChevronDown size={12} /></button>
      <button className="flex size-5 cursor-pointer items-center justify-center rounded hover:bg-tint-secondary" onClick={() => find.setOpen(false)} aria-label="close"><X size={12} /></button>
    </div>
  )
}

/** Word wrap (Alt+Z): measured chars-per-line so the gutter keeps correct
 *  per-logical-line heights even when lines wrap to multiple visual rows.
 *  The container's first <textarea> is the measuring target. */
function useWrap(host: React.RefObject<HTMLElement | null>, on: boolean) {
  const [cpl, setCpl] = useState(0)
  useEffect(() => {
    const el = host.current
    const ta = el?.querySelector('textarea')
    if (!on || !el || !ta) { setCpl(0); return }
    const cs = getComputedStyle(ta)
    const probe = document.createElement('span')
    probe.style.cssText = `position:absolute;left:-9999px;top:0;white-space:pre;font:${cs.fontSize} ${cs.fontFamily}`
    probe.textContent = '0'.repeat(64)
    el.appendChild(probe)
    const cw = probe.getBoundingClientRect().width / 64 || 7
    probe.remove()
    const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
    const ro = new ResizeObserver(() => setCpl(Math.max(1, Math.floor((ta.clientWidth - pad) / cw))))
    ro.observe(ta)
    return () => ro.disconnect()
  }, [on, host])
  return cpl
}

function useWrapPref(): [boolean, () => void] {
  const [on, setOn] = useState(() => { try { return localStorage.getItem('dw-editor-wrap') === '1' } catch { return false } })
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.altKey && e.key.toLowerCase() === 'z') { e.preventDefault(); setOn((v) => !v) }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])
  useEffect(() => { try { localStorage.setItem('dw-editor-wrap', on ? '1' : '0') } catch { /* */ } }, [on])
  return [on, useCallback(() => setOn((v) => !v), [])]
}

function WrapToggle({ on, toggle }: { on: boolean; toggle: () => void }) {
  const { t } = useTranslation()
  return (
    <button onClick={toggle} title={`${t('ws.wrap')} (Alt+Z)`}
      className={cn('flex h-6 cursor-pointer items-center gap-1 rounded-[5px] px-1.5 text-[11px]', on ? 'bg-tint-secondary text-foreground' : 'text-muted-foreground hover:text-foreground')}>
      <WrapText size={12} /> {t('ws.wrap')}
    </button>
  )
}

function Viewer({ id, path, file, rawUrl, draft, onDraft, onDiscard, onSaveText, onSaveBinary, onRetry }: {
  id: string; path: string; file?: FileResp; rawUrl: (p: string) => string
  draft?: string; onDraft: (t: string) => void; onDiscard: () => void
  onSaveText: (p: string, text: string) => Promise<string | null>
  onSaveBinary: (p: string, buf: ArrayBuffer | Blob) => Promise<string | null>
  onRetry: () => void
}) {
  const { t } = useTranslation()
  const k = kindOf(path)
  const e = ext(path)
  const src = rawUrl(path)

  if (k === 'image') return <ImageEditor src={src} name={path} onSave={(blob) => onSaveBinary(path, blob)} />
  if (k === 'pdf') return <iframe src={src} title={path} className="h-full w-full border-0 bg-[#525659]" />
  if (k === 'av') {
    const isAudio = /mp3|wav|ogg|m4a|flac|aac/.test(e)
    return (
      <div className="flex h-full items-center justify-center bg-black/90 p-4">
        {isAudio ? <audio controls src={src} className="w-[420px] max-w-full" /> : <video controls src={src} className="max-h-full max-w-full" />}
      </div>
    )
  }
  if (k === 'docx') return <DocxView src={src} name={path} />
  if (k === 'xlsx') return <XlsxView src={src} name={path} onSave={(buf) => onSaveBinary(path, buf)} />

  if (!file || (!file.text && !file.error && !file.binary && !file.tooLarge)) {
    return <div className="p-3 text-[13px] text-muted-foreground">{t('common.loading')}</div>
  }
  if (file.error) return <ErrBox msg={file.error} onRetry={onRetry} />
  if (file.tooLarge) return <Fallback path={path} src={src} msg="File too large to preview (over 2 MB)" />
  if (file.binary || file.text == null) {
    if (e === 'doc') return <Fallback path={path} src={src} msg=".doc is a legacy binary format — download to open it" />
    return <Fallback path={path} src={src} msg="Binary file — preview not supported" />
  }
  const text = draft ?? file.text
  if (k === 'md') return <MdView text={text} savedText={file.text} name={path} onChange={onDraft} onSave={() => void onSaveText(path, text)} onDiscard={onDiscard} />
  if (k === 'html') return <HtmlView text={text} savedText={file.text} name={path} onChange={onDraft} onSave={() => void onSaveText(path, text)} onDiscard={onDiscard} />
  if (k === 'csv') return <CsvView text={text} savedText={file.text} onChange={onDraft} onSave={() => void onSaveText(path, text)} onDiscard={onDiscard} />
  return <CodeEditor text={text} savedText={file.text} name={path} onChange={onDraft} onSave={() => void onSaveText(path, text)} onDiscard={onDiscard} />
}

/** Overlay-highlight editor (VS Code style): a transparent-text textarea sits
 * over a shiki-highlighted <pre> with identical font metrics — one view, both
 * colored and editable. No Preview/Edit split for code files. */
export function CodeEditor({ text, savedText, name, onChange, onSave, onDiscard }: {
  text: string; savedText: string; name: string; onChange: (t: string) => void; onSave: () => void; onDiscard: () => void
}) {
  const { t } = useTranslation()
  const gutRef = useRef<HTMLDivElement>(null)
  const preRef = useRef<HTMLPreElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const dirty = text !== savedText
  const { saving, doSave } = useSaver(dirty, onSave)
  const [wrap, toggleWrap] = useWrapPref()
  const cpl = useWrap(hostRef, wrap)
  const find = useFind(text, () => taRef.current)
  const textLines = useMemo(() => text.split('\n'), [text])
  const toks = useShikiTokens(text, name, 250)
  const rows: Tok[][] = toks ?? textLines.map((l) => [{ content: l }])
  const sync = (e: React.UIEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget
    if (gutRef.current) gutRef.current.scrollTop = el.scrollTop
    if (preRef.current) preRef.current.style.transform = `translate(${-el.scrollLeft}px, ${-el.scrollTop}px)`
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditBar mode="Edit" setMode={() => {}} modes={[]} dirty={dirty} saving={saving} onSave={doSave} onDiscard={onDiscard}
        extras={<WrapToggle on={wrap} toggle={toggleWrap} />} />
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div ref={gutRef} className="shrink-0 select-none overflow-hidden border-r border-border bg-card px-[1ch] pt-3 text-right font-mono text-[11px] leading-[20px] text-muted-foreground" aria-hidden>
          {textLines.map((l, i) => (
            <div key={i} style={wrap && cpl ? { height: Math.max(1, Math.ceil(Math.max(l.length, 1) / cpl)) * 20 } : undefined}>{i + 1}</div>
          ))}
        </div>
        <div ref={hostRef} className="relative min-w-0 flex-1 overflow-hidden bg-background">
          <pre ref={preRef} aria-hidden
            className={cn('pointer-events-none absolute left-0 top-0 m-0 bg-background p-3 pl-2 font-mono text-[12px] leading-[20px] text-foreground',
              wrap ? 'w-full whitespace-pre-wrap break-all' : 'w-max min-w-full whitespace-pre')}>
            {rows.map((toks, i) => (
              <span key={i}>
                {toks.map((tk, j) => (
                  <span key={j}
                    className={tk.color || tk.darkColor ? 'text-[var(--shiki-light)] dark:text-[var(--shiki-dark)]' : undefined}
                    style={tk.color || tk.darkColor ? ({ '--shiki-light': tk.color, '--shiki-dark': tk.darkColor } as React.CSSProperties) : undefined}
                  >{tk.content}</span>
                ))}
                {i < rows.length - 1 ? '\n' : ' '}
              </span>
            ))}
          </pre>
          <textarea
            ref={taRef}
            value={text}
            wrap={wrap ? 'soft' : 'off'}
            spellCheck={false}
            onChange={(e) => onChange(e.target.value)}
            onScroll={sync}
            className={cn('absolute inset-0 h-full w-full resize-none bg-transparent p-3 pl-2 font-mono text-[12px] leading-[20px] text-transparent caret-foreground outline-none',
              wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre')}
          />
        </div>
        <FindBar find={find} />
      </div>
    </div>
  )
}

/** Plain textarea editor (no highlight) with optional Preview pane — used by
 * md/html where a rendered preview is meaningful. */
function PlainEditor({ text, savedText, name, onChange, onSave, onDiscard, preview }: {
  text: string; savedText: string; name: string; onChange: (t: string) => void; onSave: () => void; onDiscard: () => void; preview?: React.ReactNode
}) {
  const gutRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [mode, setMode] = useState(preview ? 'Preview' : 'Edit')
  const dirty = text !== savedText
  const { saving, doSave } = useSaver(dirty, onSave)
  const [wrap, toggleWrap] = useWrapPref()
  const cpl = useWrap(hostRef, wrap && mode === 'Edit')
  const find = useFind(text, () => taRef.current)
  const textLines = useMemo(() => text.split('\n'), [text])
  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditBar mode={mode} setMode={setMode} modes={preview ? ['Preview', 'Edit'] : ['Edit']} dirty={dirty} saving={saving} onSave={doSave} onDiscard={onDiscard}
        extras={mode === 'Edit' ? <WrapToggle on={wrap} toggle={toggleWrap} /> : undefined} />
      {mode === 'Preview' && preview ? (
        <div className="min-h-0 flex-1 overflow-auto">{preview}</div>
      ) : (
        <div ref={hostRef} className="relative flex min-h-0 flex-1">
          <div ref={gutRef} className="shrink-0 select-none overflow-hidden border-r border-border bg-card px-[1ch] pt-3 text-right font-mono text-[11px] leading-[20px] text-muted-foreground" aria-hidden>
            {textLines.map((l, i) => (
              <div key={i} style={wrap && cpl ? { height: Math.max(1, Math.ceil(Math.max(l.length, 1) / cpl)) * 20 } : undefined}>{i + 1}</div>
            ))}
          </div>
          <textarea
            ref={taRef}
            value={text}
            wrap={wrap ? 'soft' : 'off'}
            spellCheck={false}
            onChange={(e) => onChange(e.target.value)}
            onScroll={(e) => { if (gutRef.current) gutRef.current.scrollTop = (e.target as HTMLTextAreaElement).scrollTop }}
            className={cn('min-w-0 flex-1 resize-none bg-background p-3 pl-2 font-mono text-[12px] leading-[20px] text-foreground outline-none',
              wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre')}
          />
          <FindBar find={find} />
        </div>
      )}
    </div>
  )
}

/* Markdown: Preview / Edit */
function MdView({ text, savedText, name, onChange, onSave, onDiscard }: {
  text: string; savedText: string; name: string; onChange: (t: string) => void; onSave: () => void; onDiscard: () => void
}) {
  const { t } = useTranslation()
  return <PlainEditor text={text} savedText={savedText} name={name} onChange={onChange} onSave={onSave} onDiscard={onDiscard}
    preview={<div className="mx-auto max-w-[760px] p-4"><Markdown text={text} /></div>} />
}

/* HTML: Preview (sandboxed iframe) / Edit */
function HtmlView({ text, savedText, name, onChange, onSave, onDiscard }: {
  text: string; savedText: string; name: string; onChange: (t: string) => void; onSave: () => void; onDiscard: () => void
}) {
  const { t } = useTranslation()
  return <PlainEditor text={text} savedText={savedText} name={name} onChange={onChange} onSave={onSave} onDiscard={onDiscard}
    preview={<iframe title={name} sandbox="allow-scripts allow-same-origin" srcDoc={text} className="h-full w-full border-0 bg-white" />} />
}

/* CSV: editable table */
function CsvView({ text, savedText, onChange, onSave, onDiscard }: {
  text: string; savedText: string; onChange: (t: string) => void; onSave: () => void; onDiscard: () => void
}) {
  const { t } = useTranslation()
  const rows = useMemo(() => {
    const out: string[][] = []
    let cur: string[] = [], cell = '', qq = false
    for (let i = 0; i < text.length && out.length < 2000; i++) {
      const c = text[i]
      if (qq) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ } else if (c === '"') qq = false
        else cell += c
      } else if (c === '"') qq = true
      else if (c === ',') { cur.push(cell); cell = '' }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++
        cur.push(cell); cell = ''; out.push(cur); cur = []
      } else cell += c
    }
    if (cell || cur.length) { cur.push(cell); out.push(cur) }
    return out.filter((r) => r.length > 1 || r[0] !== '')
  }, [text])
  const setCell = (r: number, c: number, v: string) => {
    const n = rows.map((row, i) => i === r ? row.map((x, j) => (j === c ? v : x)) : row)
    onChange(n.map((row) => row.map((c) => /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join(',')).join('\n'))
  }
  const [mode, setMode] = useState('Table')
  const dirty = text !== savedText
  const { saving, doSave } = useSaver(dirty, onSave)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditBar mode={mode} setMode={setMode} modes={['Table', 'Source']} dirty={dirty} saving={saving} onSave={doSave} onDiscard={onDiscard} />
      {mode === 'Source' ? (
        <textarea value={text} spellCheck={false} onChange={(e) => onChange(e.target.value)}
          className="min-h-0 flex-1 resize-none whitespace-pre bg-background p-3 font-mono text-[12px] leading-[20px] outline-none" />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="border-collapse text-[12px]">
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className={i === 0 ? 'sticky top-0 bg-card font-medium' : 'hover:bg-tint-secondary/50'}>
                  <td className="sticky left-0 border-b border-r border-border bg-card px-1.5 py-1 text-right text-[10px] text-muted-foreground">{i + 1}</td>
                  {r.map((c, j) => (
                    <td key={j} className="whitespace-nowrap border-b border-r border-border px-2 py-1 align-top outline-none focus:bg-accent-fill/10"
                      contentEditable suppressContentEditableWarning
                      onBlur={(e) => setCell(i, j, e.currentTarget.textContent ?? '')}>{c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** Read-only unified-diff pane for `diff:` pseudo-tabs — the `diff` grammar
 *  colorizes added/removed/context lines. */
function DiffPane({ file, onRetry }: { file?: FileResp; onRetry: () => void }) {
  const { t } = useTranslation()
  if (!file || (!file.text && !file.error)) return <div className="p-3 text-[13px] text-muted-foreground">{t('common.loading')}</div>
  if (file.error) return <ErrBox msg={file.error} onRetry={onRetry} />
  return (
    <div className="min-h-full overflow-visible p-1">
      <CodeView text={file.text ?? ''} name="x.diff" />
    </div>
  )
}

export { Viewer, DiffPane };
