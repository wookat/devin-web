import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShikiTokens, type Tok } from '@/components/CodeView'
import Markdown from '@/components/Markdown'
import { type FileResp, ext, kindOf, ErrBox, Fallback, EditBar, useSaver } from './WsShared'
import { ImageEditor, DocxView, XlsxView } from './WorkspaceMedia'

/* ---------------- viewers / editors ---------------- */

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
  const dirty = text !== savedText
  const { saving, doSave } = useSaver(dirty, onSave)
  const lines = useMemo(() => text.split('\n').length, [text])
  const toks = useShikiTokens(text, name, 250)
  const rows: Tok[][] = toks ?? text.split('\n').map((l) => [{ content: l }])
  const sync = (e: React.UIEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget
    if (gutRef.current) gutRef.current.scrollTop = el.scrollTop
    if (preRef.current) preRef.current.style.transform = `translate(${-el.scrollLeft}px, ${-el.scrollTop}px)`
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditBar mode="Edit" setMode={() => {}} modes={[]} dirty={dirty} saving={saving} onSave={doSave} onDiscard={onDiscard} />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div ref={gutRef} className="shrink-0 select-none overflow-hidden border-r border-border bg-card px-[1ch] pt-3 text-right font-mono text-[11px] leading-[20px] text-muted-foreground" aria-hidden>
          {Array.from({ length: lines }, (_, i) => <div key={i}>{i + 1}</div>)}
        </div>
        <div className="relative min-w-0 flex-1 overflow-hidden bg-background">
          <pre ref={preRef} aria-hidden
            className="pointer-events-none absolute left-0 top-0 m-0 w-max min-w-full whitespace-pre bg-background p-3 pl-2 font-mono text-[12px] leading-[20px] text-foreground">
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
            value={text}
            wrap="off"
            spellCheck={false}
            onChange={(e) => onChange(e.target.value)}
            onScroll={sync}
            className="absolute inset-0 h-full w-full resize-none whitespace-pre bg-transparent p-3 pl-2 font-mono text-[12px] leading-[20px] text-transparent caret-foreground outline-none"
          />
        </div>
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
  const [mode, setMode] = useState(preview ? 'Preview' : 'Edit')
  const dirty = text !== savedText
  const { saving, doSave } = useSaver(dirty, onSave)
  const lines = useMemo(() => text.split('\n').length, [text])
  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditBar mode={mode} setMode={setMode} modes={preview ? ['Preview', 'Edit'] : ['Edit']} dirty={dirty} saving={saving} onSave={doSave} onDiscard={onDiscard} />
      {mode === 'Preview' && preview ? (
        <div className="min-h-0 flex-1 overflow-auto">{preview}</div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div ref={gutRef} className="shrink-0 select-none overflow-hidden border-r border-border bg-card px-[1ch] pt-3 text-right font-mono text-[11px] leading-[20px] text-muted-foreground" aria-hidden>
            {Array.from({ length: lines }, (_, i) => <div key={i}>{i + 1}</div>)}
          </div>
          <textarea
            value={text}
            spellCheck={false}
            onChange={(e) => onChange(e.target.value)}
            onScroll={(e) => { if (gutRef.current) gutRef.current.scrollTop = (e.target as HTMLTextAreaElement).scrollTop }}
            className="min-w-0 flex-1 resize-none whitespace-pre bg-background p-3 pl-2 font-mono text-[12px] leading-[20px] text-foreground outline-none"
          />
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

export { Viewer };
