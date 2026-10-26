import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminFetch } from '@/lib/api'
import { Section } from './atoms'

/* 代理人 (persona/proxy) management — the dedicated plumbing-agent roles.
 * 分身: a persistent persona session on <dataDir>/persona whose AGENTS.md is
 * the behavioral spec; it answers working-session questions on the user's
 * behalf (off/semi/auto + [升级] escalation, decisions.log, webhook).
 * 侧聊: the dedicated session backing side-chat threads (<dataDir>/sidechat
 * AGENTS.md). This tab edits both specs and global persona config, and shows
 * the recent delegated-answer log. */

interface PersonaCfg { mode?: string; webhook?: string; maxPerHour?: number }
interface Decision { ts?: number; kind?: string; why?: string; session?: string; q?: string; a?: string; raw?: string }

const MODES = ['off', 'semi', 'auto'] as const

const inputCls = 'h-[30px] rounded-[6px] border border-border-secondary bg-card px-2 text-[13px] outline-none placeholder:text-muted-foreground focus:border-accent-primary'

export function PersonaTab() {
  const { t } = useTranslation()
  const [cfg, setCfg] = useState<PersonaCfg>({})
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [specs, setSpecs] = useState<{ persona: string; sidechat: string }>({ persona: '', sidechat: '' })
  const [msg, setMsg] = useState('')

  const load = () => {
    adminFetch<{ cfg: PersonaCfg; decisions: Decision[] }>('/api/admin/persona')
      .then((r) => { setCfg(r.cfg ?? {}); setDecisions(r.decisions ?? []) }).catch(() => {})
    adminFetch<{ spec: string }>('/api/admin/agent-spec?which=persona')
      .then((r) => setSpecs((s) => ({ ...s, persona: r.spec ?? '' }))).catch(() => {})
    adminFetch<{ spec: string }>('/api/admin/agent-spec?which=sidechat')
      .then((r) => setSpecs((s) => ({ ...s, sidechat: r.spec ?? '' }))).catch(() => {})
  }
  useEffect(load, [])

  const saveCfg = async (patch: Partial<PersonaCfg>) => {
    const next = { ...cfg, ...patch }
    setCfg(next)
    try { await adminFetch('/api/admin/persona', { method: 'POST', body: JSON.stringify(patch) }); setMsg(t('pa.saved')) }
    catch (e) { setMsg((e as Error).message) }
  }
  const saveSpec = async (which: 'persona' | 'sidechat') => {
    try { await adminFetch('/api/admin/agent-spec', { method: 'POST', body: JSON.stringify({ which, spec: specs[which] }) }); setMsg(t('pa.saved')) }
    catch (e) { setMsg((e as Error).message) }
  }

  const specEditor = (which: 'persona' | 'sidechat') => (
    <div className="flex flex-col gap-[10px] rounded-[6px] px-[12px] py-[10px]">
      <p className="text-[13px] text-muted-foreground">{t(`pa.${which}SpecDesc`)}</p>
      <textarea
        value={specs[which]}
        onChange={(e) => setSpecs((s) => ({ ...s, [which]: e.target.value }))}
        rows={12}
        spellCheck={false}
        className="w-full resize-y rounded-[6px] border border-border-secondary bg-card p-2 font-mono text-[12px] leading-relaxed outline-none focus:border-accent-primary"
      />
      <div className="flex items-center gap-2">
        <button onClick={() => void saveSpec(which)} className="h-[28px] cursor-pointer rounded-[6px] border border-border bg-card px-3 text-[13px] font-medium hover:bg-tint-tertiary">{t('pa.saveSpec')}</button>
        <span className="text-[11px] text-muted-foreground">{"<dataDir>"}/{which}/AGENTS.md</span>
      </div>
    </div>
  )

  return (
    <>
      <Section title={t('pa.mode')}>
        <div className="flex flex-col gap-[12px] rounded-[6px] px-[12px] py-[10px]">
          <p className="text-[13px] text-muted-foreground">{t('pa.modeDesc')}</p>
          <div className="flex w-fit items-center rounded-lg bg-tint-secondary/60 p-0.5">
            {MODES.map((m) => (
              <button
                key={m}
                onClick={() => void saveCfg({ mode: m })}
                className={`flex h-7 cursor-pointer items-center rounded-[6px] px-3 text-[13px] ${(cfg.mode ?? 'off') === m ? 'bg-card font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >{t(`pa.mode_${m}`)}</button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="w-[72px] shrink-0 text-[12px] text-muted-foreground">{t('pa.webhook')}</label>
            <input
              defaultValue={cfg.webhook ?? ''}
              onBlur={(e) => { if (e.target.value !== (cfg.webhook ?? '')) void saveCfg({ webhook: e.target.value }) }}
              placeholder={t('pa.webhookPh')}
              className={`${inputCls} min-w-0 flex-1`}
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="w-[72px] shrink-0 text-[12px] text-muted-foreground">{t('pa.maxHour')}</label>
            <input
              type="number" min={1} max={50}
              defaultValue={cfg.maxPerHour ?? 4}
              onBlur={(e) => { const n = +e.target.value; if (n > 0 && n !== (cfg.maxPerHour ?? 4)) void saveCfg({ maxPerHour: n }) }}
              className={`${inputCls} w-20`}
            />
            <span className="text-[12px] text-muted-foreground">{t('pa.maxHourDesc')}</span>
          </div>
          {msg && <span className="text-[12px] text-muted-foreground">{msg}</span>}
        </div>
      </Section>

      <Section title={t('pa.personaSpec')}>
        {specEditor('persona')}
      </Section>

      <Section title={t('pa.sidechatSpec')}>
        {specEditor('sidechat')}
      </Section>

      <Section title={t('pa.decisions')}>
        <div className="flex max-h-80 flex-col gap-1 overflow-y-auto rounded-[6px] px-[12px] py-[10px]">
          {!decisions.length && <p className="py-2 text-[13px] text-muted-foreground">{t('pa.noDecisions')}</p>}
          {[...decisions].reverse().map((d, i) => (
            <div key={i} className="flex flex-col gap-0.5 border-b border-border-secondary/60 pb-1.5 last:border-0">
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <span className={`rounded px-1 text-[10px] ${d.kind === 'answer' ? 'bg-green-500/15 text-green-600' : d.kind === 'escalate' ? 'bg-amber-500/15 text-amber-600' : 'bg-tint-tertiary text-muted-foreground'}`}>{d.kind ?? 'log'}</span>
                <span className="tabular-nums">{d.ts ? new Date(d.ts).toLocaleString() : ''}</span>
                {d.session && <span className="truncate">{d.session}</span>}
              </div>
              {d.q && <div className="truncate text-[12px] text-muted-foreground">Q: {d.q}</div>}
              {(d.a ?? d.why ?? d.raw) && <div className="whitespace-pre-wrap break-all text-[12px]">{d.a ?? d.why ?? d.raw}</div>}
            </div>
          ))}
        </div>
      </Section>
    </>
  )
}
