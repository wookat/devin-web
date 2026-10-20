export type Theme = 'light' | 'dark' | 'system'

const KEY = 'dw-theme'

export function getTheme(): Theme {
  const v = localStorage.getItem(KEY)
  return v === 'light' || v === 'dark' ? v : 'system'
}

function resolve(theme: Theme): boolean {
  return theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
}

export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', resolve(theme))
}

export function setTheme(theme: Theme) {
  localStorage.setItem(KEY, theme)
  applyTheme(theme)
}

/** Apply the stored theme and keep it in sync with the OS setting. */
export function initTheme() {
  applyTheme(getTheme())
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getTheme() === 'system') applyTheme('system')
  })
}
