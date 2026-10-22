import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import i18n from '@/i18n'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function timeAgo(iso: string): string {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return i18n.t('lib.justNow')
  if (m < 60) return i18n.t('lib.minAgo', { m })
  const h = Math.floor(m / 60)
  if (h < 24) return i18n.t('lib.hourAgo', { h })
  return i18n.t('lib.dayAgo', { d: Math.floor(h / 24) })
}

export function fmtTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString(i18n.language === 'zh' ? 'zh-CN' : 'en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** Subagent profile ids (subagent_explore / agent-general / bg…) → readable labels. */
export function subProfileLabel(profile: string): string {
  if (!profile) return ''
  const key = `lib.prof.${profile.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`
  const tr = i18n.t(key)
  if (tr !== key) return tr
  return profile.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
