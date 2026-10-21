import { Search } from 'lucide-react'
import { type TimelineItem } from '@/components/Timeline'
import { type LocalCfg } from './pageBits'

interface ComposerMetaT {
  commands: { command: string; description: string; hint?: string }[]
  skills: { name: string; description: string; repo: string }[]
  playbooks: { name: string; shortcut: string; author: string }[]
  secrets: { name: string; description: string }[]
  macros: { name: string; description: string }[]
  repos: { name: string; org: string }[]
  sessions: { id: string; title: string; snippet: string }[]
  /** Enabled ACP agents for the draft picker's agent dropdown. */
  agents?: { id: string; label: string }[]
  /** Server's own cwd — the workspace a session lands in when none is picked. */
  primary_cwd?: string
  /** Agent-level config so the /admin/new composer shows real mode+model pills. */
  cfg?: LocalCfg
  /** dw.json lastConfig — the picks a fresh session inherits. */
  last_config?: Record<string, string>
  /** prefs.sshHosts — run targets for the draft page's local/remote picker.
   *  Secrets are never echoed (hasPassword/hasPassphrase flags only). */
  ssh_hosts?: { name?: string; target: string; cwd?: string; auth?: 'agent' | 'password' | 'key'; keyPath?: string; hasPassword?: boolean; hasPassphrase?: boolean }[]
}

interface SuggestItem {
  key: string
  title: string
  sub: string
  insert: string
  cat?: string
}

// Official queued-row icons (bundle queued-messages chunk, sampled 2026-08-31):
// default = IconCircleDashed, hover/drag = IconDotGrid2x3 drag handle.
const QUEUE_DASHED_SVG = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M11.120 2.041 C 10.591 2.091,10.199 2.160,10.074 2.224 C 9.922 2.301,9.725 2.555,9.696 2.709 C 9.625 3.084,9.828 3.448,10.182 3.583 C 10.347 3.646,10.393 3.646,10.874 3.585 C 11.482 3.508,12.350 3.501,13.020 3.567 C 13.545 3.618,13.637 3.607,13.842 3.471 C 14.166 3.256,14.258 2.729,14.025 2.424 C 13.869 2.218,13.677 2.137,13.227 2.084 C 12.680 2.021,11.574 1.998,11.120 2.041 M16.767 3.646 C 16.362 3.846,16.244 4.381,16.527 4.739 C 16.572 4.797,16.816 4.999,17.070 5.189 C 17.541 5.541,18.111 6.080,18.632 6.669 C 18.866 6.933,18.956 7.007,19.091 7.043 C 19.593 7.178,20.040 6.832,20.040 6.307 C 20.040 6.056,19.989 5.968,19.539 5.441 C 19.222 5.070,18.897 4.749,18.460 4.375 C 18.178 4.134,17.575 3.691,17.413 3.606 C 17.271 3.532,16.958 3.551,16.767 3.646 M6.460 3.696 C 6.275 3.778,5.603 4.306,5.151 4.724 C 4.927 4.931,4.559 5.323,4.332 5.596 C 3.815 6.219,3.750 6.407,3.930 6.759 C 3.979 6.856,4.089 6.990,4.174 7.058 C 4.309 7.165,4.358 7.180,4.574 7.178 C 4.709 7.177,4.869 7.155,4.928 7.130 C 4.987 7.104,5.166 6.925,5.326 6.732 C 5.716 6.258,6.419 5.569,6.816 5.271 C 7.235 4.956,7.353 4.846,7.429 4.701 C 7.509 4.548,7.509 4.212,7.430 4.059 C 7.249 3.712,6.801 3.545,6.460 3.696 M20.747 9.216 C 20.554 9.288,20.452 9.380,20.353 9.573 C 20.253 9.769,20.254 9.911,20.361 10.500 C 20.422 10.835,20.455 11.212,20.469 11.748 C 20.498 12.791,20.422 13.400,20.135 14.448 C 20.017 14.877,20.001 14.979,20.036 15.103 C 20.196 15.683,20.857 15.887,21.278 15.486 C 21.401 15.369,21.452 15.272,21.535 15.000 C 21.891 13.830,22.029 12.805,21.986 11.640 C 21.952 10.694,21.791 9.729,21.629 9.492 C 21.451 9.233,21.046 9.105,20.747 9.216 M2.618 9.419 C 2.509 9.474,2.381 9.577,2.333 9.649 C 2.228 9.806,2.105 10.416,2.037 11.120 C 1.983 11.686,2.010 12.965,2.083 13.220 C 2.210 13.668,2.685 13.916,3.091 13.746 C 3.241 13.684,3.518 13.392,3.525 13.290 C 3.527 13.251,3.533 12.716,3.537 12.100 C 3.543 11.148,3.557 10.908,3.631 10.497 C 3.728 9.954,3.713 9.812,3.530 9.596 C 3.401 9.442,3.151 9.322,2.958 9.321 C 2.880 9.320,2.727 9.365,2.618 9.419 M3.740 16.153 C 3.579 16.256,3.454 16.396,3.403 16.533 C 3.340 16.699,3.351 16.986,3.426 17.132 C 3.540 17.354,3.881 17.846,4.193 18.240 C 4.570 18.716,5.506 19.644,5.708 19.744 C 6.278 20.024,6.925 19.491,6.759 18.878 C 6.721 18.735,6.614 18.608,6.126 18.123 C 5.583 17.584,5.245 17.178,4.796 16.524 C 4.552 16.168,4.456 16.105,4.129 16.089 C 3.916 16.079,3.835 16.092,3.740 16.153 M18.470 17.657 C 18.379 17.690,18.164 17.860,17.928 18.086 C 17.463 18.533,16.917 18.950,16.330 19.308 C 15.805 19.627,15.768 19.659,15.675 19.860 C 15.580 20.067,15.581 20.286,15.676 20.472 C 15.834 20.778,16.137 20.950,16.445 20.908 C 16.869 20.852,18.435 19.741,19.130 19.005 C 19.484 18.630,19.555 18.386,19.404 18.060 C 19.315 17.866,19.188 17.744,18.991 17.662 C 18.812 17.587,18.670 17.586,18.470 17.657 M9.360 20.207 C 8.915 20.333,8.687 20.811,8.876 21.220 C 8.964 21.412,9.091 21.535,9.283 21.615 C 9.505 21.708,10.569 21.908,11.123 21.961 C 11.787 22.025,12.697 21.999,12.860 21.912 C 13.224 21.717,13.378 21.270,13.202 20.923 C 13.039 20.604,12.742 20.454,12.353 20.494 C 11.842 20.548,10.708 20.429,9.900 20.237 C 9.542 20.152,9.553 20.152,9.360 20.207" stroke="none" fill-rule="evenodd" fill="currentColor"/></svg>'
const QUEUE_DRAG_SVG = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8.810 4.062 C 8.394 4.174,8.045 4.423,7.794 4.789 C 7.337 5.453,7.433 6.399,8.017 6.983 C 8.601 7.567,9.547 7.663,10.211 7.206 C 11.128 6.576,11.265 5.322,10.504 4.542 C 10.063 4.091,9.400 3.903,8.810 4.062 M14.340 4.056 C 13.057 4.375,12.567 5.948,13.452 6.908 C 14.000 7.503,14.781 7.659,15.511 7.320 C 16.445 6.886,16.788 5.635,16.206 4.789 C 15.779 4.168,15.047 3.881,14.340 4.056 M8.830 10.201 C 7.958 10.420,7.379 11.313,7.519 12.223 C 7.670 13.203,8.567 13.883,9.505 13.728 C 10.426 13.575,11.047 12.787,10.990 11.842 C 10.977 11.637,10.935 11.412,10.885 11.280 C 10.717 10.842,10.321 10.445,9.880 10.274 C 9.632 10.178,9.078 10.139,8.830 10.201 M14.230 10.235 C 13.473 10.486,12.999 11.150,13.000 11.958 C 13.002 12.851,13.620 13.583,14.495 13.728 C 15.219 13.848,15.973 13.454,16.299 12.786 C 16.761 11.841,16.406 10.764,15.490 10.329 C 15.233 10.207,15.147 10.187,14.827 10.174 C 14.544 10.163,14.408 10.176,14.230 10.235 M8.691 16.592 C 7.751 16.927,7.276 17.932,7.615 18.870 C 7.697 19.097,7.871 19.345,8.092 19.548 C 8.834 20.232,10.051 20.110,10.652 19.291 C 11.310 18.395,10.985 17.146,9.970 16.669 C 9.733 16.557,9.652 16.541,9.300 16.530 C 8.989 16.521,8.854 16.535,8.691 16.592 M14.219 16.590 C 13.916 16.698,13.677 16.852,13.472 17.071 C 12.479 18.132,13.166 19.878,14.620 19.989 C 15.246 20.036,15.838 19.746,16.206 19.211 C 16.793 18.357,16.458 17.148,15.502 16.678 C 15.251 16.554,15.187 16.540,14.822 16.530 C 14.514 16.521,14.373 16.535,14.219 16.590" stroke="none" fill-rule="evenodd" fill="currentColor"/></svg>'

// Official running-composer placeholder (Slate DOM sampled 2026-08-31):
// "Guide Devin while it works, or press <kbd>Ctrl</kbd><kbd>[enter]</kbd> to queue".
const QUEUE_ENTER_SVG = '<svg class="max-h-[12px] max-w-[12px]" aria-hidden="true" width="24px" height="24px" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M19.938 4.073 C 19.718 4.176,19.576 4.358,19.524 4.601 C 19.494 4.740,19.480 6.173,19.480 9.172 L 19.480 13.540 19.366 13.782 C 19.232 14.065,18.964 14.320,18.688 14.427 C 18.509 14.496,18.184 14.501,12.050 14.511 C 8.502 14.517,5.600 14.508,5.600 14.492 C 5.600 14.475,6.237 13.822,7.016 13.041 C 8.377 11.675,8.434 11.612,8.472 11.424 C 8.495 11.316,8.507 11.208,8.500 11.184 C 8.493 11.160,8.476 11.091,8.463 11.031 C 8.434 10.897,8.228 10.657,8.076 10.578 C 7.945 10.510,7.614 10.502,7.453 10.562 C 7.391 10.585,6.390 11.553,5.229 12.712 C 3.548 14.392,3.106 14.854,3.054 14.990 C 2.969 15.213,3.000 15.478,3.134 15.671 C 3.191 15.753,4.152 16.733,5.269 17.848 C 6.661 19.238,7.347 19.896,7.449 19.938 C 7.737 20.058,8.103 19.978,8.315 19.747 C 8.504 19.542,8.543 19.153,8.401 18.879 C 8.373 18.825,7.728 18.155,6.967 17.391 L 5.584 16.001 12.182 15.991 L 18.780 15.980 19.060 15.886 C 19.512 15.736,19.832 15.535,20.184 15.184 C 20.545 14.822,20.744 14.498,20.887 14.040 L 20.980 13.740 20.980 9.113 C 20.980 4.500,20.980 4.486,20.897 4.375 C 20.645 4.037,20.268 3.918,19.938 4.073 " stroke="none" fill-rule="evenodd" fill="currentColor"></path></svg>'
const QUEUE_PLACEHOLDER = (
  <span className="opacity-[0.333]">
    Guide Devin while it works, or press{' '}
    <kbd className="inline-flex items-center gap-[2px] align-text-bottom">
      <kbd className="inline-flex h-4 items-center justify-center rounded-[2px] bg-muted px-[4px] font-sans text-[11px] text-muted-foreground">Ctrl</kbd>
      <kbd className="inline-flex aspect-square size-4 items-center justify-center rounded-[2px] bg-muted font-sans text-[11px] text-muted-foreground [&_svg]:max-h-[12px] [&_svg]:max-w-[12px]" dangerouslySetInnerHTML={{ __html: QUEUE_ENTER_SVG }} />
    </kbd>{' '}
    to queue
  </span>
)

// `@` mention categories backed by real local data — playbooks/secrets/
// macros/plugins have no local source (composer-meta returns []), so they
// are intentionally absent rather than listed as dead empty categories.
const AT_CATEGORIES: { cat: string; title: string; sub: string }[] = [
  { cat: 'repos', title: 'Workspaces', sub: 'Local workspace directories' },
  { cat: 'sessions', title: 'Sessions', sub: 'Local Devin sessions' },
  { cat: 'files', title: 'Files', sub: 'Files in the session workspace' },
  { cat: 'skills', title: 'Skills', sub: 'Local .devin/.agents skills' },
]

type Group =
  | { type: 'work'; items: TimelineItem[]; seconds: number }
  | { type: 'row'; item: TimelineItem }
  | { type: 'item'; item: TimelineItem }


// Official prod hides lifecycle status transitions from the transcript (the
// sleep persona line and "awaiting instructions" rows are rendered separately);
// status_update itself only feeds the header status line, never a worklog row.
const LIFECYCLE_STATUSES = new Set([
  'working', 'blocked', 'finished', 'Devin went to sleep', 'Resuming session', 'resume_requested',
])
function isLifecycleStatus(it: TimelineItem): boolean {
  return it.kind === 'status' && !it.callout && (it.raw_type === 'status_update' || LIFECYCLE_STATUSES.has(it.title || ''))
}

// Official coach finding recommendations (en locale bundle, verbatim).

export { type ComposerMetaT, type SuggestItem, QUEUE_DASHED_SVG, QUEUE_DRAG_SVG, QUEUE_ENTER_SVG, QUEUE_PLACEHOLDER, AT_CATEGORIES, type Group, LIFECYCLE_STATUSES, isLifecycleStatus };
