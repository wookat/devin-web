/**
 * Official Devin console URLs that may appear in message bodies, comments or
 * structured payloads, parsed into the few destinations the mirror can host.
 * Shared by the Worker (visitor projection) and the client (admin routing).
 */
export type OfficialLink =
  | { kind: 'session'; id: string }
  | { kind: 'review'; owner: string; repo: string; number: string }
  | { kind: 'attachment' }
  | { kind: 'docs' }
  | { kind: 'other' }

const SESSION_RE = /^\/(?:sessions|desktop\/session)\/(?:devin-)?([0-9a-f]{32})\/?$/
const REVIEW_RE = /^\/review\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?$/

export function parseOfficialLink(url: string): OfficialLink | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const h = u.hostname
  if (h !== 'devin.ai' && !h.endsWith('.devin.ai')) return null
  if (h === 'docs.devin.ai') return { kind: 'docs' }
  if (h === 'app.devin.ai') {
    if (u.pathname.startsWith('/attachments/')) return { kind: 'attachment' }
    const s = SESSION_RE.exec(u.pathname)
    if (s) return { kind: 'session', id: s[1] }
    const r = REVIEW_RE.exec(u.pathname)
    if (r) return { kind: 'review', owner: r[1], repo: r[2], number: r[3] }
  }
  return { kind: 'other' }
}

/** Same-origin admin route for an official link; `null` when the mirror has no equivalent. */
export function adminMirrorPath(link: OfficialLink): string | null {
  switch (link.kind) {
    case 'session':
      return `/admin/d/${link.id}`
    case 'review':
      return `/admin/review/${link.owner}/${link.repo}/pull/${link.number}`
    default:
      return null
  }
}

/** Public GitHub URL for a Devin Review link (what visitors get instead of the review console). */
export function reviewToGithub(link: Extract<OfficialLink, { kind: 'review' }>): string {
  return `https://github.com/${link.owner}/${link.repo}/pull/${link.number}`
}

// Placeholder hrefs the Worker substitutes for official console links in
// visitor-facing text; the client renders them as inert labels.
export const VISITOR_SESSION_HREF = '#devin-session'
export const VISITOR_OFFICIAL_HREF = '#devin-official'

// Official URLs are ASCII-only, so stop at CJK/fullwidth punctuation too.
const OFFICIAL_URL_RE = /https?:\/\/(?:[\w-]+\.)*devin\.ai\/[^\s)"'\]<>`\u0080-\uffff]*/g
const BARE_URL_RE = /(^|[^\](<"'`])(https?:\/\/(?:[\w-]+\.)*devin\.ai\/[^\s)"'\]<>`\u0080-\uffff]*)(?=[\u0080-\uffff])/g
const TRAILING_PUNCT_RE = /[*.,;:!?]+$/

/**
 * GFM autolinks swallow CJK/fullwidth punctuation glued to a bare URL; wrap
 * such official URLs in `<…>` so the link ends where the URL does.
 */
export function delimitOfficialLinks(text: string): string {
  if (!text.includes('devin.ai')) return text
  return text.replace(BARE_URL_RE, (_m, pre: string, url: string) => {
    const tail = TRAILING_PUNCT_RE.exec(url)?.[0] ?? ''
    const u = url.slice(0, url.length - tail.length)
    return `${pre}<${u}>${tail}`
  })
}

/**
 * Rewrites official console links in visitor-facing Markdown: review links
 * become the public GitHub PR, session/desktop/other console links become
 * inert placeholders (bare URLs get a label so no raw host survives). Docs and
 * attachment links are left for their own handling.
 */
export function mirrorOfficialLinksForVisitor(text: string): string {
  if (!text.includes('devin.ai')) return text
  const sub = (url: string): string | null => {
    const link = parseOfficialLink(url)
    if (!link || link.kind === 'attachment' || link.kind === 'docs') return null
    if (link.kind === 'review') return reviewToGithub(link)
    return link.kind === 'session' ? VISITOR_SESSION_HREF : VISITOR_OFFICIAL_HREF
  }
  // Markdown link targets `](url)` keep their label; bare URLs get one.
  let out = text.replace(/\]\((https?:\/\/(?:[\w-]+\.)*devin\.ai\/[^\s)\u0080-\uffff]*)\)/g, (m, url: string) => {
    const r = sub(url)
    return r === null ? m : `](${r})`
  })
  // Inside code spans a Markdown link would show literally; use the bare label.
  out = out.replace(/`(https?:\/\/(?:[\w-]+\.)*devin\.ai\/[^\s`]*)`/g, (m, url: string) => {
    const r = sub(url)
    if (r === null) return m
    return r.startsWith('#') ? `\`${r === VISITOR_SESSION_HREF ? 'Devin 会话' : 'Devin 控制台'}\`` : `\`${r}\``
  })
  out = out.replace(OFFICIAL_URL_RE, (raw) => {
    const tail = TRAILING_PUNCT_RE.exec(raw)?.[0] ?? ''
    const url = raw.slice(0, raw.length - tail.length)
    const r = sub(url)
    if (r === null) return raw
    if (r.startsWith('#')) return `[${r === VISITOR_SESSION_HREF ? 'Devin 会话' : 'Devin 控制台'}](${r})${tail}`
    return r + tail
  })
  return out
}
