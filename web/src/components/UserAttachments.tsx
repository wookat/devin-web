import { useTranslation } from 'react-i18next'
import AttachmentCard from './AttachmentCard'
import QuoteChip from './QuoteChip'
import RepoChips from './RepoChips'
import SecretChip from './SecretChip'
import type { QuoteAttachment } from '../../shared/quotes'
import { cn } from '@/lib/utils'

export const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i
const VIDEO_RE = /\.(mp4|webm|mov|avi|mkv|m4v|ogv|ogg)$/i

export interface UserAttachment {
  name: string
  href: string
}

function kindOf(name: string): 'file' | 'video' | 'image' {
  if (IMAGE_RE.test(name)) return 'image'
  if (VIDEO_RE.test(name)) return 'video'
  return 'file'
}

/**
 * Official user-message attachment group: rendered as a sibling *below* the bubble
 * (not inside it), stacked with gap-1.5, right-aligned for the viewer's own messages
 * and left-aligned otherwise; `mt-0.5` only when a text bubble precedes it.
 * Items follow the official kind order quote → file → repos → secrets → video → image.
 */
export default function UserAttachments({
  attachments,
  repos = [],
  quotes = [],
  secrets = [],
  own,
  hasText,
  ts,
  onOpenTab,
  onQuoteNavigate,
}: {
  attachments: UserAttachment[]
  repos?: string[]
  quotes?: QuoteAttachment[]
  secrets?: string[]
  own: boolean
  hasText: boolean
  ts?: string
  onOpenTab?: (href: string, name: string, raw?: boolean) => void
  onQuoteNavigate?: (quote: QuoteAttachment) => void
}) {
  const { t } = useTranslation()
  if (attachments.length === 0 && repos.length === 0 && quotes.length === 0 && secrets.length === 0) return null
  const files = attachments.filter((a) => kindOf(a.name) === 'file')
  const videos = attachments.filter((a) => kindOf(a.name) === 'video')
  const images = attachments.filter((a) => kindOf(a.name) === 'image')
  const card = (a: UserAttachment) => (
    <AttachmentCard key={a.href} name={a.name} href={a.href} ts={ts} onOpenTab={onOpenTab} chip />
  )
  return (
    <div
      role="group"
      aria-label={t('att.attachments')}
      className={cn(
        'flex min-w-0 max-w-full flex-col gap-1.5',
        own ? 'ml-auto items-end' : 'ml-0 items-start',
        hasText && 'mt-0.5',
      )}
    >
      {quotes.map((q, i) => <QuoteChip key={`q-${i}`} quote={q} onNavigate={onQuoteNavigate} />)}
      {files.map(card)}
      {repos.length > 0 && <RepoChips repos={repos} />}
      {secrets.map((s, i) => <SecretChip key={`s-${i}`} name={s} />)}
      {videos.map(card)}
      {images.map(card)}
    </div>
  )
}
