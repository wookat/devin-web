import { adminFetch } from './api'

/** Display-language name the backend understands ("Chinese"/"English") —
 *  same choice VoiceButton exposes for its own UI. */
export function preferredLang(): string {
  return navigator.language?.toLowerCase().startsWith('zh') ? 'Chinese' : 'English'
}

/** One call path for message-toolbar and selection-pill translate. */
export async function translateText(text: string, target = preferredLang()): Promise<string> {
  const r = await adminFetch<{ result: string | null; error: string | null }>('/api/admin/mirror/translate', {
    method: 'POST',
    body: JSON.stringify({ text, target }),
  })
  if (r.result) return r.result
  throw new Error(r.error || 'translate failed')
}
