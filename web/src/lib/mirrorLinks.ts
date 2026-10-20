import { parseOfficialLink, adminMirrorPath, reviewToGithub, VISITOR_OFFICIAL_HREF, VISITOR_SESSION_HREF } from '../../shared/officialLinks'
import { isVisitor } from './viewer'
import i18n from '@/i18n'

export type MirrorHref =
  | { kind: 'internal'; to: string }
  | { kind: 'external'; href: string }
  | { kind: 'inert'; title: string }

/**
 * Where a user-visible link goes on the mirror. Official console URLs never
 * leave the page as-is: admins get the same-origin route (session / review),
 * visitors get the public GitHub PR or an inert label.
 */
export function mirrorHref(href: string | undefined): MirrorHref {
  if (!href) return { kind: 'inert', title: '' }
  if (href === VISITOR_SESSION_HREF) return { kind: 'inert', title: i18n.t('ml.otherSession') }
  if (href === VISITOR_OFFICIAL_HREF) return { kind: 'inert', title: i18n.t('ml.console') }
  const link = parseOfficialLink(href)
  if (!link || link.kind === 'attachment' || link.kind === 'docs') return { kind: 'external', href }
  if (isVisitor()) {
    return link.kind === 'review' ? { kind: 'external', href: reviewToGithub(link) } : { kind: 'inert', title: i18n.t('ml.console') }
  }
  const to = adminMirrorPath(link)
  return to ? { kind: 'internal', to } : { kind: 'inert', title: i18n.t('ml.pageMissing') }
}

/** Admin mirror route for an upstream `devin-<hex>` (or bare hex) session id. */
export function sessionMirrorPath(devinId: string): string {
  // sub:<root>:<aid> child sessions are already local — no resolve hop.
  if (devinId.startsWith('sub:')) return `/admin/${devinId}`
  return `/admin/d/${devinId.replace(/^devin-/, '')}`
}

/** Admin mirror route that opens a PR's review panel inside its session. */
export function reviewMirrorPath(repo: string, pullNumber: number | string): string {
  return `/admin/review/${repo}/pull/${pullNumber}`
}
