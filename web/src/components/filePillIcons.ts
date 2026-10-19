// Seti-style file-type icons for composer file pills / attachment menus, using the
// full icon set generated verbatim from the official app bundle.
// The ~150KB icon table is loaded as its own chunk right after the page mounts; until it
// lands (a few ms) lookups fall back to the default white doc glyph.
// Lookup order: exact basename -> longest extension suffix -> default white doc glyph.
type SetiModule = typeof import('./setiIcons.generated')

const DEFAULT_SVG = '<svg viewBox="0 0 1200 1000"><path d="M394.1 537.8h411.7v54.7H394.1v-54.7zm0-130.3H624v54.7H394.1v-54.7zm0-130.3h411.7v54.7H394.1v-54.7zm0 390.9H700v54.7H394.1v-54.7z"/></svg>'
const DEFAULT_FILL = '#d4d7d6'

let seti: SetiModule | null = null
void import('./setiIcons.generated').then((m) => { seti = m }).catch(() => null)

export function filePillSvg(path: string): string {
  const base = path.split('/').pop() || ''
  let svg = DEFAULT_SVG
  let fill = DEFAULT_FILL
  if (seti) {
    const { SETI_COLORS, SETI_EXT, SETI_FILENAMES, SETI_SVGS } = seti
    let hit = SETI_FILENAMES[base]
    if (!hit) {
      const lower = base.toLowerCase()
      let bestKey = ''
      for (const k of Object.keys(SETI_EXT)) {
        if (lower.endsWith(k) && k.length > bestKey.length) bestKey = k
      }
      if (bestKey) hit = SETI_EXT[bestKey]
    }
    const [icon, color] = hit || ['default', 'white']
    svg = SETI_SVGS[icon] || SETI_SVGS.default
    fill = SETI_COLORS[color] || SETI_COLORS.white
  }
  return svg.replace(
    '<svg ',
    `<svg width="14" height="14" class="self-center shrink-0" aria-hidden="true" fill="${fill}" `,
  )
}
