import { useEffect, useRef } from 'react'
import { showPillTooltip } from '@/lib/pillTooltip'

/**
 * Official initial-message repository pills (transcript `ll`/`sl`/`cl` +
 * live-sampled chip: 46px tall, 34px icon tile, p-1.5/pr-[32px], gap-2,
 * rounded-[10px], max-w-[320px], 13/500 label over an empty 12px line).
 * ≤3 repos → one chip each; more → a single "N repositories" chip whose
 * tooltip lists them all.
 */

type Provider = 'github' | 'gitlab' | 'azure' | 'bitbucket'

/** Official `sl`: host prefix only counts when the name has ≥3 segments. */
function providerOf(repo: string): Provider {
  const parts = repo.split('/')
  if (parts.length > 2) {
    const host = parts[0].toLowerCase()
    if (host.includes('gitlab')) return 'gitlab'
    if (host.includes('azure') || host.includes('visualstudio')) return 'azure'
    if (host.includes('bitbucket')) return 'bitbucket'
  }
  return 'github'
}

// Official ServiceLogos paths (24×24, currentColor).
const PATHS: Record<Provider, string> = {
  github: 'M12.0087 1.5C6.19766 1.5 1.5 6.31248 1.5 12.2662C1.5 17.0253 4.50995 21.0538 8.68555 22.4796C9.2076 22.5868 9.39883 22.2479 9.39883 21.9629C9.39883 21.7133 9.38162 20.8578 9.38162 19.9664C6.45836 20.6082 5.84962 18.683 5.84962 18.683C5.37983 17.4352 4.68375 17.1145 4.68375 17.1145C3.72697 16.455 4.75345 16.455 4.75345 16.455C5.81477 16.5263 6.37167 17.5601 6.37167 17.5601C7.31103 19.1999 8.82472 18.7366 9.43368 18.4513C9.52058 17.7561 9.79914 17.2749 10.0949 17.0076C7.7634 16.758 5.31035 15.8311 5.31035 11.6957C5.31035 10.5192 5.72765 9.55675 6.38888 8.80819C6.28456 8.54088 5.9191 7.43554 6.49342 5.95614C6.49342 5.95614 7.38073 5.67089 9.38141 7.06126C10.238 6.82559 11.1213 6.70571 12.0087 6.7047C12.896 6.7047 13.8005 6.8296 14.6358 7.06126C16.6366 5.67089 17.524 5.95614 17.524 5.95614C18.0983 7.43554 17.7326 8.54088 17.6283 8.80819C18.3069 9.55675 18.707 10.5192 18.707 11.6957C18.707 15.8311 16.254 16.74 13.905 17.0076C14.2879 17.3462 14.6183 17.9878 14.6183 19.0039C14.6183 20.4476 14.6011 21.6063 14.6011 21.9627C14.6011 22.2479 14.7926 22.5868 15.3144 22.4798C19.49 21.0535 22.5 17.0253 22.5 12.2662C22.5172 6.31248 17.8023 1.5 12.0087 1.5Z',
  gitlab: 'M21.6679 9.99357L21.6397 9.92171L18.9174 2.81706C18.8621 2.67781 18.764 2.55968 18.6373 2.47963C18.5105 2.40094 18.3627 2.36304 18.2137 2.37105C18.0647 2.37905 17.9217 2.43259 17.8041 2.52441C17.6879 2.61888 17.6035 2.74688 17.5625 2.891L15.7244 8.51474H8.28128L6.44315 2.891C6.40329 2.74609 6.31874 2.61745 6.20154 2.52337C6.08394 2.43154 5.941 2.37801 5.79201 2.37C5.64302 2.362 5.49516 2.3999 5.36839 2.47859C5.24199 2.55897 5.14401 2.67699 5.08825 2.81601L2.36074 9.91755L2.33366 9.98941C1.94177 11.0133 1.8934 12.1369 2.19583 13.1908C2.49827 14.2446 3.13512 15.1716 4.01037 15.8318L4.01974 15.8391L4.04473 15.8568L8.19172 18.9624L10.2433 20.5152L11.4931 21.4587C11.6392 21.5697 11.8177 21.6298 12.0013 21.6298C12.1848 21.6298 12.3633 21.5697 12.5095 21.4587L13.7592 20.5152L15.8108 18.9624L19.9828 15.8381L19.9932 15.8298C20.8665 15.1693 21.5019 14.2434 21.8039 13.1909C22.1058 12.1385 22.0581 11.0165 21.6679 9.99357Z',
  bitbucket: 'M20.8456 11.5265L19.3528 20.6453C19.2555 21.197 18.8661 21.5215 18.3144 21.5215H5.65839C5.10671 21.5215 4.71726 21.197 4.61991 20.6453L1.99136 4.38718C1.89401 3.8355 2.18607 3.47858 2.7053 3.47858H21.2675C21.7867 3.47858 22.0788 3.8355 21.9814 4.38718L21.2675 8.67075C21.1701 9.28737 20.8132 9.54695 20.229 9.54695H9.06577C8.90348 9.54695 8.80613 9.6443 8.8386 9.83906L9.7148 15.2259C9.74727 15.3557 9.84462 15.4531 9.97437 15.4531H13.9984C14.1282 15.4531 14.2255 15.3557 14.258 15.2259L14.8746 11.3318C14.9394 10.845 15.264 10.6503 15.7183 10.6503H20.0992C20.7482 10.6503 20.9429 10.9748 20.8456 11.5265Z',
  azure: 'M22.6669 5.33344V18.3201L17.3334 22.6933L9.06657 19.6802V22.6671L4.38657 16.5469L18.0264 17.6134V5.92013L22.6669 5.33344ZM18.12 5.98688L10.4663 1.33313V4.38656L3.44026 6.45338L1.33295 9.15975V15.3069L4.34701 16.6401V8.75963L18.12 5.98688Z',
}

function ProviderIcon({ provider }: { provider: Provider | null }) {
  if (!provider) return null
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false" className="size-4">
      <path {...(provider === 'github' ? { fillRule: 'evenodd' as const, clipRule: 'evenodd' as const } : {})} d={PATHS[provider]} fill="currentColor" />
    </svg>
  )
}

/** Official `cl`: the overflow chip only gets an icon when every repo shares a provider. */
function commonProvider(repos: string[]): Provider | null {
  const ps = repos.map(providerOf)
  return ps.every((p) => p === ps[0]) ? ps[0] : null
}

function Chip({ label, provider, tooltip }: { label: string; provider: Provider | null; tooltip?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !tooltip) return
    let hide: (() => void) | null = null
    const enter = () => { hide?.(); hide = showPillTooltip(el, tooltip) }
    const leave = () => { hide?.(); hide = null }
    el.addEventListener('mouseenter', enter)
    el.addEventListener('mouseleave', leave)
    return () => { leave(); el.removeEventListener('mouseenter', enter); el.removeEventListener('mouseleave', leave) }
  }, [tooltip])
  return (
    <div ref={ref} className="relative flex w-fit max-w-[320px] shrink-0 items-center gap-2 rounded-[10px] bg-tint-tertiary p-1.5 pr-[32px]">
      <div className="flex size-[34px] shrink-0 items-center justify-center rounded-[6px] bg-tint-tertiary text-foreground">
        <ProviderIcon provider={provider} />
      </div>
      <div className="flex min-w-0 flex-col justify-center">
        <span className="truncate text-[13px] font-medium leading-[18px] text-foreground" title={label}>{label}</span>
        <span className="truncate text-[12px] font-normal leading-4 text-muted-foreground">&nbsp;</span>
      </div>
    </div>
  )
}

export default function RepoChips({ repos }: { repos: string[] }) {
  if (repos.length === 0) return null
  if (repos.length <= 3) {
    return <>{repos.map((r, i) => <Chip key={`repo-${i}`} label={r} provider={providerOf(r)} />)}</>
  }
  return <Chip label={`${repos.length} repositories`} provider={commonProvider(repos)} tooltip={repos.join('\n')} />
}
