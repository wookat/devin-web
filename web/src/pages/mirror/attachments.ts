import { type TimelineItem } from '@/components/Timeline'
import { stripRefTags } from '@/components/Markdown'
import { stripRepoHints } from '@/lib/repos'
import { extractQuotes, foldQuoteScreenshots, quotePreviewFallback, type QuoteAttachment, type QuoteMeta } from '../../../shared/quotes'

// Staged-upload ids are always `{uuid}-{sanitized-name}` — require that shape
// so prose mentions (`/api/uploads/`, `/api/uploads/*`, `<id>` placeholders)
// don't degrade into bogus file chips with the tail stripped mid-sentence.
// Backticks are excluded throughout so inline-code mentions aren't eaten.
const ATTACH_URL_RE = /(?:https?:\/\/[^\s)"'\]`]*(?:attachments|devin-uploads|amazonaws\.com)[^\s)"'\]`]*|\/api\/share\/[^\s)"'\]\/`]+\/(?:file\/[^\s)"'\]`]+|attachment\?url=[^\s)"'\]`&]+)|\/api\/uploads\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}-[\w.%\-]+)/gi

function attachmentName(url: string): string {
  try {
    const u = new URL(url, location.origin)
    const inner = u.pathname.endsWith('/attachment') ? u.searchParams.get('url') : null
    const path = inner ? new URL(inner).pathname : u.pathname
    return decodeURIComponent(path.split('/').filter(Boolean).pop() || '') || 'file'
  } catch { return 'file' }
}

/** The Worker marks events authored by the configured upstream viewer. Those
 *  messages use the official right-aligned treatment; every other participant,
 *  including Devin Bot, keeps the participant header. */
function isOwnUserMessage(it: TimelineItem): boolean {
  return it.role === 'user' && it.own === true
}

const AVATAR_HUES = ['bg-rose-500', 'bg-orange-500', 'bg-emerald-500', 'bg-sky-500', 'bg-violet-500', 'bg-pink-500', 'bg-teal-500', 'bg-amber-500']


function splitAttachments(body: string, quoteMeta?: (QuoteMeta | null)[], preQuotes?: QuoteAttachment[]): { text: string; attachments: { url: string; name: string }[]; quotes: QuoteAttachment[] } {
  let attachments: { url: string; name: string }[] = []
  const seen = new Set<string>()
  // Visitor items arrive with quotes already parsed (and their markup stripped) by the Worker.
  const { quotes, text: unquoted } = preQuotes ? { quotes: preQuotes, text: body } : extractQuotes(body)
  for (const m of unquoted.matchAll(ATTACH_URL_RE)) {
    const url = m[0]
    if (seen.has(url)) continue
    seen.add(url)
    attachments.push({ url, name: attachmentName(url) })
  }
  if (preQuotes) {
    const shots = new Set(preQuotes.map((q) => q.screenshot?.url).filter((u): u is string => !!u))
    attachments = shots.size ? attachments.filter((a) => !shots.has(a.url)) : attachments
  } else {
    attachments = foldQuoteScreenshots(quotes, attachments, quoteMeta)
  }
  let text = stripRepoHints(unquoted).replace(/ATTACHMENT:\s*(\{[^}]*\}|"[^"]*")/g, '').replace(ATTACH_URL_RE, '')
  text = text.replace(/!?\[([^\]]*)\]\(\s*\)/g, '$1').trim()
  return { text, attachments, quotes }
}

/** Official `Nn`: message-index line — text without quote markup, else the first caption / "Quoted content". */
function indexPreview(body: string): string {
  const { quotes, text } = extractQuotes(body)
  const line = stripRefTags(text).trim().split('\n')[0].slice(0, 80)
  return line || quotePreviewFallback(quotes) || '(附件)'
}

/** Renders an attachment inline as its own panel tab, like the official file tabs. */

export { ATTACH_URL_RE, attachmentName, isOwnUserMessage, AVATAR_HUES, splitAttachments, indexPreview };
