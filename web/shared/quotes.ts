/**
 * Official `<quoted_artifact …>` blocks embedded in user-message text (the
 * composer serialises a quote as `gn`; the transcript renders it as a "quote"
 * attachment pill and never as text). Shared by the Worker (visitor
 * projection) and the frontend (admin timeline).
 */

export interface QuoteAttachment {
  /** Artifact kind: message | markdown | worklog | shell | preview | file | … */
  kind: string
  /** Official `pn` label ("Devin message", "Plan", basename of a file …). */
  label: string
  caption?: string
  /** Quoted text, whitespace-collapsed. */
  text: string
  /** Quoted transcript event (message `event_id` / worklog `start_event_id`); admin-only link target. */
  eventId?: string
  /** Quoted message timestamp (official `artifact.timestampMs`, the `?ts=` deep-link value); admin-only. */
  tsMs?: number
  /** Quoted file path (file / diff kinds); admin-only link target. */
  path?: string
  /** Official `quote.screenshot` (preview-element capture) shown as a 36px thumbnail in the pill. */
  screenshot?: QuoteScreenshot
}

/** Per-quote metadata recovered from `rich_content[].meta.quote` (index-aligned with the markup blocks). */
export interface QuoteMeta {
  screenshot?: QuoteScreenshot
  tsMs?: number
}

export interface QuoteScreenshot {
  url: string
  filename?: string
}

/** Filename the official composer gives a quoted preview element's capture (`rL(e.screenshot, 'preview-element.png')`). */
export const QUOTE_SCREENSHOT_NAME = 'preview-element.png'

const QUOTE_RE = /<quoted_artifact\s([^>]*)>([\s\S]*?)<\/quoted_artifact>/g
const CAPTION_RE = /<caption>([\s\S]*?)<\/caption>/
const CONTENT_RE = /<content>\n?([\s\S]*?)\n?<\/content>/
const ATTR_RE = /([\w-]+)="([^"]*)"/g

function unescapeHtml(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

const EVENT_CONTEXT_LABELS: Record<string, string> = {
  'slack:message': 'Slack Message',
  'slack:reaction_added': 'Slack Reaction Added',
  'linear:create': 'Linear Issue Created',
  'linear:label_added': 'Linear Label Added',
  'linear:assigned': 'Linear Assigned',
  'linear:status_changed': 'Linear Status Changed',
  'linear:priority_changed': 'Linear Priority Changed',
  'linear:moved': 'Linear Issue Moved',
  'github:issue_comment': 'GitHub Issue Comment',
  'github:issues': 'GitHub Issue',
  'github:pull_request': 'GitHub Pull Request',
  'github:pull_request_review': 'GitHub PR Review',
  'github:pull_request_review_comment': 'GitHub PR Review Comment',
  'github:check_run': 'GitHub Check Run',
  'github:push': 'GitHub Push',
  'pylon:issue_created': 'Pylon Issue Created',
  'pylon:issue_tag_added': 'Pylon Tag Added',
  'pylon:issue_status_changed': 'Pylon Status Changed',
  'schedule:recurring': 'Scheduled',
  'webhook:incoming': 'Webhook',
  'snapshot_build:completed': 'Snapshot Build Completed',
}

/** Official `pn`: the small grey label of a quote pill. */
export function quoteLabel(kind: string, attrs: Record<string, string>): string {
  switch (kind) {
    case 'markdown': return attrs.title || 'Plan'
    case 'worklog': return 'Worklog'
    case 'message': return attrs.author === 'devin' ? 'Devin message' : 'User message'
    case 'sidechain_message': return 'Side chat message'
    case 'shell': return `Shell (${attrs.shell_id ?? ''})`
    case 'preview': return attrs.component || attrs.selector || 'Preview'
    case 'pr_description': return 'PR description'
    case 'pr_comment': return 'Review comment'
    case 'event_context': return EVENT_CONTEXT_LABELS[attrs.event_type ?? ''] ?? attrs.event_type ?? 'Event'
    default: {
      const path = attrs.path ?? ''
      return path.split('/').pop() || path || kind
    }
  }
}

/** Parse quote pills out of a message and return the remaining visible text. */
export function extractQuotes(text: string): { quotes: QuoteAttachment[]; text: string } {
  const quotes: QuoteAttachment[] = []
  const rest = text.replace(QUOTE_RE, (_m, attrText: string, inner: string) => {
    const attrs: Record<string, string> = {}
    for (const a of attrText.matchAll(ATTR_RE)) attrs[a[1]] = unescapeHtml(a[2])
    const kind = attrs.kind || 'message'
    const caption = unescapeHtml(CAPTION_RE.exec(inner)?.[1] ?? '').trim() || undefined
    const body = unescapeHtml(CONTENT_RE.exec(inner)?.[1] ?? '').replace(/\s+/g, ' ').trim()
    const q: QuoteAttachment = { kind, label: quoteLabel(kind, attrs), text: body }
    if (caption) q.caption = caption
    const eventId = attrs.event_id || attrs.start_event_id
    if (eventId) q.eventId = eventId
    if (attrs.path) q.path = attrs.path
    quotes.push(q)
    return ''
  })
  return { quotes, text: rest.replace(/\n{3,}/g, '\n\n').trim() }
}

/** `rich_content[].meta.quote` node as the official events API delivers it (only the fields read here). */
export interface RichContentNode {
  type?: string | null
  text?: string
  meta?: {
    quote?: {
      text?: unknown
      screenshot?: { url?: unknown; filename?: unknown } | null
      artifact?: { kind?: unknown; timestampMs?: unknown } | null
    } | null
  } | null
}

/**
 * Official dataLoader: a quote's screenshot and source artifact live on the
 * message's `rich_content` node (`meta.quote`), not in the `<quoted_artifact>`
 * markup. Quote nodes appear in the same order as the markup blocks, so pair by
 * position. Only `screenshot.url/filename` and the message `timestampMs` (the
 * official `?ts=` link target) are read; any other quote metadata stays behind.
 */
export function richContentQuoteMeta(rich: RichContentNode[] | undefined): (QuoteMeta | null)[] {
  const out: (QuoteMeta | null)[] = []
  for (const n of rich ?? []) {
    const q = n?.meta?.quote
    if (!q) continue
    const m: QuoteMeta = {}
    const url = q.screenshot?.url
    const filename = q.screenshot?.filename
    if (typeof url === 'string' && /^https:\/\//.test(url)) {
      m.screenshot = { url, ...(typeof filename === 'string' && filename ? { filename } : {}) }
    }
    const ts = q.artifact?.timestampMs
    if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) m.tsMs = ts
    out.push(m.screenshot || m.tsMs ? m : null)
  }
  return out
}

/**
 * Attach rich-content metadata (screenshot, source timestamp) to quotes and drop
 * the duplicate image attachment the composer uploads alongside (official
 * `Or`/`Dr` dedupe: attachments whose url is a quote screenshot are not rendered
 * again). `meta` is index-aligned with `quotes` (from `richContentQuoteMeta`);
 * when absent, falls back to the composer's own convention — each `preview`
 * quote takes the next attachment named `preview-element.png` in order.
 */
export function foldQuoteScreenshots<A extends { url: string; name: string }>(
  quotes: QuoteAttachment[],
  attachments: A[],
  meta?: (QuoteMeta | null)[],
): A[] {
  if (quotes.length === 0) return attachments
  const used = new Set<string>()
  if (meta && meta.length) {
    quotes.forEach((q, i) => {
      const m = meta[i]
      if (!m) return
      if (m.screenshot) { q.screenshot = m.screenshot; used.add(m.screenshot.url) }
      if (m.tsMs) q.tsMs = m.tsMs
    })
  } else {
    const pool = attachments.filter((a) => a.name === QUOTE_SCREENSHOT_NAME)
    for (const q of quotes) {
      if (q.kind !== 'preview' || q.screenshot) continue
      const a = pool.shift()
      if (!a) break
      q.screenshot = { url: a.url, filename: a.name }
      used.add(a.url)
    }
  }
  return used.size ? attachments.filter((a) => !used.has(a.url)) : attachments
}

/** Official `Nn`: one-line preview of a message whose text may be only quotes. */
export function quotePreviewFallback(quotes: QuoteAttachment[]): string {
  if (quotes.length === 0) return ''
  return quotes.find((q) => q.caption)?.caption ?? 'Quoted content'
}
