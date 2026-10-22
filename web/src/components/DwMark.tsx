import i18n from '@/i18n'

// devin-web "turbine" mark — three sharp blades alternating inside a hexagon:
// three agents feeding one hub (the blades' shared apex). Silhouette-style,
// all hard angles — reads crisp at 16px. DwPersona spins the same blades.
const BLADES =
  "M8 8 L8 1.2 L13.89 4.6 Z " +   // top wedge
  "M8 8 L13.89 11.4 L8 14.8 Z " + // bottom-right wedge
  "M8 8 L2.11 11.4 L2.11 4.6 Z";  // top-left wedge

export default function DwMark({ size, className }: { size: number; className?: string }) {
  return (
    <svg className={className} aria-hidden="true" width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d={BLADES} fill="currentColor" />
    </svg>
  )
}

// 48-grid version — same blades scaled ×3.
export function DwLogo({ size, className }: { size: number; className?: string }) {
  return (
    <svg className={className} aria-label={i18n.t('common.logoAlt')} role="img" width={size} height={size} viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M24 24 L24 3.6 L41.67 13.8 Z M24 24 L41.67 34.2 L24 44.4 Z M24 24 L6.33 34.2 L6.33 13.8 Z" fill="currentColor" />
    </svg>
  )
}

export { BLADES }
