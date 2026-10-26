import { useEffect, useState } from 'react'

/** Extension → shiki lang. Values must be keys of hl.ts's LANG_IMPORTERS —
 *  those are lazy chunks, so this table costs nothing until a file opens.
 *  Composite extensions (d.ts, blade.php…) resolve longest-suffix first. */
const LANGS: Record<string, string> = {
  // web / scripting
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', gjs: 'javascript',
  jsx: 'jsx', tsx: 'tsx', gts: 'tsx',
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  'd.ts': 'typescript', 'd.mts': 'typescript', 'd.cts': 'typescript',
  html: 'html', htm: 'html', xhtml: 'html', vue: 'vue', svelte: 'svelte',
  astro: 'astro', imba: 'imba', marko: 'marko', edge: 'edge',
  css: 'css', scss: 'scss', sass: 'sass', less: 'less', styl: 'stylus',
  postcss: 'postcss', pcss: 'postcss', qss: 'css',
  json: 'json', map: 'json', ipynb: 'json', webmanifest: 'json', mcmeta: 'json',
  tfstate: 'json', babelrc: 'json', eslintrc: 'json', prettierrc: 'json',
  hintrc: 'json', swcrc: 'json',
  jsonc: 'jsonc', json5: 'json5', jsonl: 'jsonl', ndjson: 'jsonl',
  jsonnet: 'jsonnet', hjson: 'hjson',
  xml: 'xml', xsl: 'xsl', xslt: 'xsl', xsd: 'xml', rss: 'xml', atom: 'xml',
  plist: 'xml', svg: 'xml', storyboard: 'xml',
  yaml: 'yaml', yml: 'yaml', toml: 'toml',
  ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini', desktop: 'ini',
  editorconfig: 'ini', gitattributes: 'ini', gitmodules: 'ini',
  gitignore: 'ini', dockerignore: 'ini', npmignore: 'ini', npmrc: 'ini',
  env: 'dotenv', reg: 'reg', po: 'po', pot: 'po',
  // docs / markup
  md: 'markdown', markdown: 'markdown', mdx: 'mdx', mdc: 'mdc',
  rst: 'rst', adoc: 'asciidoc', asciidoc: 'asciidoc', org: 'org',
  wiki: 'wikitext', mediawiki: 'wikitext', textile: 'wikitext',
  tex: 'tex', latex: 'tex', sty: 'tex', cls: 'tex', bib: 'bibtex',
  pod: 'perl', log: 'log',
  // shell / system
  sh: 'bash', bash: 'bash', zsh: 'bash', ksh: 'bash', csh: 'bash',
  tcsh: 'bash', fish: 'fish', nu: 'nushell',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  bat: 'bat', cmd: 'bat',
  awk: 'awk', sed: 'awk', tcl: 'tcl',
  service: 'systemd', timer: 'systemd', socket: 'systemd',
  nginx: 'nginx', apacheconf: 'apache',
  vim: 'viml', vimrc: 'viml', gvimrc: 'viml',
  // mainstream languages
  c: 'c', h: 'c',
  cpp: 'cpp', cxx: 'cpp', cc: 'cpp', hpp: 'cpp', hxx: 'cpp',
  cs: 'csharp', csx: 'csharp',
  java: 'java', jsp: 'java',
  kt: 'kotlin', kts: 'kotlin',
  scala: 'scala', sc: 'scala',
  groovy: 'groovy', gvy: 'groovy', gradle: 'groovy', jenkinsfile: 'groovy',
  nf: 'nextflow',
  py: 'python', pyw: 'python', pyi: 'python', rpy: 'python', ipy: 'python',
  rb: 'ruby', rbw: 'ruby', rake: 'ruby', gemspec: 'ruby', podspec: 'ruby',
  erb: 'erb',
  php: 'php', phtml: 'php', phps: 'php', 'blade.php': 'blade',
  go: 'go', rs: 'rust', swift: 'swift',
  lua: 'lua', luau: 'lua',
  r: 'r', rmd: 'r', rhistory: 'r', rprofile: 'r',
  pl: 'perl', pm: 'perl', perl: 'perl', t: 'perl',
  jl: 'julia', dart: 'dart', v: 'v', vsh: 'v', vala: 'vala',
  ex: 'elixir', exs: 'elixir', eex: 'elixir', heex: 'elixir',
  erl: 'erlang', hrl: 'erlang',
  hs: 'haskell', lhs: 'haskell', hsc: 'haskell',
  ml: 'ocaml', mli: 'ocaml', mll: 'ocaml', mly: 'ocaml',
  fs: 'fsharp', fsi: 'fsharp', fsx: 'fsharp', fsscript: 'fsharp',
  clj: 'clojure', cljs: 'clojure', cljc: 'clojure', edn: 'clojure',
  lisp: 'lisp', lsp: 'lisp', el: 'emacs-lisp',
  scm: 'scheme', rkt: 'racket', fnl: 'fennel', 'common-lisp': 'common-lisp',
  cr: 'crystal', d: 'd', nim: 'nim', zig: 'zig', haxe: 'haxe', hx: 'haxe',
  coffee: 'coffeescript', litcoffee: 'coffeescript',
  m: 'objective-c', mm: 'objective-cpp', objc: 'objective-c',
  mojo: 'mojo', gleam: 'gleam', lean: 'lean', coq: 'coq',
  purs: 'purescript', hack: 'hack', hh: 'hack',
  ada: 'ada', adb: 'ada', ads: 'ada',
  pas: 'pascal', pp: 'pascal', dpr: 'pascal',
  // shaders / hardware
  glsl: 'glsl', vert: 'glsl', frag: 'glsl', geom: 'glsl', comp: 'glsl',
  hlsl: 'hlsl', fx: 'hlsl', wgsl: 'wgsl', shader: 'shaderlab',
  asm: 'mipsasm', riscv: 'riscv', ll: 'llvm',
  vh: 'verilog', sv: 'system-verilog', svh: 'system-verilog',
  vhdl: 'vhdl', vhd: 'vhdl', wasm: 'wasm', wat: 'wasm',
  // data / query / config
  sql: 'sql', plsql: 'plsql', pks: 'plsql', pkb: 'plsql',
  cql: 'cypher', gql: 'graphql', graphql: 'graphql', graphqls: 'graphql',
  sparql: 'sparql', rq: 'sparql', ttl: 'turtle',
  kql: 'kusto', spl: 'splunk',
  sas: 'sas', do: 'stata', ado: 'stata', matlab: 'matlab',
  gnuplot: 'gnuplot', gp: 'gnuplot',
  wl: 'wolfram', nb: 'wolfram', mma: 'wolfram',
  cue: 'cue', kdl: 'kdl', csv: 'csv', tsv: 'tsv',
  hcl: 'hcl', tf: 'terraform', tfvars: 'terraform',
  bicep: 'bicep', pkl: 'pkl', nix: 'nix',
  proto: 'proto', protobuf: 'proto', thrift: 'proto',
  cmake: 'cmake', mk: 'make', mak: 'make', makefile: 'make', just: 'just',
  dockerfile: 'dockerfile', containerfile: 'dockerfile',
  rel: 'rel', msg: 'rosmsg', srv: 'rosmsg', action: 'rosmsg',
  sol: 'solidity', vy: 'vyper', move: 'move', cairo: 'cairo',
  // templates
  hbs: 'handlebars', handlebars: 'handlebars', mustache: 'handlebars',
  pug: 'pug', jade: 'pug', haml: 'haml',
  jinja: 'jinja', j2: 'jinja', jinja2: 'jinja', njk: 'jinja',
  nunjucks: 'jinja', ftl: 'jinja', tmpl: 'jinja', tpl: 'jinja',
  twig: 'twig', liquid: 'liquid', soy: 'soy',
  razor: 'razor', cshtml: 'razor', blade: 'blade', templ: 'templ',
  // misc
  diff: 'diff', patch: 'diff', rej: 'diff',
  http: 'http', rest: 'http', hurl: 'hurl',
  mermaid: 'mermaid', mmd: 'mermaid',
  gherkin: 'gherkin', feature: 'gherkin',
  codeql: 'codeql', ql: 'codeql', jison: 'jison',
  narrat: 'narrat', tasl: 'tasl', talon: 'talonscript',
  st: 'smalltalk', vb: 'vb', vbs: 'vb', vba: 'vb',
  gd: 'gdscript', gdscript: 'gdscript', scad: 'openscad',
  qml: 'qml', nsi: 'nsis', nsh: 'nsis',
  typespec: 'typespec', tsp: 'typespec', typ: 'typst', typst: 'typst',
  wit: 'wit', wenyan: 'wenyan', zenscript: 'zenscript',
  'git-commit': 'git-commit', 'git-rebase': 'git-rebase',
  console: 'shellsession', shellsession: 'shellsession',
  polar: 'polar', rego: 'polar', puppet: 'puppet', jspm: 'jison',
}

/** Extensionless basenames → lang (checked before the suffix walk, and only
 *  when the name carries no usable extension or IS the extension). */
const NAME_LANGS: Record<string, string> = {
  dockerfile: 'dockerfile', containerfile: 'dockerfile',
  makefile: 'make', gnumakefile: 'make', 'makefile.am': 'make', 'makefile.in': 'make',
  justfile: 'just', 'cmakelists.txt': 'cmake',
  jenkinsfile: 'groovy', 'build.gradle': 'groovy', 'settings.gradle': 'groovy',
  'go.mod': 'go', 'go.sum': 'go', 'go.work': 'go',
  'build.bazel': 'python', 'workspace.bazel': 'python', 'module.bazel': 'python',
  gemfile: 'ruby', rakefile: 'ruby', guardfile: 'ruby', podfile: 'ruby',
  brewfile: 'ruby', vagrantfile: 'ruby', berksfile: 'ruby', capfile: 'ruby',
  fastfile: 'ruby', appfile: 'ruby', deliverfile: 'ruby', gymfile: 'ruby',
  matchfile: 'ruby', scanfile: 'ruby', snapfile: 'ruby',
  '.eslintrc': 'json', '.prettierrc': 'json', '.babelrc': 'json', '.swcrc': 'json',
  '.eslintrc.js': 'javascript', '.prettierrc.js': 'javascript',
  '.eslintrc.cjs': 'javascript', '.prettierrc.cjs': 'javascript',
  '.eslintrc.yml': 'yaml', '.prettierrc.yml': 'yaml', '.eslintrc.yaml': 'yaml',
  '.prettierrc.yaml': 'yaml',
  '.gitignore': 'ini', '.gitattributes': 'ini', '.gitmodules': 'ini',
  '.dockerignore': 'ini', '.npmignore': 'ini', '.eslintignore': 'ini',
  '.prettierignore': 'ini', '.editorconfig': 'ini', '.browserslistrc': 'ini',
  '.env': 'dotenv', '.env.local': 'dotenv', '.env.development': 'dotenv',
  '.env.production': 'dotenv', '.env.test': 'dotenv', '.env.example': 'dotenv',
  '.env.sample': 'dotenv', 'nginx.conf': 'nginx', '.htaccess': 'apache',
  'ssh_config': 'ssh-config', 'sshd_config': 'ssh-config',
  '.vimrc': 'viml', '.gvimrc': 'viml', '.ideavimrc': 'viml', '.inputrc': 'ini',
  license: 'markdown', copying: 'markdown', changelog: 'markdown',
  authors: 'markdown', contributors: 'markdown', notice: 'markdown',
  readme: 'markdown',
  'cargo.lock': 'toml', 'pipfile': 'toml', 'pipfile.lock': 'json',
  'poetry.lock': 'toml', 'gemfile.lock': 'ini', 'yarn.lock': 'yaml',
  'pnpm-lock.yaml': 'yaml', 'package-lock.json': 'json',
  'composer.lock': 'json', 'deno.lock': 'json',
  'docker-compose.yml': 'yaml', 'docker-compose.yaml': 'yaml',
  'compose.yml': 'yaml', 'compose.yaml': 'yaml',
}

/** Basename first (covers extensionless + dotfiles), then longest-suffix
 *  extension walk so `.d.ts`, `blade.php`, `nginx.conf` resolve correctly. */
export function langOf(name: string): string | null {
  const base = (name.split(/[\\/]/).pop() ?? name).toLowerCase()
  if (NAME_LANGS[base]) return NAME_LANGS[base]
  let rest = base
  for (;;) {
    const i = rest.indexOf('.')
    if (i < 0) return null
    rest = rest.slice(i + 1)
    const l = LANGS[rest]
    if (l) return l
  }
}

export type Tok = { content: string; color?: string; darkColor?: string }

/** Shiki dual-theme tokenizer, shared by the read-only CodeView and the
 * overlay-highlight CodeEditor. `debounceMs` smooths typing bursts. */
export function useShikiTokens(text: string, name: string, debounceMs = 0): Tok[][] | null {
  const [lines, setLines] = useState<Tok[][] | null>(null)
  useEffect(() => {
    let dead = false
    const lang = langOf(name)
    if (!lang) { setLines(null); return }
    const run = () =>
      import('../lib/hl')
        .then(({ codeTokens }) => codeTokens(text, lang))
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
