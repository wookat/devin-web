import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

// Official composer shell (sampled live 2026-09-01): input container max-w-740 → mx-2 mb-2 →
// "beard band" (radius 20; 22/26 while a band item is open) whose translucent "wax" sheet
// (rgba(242,242,242,.96) + blur 8px) grows upward to cover the eyebrow row that hangs above the
// card (absolute bottom-full, px-1.5, each item py-1.5). The card itself is rounded-20 p-3
// min-h-16; with the band open its border turns transparent and it gains the L2 shadow.
export default function BeardBand({ band, children, className, onBandHeight }: {
  band?: ReactNode
  children: ReactNode
  className?: string
  onBandHeight?: (h: number) => void
}) {
  const open = !!band
  const eyebrowRef = useRef<HTMLDivElement | null>(null)
  const [bandH, setBandH] = useState(0)

  useEffect(() => {
    const el = eyebrowRef.current
    if (!open || !el) {
      setBandH(0)
      onBandHeight?.(0)
      return
    }
    const ro = new ResizeObserver(() => {
      const h = el.getBoundingClientRect().height
      setBandH(h)
      onBandHeight?.(h)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [open, onBandHeight])

  return (
    <div className="relative z-30 mx-auto mt-auto w-full max-w-[740px]">
      <div className="mx-2 mb-2 flex flex-col">
        <div
          data-beard-open={open}
          className={cn('group/beard-band relative flex w-full flex-col', open ? 'rounded-[22px_22px_26px_26px]' : 'rounded-[20px]')}
        >
          {open && (
            <div
              aria-hidden
              style={{ top: -bandH }}
              className="pointer-events-none absolute inset-x-0 bottom-0 rounded-[inherit] bg-[rgba(242,242,242,0.96)] backdrop-blur dark:bg-[rgba(38,38,38,0.96)]"
            />
          )}
          <div className={cn('flex w-full flex-col px-1.5', open && 'pb-1.5')}>
            {open && (
              <div ref={eyebrowRef} data-eyebrow-row className="absolute bottom-full left-0 right-0 flex flex-col">
                <div className="relative flex min-w-0 flex-col px-1.5">{band}</div>
              </div>
            )}
            <div
              className={cn(
                'relative flex min-h-16 w-full cursor-text flex-col rounded-[20px] border border-border bg-card p-3',
                className,
              )}
            >
              {children}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export function BandItem({ children }: { children: ReactNode }) {
  return <div data-band-item className="flex min-w-0 flex-col py-1.5 empty:hidden">{children}</div>
}
