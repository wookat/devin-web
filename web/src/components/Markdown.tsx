import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Copy, Check, WrapText } from 'lucide-react'
import { Link } from 'react-router-dom'
import { LightboxImage } from './Lightbox'
import { mirrorHref } from '@/lib/mirrorLinks'
import { delimitOfficialLinks } from '../../shared/officialLinks'
import { MdTable, MdTbody, MdTd, MdTh, MdThead, MdTr } from './MdTable'

type Tok = { content: string; color?: string; darkColor?: string }

const LANG_ALIAS: Record<string, string> = {
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', yml: 'yaml', js: 'javascript', ts: 'typescript',
  py: 'python', rb: 'ruby', rs: 'rust', md: 'markdown', text: 'text', txt: 'text', plaintext: 'text',
}

/** Official-style fenced code card (bundle-sampled 2026-08-31): elevated
 *  rounded-10 bordered card, mono 12/20, shiki github-light/dark tokens,
 *  hover toolbar (Wrap lines / Copy code) hanging off the top-right edge. */
function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false)
  const [wrap, setWrap] = useState(false)
  const [hl, setHl] = useState<{ key: string; lines: Tok[][] } | null>(null)
  const text = code.replace(/\n$/, '')
  const key = `${lang || ''}\u0000${text}`
  useEffect(() => {
    let dead = false
    const l = lang ? (LANG_ALIAS[lang.toLowerCase()] || lang.toLowerCase()) : ''
    if (!l || l === 'text') return
    import('shiki')
      .then(({ codeToTokens, bundledLanguages }) => {
        if (!(l in bundledLanguages)) throw new Error('unknown lang')
        return codeToTokens(text, { lang: l as 'markdown', themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: false })
      })
      .then((r) => {
        if (dead) return
        setHl({
          key,
          lines: r.tokens.map((line) => line.map((t) => {
            const s = (t.htmlStyle || {}) as Record<string, string>
            return { content: t.content, color: s['--shiki-light'], darkColor: s['--shiki-dark'] }
          })),
        })
      })
      .catch(() => { /* plain text fallback */ })
    return () => { dead = true }
  }, [text, lang, key])
  const rows: Tok[][] = hl?.key === key ? hl.lines : text.split('\n').map((l) => [{ content: l }])
  return (
    <div className="my-4 [&:first-child]:mt-0 [&:last-child]:mb-0">
      <div className="group/code relative isolate w-full rounded-[10px] border border-border bg-card pt-3 font-mono text-[12px] leading-[20px]">
        <div className="absolute -top-3 right-2 z-10 min-w-fit opacity-0 focus-within:opacity-100 group-hover/code:opacity-100">
          <div aria-label="Actions" className="flex h-7 min-w-fit items-center gap-px whitespace-nowrap rounded-[8px] border border-border bg-card p-px shadow-sm">
            <button
              type="button"
              aria-label="Wrap lines"
              aria-pressed={wrap}
              onClick={() => setWrap((w) => !w)}
              className={`inline-flex size-6 cursor-pointer items-center justify-center rounded-[6px] hover:bg-accent hover:text-foreground ${wrap ? 'bg-accent text-foreground' : 'text-muted-foreground'}`}
            >
              <WrapText size={16} />
            </button>
            <button
              type="button"
              aria-label="Copy code"
              onClick={() => {
                void navigator.clipboard.writeText(text)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }}
              className="inline-flex size-6 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
        </div>
        <div className={`relative rounded-b-[9px] ${wrap ? 'overflow-hidden' : 'overflow-x-auto'}`}>
          <pre className="m-0 w-fit min-w-full p-0 pb-3">
            <code className="block">
              {rows.map((toks, i) => (
                <div key={i} className="flex">
                  <span className={`flex-1 px-5 text-foreground ${wrap ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'whitespace-pre'}`}>
                    {toks.map((t, j) => (
                      <span
                        key={j}
                        className={t.color || t.darkColor ? 'text-[var(--shiki-light)] dark:text-[var(--shiki-dark)]' : undefined}
                        style={t.color || t.darkColor ? ({ '--shiki-light': t.color, '--shiki-dark': t.darkColor } as React.CSSProperties) : undefined}
                      >
                        {t.content}
                      </span>
                    ))}
                    {toks.every((t) => !t.content) && '\u200b'}
                  </span>
                </div>
              ))}
            </code>
          </pre>
        </div>
      </div>
    </div>
  )
}

/** True for downloadable asset URLs hosted on Devin/S3 origins. Non-asset
 * official URLs (session pages etc.) are not proxyable and stay as-is. */
export function isUpstreamAsset(url: string): boolean {
  try {
    const u = new URL(url)
    const h = u.hostname
    if (h.endsWith('.amazonaws.com')) return true
    if (h !== 'devin.ai' && !h.endsWith('.devin.ai')) return false
    return /^\/(v1\/)?attachments\//.test(u.pathname)
  } catch {
    return false
  }
}

/** Control markers the official transcript never renders as text. */
export function stripControlMarkup(text: string): string {
  return text
    .replace(/\[SUGGEST_OPEN_DESKTOP\][\s\S]*?\[\/SUGGEST_OPEN_DESKTOP\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const REF_TAG_NAMES = ['ref_file', 'ref_snippet', 'code_snippet']
const REF_TAG_RE = /<(ref_file|ref_snippet|code_snippet)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g
const REF_OPEN_TAG_RE = /<(?:ref_file|ref_snippet|code_snippet)\b[^>]*>/g

function tagAttr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs)
  return m ? (m[1] ?? m[2] ?? '') : null
}

const b64 = (s: string) => btoa(encodeURIComponent(s))
const unb64 = (s: string) => { try { return decodeURIComponent(atob(s)) } catch { return s } }
export const fileBasename = (p: string) => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1)

/** A partially streamed `<ref_…` tag at the very end of the text (official `M`). */
function dropTrailingPartialTag(text: string): string {
  const lt = text.lastIndexOf('<')
  if (lt === -1) return text
  const tail = text.slice(lt + 1)
  if (tail.includes('>')) return text
  const name = tail.split(/[\s/]/, 1)[0] ?? ''
  if (name.length < 3) return text
  const partial = REF_TAG_NAMES.some((n) => n.startsWith(name))
  const complete = REF_TAG_NAMES.some((n) => tail.startsWith(n) && /^$|^[\s/]/.test(tail.slice(n.length)))
  if (!partial && !complete) return text
  let cut = lt
  while (cut > 0 && text[cut - 1] === '`') cut--
  return text.slice(0, cut)
}

/**
 * Official message pipeline (`Rs`): `<ref_file file=… />` / `<ref_snippet file=… lines=a-b />`
 * become `[b64](#file-ref:b64)` / `[b64](#snippet-ref:b64)` markdown links (base64 keeps
 * `_`/`*` in paths out of the markdown parser); `~` expands to /home/ubuntu; backticks
 * wrapping the tag are consumed; leftover open tags are dropped.
 */
export function refTagsToLinks(text: string): string {
  let out = text
  const hits: { start: number; end: number; repl: string }[] = []
  for (const m of text.matchAll(REF_TAG_RE)) {
    let file = tagAttr(m[2], 'file')
    if (!file) continue
    if (file.startsWith('~')) file = `/home/ubuntu${file.slice(1)}`
    const lines = tagAttr(m[2], 'lines')
    let repl: string
    if (lines) {
      const [a, b = a] = lines.includes('-') ? lines.split('-') : [lines]
      const enc = b64(`${file}:${a}-${b}`)
      repl = `[${enc}](#snippet-ref:${enc})`
    } else {
      const enc = b64(file)
      repl = `[${enc}](#file-ref:${enc})`
    }
    hits.push({ start: m.index, end: m.index + m[0].length, repl })
  }
  for (const h of hits.reverse()) {
    let pre = 0
    while (out[h.start - pre - 1] === '`') pre++
    let post = 0
    while (out[h.end + post] === '`') post++
    const n = Math.min(pre, post)
    const head = out.slice(0, h.start - n)
    const prevToken = head.slice(head.search(/\S*$/))
    const sep = /^(?:https?:\/\/|www\.)/i.test(prevToken) ? ' ' : ''
    out = head + sep + h.repl + out.slice(h.end + n)
  }
  return dropTrailingPartialTag(out).replace(REF_OPEN_TAG_RE, '')
}

/** Plain-text previews (sidebar snippet, message index): official `Vs` drops ref tags entirely. */
export function stripRefTags(text: string): string {
  return text.replace(REF_TAG_RE, '').replace(REF_OPEN_TAG_RE, '').replace(/``/g, '').replace(/[ \t]{2,}/g, ' ')
}

export type FileRefRange = [number, number] | null

/**
 * Official `inline-code-link` chip: mono, link tint, basename (+ `:a-b`), path as title.
 * Inert chips (visitor pages) show the repo-relative path only, like the visitor Changes panel.
 */
function FileRefChip({ path, range, onFileRef }: { path: string; range: FileRefRange; onFileRef?: (path: string, range: FileRefRange) => void }) {
  return (
    <span
      data-streamdown="inline-code-link"
      title={onFileRef ? path : path.replace(/^\/home\/[^/]+\/(?:repos\/[^/]+\/)?/, '')}
      onClick={onFileRef ? (e) => { e.stopPropagation(); onFileRef(path, range) } : undefined}
      className={`rounded bg-[rgb(30_152_206/0.05)] px-[3px] font-mono text-[calc(1em-1px)] font-normal text-[rgb(13_133_185/0.85)] dark:bg-[rgb(62_184_237/0.05)] dark:text-[rgb(62_184_237/0.85)] ${onFileRef ? 'cursor-pointer hover:text-[rgb(30,152,206)] active:bg-[rgb(30_152_206/0.2)] dark:hover:text-[rgb(62,184,237)]' : 'cursor-default'}`}
    >
      {fileBasename(path)}{range ? `:${range[0]}-${range[1]}` : ''}
    </span>
  )
}

export default function Markdown({ text, rewriteUrl, onFileRef, variant }: {
  text: string
  /** `thoughts`: official thought-body prose (13/18, secondary color, dense paragraph spacing). */
  variant?: 'thoughts'
  /** Rewrites upstream asset links and images to a same-origin proxy URL. */
  rewriteUrl?: (url: string) => string
  /** Click handler for `<ref_file>` / `<ref_snippet>` chips (absent → chip is inert). */
  onFileRef?: (path: string, range: FileRefRange) => void
}) {
  const mapUrl = (url?: string) => (url && rewriteUrl && isUpstreamAsset(url) ? rewriteUrl(url) : url)
  return (
    <div className={variant === 'thoughts'
      ? 'prose-chat prose-thoughts min-w-0 select-text break-words text-[13px] leading-[18px] text-muted-foreground [overflow-wrap:anywhere]'
      : 'prose-chat text-[14px] leading-[20px] break-words [overflow-wrap:anywhere]'}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children, ...props }) => {
            const inline = !className && !String(children).includes('\n')
            if (inline) return <code {...props}>{children}</code>
            const lang = /language-([\w+-]+)/.exec(className || '')?.[1]
            return <CodeBlock code={String(children ?? '')} lang={lang} />
          },
          table: MdTable,
          thead: MdThead,
          tbody: MdTbody,
          tr: MdTr,
          th: MdTh,
          td: MdTd,
          a: ({ href, children }) => {
            if (href?.startsWith('#file-ref:')) return <FileRefChip path={unb64(href.slice(10))} range={null} onFileRef={onFileRef} />
            if (href?.startsWith('#snippet-ref:')) {
              const dec = unb64(href.slice(13))
              const colon = dec.lastIndexOf(':')
              const [a, b] = dec.slice(colon + 1).split('-').map(Number)
              return <FileRefChip path={dec.slice(0, colon)} range={Number.isFinite(a) && Number.isFinite(b) ? [a, b] : null} onFileRef={onFileRef} />
            }
            const m = mirrorHref(href)
            if (m.kind === 'inert') return <span className="text-muted-foreground" title={m.title || undefined}>{children}</span>
            if (m.kind === 'internal') return <Link to={m.to}>{children}</Link>
            return <a href={mapUrl(m.href)} target="_blank" rel="noopener noreferrer">{children}</a>
          },
          img: ({ src, alt }) => (
            <LightboxImage src={mapUrl(typeof src === 'string' ? src : '') || ''} alt={alt || ''} className="my-2 block max-w-[400px] rounded-[10px] border border-border" />
          ),
        }}
      >
        {refTagsToLinks(delimitOfficialLinks(stripControlMarkup(text)))}
      </ReactMarkdown>
    </div>
  )
}
