import * as React from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import { cva, type VariantProps } from 'class-variance-authority'
import { Check, ChevronDown } from 'lucide-react'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:pointer-events-none disabled:opacity-50 cursor-pointer',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        outline: 'border border-border bg-card hover:bg-muted',
        ghost: 'hover:bg-muted',
        destructive: 'bg-red-600 text-white hover:bg-red-700',
      },
      size: {
        default: 'h-9 px-4',
        sm: 'h-8 px-3 text-xs',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

export function Button({ className, variant, size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />
}

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-xl border border-border bg-card shadow-sm', className)} {...props} />
}

export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', className)} {...props} />
}

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn('flex h-9 w-full rounded-lg border border-border bg-card px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 placeholder:text-muted-foreground', className)}
      {...props}
    />
  )
}

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn('flex w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 placeholder:text-muted-foreground resize-none', className)}
      {...props}
    />
  )
}

export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn('flex h-9 rounded-lg border border-border bg-card px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50', className)}
      {...props}
    />
  )
}

/** Official Devin combobox (measured live on app.devin.ai): trigger h-28
 *  pl-8 pr-6 text-13 transparent + hover:tint-tertiary border-secondary;
 *  content-sized width; popup = bg-elevated 94% + backdrop-blur-8 + 1px
 *  outline + rounded-10 + L3 shadow anchored trigger.left/bottom+4 min-w-200;
 *  options 30px px-8 py-6 text-13 rounded-6, highlight→tint-secondary,
 *  selected→16px check. Keyboard: arrows/Enter/Esc/Tab; outside-click closes. */
export function Combo({ value, options, onPick, className, disabled }: {
  value: string
  options: { v: string; l: string }[]
  onPick: (v: string) => void
  className?: string
  disabled?: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const [hi, setHi] = React.useState(0)
  const btnRef = React.useRef<HTMLButtonElement>(null)
  const popRef = React.useRef<HTMLDivElement>(null)
  const cur = options.findIndex((o) => o.v === value)

  React.useEffect(() => {
    if (!open) return
    setHi(cur < 0 ? 0 : cur)
    const onDown = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node) && !btnRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const r = open && btnRef.current ? btnRef.current.getBoundingClientRect() : null
  const estH = options.length * 30 + 8
  const pw = r ? Math.max(200, r.width) : 200
  const pl = r ? Math.min(r.left, window.innerWidth - pw - 8) : 0
  let pt = r ? r.bottom + 4 : 0
  if (r && pt + estH > window.innerHeight - 8 && r.top - 4 - estH > 8) pt = r.top - 4 - estH

  const pick = (v: string) => { onPick(v); setOpen(false); btnRef.current?.focus() }
  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true) }
      return
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, options.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)) }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(options[hi].v) }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false) }
    else if (e.key === 'Tab') setOpen(false)
  }

  return (
    <div className={cn('relative', className)}>
      <button
        ref={btnRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKey}
        className="flex h-[28px] w-full min-w-[68px] cursor-pointer items-center gap-1 rounded-[6px] border border-border bg-transparent pl-[8px] pr-[6px] text-[13px] leading-[18px] text-foreground outline-none hover:bg-tint-tertiary disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="min-w-0 flex-1 truncate text-left">{options[cur]?.l ?? ''}</span>
        <ChevronDown size={16} aria-hidden className="shrink-0 text-muted-foreground" />
      </button>
      {open && r && createPortal(
        <div
          ref={popRef}
          onKeyDown={onKey}
          className="fixed z-[100] overflow-hidden rounded-[10px] bg-card/95 shadow-lg ring-1 ring-border backdrop-blur-[8px]"
          style={{ left: pl, top: pt, width: pw, maxHeight: 'min(400px, 80vh)' }}
        >
          <div role="listbox" tabIndex={-1} className="p-1 outline-none">
            {options.map((o, i) => (
              <div
                key={o.v}
                role="option"
                aria-selected={o.v === value}
                onMouseEnter={() => setHi(i)}
                onClick={() => pick(o.v)}
                className={`flex cursor-pointer select-none items-center justify-between gap-[8px] rounded-[6px] px-[8px] py-[6px] text-[13px] leading-[18px] text-foreground outline-none ${i === hi ? 'bg-tint-secondary' : ''}`}
              >
                <span className="min-w-0 flex-1 truncate">{o.l}</span>
                {o.v === value && <Check size={16} className="shrink-0 text-foreground" />}
              </div>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

export function Dialog({ open, onClose, children, title }: { open: boolean; onClose: () => void; children: React.ReactNode; title: string }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4" onClick={onClose}>
      <div
        className="w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl bg-card p-5 shadow-xl max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold mb-4">{title}</h2>
        {children}
      </div>
    </div>
  )
}

export function StatusDot({ status, className }: { status: string; className?: string }) {
  if (status === 'working') {
    return (
      <span className={cn('relative inline-flex h-3 w-3', className)} title="工作中">
        <span className="absolute inline-flex h-full w-full rounded-full border-2 border-emerald-500 border-t-transparent animate-spin-slow" />
        <span className="absolute inset-[3px] rounded-full bg-emerald-500/80" />
      </span>
    )
  }
  const color =
    status === 'waiting' ? 'bg-amber-400'
    : status === 'finished' ? 'bg-slate-400'
    : status === 'sleeping' ? 'bg-sky-400'
    : status === 'expired' ? 'bg-slate-300'
    : 'bg-slate-300'
  const label =
    status === 'waiting' ? '等待输入'
    : status === 'finished' ? '已结束'
    : status === 'sleeping' ? '休眠'
    : status === 'expired' ? '已过期'
    : '未知'
  return <span className={cn('inline-flex h-3 w-3 rounded-full', color, className)} title={label} />
}

export function statusLabel(status: string): string {
  return status === 'working' ? '工作中'
    : status === 'waiting' ? '等待输入'
    : status === 'finished' ? '已结束'
    : status === 'sleeping' ? '休眠中'
    : status === 'expired' ? '已过期'
    : '未知'
}
