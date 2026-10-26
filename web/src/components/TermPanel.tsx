import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, PenLine, Play, Plus, X } from 'lucide-react'
import { adminFetch } from '@/lib/api'
import TermSession, { type TermSessionHandle, hlCmd } from './term/TermSession'
import TermHistory from './term/TermHistory'

/** Multi-terminal panel — official-style tabs, each its own xterm + /ws/term
 * socket in the session cwd. `run` optionally replaces the shell with
 * `devin ssh`/`devin forward` args (query fragment, e.g. `run=ssh&arg=<s>`).
 *
 * Input is INLINE in the xterm prompt — there is no separate input box.
 * Shell mode (default): keystrokes go to the child verbatim. Agent mode
 * (chip in the tab bar): the typed line is captured locally and Enter POSTs
 * it to /term-agent, a separate NL→command agent (devin's
 * _cognition.ai/command/revise) — NOT the session's main agent. The
 * returned command is echoed `◇ <cmd>` and executed in the same terminal.
 * Model pick persists in localStorage 'dw-term-model' (devin's revise has
 * no model field on this build — forwarded for forward-compat). */
interface TermTab { tid: number; n: number; live: boolean }
interface ModelOpt { value: string; name?: string }

const FALLBACK_MODELS: ModelOpt[] = [
  { value: 'swe-2-high', name: 'SWE-2 high' },
  { value: 'swe-2-mid', name: 'SWE-2 mid' },
  { value: 'swe-2-max', name: 'SWE-2 max' },
]

export default function TermPanel({ id, run }: { id: string; run?: string }) {
  const { t } = useTranslation()
  const [tabs, setTabs] = useState<TermTab[]>(() => [{ tid: 1, n: 1, live: false }])
  const [activeTid, setActiveTid] = useState(1)
  const [agentMode, setAgentMode] = useState(false)
  // exec: returned command runs immediately. ask: it lands in the editable
  // input line — user reviews/edits then Enter runs it.
  const [agentRun, setAgentRun] = useState<'exec' | 'ask'>('exec')
  const [agentBusy, setAgentBusy] = useState(false)
  const busyRef = useRef(false)
  const [models, setModels] = useState<ModelOpt[]>([])
  const [model, setModel] = useState(() => localStorage.getItem('dw-term-model') ?? 'swe-2-high')
  const [histLocal, setHistLocal] = useState<{ cmd: string; ts: string }[]>([])
  const handles = useRef(new Map<number, TermSessionHandle>())
  const seq = useRef({ tid: 1, n: 1 })
  const target = useRef(`${id} ${run}`)

  // Model list: the session's live config options when available, else the
  // static SWE-2 list. (The pick is persisted + sent; this build of devin
  // ignores it — see the term-agent route comment.)
  useEffect(() => {
    if (!id) return
    let alive = true
    adminFetch<{ model?: { options?: { value: string; name?: string }[] } }>(`/api/admin/session/${id}/config`)
      .then((r) => { if (alive && r?.model?.options?.length) setModels(r.model.options) })
      .catch(() => {})
    return () => { alive = false }
  }, [id])

  const spawn = useCallback(() => {
    const tid = ++seq.current.tid
    const n = ++seq.current.n
    setTabs((ts) => [...ts, { tid, n, live: false }])
    setActiveTid(tid)
  }, [])

  // A different session/run target = a whole different shell — reset to one
  // fresh terminal (old tabs unmount → each TermSession kill+disposes its own).
  useEffect(() => {
    const key = `${id} ${run}`
    if (target.current === key) return
    target.current = key
    seq.current.n = 0
    const tid = ++seq.current.tid
    setTabs([{ tid, n: ++seq.current.n, live: false }])
    setActiveTid(tid)
  }, [id, run])

  const close = (tid: number) => {
    const i = tabs.findIndex((x) => x.tid === tid)
    const next = tabs.filter((x) => x.tid !== tid)
    setTabs(next)
    handles.current.delete(tid)
    if (tid === activeTid) setActiveTid(next[Math.min(Math.max(i, 0), next.length - 1)]?.tid ?? 0)
  }

  const activeTab = tabs.find((x) => x.tid === activeTid)
  const live = !!activeTab?.live

  const submitAgent = useCallback((tid: number, line: string) => {
    const h = handles.current.get(tid)
    const PROMPT = '\x1b[36m❯\x1b[0m '
    if (!h || !id) return
    const text = line.trim()
    if (!text) { h.write(PROMPT); return }
    if (busyRef.current) { h.write(`\x1b[2m(${t('tm.agentBusy')})\x1b[0m\r\n${PROMPT}`); return }
    busyRef.current = true
    setAgentBusy(true)
    adminFetch<{ ok?: boolean; command?: string; error?: string }>(`/api/admin/session/${id}/term-agent`, {
      method: 'POST',
      body: JSON.stringify({ text, model }),
    }).then((r) => {
      const cmd = (r?.command ?? '').trim()
      if (cmd) {
        h.write(`\x1b[2m◇ \x1b[0m${hlCmd(cmd)}\r\n`)
        if (agentRun === 'ask') h.setLine(cmd)
        else h.send(cmd + '\r')
        setHistLocal((hs) => [{ cmd, ts: new Date().toISOString() }, ...hs].slice(0, 50))
      } else {
        h.write(`\x1b[31m${t('tm.agentErr')}${r?.error ?? 'unknown'}\x1b[0m\r\n`)
      }
    }).catch((e) => {
      h.write(`\x1b[31m${t('tm.agentErr')}${(e as Error).message}\x1b[0m\r\n`)
    }).finally(() => {
      busyRef.current = false
      setAgentBusy(false)
      h.write(PROMPT)
    })
  }, [id, model, agentRun, t])

  return (
    <div className="flex h-full min-h-0 flex-col bg-card font-mono text-[12px] text-foreground">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1 text-[10px] text-muted-foreground">
        {!!id && (
          <>
            <button
              type="button"
              onClick={() => setAgentMode((v) => !v)}
              aria-pressed={agentMode}
              title={t('tm.agentHint')}
              className={`flex cursor-pointer items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-[11px] ${agentMode ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              <Bot size={11} />{t('tm.agent')}
            </button>
            {agentMode && (
              <button
                type="button"
                onClick={() => setAgentRun((v) => (v === 'exec' ? 'ask' : 'exec'))}
                title={t('tm.agentRunHint', { defaultValue: 'ask: 命令进输入行可编辑；exec: 直接执行' })}
                className="flex cursor-pointer items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
              >
                {agentRun === 'exec' ? <Play size={11} /> : <PenLine size={11} />}{agentRun}
              </button>
            )}
            {agentMode && (
              <select
                value={model}
                onChange={(e) => { setModel(e.target.value); localStorage.setItem('dw-term-model', e.target.value) }}
                aria-label={t('tm.model')}
                className="cursor-pointer rounded-[5px] border border-border bg-card px-1 py-0.5 text-[11px] text-foreground outline-none"
              >
                {(models.length ? models : FALLBACK_MODELS).map((o) => (
                  <option key={o.value} value={o.value}>{o.name ?? o.value}</option>
                ))}
              </select>
            )}
            <span className="mx-0.5 h-3.5 w-px shrink-0 bg-border" />
          </>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {tabs.map((tab) => (
            <span
              key={tab.tid}
              className={`group flex shrink-0 items-center rounded-[5px] py-0.5 pl-1.5 pr-0.5 text-[11px] ${tab.tid === activeTid ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'} ${tab.live ? '' : 'opacity-60'}`}
            >
              <button
                type="button"
                onClick={() => { setActiveTid(tab.tid); handles.current.get(tab.tid)?.focus() }}
                className="cursor-pointer whitespace-nowrap"
              >
                {t('vp.terminalN', { n: tab.n })}
              </button>
              <button
                type="button"
                onClick={() => close(tab.tid)}
                title={t('common.close')}
                aria-label={t('common.close')}
                className={`ml-0.5 cursor-pointer rounded p-0.5 hover:bg-tint-tertiary ${tab.tid === activeTid ? 'opacity-100' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100'}`}
              >
                <X size={9} />
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={spawn}
            title={t('tm.newTerm', { defaultValue: 'New terminal' })}
            aria-label={t('tm.newTerm', { defaultValue: 'New terminal' })}
            className="cursor-pointer rounded p-1 hover:bg-accent hover:text-foreground"
          >
            <Plus size={11} />
          </button>
        </div>
        <span className="ml-1 shrink-0">{agentMode ? (agentBusy ? t('tm.agentBusy') : t('tm.agent')) : (live ? 'shell' : t('tm.closed'))}</span>
        <button
          type="button"
          className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
          onClick={() => handles.current.get(activeTid)?.clear()}
        >{t('tm.clear')}</button>
      </div>
      <div className="relative min-h-0 flex-1">
        {tabs.map((tab) => (
          <TermSession
            key={tab.tid}
            ref={(h) => { if (h) handles.current.set(tab.tid, h); else handles.current.delete(tab.tid) }}
            sid={id}
            run={run}
            active={tab.tid === activeTid}
            agentMode={agentMode}
            onAgentLine={(line) => submitAgent(tab.tid, line)}
            onLive={(l) => setTabs((ts) => ts.map((x) => x.tid === tab.tid ? { ...x, live: l } : x))}
          />
        ))}
        {tabs.length === 0 && (
          <button
            type="button"
            onClick={spawn}
            className="flex h-full w-full cursor-pointer flex-col items-center justify-center gap-1.5 text-muted-foreground hover:text-foreground"
          >
            <Plus size={16} />
            <span className="text-[11px]">{t('tm.newTerm', { defaultValue: 'New terminal' })}</span>
          </button>
        )}
      </div>
      {!!id && <TermHistory sid={id} local={histLocal} />}
    </div>
  )
}
