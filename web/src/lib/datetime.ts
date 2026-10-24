import i18n from '@/i18n'

/** BCP-47 tag matching the active UI language ('zh' → zh-CN, else en-US). */
export const dateLoc = (): string => (i18n.language?.startsWith('zh') ? 'zh-CN' : 'en-US')

const rtf = () => new Intl.RelativeTimeFormat(i18n.language?.startsWith('zh') ? 'zh' : 'en', { numeric: 'auto' })

/** Localized relative label for a past timestamp (e.g. '5 minutes ago'). */
export function relAgo(then: number): string {
  const ms = Date.now() - then
  if (!Number.isFinite(ms) || ms < 0) return ''
  const m = Math.floor(ms / 60000)
  if (m < 1) return rtf().format(0, 'minute')
  if (m < 60) return rtf().format(-m, 'minute')
  const h = Math.floor(m / 60)
  if (h < 24) return rtf().format(-h, 'hour')
  const d = Math.floor(h / 24)
  if (d < 30) return rtf().format(-d, 'day')
  return rtf().format(-Math.floor(d / 30), 'month')
}
