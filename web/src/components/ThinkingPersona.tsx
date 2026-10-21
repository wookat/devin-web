// Working-status persona: the turbine mark spinning (dw-persona.css).
// Same motif as DwMark — thinking = the blades in motion.
import './dw-persona.css'
import { BLADES } from './DwMark'

export default function ThinkingPersona() {
  return (
    <span className="dw-persona relative flex size-[17px] flex-shrink-0" aria-hidden="true">
      <svg viewBox="0 0 16 16" className="size-full" fill="none" xmlns="http://www.w3.org/2000/svg">
        <g className="dw-persona__core">
          <g className="dw-persona__orbit">
            <path d={BLADES} fill="currentColor" />
          </g>
        </g>
      </svg>
    </span>
  )
}
