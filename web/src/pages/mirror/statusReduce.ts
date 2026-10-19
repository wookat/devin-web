import { cn } from '@/lib/utils'

type StatusReducerInput = {
  status?: string | null
  statusEnumRaw?: string | null
  statusMessage?: string | null
  statusShortMessage?: string | null
  queuePosition?: number
  sleepReason?: string | null
  thoughts?: string | null
  userActionRequired?: string | null
  isError?: boolean
  isSleeping?: boolean
  localWakeInFlight?: boolean
  readOnly?: boolean
  visitor?: boolean
}

type ReducedStatus = {
  enum: string
  message: string
  shortMessage: string
  inputDisabled: boolean
  isSleeping: boolean
  wakeable: boolean
  persona: 'thinking' | 'rest' | 'sleep' | 'wait'
  tailText: string
  placeholder: string
  sidebarStatus: string
  wakeText: string
}

function reduceStatus(input: StatusReducerInput): ReducedStatus {
  const e = input.statusEnumRaw || input.status || ''
  const statusMessage = input.statusMessage || ''
  const shortMessage = input.statusShortMessage || ''
  const finished = e === 'finished' || e === 'expired'
  const sleeping = !!input.isSleeping || !!input.sleepReason || input.isError === true || e === 'sleeping' || e === 'finished' || e === 'expired' || e === 'crashed' || e === 'suspend_requested' || e === 'suspend_requested_frontend'
  const terminalFinished = finished && (
    e === 'expired' ||
    shortMessage.includes('Session terminated') ||
    shortMessage.includes('Session Ended') ||
    shortMessage.includes('Session expired')
  )
  let message = statusMessage || 'Loading history…'
  let short = shortMessage || message
  let inputDisabled = false
  let persona: ReducedStatus['persona'] = 'wait'
  let tailText = 'Devin is awaiting instructions'
  switch (e) {
    case 'working':
    case 'resumed':
    case 'restored':
      persona = input.thoughts || input.isSleeping === false ? 'thinking' : 'rest'
      message = statusMessage || (e === 'restored' ? 'Checkpoint restored' : 'Devin is working…')
      short = shortMessage || message
      tailText = input.thoughts || message
      break
    case 'initializing':
      persona = 'thinking'
      message = statusMessage || 'Loading history…'
      short = shortMessage || message
      tailText = statusMessage === 'Devin is starting up…' ? 'Setting up…' : message
      break
    case 'resume_requested':
    case 'resume_requested_frontend':
      persona = 'thinking'
      message = statusMessage || 'Devin is waking up.'
      short = shortMessage || message
      tailText = 'Setting up…'
      break
    case 'suspend_requested':
    case 'suspend_requested_frontend':
      persona = 'sleep'
      inputDisabled = true
      message = statusMessage || 'Going to sleep …'
      short = shortMessage || message
      tailText = 'Going to sleep…'
      break
    case 'paused':
    case 'stopped':
      persona = 'wait'
      message = statusMessage || 'Send a message to resume'
      short = shortMessage || message
      tailText = 'Send a message to resume'
      break
    case 'queued':
      persona = 'wait'
      message = input.queuePosition
        ? `High server load. Devin is waiting for capacity. Queue Position: ${input.queuePosition}...`
        : 'High server load. Devin is waiting for capacity...'
      short = shortMessage || 'Devin is queued'
      tailText = message
      break
    case 'crashed':
      persona = 'sleep'
      message = statusMessage || 'Devin crashed'
      short = shortMessage || message
      tailText = message
      break
    case 'expired':
      persona = 'sleep'
      inputDisabled = true
      message = statusMessage || 'Session is too old to be revived'
      short = shortMessage || 'Session expired'
      tailText = short
      break
    case 'waiting':
      persona = 'wait'
      inputDisabled = true
      message = statusMessage || 'Devin is reverting to a previous checkpoint'
      short = shortMessage || message
      tailText = message
      break
    case 'blocked':
      persona = 'wait'
      message = statusMessage || 'Devin is awaiting your response'
      short = shortMessage || message
      tailText = input.userActionRequired
        ? `Action required: ${input.userActionRequired}`
        : statusMessage === 'Waiting for your response'
          ? 'Send a message to resume'
          : 'Devin is awaiting instructions'
      break
    case 'finished':
      persona = 'sleep'
      inputDisabled = terminalFinished
      message = statusMessage || 'Session terminated'
      short = shortMessage || message
      tailText = sleeping ? (statusMessage || 'Devin went to sleep…') : short
      break
    default:
      persona = sleeping ? 'sleep' : 'wait'
      message = statusMessage || 'Loading history…'
      short = shortMessage || message
      tailText = sleeping ? message : 'Devin is awaiting instructions'
      break
  }
  const wakeable = !['expired', 'crashed'].includes(e) && !terminalFinished
  const placeholder = input.readOnly
    ? 'Typing is disabled during replay'
    : statusMessage === 'Devin is starting up…'
      ? 'Devin is starting up…'
      : e === 'resume_requested' || e === 'resume_requested_frontend'
        ? 'Waiting for Devin to wake up…'
        : e === 'working'
          ? input.visitor ? 'Guide Devin while it works' : 'Guide Devin while it works, or press Ctrl ↵ to queue'
          : (e === 'blocked' || sleeping || finished)
            ? 'Ask Devin to build features, fix bugs, or work on your code'
            : 'Message Devin…'
  const sidebarStatus = e === 'working' || e === 'running' || e === 'resumed' || e === 'restored'
    ? 'working'
    : e === 'blocked' || e === 'waiting' || e === 'paused' || e === 'stopped' || e === 'queued' || e === 'initializing'
      ? 'waiting'
      : sleeping ? 'sleeping' : finished ? 'finished' : 'waiting'
  return {
    enum: e,
    message,
    shortMessage: short,
    inputDisabled,
    isSleeping: sleeping,
    wakeable,
    persona,
    tailText,
    placeholder,
    sidebarStatus,
    wakeText: input.localWakeInFlight || e === 'resume_requested' || e === 'resume_requested_frontend' ? 'Connecting…' : 'Wake Devin up?',
  }
}

function mapEnum(e: string): string {
  return reduceStatus({ statusEnumRaw: e }).sidebarStatus
}

/** Official-style sidebar row: status dot, truncated title, unread dot, nested children. */
/** Official sidebar-menu-action mechanics: w-0/opacity-0, expands to w-6 on row hover / focus-within / open menu. */
function actionCls(forceVisible: boolean): string {
  return cn(
    'relative flex aspect-square cursor-pointer items-center justify-center overflow-hidden rounded-md p-0 text-muted-foreground outline-none transition-all hover:text-foreground focus:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-blue-500',
    forceVisible
      ? 'w-6 opacity-100'
      : 'w-0 opacity-0 group-has-[:focus-visible]/row:w-6 group-has-[:focus-visible]/row:opacity-100 group-hover/row:w-6 group-hover/row:opacity-100',
  )
}


export { type StatusReducerInput, type ReducedStatus, reduceStatus, mapEnum, actionCls };
