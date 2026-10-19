import { useCallback, useMemo, useState } from 'react'
import { ChevronDown, Calendar as CalendarIcon, TriangleAlert } from 'lucide-react'
import { adminFetch } from '@/lib/api'
import { viewer } from '@/lib/viewer'
import { type TimelineItem } from '@/components/Timeline'
import { PermissionRequestCard, type PermissionAction } from '@/components/StructuredCards'
import { cn } from '@/lib/utils'

const RRULE_DAYS: Record<string, string> = { MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday', SU: 'Sunday' }

/** Human-readable summary for a recurrence rule, e.g. "Weekly on Monday at 1:00 AM (GMT)". */
function formatRrule(rrule: string): string {
  const get = (k: string) => new RegExp(`${k}=([^;]+)`).exec(rrule)?.[1]
  const freq = get('FREQ')
  const day = get('BYDAY')?.split(',').map((d) => RRULE_DAYS[d] || d).join(', ')
  const hour = Number(get('BYHOUR') ?? NaN)
  const minute = Number(get('BYMINUTE') ?? 0)
  let at = ''
  if (!Number.isNaN(hour)) {
    const h12 = hour % 12 === 0 ? 12 : hour % 12
    at = ` at ${h12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'} (GMT)`
  }
  if (freq === 'WEEKLY') return `Weekly${day ? ` on ${day}` : ''}${at}`
  if (freq === 'DAILY') return `Daily${at}`
  if (freq === 'MONTHLY') return `Monthly${day ? ` on ${day}` : ''}${at}`
  return rrule
}

interface AutomationArgs {
  action?: string
  name?: string
  triggers?: { event_type?: string; conditions?: { any?: { all?: { field?: string; operator?: string; value?: string }[] }[] } }[]
  actions?: { type?: string; prompt?: string }[]
}

/**
 * Official specialized body for devin_automation_manage create requests:
 * "Create automation" heading + Name / Trigger (accent pill) / Agent
 * definition (Agent type + Instructions) sections.
 */
function AutomationRequestBody({ args }: { args: AutomationArgs }) {
  const trigger = args.triggers?.[0]
  const rrule = trigger?.conditions?.any?.[0]?.all?.find((c) => c.field === 'rrule')?.value
  const action = args.actions?.[0]
  return (
    <div className="flex flex-col gap-2.5">
      <div className="truncate text-[15px] font-medium">Create automation</div>
      {args.name && (
        <div className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-muted-foreground">Name</span>
          <span className="text-[13px] font-medium leading-[18px]">{args.name}</span>
        </div>
      )}
      {trigger && (
        <div className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-muted-foreground">Trigger</span>
          <div className="flex flex-col gap-1 rounded-md border border-border bg-background px-2.5 py-2">
            <span className="text-[13px] font-medium capitalize leading-[18px]">{(trigger.event_type || '').replace(':', ': ')}</span>
            {rrule && (
              <span className="w-fit break-words rounded-[4px] bg-blue-500/10 px-[5px] py-0.5 text-[13px] font-medium leading-[18px] text-blue-600 dark:text-blue-400">
                {formatRrule(rrule)}
              </span>
            )}
          </div>
        </div>
      )}
      {action && (
        <div className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-muted-foreground">Agent definition</span>
          <div className="flex flex-col gap-2 rounded-md border border-border bg-background px-2.5 py-2">
            <div className="flex flex-col gap-1">
              <span className="text-[13px] font-medium leading-[18px]">Agent type</span>
              <span className="text-[13px] leading-[18px] text-muted-foreground">
                {action.type === 'start_session' ? 'Start new session' : action.type}
              </span>
            </div>
            {action.prompt && (
              <div className="flex flex-col gap-1">
                <span className="text-[13px] font-medium leading-[18px]">Instructions</span>
                <span className="line-clamp-4 break-words text-[13px] leading-[18px] text-muted-foreground">{action.prompt}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function PermissionCard({ item, sessionId, resolved, onOpenSidebar }: { item: TimelineItem; sessionId: string; resolved?: 'approved' | 'denied'; onOpenSidebar?: () => void }) {
  const [busy, setBusy] = useState<PermissionAction | null>(null)
  const [local, setLocal] = useState<'approved' | 'denied' | null>(null)
  const [err, setErr] = useState(false)
  const state = resolved || local
  const perm = item.permission
  const autoArgs = useMemo<AutomationArgs | null>(() => {
    if (perm?.toolName !== 'devin_automation_manage' || !perm.toolArgs) return null
    try {
      const parsed = JSON.parse(perm.toolArgs) as AutomationArgs
      return parsed.action === 'create' ? parsed : null
    } catch { return null }
  }, [perm])
  // official respondApproval(request_id, 'approve' | 'deny', { autoRun }) -> approved + bypass_all_future
  const respond = useCallback(async (action: PermissionAction) => {
    if (!perm?.requestId || busy) return
    const approved = action !== 'deny'
    setBusy(action)
    setErr(false)
    try {
      const r = await adminFetch<{ ok: boolean }>(`/api/admin/session/${sessionId}/permission-response`, {
        method: 'POST',
        body: JSON.stringify({ request_id: perm.requestId, approved, bypass_all_future: action === 'approve_session' }),
      })
      if (r.ok) setLocal(approved ? 'approved' : 'denied')
      else setErr(true)
    } catch { setErr(true) } finally { setBusy(null) }
  }, [perm, sessionId, busy])
  return (
    <PermissionRequestCard
      item={item}
      resolved={state || undefined}
      busy={busy}
      error={err ? 'This request is no longer open' : undefined}
      onRespond={viewer().caps.canResolvePermission ? (a) => void respond(a) : undefined}
      onOpenSidebar={onOpenSidebar}
    >
      {autoArgs ? <AutomationRequestBody args={autoArgs} /> : undefined}
    </PermissionRequestCard>
  )
}

/**
 * Right-panel detail view opened from a permission card's "Open in sidebar"
 * button. Official structure: header "Permission request for <tool>" + full
 * read-only automation form (Name / Triggers / Agent definition /
 * Notifications / Advanced).
 */
function PermissionSidebarPanel({ item }: { item: TimelineItem }) {
  const [advOpen, setAdvOpen] = useState(true)
  const perm = item.permission
  const args = useMemo<AutomationArgs | null>(() => {
    if (!perm?.toolArgs) return null
    try { return JSON.parse(perm.toolArgs) as AutomationArgs } catch { return null }
  }, [perm])
  const trigger = args?.triggers?.[0]
  const rrule = trigger?.conditions?.any?.[0]?.all?.find((c) => c.field === 'rrule')?.value
  const action = args?.actions?.[0]
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-1.5 text-[14px]">
        <TriangleAlert size={14} className="shrink-0 text-muted-foreground" />
        <span>Permission request for</span>
        <span className="rounded bg-muted px-[3px] font-mono text-[13px]">{perm?.toolName || 'unknown'}</span>
      </div>
      {args?.action === 'create' && <div className="text-[13px] text-muted-foreground">Create an automation</div>}
      {args?.name !== undefined && (
        <div className="flex flex-col gap-1">
          <span className="text-[12px] text-muted-foreground">Name</span>
          <span className="text-[15px] font-medium">{args.name}</span>
        </div>
      )}
      {trigger && (
        <div className="flex flex-col gap-2">
          <div>
            <h3 className="text-[14px] font-medium">Triggers</h3>
            <p className="text-[13px] text-muted-foreground">Run automation when any of these conditions are met</p>
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-3">
            <CalendarIcon size={14} className="shrink-0 text-muted-foreground" />
            <span className="text-[13px]">{rrule ? formatRrule(rrule) : (trigger.event_type || '').replace(':', ': ')}</span>
          </div>
        </div>
      )}
      {action && (
        <div className="flex flex-col gap-2">
          <div>
            <h3 className="text-[14px] font-medium">Agent definition</h3>
            <p className="text-[13px] text-muted-foreground">Define what happens when triggers are activated</p>
          </div>
          <div className="flex flex-col gap-3 rounded-lg border border-border px-3 py-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-[13px] font-medium">Agent type</div>
                <div className="text-[13px] text-muted-foreground">Decide what the agent should do on new events</div>
              </div>
              <span className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[13px] text-muted-foreground">
                {action.type === 'start_session' ? 'Start new session' : action.type}
                <ChevronDown size={12} />
              </span>
            </div>
            {action.prompt && (
              <div className="flex flex-col gap-1">
                <div className="text-[13px] font-medium">Instructions</div>
                <div className="text-[13px] text-muted-foreground">Describe what the agent should do</div>
                <div className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted px-3 py-2 text-[13px] leading-relaxed">{action.prompt}</div>
              </div>
            )}
          </div>
        </div>
      )}
      <div>
        <h3 className="text-[14px] font-medium">Notifications</h3>
        <p className="text-[13px] text-muted-foreground">Alert when the automation run completes</p>
      </div>
      <div className="flex flex-col gap-2">
        <button onClick={() => setAdvOpen(!advOpen)} className="flex w-fit cursor-pointer items-center gap-1 text-[14px] font-medium">
          Advanced <ChevronDown size={13} className={cn('transition-transform', !advOpen && '-rotate-90')} />
        </button>
        {advOpen && (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-3">
            <div>
              <div className="text-[13px] font-medium">Allow auto-start of child sessions</div>
              <div className="text-[13px] text-muted-foreground">Sessions can spawn child sessions automatically without your approval</div>
            </div>
            <span aria-hidden className="relative h-5 w-9 shrink-0 rounded-full bg-muted"><span className="absolute left-0.5 top-0.5 size-4 rounded-full bg-background shadow" /></span>
          </div>
        )}
      </div>
      {!args && item.body && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted px-3 py-2 font-mono text-[12px] leading-relaxed">{item.body}</pre>
      )}
    </div>
  )
}


export { RRULE_DAYS, formatRrule, type AutomationArgs, AutomationRequestBody, PermissionCard, PermissionSidebarPanel };
