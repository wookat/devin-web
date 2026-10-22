import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { Download, ChevronLeft, ChevronRight } from 'lucide-react'

interface GalleryImage {
  src: string
  alt: string
}

/** Official lightbox caption: basename of the URL when it looks like a filename, else alt. */
export function lightboxFilename(src: string, alt?: string): string {
  if (!src.startsWith('data:')) {
    const base = src.split('/').pop()?.split(/[?#]/)[0] ?? ''
    if (base.includes('.')) {
      try {
        return decodeURIComponent(base)
      } catch {
        return base
      }
    }
  }
  return alt || 'Image'
}

const abs = (u: string) => new URL(u, window.location.href).href

function collectGallery(initial: GalleryImage): GalleryImage[] {
  const imgs = [...document.querySelectorAll<HTMLImageElement>('img[data-lightbox]')]
    .filter((i) => i.checkVisibility?.() ?? true)
    .map((i) => ({ src: i.src, alt: i.alt }))
  const list = imgs.length ? imgs : [initial]
  return list.some((g) => g.src === initial.src) ? list : [initial, ...list]
}

export function LightboxOverlay({ src: initialSrc, alt, onClose }: { src: string; alt?: string; onClose: () => void }) {
  const { t } = useTranslation()
  const [gallery] = useState<GalleryImage[]>(() => collectGallery({ src: abs(initialSrc), alt: alt || '' }))
  const [idx, setIdx] = useState(() => Math.max(0, gallery.findIndex((g) => g.src === abs(initialSrc))))
  const total = gallery.length
  const cur = gallery[Math.min(idx, total - 1)]
  const step = (d: number) => setIdx((i) => (i + d + total) % total)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (total > 1 && e.key === 'ArrowLeft') { e.preventDefault(); setIdx((i) => (i - 1 + total) % total) }
      if (total > 1 && e.key === 'ArrowRight') { e.preventDefault(); setIdx((i) => (i + 1) % total) }
    }
    window.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [onClose, total])
  const name = lightboxFilename(cur.src, cur.alt)
  const navBtn =
    'pointer-events-auto flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border-secondary bg-elevated text-foreground shadow-md hover:bg-tint-secondary'
  return createPortal(
    <>
      <div className="fixed inset-0 z-[100] bg-scrim" />
      <div
        className="fixed inset-0 z-[100] flex min-h-full items-center justify-center p-0"
        onClick={onClose}
        role="dialog"
        aria-modal="true"
        aria-label={t('att.imgPreview')}
      >
        <div className="pointer-events-none flex max-h-[98vh] max-w-[98vw] flex-col items-center gap-2 outline-none">
          <div className="relative flex w-full items-center justify-center px-10">
            {total > 1 && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); step(-1) }}
                className={`${navBtn} absolute left-0`}
                aria-label={t('att.prev')}
              >
                <ChevronLeft size={20} strokeWidth={1.75} />
              </button>
            )}
            <img
              src={cur.src}
              alt={cur.alt}
              loading="eager"
              onClick={(e) => e.stopPropagation()}
              className="pointer-events-auto h-auto max-h-[calc(98vh-3rem)] min-h-12 w-auto max-w-full object-contain"
            />
            {total > 1 && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); step(1) }}
                className={`${navBtn} absolute right-0`}
                aria-label={t('att.next')}
              >
                <ChevronRight size={20} strokeWidth={1.75} />
              </button>
            )}
          </div>
          <div
            onClick={(e) => e.stopPropagation()}
            className="pointer-events-auto flex max-w-full items-center gap-1.5 rounded-md border border-border-secondary bg-elevated py-1 pl-2.5 pr-1 text-[13px] leading-[18px] text-foreground shadow-md"
          >
            <span className="min-w-0 truncate">{name}</span>
            {total > 1 && (
              <span className="shrink-0 text-muted-foreground">
                {idx + 1} / {total}
              </span>
            )}
            <a
              href={cur.src}
              download={name}
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-tint-secondary hover:text-foreground"
              aria-label={t('common.download')}
            >
              <Download size={14} />
            </a>
          </div>
        </div>
      </div>
    </>,
    document.body,
  )
}

/** Image that opens an in-page lightbox overlay on click; visible instances form the gallery. */
export function LightboxImage({
  src,
  alt,
  className,
  eager,
  onNaturalSize,
  onError,
}: {
  src: string
  alt?: string
  className?: string
  eager?: boolean
  onNaturalSize?: (size: { width: number; height: number }) => void
  onError?: () => void
}) {
  const [open, setOpen] = useState(false)
  const report = (img: HTMLImageElement | null) => {
    if (img && onNaturalSize && img.naturalWidth && img.naturalHeight) onNaturalSize({ width: img.naturalWidth, height: img.naturalHeight })
  }
  return (
    <>
      <img
        ref={report}
        data-lightbox=""
        src={src}
        alt={alt || ''}
        loading={eager ? 'eager' : 'lazy'}
        onClick={() => setOpen(true)}
        onLoad={onNaturalSize ? (e) => report(e.currentTarget) : undefined}
        onError={onError}
        className={`cursor-pointer ${className || ''}`}
      />
      {open && <LightboxOverlay src={src} alt={alt} onClose={() => setOpen(false)} />}
    </>
  )
}
