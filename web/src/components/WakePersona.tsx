// Idle persona: the same turbine mark, animation paused (--dw-play). Tones
// mirror the official semantics: sleeping = 40% fg rotated 30deg; action =
// full-opacity orange.
import './dw-persona.css'
import { BLADES } from './DwMark'

const TONES = {
  sleep: 'text-foreground opacity-40 rotate-[30deg]',
  action: 'text-[rgb(245,142,58)]',
} as const

export default function WakePersona({ tone = 'sleep' }: { tone?: keyof typeof TONES }) {
  return (
    <span className={`dw-persona dw-persona--paused relative flex size-[17px] flex-shrink-0 ${TONES[tone]}`} aria-hidden="true">
      <svg viewBox="0 0 16 16" className="size-full" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d={BLADES} fill="currentColor" />
      </svg>
    </span>
  )
}
