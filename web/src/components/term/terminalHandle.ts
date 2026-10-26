import { useImperativeHandle, useRef, type ForwardedRef } from 'react'

export interface TermSessionHandle {
  /** Write complete commands only while ready; never replay after reconnect. */
  send(data: string): void
  /** Write bytes to the display only. */
  write(data: string): void
  /** Load an ask suggestion into the editor; raw PTYs receive it without Enter. */
  setLine(data: string): void
  clear(): void
  focus(): void
  isLive(): boolean
  shellHint(): string | undefined
  revision(): number
  agentSettled(): void
}

/** One object per mounted terminal, even when a parent's callback ref changes.
 * React re-runs useImperativeHandle when the ref changes despite [] deps.
 * The methods read stable refs, so neither rerenders nor reconnects need a new
 * object; revision/live checks distinguish canceled work on this incarnation. */
export function useTerminalHandle(ref: ForwardedRef<TermSessionHandle>, create: () => TermSessionHandle): void {
  const handle = useRef<TermSessionHandle | null>(null)
  if (handle.current === null) handle.current = create()
  useImperativeHandle(ref, () => handle.current!, [])
}
