import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

/** Per-language on-demand loaders — each is its own tiny chunk, fetched only
 *  the first time that language is actually highlighted (vs the bundled
 *  `shiki` import's ~10MB all-langs/all-themes payload). */
const LANG_IMPORTERS = {
  bash: () => import('@shikijs/langs/bash'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  css: () => import('@shikijs/langs/css'),
  dart: () => import('@shikijs/langs/dart'),
  diff: () => import('@shikijs/langs/diff'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  go: () => import('@shikijs/langs/go'),
  graphql: () => import('@shikijs/langs/graphql'),
  html: () => import('@shikijs/langs/html'),
  ini: () => import('@shikijs/langs/ini'),
  java: () => import('@shikijs/langs/java'),
  javascript: () => import('@shikijs/langs/javascript'),
  json: () => import('@shikijs/langs/json'),
  jsonc: () => import('@shikijs/langs/jsonc'),
  jsx: () => import('@shikijs/langs/jsx'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  less: () => import('@shikijs/langs/less'),
  lua: () => import('@shikijs/langs/lua'),
  markdown: () => import('@shikijs/langs/markdown'),
  php: () => import('@shikijs/langs/php'),
  powershell: () => import('@shikijs/langs/powershell'),
  python: () => import('@shikijs/langs/python'),
  r: () => import('@shikijs/langs/r'),
  regexp: () => import('@shikijs/langs/regexp'),
  ruby: () => import('@shikijs/langs/ruby'),
  rust: () => import('@shikijs/langs/rust'),
  scss: () => import('@shikijs/langs/scss'),
  sql: () => import('@shikijs/langs/sql'),
  svelte: () => import('@shikijs/langs/svelte'),
  swift: () => import('@shikijs/langs/swift'),
  toml: () => import('@shikijs/langs/toml'),
  tsx: () => import('@shikijs/langs/tsx'),
  typescript: () => import('@shikijs/langs/typescript'),
  vue: () => import('@shikijs/langs/vue'),
  xml: () => import('@shikijs/langs/xml'),
  yaml: () => import('@shikijs/langs/yaml'),
} satisfies Record<string, () => Promise<{ default: unknown }>>

export type HlLang = keyof typeof LANG_IMPORTERS
export const hasLang = (l: string): l is HlLang => l in LANG_IMPORTERS

let hlPromise: Promise<HighlighterCore> | null = null
const loadedLangs = new Set<string>()

function core(): Promise<HighlighterCore> {
  hlPromise ??= createHighlighterCore({
    themes: [import('@shikijs/themes/github-light'), import('@shikijs/themes/github-dark')],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  })
  return hlPromise
}

/** Same output shape as shiki's `codeToTokens` (github-light + github-dark
 *  dual-theme tokens) but backed by a slim core — languages load lazily. */
export async function codeTokens(text: string, lang: string) {
  if (!hasLang(lang)) throw new Error('unknown lang')
  const hl = await core()
  if (!loadedLangs.has(lang)) {
    const mod = await LANG_IMPORTERS[lang]()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await hl.loadLanguage(mod.default as any)
    loadedLangs.add(lang)
  }
  return hl.codeToTokens(text, {
    lang: lang as 'markdown',
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultColor: false,
  })
}
