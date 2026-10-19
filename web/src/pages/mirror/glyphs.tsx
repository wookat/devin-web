import { cloneElement, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

// Official SVG glyph wrapper: renders a verbatim-extracted app.devin.ai icon.
function OfficialGlyph({ svg, className }: { svg: string; className?: string }) {
  return <span aria-hidden className={cn('inline-flex shrink-0 items-center justify-center [&_svg]:size-4', className)} dangerouslySetInnerHTML={{ __html: svg }} />
}

function SessionSettingsGlyph({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M3.75 10.25C2.7835 10.25 2 11.0335 2 12C2 12.9665 2.7835 13.75 3.75 13.75C4.7165 13.75 5.5 12.9665 5.5 12C5.5 11.0335 4.7165 10.25 3.75 10.25Z" fill="currentColor" />
      <path d="M12 10.25C11.0335 10.25 10.25 11.0335 10.25 12C10.25 12.9665 11.0335 13.75 12 13.75C12.9665 13.75 13.75 12.9665 13.75 12C13.75 11.0335 12.9665 10.25 12 10.25Z" fill="currentColor" />
      <path d="M20.25 10.25C19.2835 10.25 18.5 11.0335 18.5 12C18.5 12.9665 19.2835 13.75 20.25 13.75C21.2165 13.75 22 12.9665 22 12C22 11.0335 21.2165 10.25 20.25 10.25Z" fill="currentColor" />
    </svg>
  )
}

function AwaitingInstructionsGlyph({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M5.05 1.5h5.9L14.5 5.05v5.9L10.95 14.5h-5.9L1.5 10.95v-5.9L5.05 1.5Z" fill="currentColor" />
      <path d="M8 4.25v4.1M8 10.75v.1" stroke="white" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  )
}

function HeaderMenuPortal({ open, pos, onClose, children }: { open: boolean; pos: { left: number; top: number; width: number }; onClose: () => void; children: ReactElement }) {
  if (!open) return null
  // Always portaled: the <header> has overflow-hidden (44px tall), so an
  // absolute menu rendered inside it gets clipped — on every viewport size.
  const child = children as ReactElement<{ className?: string; style?: Record<string, string | number> }>
  const menu = cloneElement(child, {
    className: cn(child.props.className, 'fixed right-auto top-auto'),
    style: { left: pos.left, top: pos.top, width: pos.width },
  })
  return createPortal(
    <>
      <div className="fixed inset-0 z-10" onClick={onClose} />
      {menu}
    </>,
    document.body,
  )
}

// Official session-index glyph for API-origin user messages (sampled from app.devin.ai popup DOM)
function ApiOriginGlyph() {
  return (
    <svg aria-hidden width="9" height="9" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4.45605 1.11269C4.55981 1.05352 4.68722 1.05364 4.79102 1.11269L7.2627 2.52383C7.36778 2.584 7.43244 2.69571 7.43262 2.8168V3.60586C7.43262 4.32382 7.81792 4.98717 8.44141 5.34316L8.55469 5.40762C9.17212 5.76015 9.93011 5.75813 10.5459 5.40273L11.1709 5.04238C11.2754 4.98204 11.4043 4.98204 11.5088 5.04238L13.9482 6.45059C14.0527 6.51092 14.1172 6.62288 14.1172 6.74355V9.56094C14.117 9.68144 14.0526 9.79266 13.9482 9.85293L11.5088 11.2621C11.4044 11.3223 11.2753 11.3223 11.1709 11.2621L10.3232 10.7719C9.72949 10.4289 8.9977 10.4277 8.40234 10.768C7.80216 11.1111 7.43173 11.7494 7.43164 12.4408V13.1547C7.43164 13.276 7.36696 13.3884 7.26172 13.4486L4.79102 14.8588C4.6872 14.9181 4.5599 14.918 4.45605 14.8588L1.98535 13.4486C1.87995 13.3885 1.81445 13.2761 1.81445 13.1547V10.3412C1.81446 10.2198 1.87995 10.1074 1.98535 10.0473L4.45605 8.63711C4.55987 8.57798 4.68724 8.57787 4.79102 8.63711L6.20898 9.4457C6.29055 9.49224 6.37613 9.52815 6.46289 9.55898C6.69299 9.64758 6.94611 9.69766 7.21094 9.69766C8.13834 9.69755 8.89056 8.95246 8.89062 8.03359C8.89062 7.11462 8.14628 6.35586 7.21875 6.35586C6.93968 6.35586 6.69674 6.38713 6.48633 6.44277C6.45404 6.45071 6.4225 6.46121 6.39062 6.47109C6.36028 6.48071 6.33064 6.49063 6.30176 6.50137C6.2672 6.51425 6.23307 6.52811 6.19922 6.54336C6.17069 6.55604 6.14317 6.56956 6.11621 6.5834C6.09598 6.59389 6.07459 6.6023 6.05469 6.61367L4.79102 7.33633C4.6872 7.39541 4.55983 7.39553 4.45605 7.33633L1.98535 5.92519C1.88002 5.86506 1.8146 5.75349 1.81445 5.63223V2.8168C1.81463 2.69556 1.88004 2.58395 1.98535 2.52383L4.45605 1.11269Z" fill="currentColor" />
    </svg>
  )
}


export { OfficialGlyph, SessionSettingsGlyph, AwaitingInstructionsGlyph, HeaderMenuPortal, ApiOriginGlyph };
