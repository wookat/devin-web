// One-time rename of every wb*-prefixed localStorage key to its dw* name —
// must run before i18n/theme init read their keys, so it is imported FIRST
// in main.tsx. `wb2-x` → `dw-x`; `wb-*` → `dw-*`; `wb_*` → `dw_*`.
try {
  const moves: [string, string][] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (!k) continue
    const nk = k.replace(/^wb2-/, 'dw-').replace(/^wb-/, 'dw-').replace(/^wb_/, 'dw_')
    if (nk !== k) moves.push([k, nk])
  }
  for (const [from, to] of moves) {
    const v = localStorage.getItem(from)
    if (v !== null && localStorage.getItem(to) === null) localStorage.setItem(to, v)
    localStorage.removeItem(from)
  }
} catch { /* storage unavailable */ }
