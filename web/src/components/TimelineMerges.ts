import type { EnvResolution, TimelineItem } from './Timeline'

/**
 * Official scripted_tools_group across page boundaries: a `scripted_tools`
 * completion loaded on another page flips its `scripted_tools_started` row to
 * "Ran scripted tool" and disappears as a standalone row.
 */
export function mergeScriptedRuns(items: TimelineItem[]): TimelineItem[] {
  const done = new Map<string, TimelineItem>()
  const started = new Set<string>()
  const orphans = new Map<string, TimelineItem[]>()
  for (const it of items) {
    if (it.raw_type === 'scripted_tools' && it.shellId) done.set(it.shellId, it)
    else if (it.raw_type === 'scripted_tools_started' && it.shellId) started.add(it.shellId)
    else if (it.runId) orphans.set(it.runId, [...(orphans.get(it.runId) || []), it])
  }
  if (!done.size && !orphans.size) return items
  return items.flatMap((it) => {
    if (it.raw_type === 'scripted_tools' && it.shellId && started.has(it.shellId)) return []
    if (it.runId && started.has(it.runId)) return []
    if (it.raw_type === 'scripted_tools_started' && it.shellId) {
      const d = done.get(it.shellId)
      const kids = orphans.get(it.shellId)
      if (!d && !kids) return [it]
      const nested = kids
        ? [...(it.nested || []), ...kids.map((k) => ({ label: k.title || k.raw_type.replace(/_/g, ' '), ts: k.ts }))].sort((a, b) => a.ts.localeCompare(b.ts))
        : it.nested
      const ran = d || it.kind === 'shell_done'
      const n = nested?.length
      const title = n ? `${ran ? 'Ran' : 'Running'} ${n} scripted tool ${n === 1 ? 'event' : 'events'}` : ran ? 'Ran scripted tool' : 'Running scripted tool'
      return [{ ...it, kind: ran ? ('shell_done' as const) : it.kind, title, nested, exitCode: d?.exitCode ?? it.exitCode, body: it.body || d?.body }]
    }
    return [it]
  })
}

/** Official groups show one row per command: the completion event merges into
 * the command row (output behind the expand), no standalone "Exit code" rows. */
export function mergeShellPairs(items: TimelineItem[]): TimelineItem[] {
  const doneByProcess = new Map<string, TimelineItem[]>()
  for (const it of items) {
    if (it.kind === 'shell_done' && it.processId) {
      const list = doneByProcess.get(it.processId)
      if (list) list.push(it)
      else doneByProcess.set(it.processId, [it])
    }
  }
  const consumed = new Set<string>()
  const shellPids = new Set(items.filter((i) => i.kind === 'shell' && i.processId).map((i) => i.processId!))
  for (const [pid, dones] of doneByProcess) {
    if (shellPids.has(pid)) for (const d of dones) consumed.add(d.id)
  }
  const out: TimelineItem[] = []
  for (const it of items) {
    if (it.kind === 'shell') {
      const dones = it.processId ? doneByProcess.get(it.processId) : undefined
      if (dones && dones.length > 0) {
        for (const d of dones) consumed.add(d.id)
        const last = dones[dones.length - 1]
        const outputs = dones.map((d) => d.body).filter(Boolean)
        out.push({
          ...it,
          exitCode: last.exitCode,
          terminal: it.startupCommand ? undefined : (last.terminal ?? it.terminal),
          terminalMore: last.terminalMore ?? it.terminalMore,
          pageCursor: last.pageCursor ?? it.pageCursor,
          output: outputs.length ? outputs.join('\n\n') : undefined,
        })
      } else {
        out.push(it)
      }
    } else if (it.kind === 'shell_done') {
      // a completion whose command row lives on a page not loaded yet stays hidden (official never renders it alone)
      if (!consumed.has(it.id) && !it.processId) out.push(it)
    } else {
      out.push(it)
    }
  }
  return out
}

/**
 * Official `bo` index across page boundaries: a completion / error / dismissal
 * loaded on another page resolves its suggestion card and never renders itself
 * (first completion wins, latest error wins).
 */
export function mergeEnvLifecycle(items: TimelineItem[]): TimelineItem[] {
  const done = new Map<string, EnvResolution>()
  const errored = new Map<string, EnvResolution>()
  const dismissed = new Set<string>()
  let any = false
  const byTs = items.filter((it) => it.envLifecycle).sort((a, b) => a.ts.localeCompare(b.ts))
  for (const it of byTs) {
    const lc = it.envLifecycle!
    any = true
    if (lc.resolution?.state === 'accepted') { if (!done.has(lc.originalEventId)) done.set(lc.originalEventId, lc.resolution) }
    else if (lc.resolution?.state === 'error') errored.set(lc.originalEventId, lc.resolution)
    else if (lc.dismissed) dismissed.add(lc.originalEventId)
  }
  if (!any) return items
  return items.flatMap((it) => {
    if (it.envLifecycle) return []
    if (it.kind !== 'env_suggestion' || !it.envSuggestion) return [it]
    const res = done.get(it.id) ?? (it.envSuggestion.resolution?.state === 'accepted' ? it.envSuggestion.resolution : undefined) ?? errored.get(it.id) ?? it.envSuggestion.resolution
    const dis = it.envSuggestion.dismissed || dismissed.has(it.id) || undefined
    if (res === it.envSuggestion.resolution && dis === it.envSuggestion.dismissed) return [it]
    return [{ ...it, envSuggestion: { ...it.envSuggestion, resolution: res, dismissed: dis } }]
  })
}

/**
 * Official `xo` over every loaded page: a later env suggestion for the same
 * repo + file + target supersedes an earlier one (Outdated badge).
 */
export function envSupersededMap(items: TimelineItem[]): Map<string, string> {
  const sug = items.filter((it) => it.kind === 'env_suggestion' && it.envSuggestion)
  const out = new Map<string, string>()
  for (const a of sug) {
    const ea = a.envSuggestion!
    const ta = new Date(a.ts).getTime()
    let best: TimelineItem | undefined
    let bestTs = 0
    for (const b of sug) {
      if (b.id === a.id) continue
      const eb = b.envSuggestion!
      if (eb.repo !== ea.repo || eb.filePath !== ea.filePath || (eb.target ?? 'repo') !== (ea.target ?? 'repo')) continue
      const tb = new Date(b.ts).getTime()
      if (tb > ta && tb > bestTs) { best = b; bestTs = tb }
    }
    if (best) out.set(a.id, best.id)
    else if (ea.supersededBy) out.set(a.id, ea.supersededBy)
  }
  return out
}
