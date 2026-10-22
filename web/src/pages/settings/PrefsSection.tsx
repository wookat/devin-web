import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '@/i18n'
import { adminFetch } from '@/lib/api'
import { getTheme, setTheme, type Theme } from '@/lib/theme'
import { Row, Section, Sel, Sw } from './atoms'

/* Preferences tab — general (send shortcut / work-send / theme / language),
 * Devin session (auto-resume), sidebar (group-by / compact / archived).
 * Send-shortcut + theme + sidebar keys ride localStorage (same keys the
 * session page + SessionTree read); autoResume persists via /api/admin/prefs. */

const TREE_PREFS_KEY = 'sidebar-sessions-prefs'
const readTreePrefs = () => { try { return JSON.parse(localStorage.getItem(TREE_PREFS_KEY) || '{}') } catch { return {} } }

export function PreferencesTab() {
  const { t } = useTranslation()
  const [autoResume, setAutoResume] = useState<boolean | null>(null)
  const [sendWith, setSendWith] = useState<'enter' | 'ctrlenter'>(() =>
    (localStorage.getItem('dw-send-with') === 'ctrlenter' ? 'ctrlenter' : 'enter'))
  const [workSend, setWorkSend] = useState<'queue' | 'interrupt'>(() =>
    (localStorage.getItem('dw-work-send') === 'interrupt' ? 'interrupt' : 'queue'))
  const [theme, setThemeState] = useState<Theme>(getTheme)
  const [groupBy, setGroupBy] = useState<string>(() => readTreePrefs().groupBy ?? 'folders')
  const [compact, setCompact] = useState<boolean>(() => !!readTreePrefs().compact)
  const [showArchived, setShowArchived] = useState<boolean>(() => !!readTreePrefs().showArchived)

  useEffect(() => {
    adminFetch<{ prefs: { autoResume?: boolean } }>('/api/admin/prefs')
      .then((r) => setAutoResume(!!r.prefs?.autoResume))
      .catch(() => setAutoResume(false))
  }, [])

  const writeTreePrefs = (patch: Record<string, unknown>) => {
    const cur = readTreePrefs()
    localStorage.setItem(TREE_PREFS_KEY, JSON.stringify({ ...cur, ...patch }))
  }
  const pickGroupBy = (v: string) => { setGroupBy(v); writeTreePrefs({ groupBy: v }) }
  const toggleCompact = () => { const v = !compact; setCompact(v); writeTreePrefs({ compact: v }) }
  const toggleArchived = () => { const v = !showArchived; setShowArchived(v); writeTreePrefs({ showArchived: v }) }

  const toggleAutoResume = () => {
    if (autoResume == null) return
    const next = !autoResume
    setAutoResume(next)
    void adminFetch('/api/admin/prefs', { method: 'POST', body: JSON.stringify({ autoResume: next }) })
      .catch(() => setAutoResume(!next))
  }
  const pickSend = (v: 'enter' | 'ctrlenter') => { setSendWith(v); localStorage.setItem('dw-send-with', v) }
  const pickWorkSend = (v: 'queue' | 'interrupt') => { setWorkSend(v); localStorage.setItem('dw-work-send', v) }
  const pickTheme = (v: Theme) => { setThemeState(v); setTheme(v) }

  return (
    <>
      <Section title={t('set.general')}>
        <Row title={t('set.sendShortcut')} desc={t('set.sendShortcutDesc')}>
          <Sel value={sendWith} onPick={(v) => pickSend(v as 'enter' | 'ctrlenter')}
            options={[{ v: 'enter', l: 'Enter' }, { v: 'ctrlenter', l: 'Ctrl+Enter' }]} />
        </Row>
        <Row title={t('set.workSend')} desc={t('set.workSendDesc')}>
          <Sel value={workSend} onPick={(v) => pickWorkSend(v as 'queue' | 'interrupt')}
            options={[{ v: 'queue', l: t('set.wsQueue') }, { v: 'interrupt', l: t('set.wsInterrupt') }]} />
        </Row>
        <Row title={t('set.theme')} desc={t('set.themeDesc')}>
          <Sel value={theme} onPick={(v) => pickTheme(v as Theme)}
            options={[{ v: 'system', l: t('set.thSystem') }, { v: 'light', l: t('set.thLight') }, { v: 'dark', l: t('set.thDark') }]} />
        </Row>
        <Row title={t('set.language')} desc={t('set.languageDesc')}>
          <Sel value={i18n.language.startsWith('zh') ? 'zh' : 'en'} onPick={(v) => void i18n.changeLanguage(v)}
            options={[{ v: 'zh', l: '中文' }, { v: 'en', l: 'English' }]} />
        </Row>
      </Section>

      <Section title={t('set.devinSession')}>
        <Row title={t('set.autoResume')} desc={t('set.autoResumeDesc')}>
          <Sw on={!!autoResume} onToggle={toggleAutoResume} busy={autoResume == null} />
        </Row>
      </Section>



      <Section title={t('set.sidebar')}>
        <Row title={t('set.groupBy')} desc={t('set.groupByDesc')}>
          <Sel value={groupBy} onPick={pickGroupBy}
            options={[{ v: 'folders', l: t('set.foldersOpt') }, { v: 'project', l: t('set.projectOpt') }]} />
        </Row>
        <Row title={t('set.compact')} desc={t('set.compactDesc')}>
          <Sw on={compact} onToggle={toggleCompact} />
        </Row>
        <Row title={t('set.showArchived')} desc={t('set.showArchivedDesc')}>
          <Sw on={showArchived} onToggle={toggleArchived} />
        </Row>
      </Section>
    </>
  )
}
