import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

// Official composer shell, decoded from the deob'd app bundle (lib-hdcpZ3gz / composer-toolbar):
//   column px-6(X=6) · pt=mr pb=hr where mr=max(0,min(6,beardExt)-min(6,eyebrowExt)),
//   hr=mirror · wax sheet absolute inset-0 + top:-eyebrowExtent (beard is IN-FLOW so
//   it sits inside the wax) · card rounded-20 p-3 bg-elevated border-border-primary,
//   open → border-transparent + shadow-L2 + (light: bg-elevated / dark: elevated-transparent
//   = white/5) · eyebrow hangs absolute bottom-full px-1.5 items py-1.5 · beard items
//   flex-nowrap items-center gap-1 px-1 pt-2.5 pb-2.5 (chrome inset).
export default function BeardBand({ band, chin, children, className, wrapClassName, cardRef, bareCard }: {
  band?: ReactNode
  chin?: ReactNode
  children: ReactNode
  className?: string
  /** Outer column width class — default is the official 740 composer column
   *  (sessions and the draft page share it). */
  wrapClassName?: string

  cardRef?: React.Ref<HTMLDivElement>
  /** Drop the inner card chrome entirely — the draft page keeps only two
   *  layers (wax + its own inner surface), not the official three. */
  bareCard?: boolean
}) {
  const openTop = !!band
  const openBot = !!chin
  const open = openTop || openBot
  const eyebrowRef = useRef<HTMLDivElement | null>(null)
  const chinRef = useRef<HTMLDivElement | null>(null)
  const [bandH, setBandH] = useState(0)
  const [chinH, setChinH] = useState(0)

  useEffect(() => {
    const el = eyebrowRef.current
    if (!openTop || !el) {
      setBandH(0)
      return
    }
    const ro = new ResizeObserver(() => {
      setBandH(el.getBoundingClientRect().height)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [openTop])

  useEffect(() => {
    const el = chinRef.current
    if (!openBot || !el) {
      setChinH(0)
      return
    }
    const ro = new ResizeObserver(() => setChinH(el.getBoundingClientRect().height))
    ro.observe(el)
    return () => ro.disconnect()
  }, [openBot])

  // Official steady-state radii (ramp vars lerp to these endpoints):
  // eyebrow open → top 22 / bottom 26; beard open → top 26 / bottom 22; both → 22; closed 20.
  const radius = openTop && openBot ? 'rounded-[22px]' : openTop ? 'rounded-[22px_22px_26px_26px]' : openBot ? 'rounded-[26px_26px_22px_22px]' : 'rounded-[20px]'
  // mr/hr — padding only on the side OPPOSITE the open band (6px cap).
  const padTop = Math.max(0, Math.min(6, chinH) - Math.min(6, bandH))
  const padBottom = Math.max(0, Math.min(6, bandH) - Math.min(6, chinH))

  return (
    <div className={cn('relative z-30 mx-auto mt-auto w-full', wrapClassName ?? 'max-w-[740px]')}>
      {/* mx-2 + px-1.5 below are the official chrome insets — they only make
       *  sense while the wrap sits at max-width (the 740 column gives the
       *  card its ~10px/side overhang over the 692 message column). Once the
       *  chat pane narrows past ~800px the wrap clamps and the fixed chrome
       *  just becomes dead space: gated off via the chat-pane container
       *  query. Draft page isn't inside a chat-pane container, so it always
       *  renders chromeless (its wrap px-6 aligns the card with the cards
       *  below). */}
      <div className="mb-2 flex flex-col @[800px]/chat-pane:mx-2">
        <div
          data-beard-open={open}
          data-eyebrow-visible={openTop}
          className={cn('group/beard-band relative flex w-full flex-col', radius)}
        >
          {open && (
            <div
              aria-hidden
              style={{ top: -bandH }}
              className={cn(
                'pointer-events-none absolute inset-0 rounded-[inherit]',
                // Official rule: with the eyebrow hidden, light theme flattens to
                // tint-tertiary and drops the blur; dark keeps the wax either way.
                openTop
                  ? 'bg-elevated-wax backdrop-blur'
                  : 'bg-tint-tertiary dark:bg-elevated-wax dark:backdrop-blur',
              )}
            />
          )}
          {/* px-1.5 = the inner card's inset inside the wax frame: always on
           *  while a band/chin is open (the gray frame must visibly wrap the
           *  card); when closed and the pane is narrow there is no frame, so
           *  the card takes the full column instead of leaving dead space. */}
          <div className={cn('flex w-full flex-col', open ? 'px-1.5' : '@[800px]/chat-pane:px-1.5')} style={{ paddingTop: padTop, paddingBottom: padBottom }}>
            {openTop && (
              <div ref={eyebrowRef} data-eyebrow-row className="absolute bottom-full left-0 right-0 flex flex-col">
                <div className="relative flex min-w-0 flex-col px-1.5">{band}</div>
              </div>
            )}
            <div
              ref={cardRef}
              className={cn(
                'relative flex w-full cursor-text flex-col',
                bareCard
                  ? 'p-0'
                  : cn(
                      'overflow-hidden rounded-[20px] border p-3',
                      open
                        ? 'border-transparent bg-card shadow-shadow-L2 dark:bg-elevated-transparent'
                        : 'border-border bg-card',
                    ),
                className,
              )}
            >
              {children}
            </div>
            {openBot && (
              <div ref={chinRef} data-beard-row className="relative flex w-full flex-col">
                {chin}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export function BandItem({ children, slot = 'band' }: { children: ReactNode; slot?: 'band' | 'chin' }) {
  // Official: eyebrow items are `flex-col py-1.5`; beard items are
  // `flex-nowrap items-center gap-1 px-1 pt-2.5 pb-2.5` (chrome inset).
  return (
    <div
      data-band-item
      className={
        slot === 'chin'
          ? 'relative flex min-w-0 flex-nowrap items-center gap-1 px-1 pb-2.5 pt-2.5 empty:hidden'
          : 'flex min-w-0 flex-col py-1.5 empty:hidden'
      }
    >
      {children}
    </div>
  )
}
