import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Zap, Shield, BookOpen } from 'lucide-react'
import { OExpand } from '@/components/officialIcons'
import { adminFetch } from '@/lib/api'
import AppSidebar from '@/components/AppSidebar'
import type { MirrorTreeSession } from './mirror/treeCache'

/**
 * Placeholder for official nav surfaces that have no local equivalent yet
 * (Automations / Security / Wiki). Keeps the sidebar's official shape without
 * promising features that don't exist — one shared page keyed by `surface`.
 */
const SURFACES = {
  automations: { icon: Zap, key: 'sp.automations' },
  security: { icon: Shield, key: 'sp.security' },
  wiki: { icon: BookOpen, key: 'sp.wiki' },
} as const

export default function StubPage({ surface }: { surface: keyof typeof SURFACES }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [sideOpen, setSideOpen] = useState(window.innerWidth >= 1024)
  const [tree, setTree] = useState<MirrorTreeSession[]>([])
  useEffect(() => {
    adminFetch<{ sessions: MirrorTreeSession[] }>('/api/admin/mirror/sessions')
      .then((r) => setTree(r.sessions ?? []))
      .catch(() => {})
  }, [])
  const S = SURFACES[surface]
  const Icon = S.icon
  return (
    <div className="flex h-screen bg-background text-foreground">
      <AppSidebar
        open={sideOpen}
        onToggle={setSideOpen}
        active={surface}
        tree={tree.filter((s) => s.status_enum !== 'archived')}
        archivedTree={tree.filter((s) => s.status_enum === 'archived')}
        onOpen={(s) => navigate(`/admin/${s.devin_id}`)}
        onRefresh={() => void adminFetch<{ sessions: MirrorTreeSession[] }>('/api/admin/mirror/sessions').then((r) => setTree(r.sessions ?? [])).catch(() => {})}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border-secondary px-2 pr-[7px]">
          {!sideOpen && (
            <button
              onClick={() => setSideOpen(true)}
              className="flex size-7 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-tint-secondary hover:text-foreground"
              aria-label={t('sp.expandSb')}
              title={t('sp.expandSb')}
            >
              <OExpand size={16} />
            </button>
          )}
        </header>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6">
          <Icon size={28} className="text-muted-foreground" />
          <h1 className="text-[17px] font-medium">{t(S.key)}</h1>
          <p className="max-w-sm text-center text-[13px] text-muted-foreground">{t('stub.na')}</p>
        </div>
      </div>
    </div>
  )
}
