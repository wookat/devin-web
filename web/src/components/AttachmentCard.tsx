import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Code2, Copy, Link2, Check, Eye } from 'lucide-react'
import { LightboxImage } from './Lightbox'
import Markdown from './Markdown'
import { cn } from '@/lib/utils'
import { CHIP_DOCX_SVG, CHIP_XLSX_SVG } from './chipOfficeIcons'
import { copyText } from '../lib/clipboard'

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i

const VIDEO_RE = /\.(mp4|webm|mov)$/i

/** Official thumbnail fit: the box never exceeds `max` on either side and never
 *  upscales; aspect is clamped to 8:1 / 1:5 and the image is object-cover cropped. */
const THUMB_MAX_WIDE = 8
const THUMB_MAX_TALL = 5
export function fitThumb(size: { width: number; height: number }, max: number): { width: number; height: number } {
  const n = size.width / size.height
  const r = Math.min(THUMB_MAX_WIDE, Math.max(1 / THUMB_MAX_TALL, n))
  const h = Math.min(max, max / r, size.width / r, size.height)
  return { width: Math.round(h * r), height: Math.round(h) }
}

/** Official chat image attachment: 400px-bounded thumbnail with a fixed aspect box once
 *  the natural size is known (no layout shift on lightbox open / virtualization). */
export function ImageThumb({ href, name, max = 400, onError }: { href: string; name: string; max?: number; onError?: () => void }) {
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const onNaturalSize = useCallback((s: { width: number; height: number }) => {
    setNatural((prev) => (prev && prev.width === s.width && prev.height === s.height ? prev : s))
  }, [])
  const fit = natural ? fitThumb(natural, max) : null
  return (
    <div
      className={cn('mt-0.5 min-h-0 min-w-0', max === 300 ? 'max-w-[300px]' : 'max-w-[400px]')}
      style={fit ? { width: fit.width, maxWidth: '100%', aspectRatio: `${fit.width} / ${fit.height}` } : undefined}
    >
      <LightboxImage
        src={href}
        alt={name}
        eager
        onNaturalSize={onNaturalSize}
        onError={onError}
        className={cn(
          'block max-w-full rounded-[10px] border border-foreground/[0.06]',
          fit ? 'h-full w-full object-cover object-center' : cn('h-auto w-auto', max === 300 ? 'max-h-[300px]' : 'max-h-[400px]'),
        )}
      />
    </div>
  )
}

/** Official previewable set: text/code extensions, well-known extensionless files, and
 *  html/htm/pdf/svg. Anything else (docx/xlsx/zip …) is download-only. */
const PREVIEW_EXT = new Set('md.mdx.markdown.txt.log.diff.patch.json.jsonc.yaml.yml.toml.ini.cfg.conf.env.xml.csv.tsv.css.scss.sass.less.js.mjs.cjs.jsx.ts.mts.cts.tsx.py.rb.go.rs.java.kt.swift.c.h.cpp.hpp.cc.cs.php.sh.bash.zsh.fish.ps1.sql.lua.r.dart.vue.svelte.tf.hcl.dockerfile.gradle.proto.graphql.gql.html.htm.pdf.svg'.split('.'))
const PREVIEW_NAMES = new Set(['dockerfile', 'makefile', 'license', 'readme', 'changelog', 'authors', 'contributors', 'procfile', 'gemfile', 'rakefile'])
export function isPreviewable(name: string): boolean {
  const base = (name.split(/[\\/]/).pop() || name).toLowerCase()
  if (PREVIEW_NAMES.has(base)) return true
  const dot = base.lastIndexOf('.')
  return dot >= 0 && PREVIEW_EXT.has(base.slice(dot + 1))
}

/** Admin media URLs carry `mt=` only once the session detail has loaded; fetching earlier just 401s. */
const awaitingMediaToken = (href: string) => /[?&]mt=(?:&|$)/.test(href)

/** Official inline .md attachment: 360px tinted card — header (name + View code /
 *  Copy content / Copy link / Download) over a 50%-scaled rendered-markdown thumbnail. */
function MdPreviewCard({ name, href, ts, onOpenTab }: { name: string; href: string; ts?: string; onOpenTab: (href: string, name: string, raw?: boolean) => void }) {
  const { t } = useTranslation()
  const [text, setText] = useState<string | null>(null)
  const [done, setDone] = useState('')
  useEffect(() => {
    if (awaitingMediaToken(href)) return
    let dead = false
    fetch(href).then((r) => (r.ok ? r.text() : Promise.reject())).then((t) => { if (!dead) setText(t) }).catch(() => { if (!dead) setText('') })
    return () => { dead = true }
  }, [href])
  const flash = (k: string) => { setDone(k); setTimeout(() => setDone(''), 1200) }
  const abtn = 'inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50'
  return (
    <div className="w-[360px] max-w-full rounded-[14px] bg-muted px-1.5 pb-1.5">
      <div className="flex h-10 items-center gap-1 pl-2 pr-1">
        <button onClick={() => onOpenTab(href, name)} className="min-w-0 flex-1 cursor-pointer truncate text-left text-[13px] text-foreground hover:underline">
          {name}
        </button>
        <button aria-label={t('att.viewCode')} title={t('att.viewCode')} onClick={() => onOpenTab(href, name, true)} className={abtn}>
          <Code2 size={16} />
        </button>
        <button
          aria-label={t('att.copyContent')}
          title={t('att.copyContent')}
          disabled={!text}
          onClick={() => { if (text) { copyText(text); flash('content') } }}
          className={abtn}
        >
          {done === 'content' ? <Check size={16} /> : <Copy size={16} />}
        </button>
        <button
          aria-label={t('att.copyLink')}
          title={t('att.copyLink')}
          onClick={() => {
            const q = new URLSearchParams({ tab: name })
            const ms = ts ? new Date(ts).getTime() : NaN
            if (!Number.isNaN(ms)) q.set('ts', String(ms))
            copyText(`${location.origin}${location.pathname}?${q}`)
            flash('link')
          }}
          className={abtn}
        >
          {done === 'link' ? <Check size={16} /> : <Link2 size={16} />}
        </button>
        <a aria-label={t('common.download')} title={t('common.download')} href={href} download={name} className={abtn}>
          <Download size={16} />
        </a>
      </div>
      <button
        onClick={() => onOpenTab(href, name)}
        className={cn('block w-full cursor-pointer overflow-hidden rounded-[8px] bg-card text-left shadow-sm', text === null && 'animate-pulse')}
        style={{ height: 226 }}
      >
        {text ? (
          <div className="relative h-full overflow-hidden px-3 py-2">
            <div className="pointer-events-none w-[200%] max-w-none origin-top-left scale-50 select-none">
              <Markdown text={text} />
            </div>
          </div>
        ) : null}
      </button>
    </div>
  )
}

/** Official chip file-type tiles (SVGs sampled live from app.devin.ai). */
function ChipPdfIcon() {
  return (
    <svg aria-hidden="true" width="34" height="34" viewBox="10 186 34 34" fill="none">
      <defs><clipPath id="chip-pdf-c"><rect x="10" y="186" width="34" height="34" rx="6" fill="white" /></clipPath></defs>
      <g clipPath="url(#chip-pdf-c)">
        <rect x="10" y="186" width="34" height="34" rx="6" fill="#FA0F00" />
        <path d="M15.1902 194.152C15.1902 193.048 16.0856 192.152 17.1902 192.152H29.8587C30.3891 192.152 30.8978 192.363 31.2729 192.738L38.224 199.689C38.5991 200.064 38.8098 200.573 38.8098 201.103V225.019C38.8098 226.124 37.9144 227.019 36.8098 227.019H17.1902C16.0856 227.019 15.1902 226.124 15.1902 225.019V194.152Z" fill="white" />
        <path d="M31.5951 202.728C30.8777 201.983 28.9189 202.286 28.45 202.341C27.7603 201.679 27.2913 200.879 27.1258 200.603C27.3741 199.858 27.5396 199.113 27.5672 198.313C27.5672 197.624 27.2913 196.879 26.5188 196.879C26.243 196.879 25.9946 197.044 25.8567 197.265C25.5256 197.844 25.6635 199.003 26.1877 200.189C25.8843 201.045 25.6084 201.872 24.8359 203.335C24.0359 203.665 22.353 204.438 22.215 205.266C22.1599 205.514 22.2426 205.762 22.4357 205.955C22.6288 206.121 22.8771 206.204 23.1254 206.204C24.1462 206.204 25.1393 204.797 25.8291 203.61C26.4084 203.417 27.3189 203.141 28.2293 202.976C29.3052 203.914 30.2432 204.052 30.7398 204.052C31.4019 204.052 31.6502 203.776 31.733 203.527C31.8709 203.252 31.7881 202.948 31.5951 202.728ZM30.9053 203.197C30.8777 203.39 30.6295 203.583 30.188 203.472C29.6638 203.335 29.1949 203.086 28.7811 202.755C29.1397 202.7 29.9397 202.617 30.5191 202.728C30.7398 202.783 30.9605 202.921 30.9053 203.197ZM26.2981 197.513C26.3533 197.431 26.4361 197.375 26.5188 197.375C26.7671 197.375 26.8222 197.679 26.8222 197.927C26.7947 198.507 26.6843 199.086 26.4912 199.638C26.0774 198.534 26.1602 197.762 26.2981 197.513ZM26.243 202.865C26.4636 202.424 26.7671 201.652 26.8775 201.32C27.1257 201.734 27.5396 202.231 27.7603 202.452C27.7603 202.479 26.905 202.645 26.243 202.865ZM24.6152 203.969C23.9807 205.017 23.3186 205.679 22.9599 205.679C22.9047 205.679 22.8495 205.652 22.7944 205.624C22.7116 205.569 22.684 205.486 22.7116 205.376C22.7944 204.99 23.5117 204.466 24.6152 203.969Z" fill="#FA0F00" />
        <path d="M22.5723 211.668C22.9575 211.668 23.2833 211.748 23.5488 211.906C23.817 212.062 24.0215 212.275 24.1621 212.543C24.3027 212.811 24.373 213.112 24.373 213.445C24.373 213.779 24.3014 214.079 24.1582 214.348C24.0176 214.613 23.8118 214.824 23.541 214.98C23.2728 215.134 22.9471 215.211 22.5645 215.211H21.4941V217H20.4395V211.668H22.5723ZM27.168 211.668C27.7096 211.668 28.1562 211.772 28.5078 211.98C28.8594 212.189 29.1211 212.491 29.293 212.887C29.4674 213.283 29.5547 213.76 29.5547 214.32C29.5547 214.883 29.4674 215.365 29.293 215.766C29.1185 216.167 28.8542 216.473 28.5 216.684C28.1484 216.895 27.7044 217 27.168 217H25.2227V211.668H27.168ZM33.9121 212.539H31.5684V214.027H33.709V214.879H31.5684V217H30.5137V211.668H33.9121V212.539ZM26.2773 216.137H27.0273C27.2747 216.137 27.4896 216.1 27.6719 216.027C27.8542 215.952 28.0026 215.84 28.1172 215.691C28.2344 215.54 28.3216 215.353 28.3789 215.129C28.4388 214.905 28.4688 214.642 28.4688 214.34C28.4688 213.939 28.4167 213.604 28.3125 213.336C28.2109 213.068 28.0534 212.866 27.8398 212.73C27.6289 212.595 27.3581 212.527 27.0273 212.527H26.2773V216.137ZM21.4902 214.383H22.3691C22.5643 214.383 22.7312 214.346 22.8691 214.273C23.0071 214.198 23.1126 214.091 23.1855 213.953C23.2611 213.812 23.2988 213.643 23.2988 213.445C23.2988 213.143 23.2168 212.911 23.0527 212.75C22.8887 212.589 22.6607 212.508 22.3691 212.508H21.4902V214.383Z" fill="#191919" />
      </g>
    </svg>
  )
}

function ChipZipIcon() {
  return (
    <svg aria-hidden="true" width="34" height="34" viewBox="10 274 34 34" fill="none">
      <defs><clipPath id="chip-zip-c"><rect x="10" y="274" width="34" height="34" rx="6" fill="white" /></clipPath></defs>
      <g clipPath="url(#chip-zip-c)">
        <rect x="10" y="274" width="34" height="34" rx="6" fill="#FDD05B" />
        <path d="M15.1902 282.152C15.1902 281.048 16.0856 280.152 17.1902 280.152H29.8587C30.3891 280.152 30.8978 280.363 31.2729 280.738L38.224 287.689C38.5991 288.064 38.8098 288.573 38.8098 289.103V313.019C38.8098 314.124 37.9144 315.019 36.8098 315.019H17.1902C16.0856 315.019 15.1902 314.124 15.1902 313.019V282.152Z" fill="white" />
        <rect x="18" y="280.428" width="2" height="2" fill="black" /><rect x="20" y="282.428" width="2" height="2" fill="black" /><rect x="18" y="284.428" width="2" height="2" fill="black" /><rect x="20" y="286.428" width="2" height="2" fill="black" /><rect x="18" y="288.428" width="2" height="2" fill="black" /><rect x="20" y="290.428" width="2" height="2" fill="black" />
        <path fillRule="evenodd" clipRule="evenodd" d="M24.8457 300.359L22.2793 304.078V304.133H24.9238V305H20.9902V304.309L23.5684 300.59V300.535H21.0605V299.668H24.8457V300.359ZM26.9883 305H25.9336V299.668H26.9883V305ZM30.3574 299.668C30.7427 299.668 31.0684 299.747 31.334 299.906C31.6021 300.062 31.8067 300.275 31.9473 300.543C32.0878 300.811 32.1582 301.112 32.1582 301.445C32.1582 301.779 32.0865 302.079 31.9434 302.348C31.8028 302.613 31.5969 302.824 31.3262 302.98C31.058 303.134 30.7323 303.211 30.3496 303.211H29.2793V305H28.2246V299.668H30.3574ZM29.2754 302.383H30.1543C30.3494 302.383 30.5164 302.346 30.6543 302.273C30.7922 302.198 30.8978 302.091 30.9707 301.953C31.0462 301.813 31.084 301.643 31.084 301.445C31.084 301.143 31.0018 300.911 30.8379 300.75C30.6739 300.589 30.4458 300.508 30.1543 300.508H29.2754V302.383Z" fill="#191919" />
      </g>
    </svg>
  )
}

function ChipCsvIcon() {
  return (
    <svg aria-hidden="true" width="34" height="34" viewBox="10 230 34 34" fill="none">
      <defs><clipPath id="chip-csv-c"><rect x="10" y="230" width="34" height="34" rx="6" fill="white" /></clipPath></defs>
      <g clipPath="url(#chip-csv-c)">
        <rect x="10" y="230" width="34" height="34" rx="6" fill="#33AA4D" />
        <path d="M15.1902 238.152C15.1902 237.048 16.0856 236.152 17.1902 236.152H29.8587C30.3891 236.152 30.8978 236.363 31.2729 236.738L38.224 243.689C38.5991 244.064 38.8098 244.573 38.8098 245.103V269.019C38.8098 270.124 37.9144 271.019 36.8098 271.019H17.1902C16.0856 271.019 15.1902 270.124 15.1902 269.019V238.152Z" fill="white" />
        <path fillRule="evenodd" clipRule="evenodd" d="M21.6816 255.566C21.9732 255.566 22.2429 255.609 22.4902 255.695C22.7401 255.779 22.9577 255.9 23.1426 256.059C23.3274 256.217 23.4733 256.405 23.5801 256.621C23.6895 256.837 23.7506 257.078 23.7637 257.344V257.441H22.7441C22.7285 257.251 22.6751 257.082 22.584 256.934C22.4955 256.785 22.3743 256.669 22.2207 256.586C22.0671 256.5 21.8898 256.457 21.6895 256.457C21.4448 256.457 21.2336 256.518 21.0566 256.641C20.8823 256.763 20.748 256.94 20.6543 257.172C20.5632 257.404 20.5176 257.685 20.5176 258.016V258.676C20.5176 259.004 20.5632 259.283 20.6543 259.512C20.7454 259.741 20.8784 259.915 21.0527 260.035C21.2297 260.152 21.4422 260.211 21.6895 260.211C21.8924 260.211 22.071 260.172 22.2246 260.094C22.3782 260.013 22.4994 259.902 22.5879 259.762C22.6764 259.621 22.7285 259.46 22.7441 259.277H23.7637V259.379C23.7454 259.717 23.6452 260.017 23.4629 260.277C23.2806 260.535 23.0357 260.737 22.7285 260.883C22.4213 261.029 22.0721 261.102 21.6816 261.102C21.2026 261.102 20.7961 261.005 20.4629 260.812C20.1297 260.617 19.8756 260.338 19.7012 259.977C19.5293 259.615 19.4434 259.181 19.4434 258.676V258.012C19.4434 257.507 19.5306 257.072 19.7051 256.707C19.8795 256.343 20.1336 256.061 20.4668 255.863C20.8026 255.665 21.2079 255.566 21.6816 255.566ZM26.5508 255.559C26.957 255.559 27.3034 255.626 27.5898 255.762C27.8789 255.897 28.1016 256.079 28.2578 256.309C28.4167 256.535 28.5052 256.786 28.5234 257.062H27.5234C27.5 256.935 27.4466 256.82 27.3633 256.719C27.2826 256.617 27.1732 256.536 27.0352 256.477C26.8971 256.417 26.7331 256.387 26.543 256.387C26.2539 256.387 26.026 256.454 25.8594 256.59C25.6953 256.723 25.6133 256.893 25.6133 257.102C25.6133 257.263 25.6771 257.396 25.8047 257.5C25.9323 257.604 26.112 257.682 26.3438 257.734L27.1719 257.926C27.4609 257.991 27.7122 258.085 27.9258 258.207C28.1393 258.327 28.306 258.486 28.4258 258.684C28.5456 258.882 28.6055 259.13 28.6055 259.43C28.6055 259.76 28.5221 260.052 28.3555 260.305C28.1914 260.555 27.9518 260.75 27.6367 260.891C27.3242 261.029 26.9544 261.098 26.5273 261.098C26.1055 261.098 25.7357 261.027 25.418 260.883C25.1003 260.737 24.8503 260.527 24.668 260.254C24.4857 259.978 24.3881 259.645 24.375 259.254H25.3867C25.4049 259.43 25.4583 259.582 25.5469 259.711C25.638 259.84 25.7591 259.94 25.9102 260.012C26.0638 260.081 26.243 260.117 26.4473 260.117C26.6576 260.117 26.8346 260.091 26.9785 260.039C27.125 259.984 27.2357 259.908 27.3105 259.809C27.3854 259.707 27.4229 259.589 27.4229 259.453C27.4229 259.326 27.3867 259.221 27.3145 259.137C27.2422 259.049 27.1328 258.975 26.9863 258.914C26.8398 258.851 26.6536 258.79 26.4277 258.734L25.4238 258.488C24.9837 258.38 24.6341 258.206 24.375 257.965C24.1159 257.721 23.9883 257.393 23.9922 256.98C23.9922 256.652 24.0794 256.362 24.2539 256.113C24.431 255.863 24.6745 255.668 24.9844 255.527C25.2943 255.384 25.6471 255.312 26.043 255.312L26.5508 255.559ZM30.5469 261L28.9023 255.668H29.9922L31.0586 259.559L32.1367 255.668H33.2188L31.5742 261H30.5469Z" fill="#191919" />
        {[242.428, 245.428, 248.428].map((y) => [19, 23, 27, 31].map((x) => (
          <rect key={`${x}-${y}`} x={x} y={y} width="4" height="3" stroke="#D9D9D9" strokeWidth="0.5" />
        )))}
      </g>
    </svg>
  )
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
}

/** Official user-uploaded attachment chip: 38px doc-icon tile + name/size column +
 *  hover-revealed View / Download buttons (group-hover opacity). */
function FileChip({ name, href, onOpenTab }: { name: string; href: string; onOpenTab?: (href: string, name: string, raw?: boolean) => void }) {
  const { t } = useTranslation()
  const [size, setSize] = useState<number | null>(null)
  useEffect(() => {
    if (awaitingMediaToken(href)) return
    let dead = false
    fetch(href, { method: 'HEAD' })
      .then((r) => { const l = r.headers.get('content-length'); if (!dead && l) setSize(parseInt(l, 10)) })
      .catch(() => { /* size stays hidden */ })
    return () => { dead = true }
  }, [href])
  const hbtn = 'inline-flex size-6 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/attachment:opacity-100'
  const view = onOpenTab && isPreviewable(name) ? () => onOpenTab(href, name) : undefined
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="group/attachment relative flex w-fit max-w-xs shrink-0 cursor-pointer items-center gap-2 overflow-hidden rounded-[6px] pr-2 !text-inherit !no-underline"
      onClick={(e) => {
        if (!view) return
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return
        e.preventDefault()
        view()
      }}
    >
      <div className="flex size-[38px] shrink-0 items-center justify-center rounded-[6px] bg-muted">
        {/\.docx?$/i.test(name) ? (
          <span className="flex size-[34px]" dangerouslySetInnerHTML={{ __html: CHIP_DOCX_SVG }} />
        ) : /\.xlsx?$/i.test(name) ? (
          <span className="flex size-[34px]" dangerouslySetInnerHTML={{ __html: CHIP_XLSX_SVG }} />
        ) : /\.pdf$/i.test(name) ? (
          <ChipPdfIcon />
        ) : /\.zip$/i.test(name) ? (
          <ChipZipIcon />
        ) : /\.csv$/i.test(name) ? (
          <ChipCsvIcon />
        ) : /\.json$/i.test(name) ? (
          <svg aria-hidden="true" width="34" height="34" viewBox="10 406 34 34" fill="none">
            <defs>
              <linearGradient id="jn-g0" x1="17.85" y1="414.27" x2="36.16" y2="432.59" gradientUnits="userSpaceOnUse">
                <stop /><stop offset="1" stopColor="white" />
              </linearGradient>
              <linearGradient id="jn-g1" x1="36.16" y1="432.59" x2="17.85" y2="414.27" gradientUnits="userSpaceOnUse">
                <stop /><stop offset="1" stopColor="white" />
              </linearGradient>
            </defs>
            <rect x="10" y="406" width="34" height="34" rx="6" fill="#E6E6E6" />
            <path fillRule="evenodd" clipRule="evenodd" d="M26.9781 429.782C32.7302 437.623 38.3596 427.593 38.3513 421.562C38.3415 414.43 31.1134 410.444 26.9734 410.444C20.3284 410.444 14 415.936 14 423.45C14 431.802 21.254 436.428 26.9734 436.428C25.6791 436.242 21.3661 435.318 21.3081 425.384C21.2691 418.665 23.4999 415.98 26.9639 417.161C27.0415 417.19 30.785 418.667 30.785 423.491C30.785 428.294 26.9781 429.782 26.9781 429.782Z" fill="url(#jn-g0)" />
            <path fillRule="evenodd" clipRule="evenodd" d="M26.9711 417.156C23.1703 415.846 18.5142 418.979 18.5142 425.253C18.5142 435.498 26.1063 436.428 27.0266 436.428C33.6715 436.428 39.9999 430.936 39.9999 423.422C39.9999 415.071 32.7459 410.444 27.0266 410.444C28.6106 410.225 35.5645 412.159 35.5645 421.663C35.5645 427.861 30.3721 431.235 26.995 429.793C26.9175 429.764 23.174 428.288 23.174 423.464C23.174 418.66 26.9711 417.156 26.9711 417.156Z" fill="url(#jn-g1)" />
          </svg>
        ) : (
          <svg aria-hidden="true" width="34" height="34" viewBox="10 450 34 34" fill="none">
            <rect x="10" y="450" width="34" height="34" rx="6" fill="#317CFF" />
            <path d="M15.19 458.15c0-1.1.9-2 2-2h12.67c.53 0 1.04.21 1.41.59l6.95 6.95c.38.37.59.88.59 1.41v23.92c0 1.1-.9 2-2 2H17.19c-1.1 0-2-.9-2-2v-30.87z" fill="white" />
            <rect x="18" y="465.43" width="18" height="2" fill="#B5D0FF" />
            <rect x="18" y="469.43" width="18" height="2" fill="#B5D0FF" />
            <rect x="18" y="473.43" width="11" height="2" fill="#B5D0FF" />
          </svg>
        )}
      </div>
      <div className="flex min-w-0 flex-col justify-center">
        <span className="truncate text-[13px] font-medium text-foreground" title={name}>{name}</span>
        {size !== null && <span className="text-[12px] font-normal text-muted-foreground">{fmtSize(size)}</span>}
      </div>
      {view && (
        <button aria-label={t('att.view')} title={t('att.view')} onClick={(e) => { e.preventDefault(); e.stopPropagation(); view() }} className={cn(hbtn, 'ml-0.5')}>
          <Eye size={16} />
        </button>
      )}
      <button
        aria-label={t('att.download')}
        title={t('common.download')}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          const t = document.createElement('a')
          t.href = href
          t.download = name
          document.body.appendChild(t)
          t.click()
          document.body.removeChild(t)
        }}
        className={cn(hbtn, !view && 'ml-0.5')}
      >
        <Download size={16} />
      </button>
    </a>
  )
}

export default function AttachmentCard({ name, href, ts, onOpenTab, chip }: { name: string; href: string; ts?: string; onOpenTab?: (href: string, name: string, raw?: boolean) => void; chip?: boolean }) {
  // Official transcript: an image that fails to load degrades to the file chip.
  const [imgBroken, setImgBroken] = useState(false)
  useEffect(() => setImgBroken(false), [href])
  const isImage = IMAGE_RE.test(name) && !imgBroken
  if ((chip || imgBroken) && !isImage && !VIDEO_RE.test(name)) {
    return <FileChip name={name} href={href} onOpenTab={onOpenTab} />
  }
  if (!isImage && onOpenTab && /\.md$/i.test(name)) {
    return <MdPreviewCard name={name} href={href} ts={ts} onOpenTab={onOpenTab} />
  }
  if (VIDEO_RE.test(name)) {
    return (
      <div className="mt-0.5 min-w-0">
        <div className="max-h-[400px] w-[550px] max-w-full overflow-hidden rounded-[6px] border border-foreground/[0.06]">
          <video controls playsInline preload="metadata" src={`${href}#t=0.1`} aria-label={name} className="block max-h-[400px] w-full rounded-[6px]" />
        </div>
      </div>
    )
  }
  if (isImage) {
    if (awaitingMediaToken(href)) return <div className="mt-0.5 h-[120px] w-[160px] animate-pulse rounded-[10px] bg-muted" aria-label={name} />
    return <ImageThumb href={href} name={name} onError={() => setImgBroken(true)} />
  }
  return <FileChip name={name} href={href} onOpenTab={onOpenTab} />
}
