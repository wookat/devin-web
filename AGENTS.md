# devin-workbench-local

Local, LAN-accessible Devin workbench: `devin-workbench-v2` cloud-style frontend
on top of local `devin acp` processes, with multi-account rotation on SWE rate limits.

## Build / run

```cmd
npm run build                       :: vite + tsc → dist/
deploy.bat                          :: build + free :7791 + clean orphan acp + start
:: or manually:
set DEVIN_REMOTE_ALLOWED_HOSTS=192.168.6.251:7791
node dist\server\index.js --host 0.0.0.0 --port 7791
```

Self-redeploy (once the new server is up — no more manual deploy.bat):
`POST /api/admin/redeploy` runs `npm run build` (~1-3min), then respawns
via the DETACHED `scripts/respawn.mjs` helper and exits.
`POST /api/admin/restart` skips the build. UI: header `…` menu → 服务 →
重启服务 / 重新构建并重启; the page then polls /api/accounts (down→up)
and reloads — do NOT use a fixed sleep, the build window is
unpredictable. Build failure keeps the old server alive. Agents can also
`curl -X POST localhost:7791/api/admin/redeploy` — the call kills the
caller's own acp along with the server; the session replays on next use.
Before exiting, the server drains in-flight prompts and waits as long as
they take — a deploy NEVER kills an in-flight turn (a wedged prompt is
ended via End session / Restart agent in the UI, which releases the drain);
it logs a `waiting on N inflight` heartbeat every 30s meanwhile.
Interrupted-turn recovery: `dispatchPrompt` records the outgoing message in
`<dataDir>/open-turns.json` and clears it when the prompt settles — an entry
surviving at boot means the server died mid-turn. A successful settle also
appends `wb_turn_end` to the session log (errors append `wb_notice`); both
survive replay via the tail re-append and are NOT timeline rows (tlPush
skips them). `interruptedTurn()` (exported from sessionio) feeds
`interrupted` on the /timeline response: open-turns evidence first, then a
log tail with a user message but no turn boundary — for pre-marker logs
only when the tail ends on a bare tool_call/thought (a finished turn never
does). The client shows an amber resume banner — the `kind` field picks the
action: 'continue' (turn reached the agent → sends 继续) vs 'resend'
(prompt never echoed → replays the original message+attachments);
dismissal persisted in `wb2-intd:<id>`. `autoResumeInterrupted(ctx)` runs
4s after listen when wb.json `prefs.autoResume` is on (max 2 attempts per
turn, `resumeCount` carried through dispatchPrompt) — it resumes crashed
turns WITHOUT any tab open. `GET/POST /api/admin/prefs` backs the
`/settings` page (official Preferences-style layout) whose send-shortcut /
theme rows read the same localStorage keys the session page does.
respawn.mjs is pure node: waits for the port via net.connect, cleans
orphaned acp children, spawns the server detached with stdio →
`<dataDir>/server.log` (4MB-rotated), its own steps →
`<dataDir>/respawn.log`. If a respawn ever dies silently, read those two
logs FIRST. `respawn.bat` is only a shim for the old build's
`cmd /c respawn.bat` spawn.

## Test

```cmd
npm test                            :: read-only API smoke (test/api-smoke.mjs)
node test/api-smoke.mjs --send      :: + real prompt round-trip (costs tokens)
node test/api-smoke.mjs --id <sid>  :: target a specific session
npm run typecheck                   :: server + web tsc
powershell -File clean-orphans.ps1  :: kill acp processes with dead parents
```

## Gotchas

- `session/load` locks a session to ONE acp process (`session_locked`,
  retryable). `sessionHost` in `server/src/sessionio.ts` pins ops to the host
  process — never re-resolve cwd for a loaded session (session/list rewrites
  `sessionCwd` and would bounce it to the other pooled acp).
- Server module map: `localwb.ts` = wb.json registry routes + workspace index
  + the big admin/share router; `sessionio.ts` = hostFor (the ONE session→acp
  resolver: dedicated → sessionHost pin → cwd pool), load/replay dedup, live
  config, attachmentBlocks, promptWithRetry (the ONE rate-limit retry policy:
  cool acp.account → rotate → resend once → status 429 when all cooling),
  dispatchPrompt, subagents, session listing; `wbtimeline.ts` = log→WbItem
  builder + tlCache + noteUpdate deltas + tail snapshots; `wbstore.ts` =
  wb.json registry (meta/folders/pins/lastConfig). `sessionSubs` in localwb.ts
  is the shared admin/share subroute table — add identical-semantics subs there
  (message/upload/file-contents/dashboard), keep sanitized share-only or
  admin-only subs in the branches.
- Attachments are STRUCTURED: dispatchPrompt stores `attachments[]` on the
  `_local` log entry → `WbItem.attachments` → `TimelineItem.attachments`.
  Legacy `ATTACHMENT:"url"` marker lines in old persisted tails are still
  parsed by `splitAttachments` as fallback — keep it.
- `AdminMirror.tsx` = the page component only (~4.3k). Everything else lives in
  `web/src/pages/mirror/`: glyphs, treeCache, composerMeta, timelineUtil,
  dialogs, VoiceButton, Sidechat, ResourcePanels, TimelineRows, Permission,
  ChangesPanel, ComputerPanel, attachments, ViewerPanels, ProgressPanels,
  PrPanel, WorkspacePanel, AgentsPanel, panelTabs, statusReduce, SessionTree,
  pageBits.
- `session/new` and `session/load` carry `modes` + `configOptions` in the
  RESPONSE, not notifications — captured via `captureLoadResponse`. Old loaded
  sessions get the last-seen agent-level config as fallback (`lastAgentCfg`).
- `mode` is dual-exposed: `modes` (set via `session/set_mode`) + a `configOptions`
  mirror group that lags. `POST .../config` routes both `mode` and `_mode` to
  set_mode.
- Frontend mode pill reads `GET /config`; when `model` is present it renders the
  real ACP option groups, else falls back to the cloud Ultra/Fusion menu.
- Windows: force-killing node orphans the acp children holding session locks —
  run `clean-orphans.ps1` (deploy.bat already does it in the right order).
- Two WS endpoints coexist: `/ws` (broadcast hub) + `/ws/term` (interactive
  shell in the session cwd, JSON frames `{d}`). A `ws` WebSocketServer bound
  with `server`+`path` aborts (400) every non-matching upgrade — both endpoints
  use `noServer` + manual `server.on('upgrade')` routing.
- `wb.json` `lastConfig` remembers the last model/mode/effort/speed pick and
  `POST /api/admin/sessions/new` applies it (desktop carries the pick forward).
- New-session flow mirrors desktop: `/` redirects to `/admin/new`, which is the
  `id === 'new'` draft sentinel inside AdminMirror — centered composer
  (`mt-auto` empty state + `mb-auto` footer), no session endpoints fire, first
  send POSTs `/api/admin/sessions/new` {task,folder,cwd} then `nav(replace)`
  into `/admin/<id>`. Draft model/mode pills mutate `lastSeenLocalCfg` +
  `draftPicks` (replayed via /config after create); `wb2-new-session-draft`
  sessionStorage hands text between pages. `composer-meta` response carries
  `primary_cwd` for the draft workspace picker. `/admin/new` must stay out of
  every session-scoped fetch (main.tsx boot prefetch excludes it).
- Header settings menu is LOCAL-only: Send-with (localStorage), Rename/Folder/
  Archive (wb.json), Copy link (`/s/<id>?t=local`), Share-to-cloud + End session
  (verified `_cognition.ai/*` ext), Restart agent process (`POST .../restart` →
  `restartSession` kills the hosting acp; next op respawns + replays — pooled
  hosts shared by other sessions heal via hostFor's exited-pin check). The
  cloud keep-alive/tags/reboot/reset-token entries were stubs — removed.
- `ATTACH_URL_RE` (web/src/pages/mirror/attachments.ts) extracts attachment
  URLs from message text — uploads branch REQUIRES the `{uuid}-{name}` id
  shape, share branch requires non-empty `file/<name>`/`url=` param, backticks
  excluded everywhere. Loosening it re-breaks prose mentions (`/api/uploads/*`
  inside code spans became bogus file chips + ate text mid-sentence).
- `@files` mentions come from `/api/admin/mirror/indexed-paths?session=<id>`
  (bounded BFS of the session cwd, 60s cache); `@skills` from local
  `.devin/skills` + `.agents/skills` dirs (project + user).
- `devin acp` promptCapabilities: `image: true`, `embeddedContext: true`,
  `resource_links` — `/message` accepts `attachments: [{url,name}]` pointing at
  `/api/uploads/<id>`; images go as base64 `image` blocks, text files ≤512KB as
  embedded `resource`, the rest as `file://` `resource_link`.
- Upload contract is RAW BODY + `?filename=` (`POST .../upload-stage` for admin,
  `.../upload` or `.../upload-stage` for share) — `saveUpload` streams req
  verbatim, NO multipart parsing. Sending FormData saves the whole multipart
  envelope (boundary+headers) to disk and loses the filename → `upload.bin` →
  octet-stream → `resource_link` instead of an inline image. Frontend must
  `body: file` directly; synthesize a name from `file.type` when `file.name`
  is empty (clipboard pastes).
- `session/list` `_meta` carries `cognition.ai/isLocked` + `lockHolderPid` +
  `createdAt` — surfaced as `is_locked`/`loaded_here`/`created_at`/`cwd` on
  tree rows (amber lock icon = held by ANOTHER process, e.g. desktop/CLI).
- Workspace browser: `GET session/:id/files?path=` (list, cwd-confined) and
  `/file?path=` (text ≤2MB, binary flagged). Rendered by WorkspacePanel on the
  'editor' tab (cloud vscode link never exists locally).
- Sidebar `prefs.groupBy: 'project'` buckets ungrouped sessions by cwd.
- POSTing `/version` against a session locked by another acp returns 500
  (`session_locked`, retried 5x) — expected; the smoke test should target an
  unlocked session (`--id lucky-badger`).
- Public access: Cloudflare Tunnel `devin-workbench` (id cb705fa8) runs as the
  `Cloudflared` Windows service (token-managed, survives reboots). Ingress maps
  `devin-local.zalize.com` (+ `devin.zalize.com`) → http://127.0.0.1:7791. Any
  new public hostname MUST also be added to DEVIN_REMOTE_ALLOWED_HOSTS.
  NOTE: the workbench has no auth — anyone with the URL has full control.
  `devin.zalize.com` itself 404s: its DNS is a read-only AAAA→100:: record
  managed by another CF product (undeletable via API key).
- `session/load` counts as ACTIVITY — it bumps the session's `updatedAt` and
  replays the full history. Sidebar prefetch (`prefetchSession`) must only hit
  memory-only endpoints (slim detail); never prefetch timeline/config or every
  hover loads history + marks sessions "just now".
- Load dedup: `loadInflight` in sessionio.ts shares one replay per session.
  /timeline kicks `ensureLoaded` without awaiting (progressive fill, shows
  "Loading history…" via `loadInflight.has`). Only timeline/config/mutations
  trigger loads; detail/changes/messages/todos are memory-only.
- Full history lives on DISK: `sessionLog` write-through appends every update
  to `<dataDir>/log/<id>.jsonl` — the in-memory ring (5000) is only the live
  window. `tlCache`/`buildTimeline` seeds from `readDisk` on cold start, log
  `gen` bump (clear before re-replay), or an unconsumed-eviction gap
  (`headSeq > seenSeq+1`) — so /timeline backfill reaches the complete
  history. Entries carry `seq` (per-session monotonic, resumes from the file
  tail across restarts) → item ids are `e<seq>`, stable across rebuilds; the
  client cursor stays an index into the items array either way. `clear()`
  does NOT truncate — it renames the file to `.jsonl.bak` before a re-replay:
  `dropBackup` on success, `restoreFile`+`restoreMemory` on failure (a
  `session_locked`/dead-acp load must not erase the transcript), and a
  constructor sweep restores a fuller `.bak` after a mid-replay crash.
  After a successful replay, `doLoad` re-appends the unreplayed tail
  (anchor-matched past the last entry devin's store covered) so a just-
  finished exchange can't vanish on refresh. Devin ALSO re-pushes the last
  streamed message as live deltas right after session/load — those echoes
  reuse the original `cognition.ai/streamingMessageId` (replayed copies lack
  it), so `doLoad` harvests pre-clear ids into `replayEchoIds` and
  `isReplayEcho` drops the re-push at the append gate in index.ts. Never
  dedup by text alone — consecutive identical replies ("收到" twice) are
  legitimate; the smid is what separates an echo from a new turn.
- `session/list` `updatedAt` may be absent — persist last-seen into
  `wb.json` meta (`m.updatedAt`); never fall back to `new Date()`.
- `snippet()` from a built timeline is O(log); the sidebar uses
  `snippetFromLog` (tail-scan) for the same reason.

## Live screen / embedded browser (Computer tab)

- **Desktop view (read-only)**: `GET /api/admin/screen/live` → MJPEG.
  `server/src/screen.ts` compiles `scripts/screencap.cs` once per machine
  with the in-box .NET Framework `csc.exe` → `<dataDir>/screencap/`
  (sha-stamped; a .ps1 doing CopyFromScreen loops gets AMSI-blocked —
  do NOT reintroduce a PowerShell capture script). The capture child
  dies when the last MJPEG client disconnects.
- **Embedded browser (interactive)**: `/ws/browser` ↔ a dedicated
  Edge/Chrome (`<dataDir>/browser-profile`, CDP on 127.0.0.1).
  `server/src/localbrowser.ts` launches with `--remote-debugging-port=0`
  and discovers the endpoint via `<profile>/DevToolsActivePort` — the
  launcher hands off and exits, so stderr/proc lifetime are useless.
  `adopt()` reuses a still-running instance (port file + /json/version
  ping); `killStale()` clears profile-singleton squatters. Frames come
  from `Page.startScreencast`; input goes through `Input.dispatch*` with
  client coords normalized (u,v scaled by screencast metadata).
- Desktop input (real mouse/keyboard) is deliberately NOT exposed — the
  workbench has no auth, and the tunnel URL would become remote control
  of the host PC. Both surfaces are admin-tree only; the share tree
  never sees them.
- Frontend: `web/src/pages/mirror/LocalLive.tsx` (桌面|浏览器 toggle)
  replaces the cloud-only noVNC `LiveDesktop` in `ComputerPanel` when
  `canControl && !shots`. Text input rides a transparent textarea →
  `Input.insertText` (IME + local-clipboard paste work); control keys
  and chords go as `rawKeyDown`/`keyUp` with a VK map.

## Accounts / quota / context

- `/api/accounts` rows carry `info` — normalized GetUserStatus fields
  (email, plan, daily/weeklyQuotaRemainingPercent, overageBalanceUsd,
  planEnd, reset timestamps). Cached 60s per key; stale reads kick a
  background refresh, `POST /api/accounts/refresh {name?}` forces it.
- `current` vs `picked`: `current` is DISPLAY (the in-use account, shown even
  while cooling — never collapses to "无账号" when all cool); `picked` is the
  healthy spawn target (`accounts.pick()`, null when all cooling). Rows carry
  both flags.
- Cooldown marks merge own `accounts-state.json` + daemon `state.json`
  (Math.max); expired marks are pruned at read time. `POST
  /api/accounts/unlimited {name}` clears a mark in BOTH files (bogus/stale
  mark or user-verified healthy). `POST /api/accounts/rotate {target?}` —
  target picks a specific account; no target = next healthy.
- Rotation MUST kill pooled acp processes — they hold the old key in their
  spawn env (`WINDSURF_API_KEY`, which overrides credentials.toml per
  devin-rotate's own docs). Never skip `killPooled` on "next === from": after
  markLimited, pick() already returns the rotate target, so that comparison
  silently left the failed process alive while state said "switched".
  `killPooled(agent, keep)` spares processes already on the target;
  `acp.kill()` flips `exited` eagerly (the 'exit' event lags) so hostFor can
  never hand back a dying process. `onRateLimited` is gated by loadInflight —
  replayed agent-log lines must not mark accounts.
- GetUserStatus is a Connect-JSON call to
  `server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus`.
  The session token goes in the REQUEST BODY `metadata.api_key` — NOT an
  Authorization header (every header variant returns 400). Body shape:
  `{metadata:{api_key,ide_name,ide_version,extension_name,extension_version,os_name}}`.
- Add account: `POST /api/accounts {name,key}` (paste token, validated
  `devin-session-token$` prefix) or browser PKCE:
  `POST /api/accounts/login/start` → `{url,id}` opens
  `app.devin.ai/auth/cli/continue`; user pastes the code into
  `POST /api/accounts/login/finish {id,code,name?}` which exchanges at
  `app.devin.ai/api/auth/cli/token` and names the row after the account
  email. `DELETE /api/accounts/:name` rebuilds accounts.toml without it.
  Both share the file with devin-rotate — no restart needed.
- Session detail `session.context_usage` = latest root-chain
  `usage_update`: `{used,size,inputTokens,outputTokens,cachedReadTokens,
  totalAcuCost,ts}`. Rendered as a chip next to the composer model pill.
  Subagent usage_updates are filtered out by `subagent_context` meta.

## Subagent protocol (verified against live wire + devin.exe + desktop bundle)

- Spawn = `tool_call` on `run_subagent`; `rawInput` carries
  `title/task/profile/is_background` and `resume:"<agentId>"` when the lead
  resumes an existing agent. Lifecycle = `tool_call_update` on the child's OWN
  root toolCallId (= agentId, ≠ the spawn call's id) with
  `cognition.ai/subagent_started` (title/profile/depth/isBackground/model/agentId)
  or `cognition.ai/subagent_completed` (success/summary) in `_meta`. Child
  events carry `cognition.ai/subagent_context.parentAgentId=<agentId>`.
- Replay strips lifecycle meta + child events — spawn calls still arrive, so
  rows seed from `rawInput` as `spawn:<toolCallId>` pseudo-ids (no controls,
  no transcript). Live rows adopt their real id from `subagent_started` via a
  FIFO pendingSpawns queue in tlPush; `resume` calls tag the existing agentId.
- Controls: `_cognition.ai/subagent/{cancel,foreground,background}` extMethods
  via `POST .../subagent/:aid/control` — verified `{}` on live agents.
- Client→subagent messaging does NOT exist on this agent build: prompt `_meta`
  (`subagent_context`, `chain:{side:id}`, block-level metas) is ignored and
  `_cognition.ai/sidechain/request` returns Method not found. The only real
  path — same one desktop/lead uses — is `run_subagent(resume="<id>")`, which
  the lead agent invokes (officially documented: "ask the agent to resume a
  subagent"; resumed agents run foreground). `/subagent/:aid/message` and the
  `sub:` child-session `/message` therefore send an imperative relay on the
  main chain: `[Subagent relay] Call run_subagent(resume="<id>", task=<message>)
  now … User message: "<json-quoted>"`. The wording MUST stay imperative with
  the user text JSON-quoted — a loose "relay this message" phrasing lets the
  lead misread the body as a task for itself (observed: it debugged the
  message content instead of calling the tool). A running agent can't be
  resumed; a dead/unregistered one reports "no subagent exists" — the lead
  surfaces the honest error.
- **Rate limits inside a child resume arrive as an ordinary failed
  tool_call_update** (rawOutput/content text), NOT a prompt-level error —
  promptWithRetry and onAgentLog never see them. `watchSubRateLimit` in
  index.ts registers every live `run_subagent` tool_call (toolCallId →
  sessionId), and on a `failed` update whose result matches
  `isRateLimitError` it cools the pinned host's account + rotates (gated by
  loadInflight like onRateLimited — replays must not cool accounts).
- Handshake `_meta` advertises `cognition.ai/subagentSupport|subagentControl|
  chains|sidechains|messageGrouping|partialContent|clarificationRequested`.
- `session/load` `update_meta` (eventId/timestamp/sidechain/subagent_*) does
  NOT restore event ids on replay — don't rely on them.
- `cognition.ai/timestamp` DOES survive replay — it's the event creation
  stamp and identical across generations (devin's store accumulates echo
  copies: one loaded log held 9 generations of the same subagent run).
  `tlPush` dedupes row-producing events on (kind|stamp) via `st.dedup` —
  without it every re-load multiplies visible history.
- **Child sessions = `sub:<parent>:<agentId>` pseudo-ids** — cloud parity:
  a subagent opens as a FULL session page (own timeline+composer+controls),
  nested under the parent in the sidebar tree. `handleSubSession` in
  localwb.ts serves the whole per-session contract for the `sub:` id
  (detail/timeline/messages/message/control/end/subagents/changes/todos/
  config/files via `cwdFor`→parent cwd). Children populate via
  `GET mirror/session-children?root=<id|sub:id>` (lazy per row) and
  `mirror/parent` for the breadcrumb. Parent/child ownership comes from the
  SPAWN CALL's stream tag (originTag), never from the child's own lifecycle
  stream (which is tagged with its own id — self-as-child → infinite
  recursion otherwise).
- **Coverage rule for subagent data**: the memory ring (5000) is
  authoritative ONLY when `mem[0].seq === 0` — clear()+replay restarts seq
  at 0, so that proves nothing was evicted. Otherwise `subsAny`/
  `subagentTimeline` must union the sidecars with the memory tail, deduped
  on seq. Bare `mem.length` checks lose early spawns on >5000-entry
  sessions — this bug already shipped once.
- **Subagent sidecars** (Claude-Code-style sidechains, replacing `.subidx`):
  `sessionLog.append` fans each update out to
  `<id>.sub.<aid>.jsonl` (that child agent's own stream — context tag,
  lifecycle meta, root-call updates) and `<id>.subs.jsonl` (spawn-call +
  lifecycle lines only — the listing journal). `<id>.subscan` `{"off":N}`
  is the coverage marker: sidecars are complete for exactly the main file's
  prefix [0,off); appends advance it, `ensureSubFiles` scans whatever lies
  beyond (legacy logs bootstrap lazily, chunked in the background past
  32MB; appends skip sidecar writes while coverage lags so a scan never
  double-writes). `readSubStream`/`parseSubFile` sort+dedupe on seq since
  scan-vs-append overlap can interleave lines. `clear()`/`restoreFile()`
  wipe every `<id>.jsonl.sub*` file (old generation); the constructor
  deletes leftover `.subidx`. Child timelines read ONE small sidechain —
  never the parent log.
- **Log durability**: `writer()` opens each `<id>.jsonl` `'a+'` and on first
  open scans the last 8KB for a torn tail (crash mid-write → partial final
  line) and truncates back to the last newline via `fs.truncateSync(path)`
  — two Windows/Node quirks dictated this: plain `'a'` fds throw EBADF on
  readSync, and append-mode fds throw EPERM on ftruncateSync, so the
  truncate MUST go through the path API while the fd stays `'a+'`. Writes
  then append behind complete lines only. `fsyncSync` runs at turn
  boundaries (`wb_turn_end`/`wb_notice`) — per-append fsync would tax the
  event loop; intra-turn loss is bounded by OS cache and recovery treats
  an unfinished turn the same either way.
- `DEVIN_REMOTE_NO_AUTORESUME=1` disables the boot open-turns sweep —
  REQUIRED on second instances sharing the data dir, or each boot re-sends
  "继续" into sessions the primary already resumed (and burns GBs replaying).
  Auto-resume also SKIPS sessions whose disk log exceeds 256MB (a
  session/load replay of a 3.7GB log saturates the event loop for minutes)
  and staggers remaining resumes 5s apart — the interrupted banner still
  offers manual resume for skipped ones.

## Desktop-parity capability matrix (probed live against `devin acp`, v3.10.67 bundle)

Desktop = Windsurf/VS Code fork at `D:\Program Files\Devin\resources\app`
(sessions.desktop.main.js ~44MB). Its `_cognition.ai/*` methods are intent
evidence, NOT proof of local ACP support.

**Verified working on local `devin acp`** (wired via `GET session/:id/resources`
→ Resources panel; param shapes fall back `{sessionId,cwd}→{cwd}→{}`):

| Method | Params | Returns |
|---|---|---|
| `_cognition.ai/rules/list` | `{cwd}` or `{}` (NOT sessionId — agent-scoped) | rules[{name,path,provider,providerLabel,content?}] |
| `_cognition.ai/skills/list` | `{sessionId,cwd}` | skills[{name,displayName,description,path}] |
| `_cognition.ai/subagents/list` | `{sessionId,cwd}` | spawnable profiles (empty on this install) |
| `_cognition.ai/plans/list` | `{cwd}` or `{}` | plans[{path,title,description}] |
| `_cognition.ai/hooks/list` | `{cwd}` or `{}` | hooks[] (empty on this install) |
| `_cognition.ai/config/read` | `{sessionId}` or `{}` | full agent config (model, thinking, etc.) |
| `_cognition.ai/session/rename` | `{sessionId,title}` | `{}` |
| `_cognition.ai/session/end` | `{sessionId,reason:'user'}` (needs loaded session) | `{dispatched:true}` — wired as `POST session/:id/end` |
| `_cognition.ai/session/share` | `{sessionId}` (needs loaded session) | `{shareId,url}` — uploads transcript to Cognition → app.devin.ai link; wired as `POST session/:id/share` |
| `_cognition.ai/reads/recentModelUids` | `{sessionId,limit}` — limit REQUIRED | `{uids:[...]}` recent model picks |
| `_cognition.ai/command/revise` | `{sessionId,command,note}` — note REQUIRED non-empty | `{command}` revised command |
| `subagent/{cancel,foreground,background}` | `{sessionId,agentId}` | `{}` |

**ACP console**: `POST session/:id/ext {method,params,load?}` — raw passthrough
for ANY `_cognition.ai/*` method; no session/load unless `load:1`. UI lives at
the bottom of the Resources panel (method datalist + JSON params + result).
`Invalid params` = method exists, wrong schema; `Method not found` = absent.

**Method not found on this agent build (~55 verified)**: auth/*, mcp/*,
plugins/*, billingInformation, browserPreview/*, wiki/*, net-policy/*,
local-tools/*, interactive-browser/get, pr/*, code-scan*, secret/*, snapshot*,
slack/teams-sync, revert/*, plan/accept·edit·toggle-confirm-mode,
session/{archive,reboot,pin,setTags,markRead,heartbeat,feedback,loadSpine,
loadPage,moveToFolder,removeFromFolder}, sessions/bulkArchive, adaQueries/*,
session-spending-limit/*, document/*, workspace/didChangeFiles,
terminal/{commandStarted,killBackgroundShell}, sidechain/{request,cancel},
test-app/approve, deploy/approve, skill-suggestion/*, environment-suggestion/*,
queuedMessages/*, diagnostics/sessionExport, resource/load, scope_search,
repos/list, folder/{list,delete,rename}, repo-index/decide, command endpoints
like agent_stopped/thinking_complete/loadStarting (agent→client notifications).

**Exists but schema unresolved (Invalid params on all tried shapes)**:
reads/promptHistory, workflows/list, config/write, terminal/killBackgroundShell
— required-field names unknown. Tried: sessionId/session_id, cwd, cursor,
limit, query, shell_id/terminal_id/command_id, {config:{}}, note, path. Binary
hints: `config/write: no config path`, `rules/list: session has no rules
registry`. Params use camelCase serde names; the desktop bundle builds them
via proto request types whose call sites are too obfuscated to extract
cheaply. Keep probing in the ACP console.

CLI surface (`devin.exe --help`): auth login/status/logout, models, doctor,
rules, skills, plugins, cloud, desktop, ls/rm, ssh, forward, update, version,
migrate, sandbox, setup, uninstall, acp.

## CLI proxy (frontend ↔ devin.exe)

`POST /api/admin/cli/run {cmd, arg?}` — whitelist table in localwb.ts maps
`cmd` → argv; `runCli` spawns `devin` (same binary as the acp pool), 30s cap,
256KB output cap, no shell (arg is positional-only, can't inject). Wired UI:
LocalDock "CLI 工具" section (Terminal icon in the sidebar dock header).
Read: version, auth status, doctor, models list, rules list/paths/show,
skills list/paths/show, plugins list/info, ls --format json, sandbox setup,
desktop (launches Devin Desktop). Write (UI confirm-gates): plugins
install/update/remove, migrate hooks/workflows, update.

Interactive commands ride the `/ws/term` channel instead of one-shot spawn:
`?run=ssh&arg=<session>` → `devin ssh <session>`; `?run=forward&arg=<session>
&ports=8080,3000` → `devin forward` (target validated `[\w./:@-]{1,200}`,
ports `\d+(:\d+)?`). Process lifetime = WS lifetime (close ⇒ kill ⇒ tunnel
down). UI: LocalDock "云端会话" block — user pastes a cloud session id/URL,
embedded TermPanel (extracted to web/src/components/TermPanel.tsx, shared by
session Term tab + this block) gives the interactive shell.

## Cloud-parity replication protocol (mandatory when copying app.devin.ai UI)

Never eyeball parity — measure it, or the deltas WILL be found by the user.
Official assets: logged-in Playwright session + all 903 Vite chunks already
downloaded to `_devin_assets/` (grep for component source), live DOM dumps
in `official-*-dom.txt`. For EVERY page/component being replicated:

1. **Inventory first, no cherry-picking** — on the official page, enumerate
   EVERY visible control (`button, a, input, select, [role=*]`) with one
   eval: tag, role, text, bounding rect, font size/weight, color, bg,
   border, radius. Components you skip are the ones that will be wrong
   (e.g. select triggers are `button[role=combobox]` with CONTENT-SIZED
   widths — Enter=68, Manual=80, System=176 — never a fixed 176).
2. **Measure all states** — closed, OPEN (the popup is half the component:
   ours = fixed listbox, bg-elevated 94% + backdrop-blur-8 + 1px outline +
   rounded-10 + L3 shadow, anchored trigger.left/bottom+4, min-w 200;
   options 30px px-8 py-6 text-13 rounded-6, highlighted→tint-secondary,
   selected→16px right check), hover, focus, disabled, checked.
3. **Port the real DOM structure** — inner span hierarchy, aria attrs,
   icon sizes; swap data source for our `/api/admin/*`, keep markup.
4. **Verify numerically at the same viewport** — run the same eval locally
   and diff rect/computed-style field-by-field. "Looks close" is not
   acceptable; equal numbers are. Then screenshot both ends (desktop
   1440 + mobile 390) for a final eyeball pass.
5. Findings live in this file / code comments — don't make the user
   re-report deltas the protocol would have caught.
