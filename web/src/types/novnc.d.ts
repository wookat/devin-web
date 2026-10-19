declare module '@novnc/novnc' {
  interface RFBOptions {
    shared?: boolean
    credentials?: { username?: string; password?: string; target?: string }
    wsProtocols?: string[]
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: RFBOptions)
    viewOnly: boolean
    scaleViewport: boolean
    showDotCursor: boolean
    compressionLevel: number
    qualityLevel: number
    resizeSession: boolean
    background: string
    focusOnClick: boolean
    disconnect(): void
    focus(): void
  }
}
