// Per-format file icons (official Devin parity): extension → lucide glyph +
// brand-ish tint. Office docs get their recognizable colors (docx blue,
// xlsx green, pptx orange, pdf red); code files get per-language tints.
// Used anywhere a file NAME renders — trees, cards, chips, pickers.
import {
  File, FileText, FileCode, FileImage, FileSpreadsheet, FileArchive,
  FileAudio, FileVideo, FileJson, FileType, FileTerminal, FileCog,
  FileKey, FileLock, Presentation, Database, Folder as FolderIcon,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const ext = (p: string) => {
  const base = (p.split(/[\\/]/).pop() ?? '').toLowerCase()
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1) : ''
}
const baseName = (p: string) => (p.split(/[\\/]/).pop() ?? '').toLowerCase()

type Spec = { Icon: LucideIcon; tint: string }

const TINT = {
  muted: 'text-muted-foreground',
  blue: 'text-blue-500',
  green: 'text-green-600',
  emerald: 'text-emerald-600',
  teal: 'text-teal-600',
  cyan: 'text-cyan-600',
  sky: 'text-sky-500',
  orange: 'text-orange-500',
  amber: 'text-amber-600',
  red: 'text-red-500',
  yellow: 'text-yellow-500',
  purple: 'text-purple-500',
  pink: 'text-pink-500',
  slate: 'text-slate-500',
} as const

function specOf(p: string): Spec {
  const e = ext(p)
  const b = baseName(p)

  // Well-known extensionless names first.
  if (b === 'dockerfile' || b.startsWith('dockerfile.')) return { Icon: FileCode, tint: TINT.sky }
  if (b === 'makefile' || b === 'cmakelists.txt') return { Icon: FileTerminal, tint: TINT.orange }
  if (b === 'license' || b.startsWith('license.') || b === 'notice') return { Icon: FileText, tint: TINT.yellow }
  if (b.startsWith('.env') || b === '.env') return { Icon: FileKey, tint: TINT.amber }
  if (b === '.gitignore' || b === '.gitattributes' || b === '.gitmodules') return { Icon: FileCog, tint: TINT.muted }

  // Office / document formats — the recognizable brand tints.
  if (e === 'pdf') return { Icon: FileText, tint: TINT.red }
  if (e === 'doc' || e === 'docx' || e === 'odt' || e === 'rtf' || e === 'pages') return { Icon: FileText, tint: TINT.blue }
  if (e === 'xls' || e === 'xlsx' || e === 'xlsm' || e === 'ods' || e === 'numbers') return { Icon: FileSpreadsheet, tint: TINT.green }
  if (e === 'csv' || e === 'tsv') return { Icon: FileSpreadsheet, tint: TINT.green }
  if (e === 'ppt' || e === 'pptx' || e === 'odp' || e === 'key') return { Icon: Presentation, tint: TINT.orange }

  // Media.
  if ('png jpg jpeg gif webp ico bmp avif svg tiff heic heif'.split(' ').includes(e)) return { Icon: FileImage, tint: TINT.purple }
  if ('mp3 wav ogg m4a flac aac opus wma aiff mid midi'.split(' ').includes(e)) return { Icon: FileAudio, tint: TINT.pink }
  if ('mp4 webm mov mkv avi m4v ogv wmv mts 3gp'.split(' ').includes(e)) return { Icon: FileVideo, tint: TINT.pink }
  if ('ttf otf woff woff2 eot'.split(' ').includes(e)) return { Icon: FileType, tint: TINT.slate }

  // Archives / packages.
  if ('zip tar gz tgz bz2 xz 7z rar jar war cab lz4 zst'.split(' ').includes(e)) return { Icon: FileArchive, tint: TINT.amber }

  // Structured data / config.
  if ('json jsonc json5 ipynb'.split(' ').includes(e)) return { Icon: FileJson, tint: TINT.slate }
  if ('yml yaml toml ini cfg conf properties prefs'.split(' ').includes(e)) return { Icon: FileCog, tint: TINT.slate }
  if ('xml xsl plist'.split(' ').includes(e)) return { Icon: FileCode, tint: TINT.orange }
  if ('db sqlite sqlite3 mdb accdb sql'.split(' ').includes(e)) return { Icon: Database, tint: TINT.slate }
  if ('pem crt cer der key p12 pfx pub asc gpg keystore'.split(' ').includes(e)) return { Icon: FileKey, tint: TINT.amber }
  if ('lock'.split(' ').includes(e)) return { Icon: FileLock, tint: TINT.muted }

  // Shell / scripts.
  if ('sh bash zsh fish ps1 psm1 bat cmd applescript'.split(' ').includes(e)) return { Icon: FileTerminal, tint: TINT.emerald }

  // Docs / prose.
  if ('md markdown mdx txt log rst adoc org tex bib'.split(' ').includes(e)) return { Icon: FileText, tint: TINT.muted }

  // Code — per-language tints (seti-ish hues).
  if ('html htm vue svelte'.split(' ').includes(e)) return { Icon: FileCode, tint: TINT.orange }
  if ('css scss sass less styl'.split(' ').includes(e)) return { Icon: FileCode, tint: TINT.sky }
  if ('js mjs cjs jsx'.split(' ').includes(e)) return { Icon: FileCode, tint: TINT.yellow }
  if ('ts mts cts tsx'.split(' ').includes(e)) return { Icon: FileCode, tint: TINT.blue }
  if ('py pyi pyc pyw'.split(' ').includes(e)) return { Icon: FileCode, tint: TINT.green }
  if ('go mod sum'.split(' ').includes(e)) return { Icon: FileCode, tint: TINT.cyan }
  if ('rs rlib'.split(' ').includes(e)) return { Icon: FileCode, tint: TINT.orange }
  if ('java class jar'.split(' ').includes(e)) return { Icon: FileCode, tint: TINT.red }
  if ('c h'.split(' ').includes(e)) return { Icon: FileCode, tint: TINT.blue }
  if ('cc cpp cxx hpp hh hxx'.split(' ').includes(e)) return { Icon: FileCode, tint: TINT.purple }
  if ('cs csx csproj'.split(' ').includes(e)) return { Icon: FileCode, tint: TINT.purple }
  if ('rb erb gemspec rake'.split(' ').includes(e)) return { Icon: FileCode, tint: TINT.red }
  if ('php phtml'.split(' ').includes(e)) return { Icon: FileCode, tint: TINT.purple }
  if ('swift'.split(' ').includes(e)) return { Icon: FileCode, tint: TINT.orange }
  if ('kt kts kotlin'.split(' ').includes(e)) return { Icon: FileCode, tint: TINT.purple }
  if ('lua'.split(' ').includes(e)) return { Icon: FileCode, tint: TINT.blue }
  if ('r rmd'.split(' ').includes(e)) return { Icon: FileCode, tint: TINT.sky }
  if ('ex exs'.split(' ').includes(e)) return { Icon: FileCode, tint: TINT.purple }
  if ('hs lhs'.split(' ').includes(e)) return { Icon: FileCode, tint: TINT.purple }
  if ('scala sc'.split(' ').includes(e)) return { Icon: FileCode, tint: TINT.red }
  if ('dart'.split(' ').includes(e)) return { Icon: FileCode, tint: TINT.cyan }
  if ('zig'.split(' ').includes(e)) return { Icon: FileCode, tint: TINT.amber }
  if ('graphql gql'.split(' ').includes(e)) return { Icon: FileCode, tint: TINT.pink }
  if ('tf hcl'.split(' ').includes(e)) return { Icon: FileCode, tint: TINT.purple }
  if ('proto'.split(' ').includes(e)) return { Icon: FileCode, tint: TINT.teal }
  if ('wasm wat'.split(' ').includes(e)) return { Icon: FileCode, tint: TINT.purple }
  if ('diff patch'.split(' ').includes(e)) return { Icon: FileCode, tint: TINT.teal }
  // Any other known code-ish extension → plain code glyph.
  if ('asm s pl pm clj cljs erl fs fsx vb vbs sol nim ml mli jl groovy gradle cmake mk hx hxp d cr elm purs coffee'.split(' ').includes(e)) return { Icon: FileCode, tint: TINT.teal }
  return { Icon: File, tint: TINT.muted }
}

/** The one file-type icon. `dir` renders the shared folder glyph. */
export function FileIcon({ path, dir, size = 14, className }: { path: string; dir?: boolean; size?: number; className?: string }) {
  if (dir) return <FolderIcon size={size} className={cn('shrink-0 text-muted-foreground', className)} />
  const { Icon, tint } = specOf(path)
  return <Icon size={size} className={cn('shrink-0', tint, className)} />
}

export { ext as fileExt }
