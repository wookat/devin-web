import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { PublicMessage } from '@/lib/api'
import Markdown from './Markdown'
import AttachmentCard from './AttachmentCard'
import { fmtTime, cn } from '@/lib/utils'

const ROLE_KEYS: Record<string, string> = { devin: 'Devin', admin: 'cv.admin', visitor: 'cv.visitor', user: 'cv.user' }

export default function ChatView({
  messages, attachmentUrl, showRoleLabels,
}: {
  messages: PublicMessage[]
  attachmentUrl: (url: string) => string
  showRoleLabels?: boolean
}) {
  const { t } = useTranslation()
  const bottomRef = useRef<HTMLDivElement>(null)
  const countRef = useRef(0)
  useEffect(() => {
    if (messages.length !== countRef.current) {
      countRef.current = messages.length
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages.length])

  return (
    <div className="space-y-4">
      {messages.length === 0 && (
        <div className="text-center text-sm text-muted-foreground py-12">{t('cv.noMsgs')}</div>
      )}
      {messages.map((m) => {
        const isDevin = m.role === 'devin'
        return (
          <div key={m.id} className={cn('flex', isDevin ? 'justify-start' : 'justify-end')}>
            <div className={cn('max-w-[92%] sm:max-w-[80%]')}>
              <div className={cn('text-[11px] text-muted-foreground mb-0.5 flex gap-2', isDevin ? '' : 'justify-end')}>
                <span>{showRoleLabels ? (ROLE_KEYS[m.role] ? t(ROLE_KEYS[m.role]) : m.role) : (isDevin ? 'Devin' : t('cv.me'))}</span>
                <span>{fmtTime(m.timestamp)}</span>
              </div>
              <div className={cn(
                'rounded-2xl px-3.5 py-2.5',
                isDevin ? 'bg-card border border-border rounded-tl-sm' : 'bg-primary/10 rounded-tr-sm',
              )}>
                {m.message && <Markdown text={m.message} rewriteUrl={attachmentUrl} />}
                {m.attachments.length > 0 && (
                  <div className={cn('space-y-2', m.message && 'mt-2')}>
                    {m.attachments.map((a) => (
                      <AttachmentCard key={a.url} name={a.name} href={attachmentUrl(a.url)} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )
      })}
      <div ref={bottomRef} />
    </div>
  )
}
