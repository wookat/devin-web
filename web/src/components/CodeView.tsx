import { useEffect, useState } from 'react'

const LANGS: Record<string, string> = {
  md: 'markdown', ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript',
  py: 'python', json: 'json', html: 'html', css: 'css', sh: 'bash', bash: 'bash',
  yml: 'yaml', yaml: 'yaml', sql: 'sql', go: 'go', rs: 'rust', toml: 'toml',
}

export type Tok = { content: string; color?: string; darkColor?: string }

/** Shiki dual-theme tokenizer, shared by the read-only CodeView and the
 * overlay-highlight CodeEditor. `debounceMs` smooths typing bursts. */
export function useShikiTokens(text: string, name: string, debounceMs = 0): Tok[][] | null {
  const [lines, setLines] = useState<Tok[][] | null>(null)
  useEffect(() => {
    let dead = false
    const ext = name.split('.').pop()?.toLowerCase() || ''
    const lang = LANGS[ext]
    if (!lang) { setLines(null); return }
    const run = () =>
      import('shiki')
        .then(({ codeToTokens }) =>
          codeToTokens(text, { lang: lang as 'markdown', themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: false }),
        )
        .then((r) => {
          if (dead) return
          setLines(r.tokens.map((l) => l.map((t) => {
            const s = (t.htmlStyle || {}) as Record<string, string>
            return { content: t.content, color: s['--shiki-light'], darkColor: s['--shiki-dark'] }
          })))
        })
        .catch(() => { if (!dead) setLines(null) })
    const h = debounceMs ? window.setTimeout(run, debounceMs) : (run(), null)
    return () => { dead = true; if (h != null) window.clearTimeout(h) }
  }, [text, name, debounceMs])
  return lines
}

/** Official-style code view: line-number gutter + shiki dual-theme
 *  (github-light/github-dark via CSS variables, live theme switching). */
export default function CodeView({ text, name }: { text: string; name: string }) {
  const lines = useShikiTokens(text, name)
  const rows: Tok[][] = lines ?? text.split('\n').map((l) => [{ content: l }])
  return (
    <div className="grid w-full grid-cols-[auto_1fr] font-mono text-[12px] leading-[20px]">
      {rows.map((toks, i) => (
        <div key={i} className="col-span-2 grid grid-cols-subgrid">
          <div className="select-none border-r border-border bg-card pl-[2ch] pr-[1ch] text-right text-[11px] leading-[20px] text-muted-foreground">
            {i + 1}
          </div>
          <div className="whitespace-break-spaces break-all px-2 text-foreground [overflow-wrap:anywhere]" data-line-number={i + 1}>
            <code className="select-text break-all">
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
            </code>
          </div>
        </div>
      ))}
    </div>
  )
}
