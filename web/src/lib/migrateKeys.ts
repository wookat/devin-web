// One-time cleanup: purge pre-rename wb* localStorage keys. Imported FIRST
// in main.tsx (before i18n/theme init) so stale keys can't shadow dw* ones.
try {
  const dead: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k && /^wb(?=[-_2])/.test(k)) dead.push(k)
  }
  for (const k of dead) localStorage.removeItem(k)
} catch { /* storage unavailable */ }
