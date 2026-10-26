import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, PanelLeft, ChevronRight, SlidersHorizontal, KeyRound, Wrench, Stethoscope, Info, Boxes, Server, SquareTerminal, Bot } from 'lucide-react'
import { PreferencesTab } from '@/pages/settings/PrefsSection'
import { AccountsTab } from '@/pages/settings/AccountsSection'
import { ResourcesTab } from '@/pages/settings/ResourcesSection'
import { SshTab } from '@/pages/settings/SshSection'
import { CliTab } from '@/pages/settings/CliSection'
import { AgentsTab } from '@/pages/settings/AgentsSection'
import { ServiceTab, AboutTab } from '@/pages/settings/ServiceSection'
import { DiagTab } from '@/pages/settings/DiagSection'
import { PersonaTab } from '@/pages/settings/PersonaSection'

/** Preferences — markup replicated from app.devin.ai/settings/preferences
 * (DOM extracted live 2026-10-19): content column `flex flex-col gap-[36px]
 * max-w-[700px]`; page header `text-17` + `text-13 secondary`; each section =
 * `gap-[12px]` → `text-14` heading + double-layer card
 * (`bg-tint-tertiary rounded-[10px]` shell ⊃ `bg-elevated border rounded-[10px]
 * p-[6px]` body); each row `min-h-[60px] px-[12px] py-[10px]` with
 * `text-13` title + `text-13 text-secondary` desc, control right.
 * Tab bodies live in pages/settings/*Section.tsx; this file is the shell —
 * left rail + breadcrumb + hub grid + tab dispatch. */

// Tab config — official settings splits pages by responsibility into the left
// rail (Personal group → Preferences…; org group → everything else). Ours maps:
// personal: general/session/sidebar; local instance: accounts → about.
// Official category → icon-tile colors (route-org-settings-hub.js):
//   organization/enterprise → bg-tint-secondary text-text-primary
//   products → bg-tint-blue text-blue · resources → bg-tint-purple text-purple
//   administration → bg-tint-green text-green
const CAT_CLS: Record<string, string> = {
  organization: 'bg-tint-secondary text-text-primary',
  products: 'bg-tint-blue text-blue',
  resources: 'bg-tint-purple text-purple',
  administration: 'bg-tint-green text-green',
}
const TABS: { key: string; group: 'personal' | 'instance'; cat: string; icon: React.ReactNode }[] = [
  { key: 'preferences', group: 'personal', cat: 'organization', icon: <SlidersHorizontal size={16} /> },
  { key: 'persona', group: 'personal', cat: 'products', icon: <Bot size={16} /> },
  { key: 'accounts', group: 'instance', cat: 'administration', icon: <KeyRound size={16} /> },
  { key: 'resources', group: 'instance', cat: 'resources', icon: <Boxes size={16} /> },
  { key: 'ssh', group: 'instance', cat: 'products', icon: <Server size={16} /> },
  { key: 'cli', group: 'instance', cat: 'products', icon: <SquareTerminal size={16} /> },
  { key: 'agents', group: 'instance', cat: 'products', icon: <Boxes size={16} /> },
  { key: 'service', group: 'instance', cat: 'administration', icon: <Wrench size={16} /> },
  { key: 'diag', group: 'instance', cat: 'administration', icon: <Stethoscope size={16} /> },
  { key: 'about', group: 'instance', cat: 'organization', icon: <Info size={16} /> },
]

export default function Settings() {
  const { t } = useTranslation()
  const { tab: rawTab } = useParams()
  const tab = TABS.some(x => x.key === rawTab) ? rawTab : undefined
  // Shared status line: rendered inside the accounts Section (official slot);
  // service-tab actions also write to it — preserved from the monolith.
  const [prefsMsg, setPrefsMsg] = useState('')
  const [sq, setSq] = useState('')

  return (
    <div className="flex h-screen bg-background text-foreground">
      {/* Official left rail: 300px full-height settings nav (md+) */}
      <aside className="hidden w-[300px] shrink-0 flex-col border-r border-border bg-background md:flex">
        <div className="flex h-11 items-center border-b border-border px-3">
          <Link to="/admin/new" className="flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
            <ArrowLeft size={14} /> {t('set.backToApp')}
          </Link>
        </div>
        {/* official "Search settings…" — filters nav rows live */}
        <div className="px-2 pt-2">
          <input
            value={sq}
            onChange={(e) => setSq(e.target.value)}
            placeholder={t('set.searchPh')}
            className="h-[30px] w-full rounded-[6px] border border-border-secondary bg-card px-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-accent-primary"
          />
        </div>
        <nav className="flex flex-col gap-0.5 overflow-y-auto p-2 text-[13px]">
          {(['personal', 'instance'] as const).map(g => {
            const items = TABS.filter(x => x.group === g &&
              (!sq || t(`set.tab.${x.key}`).toLowerCase().includes(sq.toLowerCase()) || t(`set.tabDesc.${x.key}`, { defaultValue: '' }).toLowerCase().includes(sq.toLowerCase()) || t(`set.tabKw.${x.key}`, { defaultValue: '' }).toLowerCase().includes(sq.toLowerCase())))
            if (!items.length) return null
            return (
              <div key={g}>
                <p className="px-2 pb-1 pt-2 text-[11px] text-muted-foreground first:pt-0">{t(g === 'personal' ? 'set.personal' : 'set.localInstance')}</p>
                {items.map(x => (
                  <Link key={x.key} to={`/settings/${x.key}`}
                    className={`flex h-[30px] items-center gap-2 rounded-[6px] px-2 ${tab === x.key ? 'bg-tint-secondary font-medium text-foreground' : 'text-muted-foreground hover:bg-tint-secondary hover:text-foreground'}`}>
                    {x.icon} {t(`set.tab.${x.key}`)}
                  </Link>
                ))}
              </div>
            )
          })}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
      {/* Official 44px top bar (all widths): breadcrumb "Settings / Preferences" */}
      <header className="flex h-11 flex-shrink-0 select-none items-center gap-1 border-b border-border px-3">
        <Link to="/admin/new" aria-label={t('set.back')} className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent md:hidden">
          <PanelLeft size={15} />
        </Link>
        <span className="text-[13px] text-muted-foreground">{t('set.settings')}</span>
        <span className="text-[13px] text-muted-foreground">/</span>
        <span className="text-[13px] font-medium text-foreground">{tab ? t(`set.tab.${tab}`) : t('set.hub')}</span>
      </header>
      {/* Official main: scrollable body, content col max-w-700 gap-36 */}
      <main className="relative h-full min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="w-full px-4 pb-4 pt-4 sm:px-12 sm:pb-12 sm:pt-12">
          <div className="mx-auto flex h-fit w-full max-w-[700px] flex-col gap-[36px]">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex min-w-0 flex-1 basis-80 flex-col gap-1">
                <h2 className="text-[17px] font-medium text-foreground">{tab ? t(`set.tab.${tab}`) : t('set.hub')}</h2>
                <p className="text-[13px] text-muted-foreground">{tab ? t(`set.tabDesc.${tab}`, { defaultValue: '' }) : t('set.hubDesc')}</p>
              </div>
            </div>

            {/* official hub: flex-col gap-10; row = focus-ring-inset
                hover:bg-tint-tertiary min-h-[60px] gap-3 rounded-[6px] px-[12px]
                py-[10px]; icon tile size-7 rounded-md category-colored */}
            {!tab && (['personal', 'instance'] as const).map(g => {
              const items = TABS.filter(x => x.group === g)
              return (
                <div key={g} className="flex flex-col">
                  <div className="flex flex-col gap-[2px] pb-3">
                    <h3 className="text-[14px] font-medium text-foreground">{t(g === 'personal' ? 'set.personal' : 'set.localInstance')}</h3>
                    <p className="text-[13px] text-muted-foreground">{t(g === 'personal' ? 'set.personalDesc' : 'set.instanceDesc')}</p>
                  </div>
                  <div className="overflow-hidden rounded-[10px] bg-tint-tertiary">
                    <div className="flex flex-col gap-[2px] rounded-[10px] border border-border bg-card p-[6px]">
                      {items.map(x => (
                        <Link key={x.key} to={`/settings/${x.key}`}
                          className="focus-ring-inset flex min-h-[60px] items-center gap-3 rounded-[6px] px-[12px] py-[10px] hover:bg-tint-tertiary">
                          <span className={`flex size-7 shrink-0 items-center justify-center rounded-md ${CAT_CLS[x.cat]}`}>{x.icon}</span>
                          <span className="flex min-w-0 flex-1 items-center gap-2">
                            <span className="text-[13px] font-medium text-foreground">{t(`set.tab.${x.key}`)}</span>
                          </span>
                          <ChevronRight size={16} className="shrink-0 text-muted-foreground" />
                        </Link>
                      ))}
                    </div>
                  </div>
                </div>
              )
            })}

            {tab === 'preferences' && <PreferencesTab />}

            {tab === 'persona' && <PersonaTab />}

            {tab === 'accounts' && <AccountsTab msg={prefsMsg} setMsg={setPrefsMsg} />}

            {tab === 'resources' && <ResourcesTab />}

            {tab === 'ssh' && <SshTab />}

            {tab === 'cli' && <CliTab />}

            {tab === 'agents' && <AgentsTab />}

            {tab === 'service' && <ServiceTab setMsg={setPrefsMsg} />}

            {tab === 'diag' && <DiagTab />}

            {tab === 'about' && <AboutTab />}
          </div>
        </div>
      </main>
      </div>
    </div>
  )
}
