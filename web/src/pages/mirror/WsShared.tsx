import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileWarning, Save } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FileIcon } from '@/lib/fileIcon'

// ---------------------------------------------------------------------------
// Shared workspace helpers: path/kind tables, git tint, file-type icon,
// context menu, and the small viewer chrome used by every editor kind.
// ---------------------------------------------------------------------------

interface WsEntry { name: string; dir: boolean; size: number; mtime: string }
interface FileResp { path: string; text: string | null; binary?: boolean; tooLarge?: boolean; size?: number; truncated?: boolean; mtime?: string; error?: string }

/* Cross-panel "open this workspace file in the Editor tab" channel: the
   timeline/progress rows can't call WorkspacePanel directly, so they queue a
   path here and fire WS_OPEN_EVENT; WorkspacePanel consumes it on mount and
   on every event. */
const WS_OPEN_EVENT = 'dw-ws-open'
const pendingWsOpen = new Map<string, string>()
function requestWsOpen(sessionId: string, path: string) {
  pendingWsOpen.set(sessionId, path)
  try { window.dispatchEvent(new CustomEvent(WS_OPEN_EVENT, { detail: { id: sessionId, path } })) } catch { /* SSR */ }
}
function consumeWsOpen(sessionId: string): string | null {
  const p = pendingWsOpen.get(sessionId) ?? null
  pendingWsOpen.delete(sessionId)
  return p
}

const ext = (p: string) => (p.split(/[\\/]/).pop() ?? '').split('.').pop()?.toLowerCase() ?? ''
const base = (p: string) => p.split(/[\\/]/).pop() ?? p
const parentOf = (p: string) => p.split('/').slice(0, -1).join('/')
type Kind = 'image' | 'pdf' | 'av' | 'md' | 'html' | 'docx' | 'xlsx' | 'csv' | 'text' | 'bin'
const KINDS: Record<string, Kind> = {}
for (const e of 'png jpg jpeg gif webp ico bmp avif'.split(' ')) KINDS[e] = 'image'
for (const e of 'mp4 webm mov mkv avi mp3 wav ogg m4a flac aac'.split(' ')) KINDS[e] = 'av'
for (const e of 'md markdown mdx'.split(' ')) KINDS[e] = 'md'
for (const e of 'html htm svg'.split(' ')) KINDS[e] = 'html'
KINDS.pdf = 'pdf'
KINDS.docx = 'docx'
for (const e of 'xlsx xls'.split(' ')) KINDS[e] = 'xlsx'
KINDS.csv = 'csv'
const TEXT_EXTS = new Set(`
txt log text asc nfo
js jsx mjs cjs gjs ts tsx mts cts gts
vue svelte astro imba marko edge
html htm xhtml
css scss sass less styl postcss pcss qss
json jsonc json5 jsonl ndjson jsonnet hjson map ipynb webmanifest mcmeta tfstate
babelrc eslintrc prettierrc hintrc swcrc
xml xsl xslt xsd rss atom plist storyboard
yaml yml toml ini cfg conf properties desktop editorconfig gitattributes
gitmodules gitignore dockerignore npmignore npmrc env reg po pot
md markdown mdx mdc rst adoc asciidoc org wiki mediawiki textile tex latex sty cls bib
sh bash zsh ksh csh tcsh fish nu ps1 psm1 psd1 bat cmd awk sed tcl
service timer socket nginx apacheconf vim vimrc gvimrc
c h cpp cxx cc hpp hxx cs csx java jsp kt kts scala sc groovy gvy gradle jenkinsfile nf
py pyw pyi rpy ipy rb rbw rake gemspec podspec erb php phtml phps blade
go rs swift lua luau r rmd rhistory rprofile pl pm perl t jl dart v vsh vala
ex exs eex heex erl hrl hs lhs hsc ml mli mll mly fs fsi fsx fsscript
clj cljs cljc edn lisp lsp el scm rkt fnl cr d nim zig haxe hx
coffee litcoffee m mm objc mojo gleam lean coq purs hack hh
ada adb ads pas pp dpr
glsl vert frag geom comp hlsl fx wgsl shader asm riscv ll vh sv svh vhdl vhd wat wast
sql plsql pks pkb cql gql graphql graphqls sparql rq ttl
kql spl sas do ado matlab gnuplot gp wl nb mma
cue kdl csv tsv tf tfvars bicep pkl nix proto protobuf thrift cmake mk mak just
rel msg srv action sol vy move cairo
hbs handlebars mustache pug jade haml jinja j2 jinja2 njk nunjucks ftl tmpl tpl
twig liquid soy razor cshtml templ
diff patch rej http rest hurl mermaid mmd gherkin feature codeql ql jison
narrat tasl talon st vbs vba gd gdscript scad qml qmldir nsi nsh
typespec tsp typ typst wit wenyan zenscript polar rego puppet
makefile dockerfile containerfile mod sum vtt srt ics hcl lock
`.split(/\s+/).filter(Boolean))
const kindOf = (p: string): Kind => KINDS[ext(p)] ?? (TEXT_EXTS.has(ext(p)) ? 'text' : 'bin')
/** kinds backed by a text payload and therefore editable */
const EDITABLE: Record<Kind, boolean> = { image: false, pdf: false, av: false, md: true, html: true, docx: false, xlsx: true, csv: true, text: true, bin: false }

/* git status letter → VSCode-ish tint */
function gitCls(s?: string) {
  if (!s) return 'text-muted-foreground'
  if (s === 'M') return 'text-[#b58900]'
  if (s === 'U' || s === 'A') return 'text-[#28a745]'
  if (s === 'D') return 'text-red-500'
  return 'text-blue-500'
}
function gitTitle(t: (k: string) => string, s?: string) {
  return ({ M: t('ws.gitM'), U: t('ws.gitU'), A: t('ws.gitA'), D: t('ws.gitD'), R: t('ws.gitR'), C: t('ws.gitC') } as Record<string, string>)[s ?? ''] ?? s
}

// TypeIcon delegates to the shared per-format FileIcon (lib/fileIcon) — same
// table the changes tree / search results / pickers render with.
function TypeIcon({ path, dir, size = 14, className }: { path: string; dir?: boolean; size?: number; className?: string }) {
  return <FileIcon path={path} dir={dir} size={size} className={className} />
}

interface MenuPos { x: number; y: number }
interface CtxItem { label: string; danger?: boolean; sep?: boolean; onClick?: () => void }

function CtxMenu({ pos, items, onClose }: { pos: MenuPos; items: (CtxItem | null)[]; onClose: () => void }) {
  useEffect(() => {
    const h = () => onClose()
    window.addEventListener('mousedown', h)
    window.addEventListener('blur', h)
    return () => { window.removeEventListener('mousedown', h); window.removeEventListener('blur', h) }
  }, [onClose])
  const x = Math.min(pos.x, window.innerWidth - 190)
  const y = Math.min(pos.y, window.innerHeight - items.length * 32 - 12)
  return (
    <div
      className="fixed z-[80] min-w-[176px] rounded-[10px] border border-border/60 bg-white/95 p-1 shadow-lg backdrop-blur-md"
      style={{ left: x, top: y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.filter(Boolean).map((it, i) => it!.sep ? (
        <div key={i} className="mx-2 my-1 h-px bg-border/60" />
      ) : (
        <button key={i} onClick={() => { it!.onClick?.(); onClose() }}
          className={cn('flex h-[30px] w-full cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] leading-[18px] outline-none hover:bg-tint-secondary',
            it!.danger ? 'text-red-500' : 'text-foreground')}>
          {it!.label}
        </button>
      ))}
    </div>
  )
}

function ErrBox({ msg, onRetry }: { msg: string; onRetry: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4">
      <FileWarning size={24} className="text-red-500" />
      <div className="text-[13px] text-red-500">{msg}</div>
      <button onClick={onRetry} className="rounded-[6px] border border-border px-2.5 py-1 text-[12px] hover:bg-tint-secondary">{t('common.retry')}</button>
    </div>
  )
}

function Fallback({ path, src, msg }: { path: string; src: string; msg: string }) {
  const { t } = useTranslation()
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-muted-foreground">
      <TypeIcon path={path} size={28} />
      <div className="text-[13px] font-medium text-foreground">{base(path)}</div>
      <div className="text-[12px]">{msg}</div>
      <a href={src} download className="mt-1 rounded-[6px] border border-border px-3 py-1.5 text-[12px] text-foreground hover:bg-tint-secondary">{t('common.download')}</a>
    </div>
  )
}

/** Toolbar for editable text kinds: Edit/Preview toggle + save state. */
function EditBar({ mode, setMode, modes, dirty, saving, onSave, onDiscard }: {
  mode: string; setMode: (m: string) => void; modes: string[]
  dirty: boolean; saving: boolean; onSave: () => void; onDiscard: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-border px-2">
      <div className="flex items-center gap-0.5">
        {modes.map((m) => (
          <button key={m} onClick={() => setMode(m)}
            className={cn('h-6 cursor-pointer rounded-[5px] px-2 text-[12px]', mode === m ? 'bg-tint-secondary font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}>{m}</button>
        ))}
      </div>
      <div className="ml-auto flex items-center gap-1.5">
        {dirty && <span className="text-[11px] text-amber-600">{t('ws.unsaved')}</span>}
        {dirty && <button onClick={onDiscard} className="h-6 cursor-pointer rounded-[5px] px-2 text-[12px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground">{t('ws.discard')}</button>}
        <button onClick={onSave} disabled={!dirty || saving}
          className={cn('flex h-6 cursor-pointer items-center gap-1 rounded-[5px] px-2 text-[12px]', dirty ? 'bg-accent-fill text-white hover:opacity-90' : 'text-muted-foreground opacity-50')}>
          <Save size={12} /> {saving ? t('ws.saving') : t('common.save')}
        </button>
      </div>
    </div>
  )
}

function useSaver(dirty: boolean, onSave: () => void) {
  const [saving, setSaving] = useState(false)
  const doSave = useCallback(() => {
    if (!dirty || saving) return
    setSaving(true); void Promise.resolve(onSave()).finally(() => setSaving(false))
  }, [dirty, saving, onSave])
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); doSave() }
    }
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [doSave])
  return { saving, doSave }
}

export { type WsEntry, type FileResp, ext, base, parentOf, type Kind, kindOf, EDITABLE, gitCls, gitTitle, TypeIcon, type MenuPos, type CtxItem, CtxMenu, ErrBox, Fallback, EditBar, useSaver, WS_OPEN_EVENT, requestWsOpen, consumeWsOpen };
