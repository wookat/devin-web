import { Component, type ReactNode } from 'react'
import i18n from '@/i18n'

type Props = { children: ReactNode }
type State = { err: Error | null }

// Whole-app render boundary: a single-component render crash must not
// white-screen the shell. Shows a minimal fallback with reload/home actions.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { err: null }
  static getDerivedStateFromError(err: Error) { return { err } }
  componentDidCatch(err: Error, info: unknown) { console.error('[ui] render crash:', err, info) }
  render() {
    if (!this.state.err) return this.props.children
    const e = this.state.err
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-foreground">
        <div className="text-[15px] font-medium">{i18n.t('err.title')}</div>
        <pre className="max-w-lg whitespace-pre-wrap break-all rounded-md border border-border-secondary bg-card px-3 py-2 text-[12px] text-muted-foreground">{e.message || String(e)}</pre>
        <div className="flex gap-2">
          <button onClick={() => location.reload()} className="cursor-pointer rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:opacity-90">{i18n.t('err.reload')}</button>
          <button onClick={() => { location.href = '/admin/new' }} className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-[13px] hover:bg-accent">{i18n.t('err.home')}</button>
        </div>
      </div>
    )
  }
}
