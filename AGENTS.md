# devin-web

Local, LAN-accessible Devin web: `devin-web` cloud-style frontend
on top of local `devin acp` processes, with multi-account rotation on SWE rate limits.

## Build / run

```cmd
node devin-web.mjs <cmd>            :: cross-platform service CLI (single entrypoint):
::   run | start | stop | restart [--build] | status | install | uninstall | deploy | logs
::   install → win32 Scheduled Tasks, linux systemd --user, darwin LaunchAgent
deploy.bat                          :: thin wrapper → node devin-web.mjs deploy
:: or manually (dev only — production should always go through the supervisor):
node scripts\supervisor.mjs         :: :7791 BIOS → spawns backend on :7792
node dist\server\index.js --host 0.0.0.0 --port 7791   :: bare, unsupervised
```

Production topology — `scripts/supervisor.mjs` is the BIOS: a ~400-line
always-on process that owns :7791, serves `dist/web` itself, reverse-proxies
`/api/*` + `/ws*` upgrades to the backend child on 127.0.0.1:7792, and
health-probes `GET /api/health` every 4s. It supervises TWO children:
the backend (`dist/server/index.js` :7792) and the **acp broker**
(`scripts/acp-broker.mjs` — the long-lived owner of every local
`devin acp` child; injected into the backend as `DEVIN_WEB_ACP_BROKER`).
Backend exit OR 3 failed probes → clean orphaned acp children + respawn
(>5 exits/5min → 60s backoff). Broker exit → respawn after 1.5s; its own
pid journal (`<dataDir>/broker-state.json`) sweeps acp it orphaned. So a
hard crash, wedged event loop, or reboot self-heals — the static page
stays up even while the backend is dead (APIs 502 `backend_unavailable`
until it's back). Its own status/controls: `GET /api/_super/status`,
`POST /api/_super/restart` (backend-only bounce — broker + acp survive,
in-flight turns keep streaming), `POST /api/_super/stop`
(intentional stop — kills backend AND broker — writes
`<dataDir>/supervisor.stopped` so the watchdog does NOT resurrect it; any
fresh start clears the marker).
Boot persistence via `devin-web.mjs install` (platform-native):
win32 → Scheduled Tasks `devin-web-supervisor` (onlogon) +
`devin-web-watchdog` (every minute → `scripts/watchdog.mjs`, revives the
supervisor if :7791 is silent); linux → systemd --user unit
(Restart=always + enable-linger); darwin → launchd LaunchAgent
(RunAtLoad+KeepAlive).
Supervisor injects a default `DEVIN_WEB_ALLOWED_HOSTS` (the tunnel hosts)
when the environment lacks it — boot-time tasks have no shell env.
`POST /api/_super/restart` vs the backend's own routes: prefer
`/api/admin/restart` when the backend is up (graceful marks + offset
journal); `/_super/restart` is the hard reset for a wedged backend —
still turn-safe under the broker (turns stream through it; only the
offset journal is skipped → re-attach joins at live edge). Logs:
`<dataDir>/supervisor.log` + `server.log` + `broker.log`.

Self-redeploy: `POST /api/admin/redeploy` runs `npm run build` (~1-3min).
`POST /api/admin/restart` skips the build. UI: Settings → 服务 →
重启服务 / 重新构建并重启 / 硬重启 / 停止; the page then polls until the
backend is back and reloads — do NOT use a fixed sleep, the build window is
unpredictable. Build failure keeps the old server alive. Agents can also
`curl -X POST localhost:7791/api/admin/redeploy` — the call kills the
caller's own acp along with the server; the session replays via auto-resume.

RESTART IS IMMEDIATE — there is NO drain wait. `/api/admin/restart` and
redeploy's post-build step do exactly this: `beginDrain()` (gates new sends
for the ~400ms exit window only), `markGracefulExit()` (in-flight turns'
open-turns entries survive + broker stream offsets are journaled),
then kill and `process.exit(0)`:
  - **broker mode** (production): `ctx.manager.killHelpers()` — only the
    backend's local terminal helpers die; acp children keep running under
    the broker, in-flight turns stream straight through the restart.
  - **direct mode** (`DEVIN_WEB_ACP_BROKER` unset — bare dev): the legacy
    `ctx.manager.killAll()` — acp children die so session locks can't
    orphan (the original "hard restart → session_locked" fix).
The supervisor sees the exit and respawns; the whole cycle is a few
seconds. Bare dev runs (no DEVIN_WEB_SUPERVISED) spawn the detached
supervisor on exit so :7791 always ends up supervised — there is no
respawn.mjs/respawn.bat chain anymore (deleted). `markGracefulExit` is
also set by the SIGINT/SIGTERM handler for the same reason. The old
drain-loop (wait for inflight, heartbeat every 30s, DEVIN_WEB_DRAIN_TIMEOUT_MS
bound) is GONE — open-turns recovery made waiting worthless and replay-type
turns deadlocked it for hours. `GET /api/admin/drain` still reports the
brief gate state for diagnostics. Keep `prefs.autoResume` on — it covers
the crash path adoption can't (dead broker, dead acp).

ACP BROKER + ADOPTION — `scripts/acp-broker.mjs` owns local acp children
(short-lived control plane / long-lived worker, the pgbouncer-tmux-LSP-
daemon pattern). Wire: ndjson ctl channel (spawn/kill/list + exit events)
and one raw duplex data channel per acp (first line `{"attach":id,"after":N}`
— the broker replays ring-buffered stdout frames newer than `after`, frames
cut at line boundaries, ~4MB ring). Client side is `server/src/acpbroker.ts`:
`brokerSpawn`/`brokerAttach` (a net.Socket posing as ChildProcess stdio via
the `ProcHandle` structural type), `brokerList`, `brokerOnExit`, and the
`<dataDir>/acp-offsets.json` journal `markGracefulExit` writes so the next
backend re-attaches at the exact byte position (crash/no-offset → attach at
live edge `MAX_SAFE_INTEGER` — never replays already-consumed history).
`DevinAcp.start` branches: `brokerEnabled && !ssh` → `startBrokered` (ctl
spawn + attach + shared init handshake); adoption uses `adoptBrokered`
(tolerateInit — devin may refuse a second initialize on the same stdio;
the connection still answers every other RPC). SSH agents stay direct —
ssh2 channels are in-process objects, not children a broker can hold.
Boot order in index.ts: `adoptBrokerAcps(ctx)` (broker list → per-acp
attach + `session/list` → rebuild loadedOn/sessionHost/bySession; sessions
with surviving open-turns get `watchAdoptedTurn` — pseudo-inflight +
busySessions protection + a 90s-silence settle detector, since the turn's
prompt response died on the old byte stream) is AWAITED before the orphan
sweep + `autoResumeInterrupted` so resume never double-prompts a turn that
is still running. `manager.adopt` re-seats pooled acp by their journaled
pool `key` (spawn args thread it through); dedicated agents journal a bare
`agent.id` key and are re-bound via `bindSession`. Exit-event dedup:
broker ctl `ev:exit` → fake proc 'exit' AND socket 'close' → same 'exit' —
init's `finished` guard takes the first.
Interrupted-turn recovery: `dispatchPrompt` records the outgoing message in
`<dataDir>/open-turns.json` and clears it when the prompt settles — an entry
surviving at boot means the server died mid-turn. A successful settle also
appends `dw_turn_end` to the session log (errors append `dw_notice`); both
survive replay via the tail re-append and are NOT timeline rows (tlPush
skips them). `interruptedTurn()` (exported from sessionio) feeds
`interrupted` on the /timeline response: open-turns evidence first, then a
log tail with a user message but no turn boundary — for pre-marker logs
only when the tail ends on a bare tool_call/thought (a finished turn never
does). The client shows an amber resume banner — the `kind` field picks the
action: 'continue' (turn reached the agent → sends 继续) vs 'resend'
(prompt never echoed → replays the original message+attachments);
dismissal persisted in `dw-intd:<id>`. `autoResumeInterrupted(ctx)` runs
4s after listen when dw.json `prefs.autoResume` is on (max 2 attempts per
turn, `resumeCount` carried through dispatchPrompt) — it resumes crashed
turns WITHOUT any tab open. `GET/POST /api/admin/prefs` backs the
`/settings` page (official Preferences-style layout) whose send-shortcut /
theme rows read the same localStorage keys the session page does.
Unsupervised boot: backend exits hand :7791 to a detached supervisor spawn
(the migration hand-off from unsupervised → supervised);
DEVIN_WEB_NO_SUPERVISOR=1 keeps the old bare-exit behaviour. Orphaned acp
children (SIGKILL/crash paths skip killAll) are swept at boot BEFORE
auto-resume so dead locks can't block replays; `clean-orphans.ps1` +
`POST /api/admin/repair {fix:"kill-orphans"}` do it manually.
`GET /api/admin/diagnose` + `/api/admin/repair` (fixes: kill-orphans,
stop-turns, clear-open-turns, restart-now) back Settings → 诊断.

## Test

```cmd
npm test                            :: read-only API smoke (test/api-smoke.mjs)
node test/api-smoke.mjs --send      :: + real prompt round-trip (costs tokens)
node test/api-smoke.mjs --id <sid>  :: target a specific session
node test/broker-smoke.cjs          :: acp-broker wire smoke (spawn/attach/replay/exit)
npm run typecheck                   :: server + web tsc
powershell -File clean-orphans.ps1  :: kill acp processes with dead parents
```

## Extension seams (edition-ready)

`server/src/edition.ts` — `DEVIN_WEB_EDITION` (local/team/school/enterprise)
+ `featureEnabled()` gate table; feature code asks the table, never checks
the edition name. `server/src/authn.ts` — `requireAdmin(req)` guards
`/api/admin/*`: unset `DEVIN_WEB_ADMIN_KEY` = open local mode; set = the
existing `x-admin-key` channel (frontend `dw_admin_key`, settable in
Settings → 服务 → 访问密钥) becomes a real gate. `/api/health` reports
`edition`. Team/school/enterprise swap requireAdmin + the FEATURES table —
route code never changes.

## Gotchas

- The pre-rename data dir was `~/.devin-remote` (upstream project name); the
  rename to `~/.devin-web` did NOT carry data. `migrateLegacyDataDir()` in
  store.ts runs at Store construction: copies missing log/uploads/tl files
  (bigger `.jsonl` wins), deep-merges store.json/dw.json (pins/folders/titles)
  /accounts-state.json, marks `.migrated-devin-remote`. Sessions' spawn-time
  cwd inside devin's store still says `devin-workbench-local` —
  `remapLegacyCwd()` (store.ts) rewrites that path segment on every
  `sessionCwd.set` + `workspaces()` read.
- i18next interpolation is `{{var}}` ONLY — single-brace `{name}` renders
  literally. All locale keys must use `{{var}}`.
- `session/load` locks a session to ONE acp process (`session_locked`,
  retryable). `sessionHost` in `server/src/sessionio.ts` pins ops to the host
  process — never re-resolve cwd for a loaded session (session/list rewrites
  `sessionCwd` and would bounce it to the other pooled acp).
- Server module map: `localweb.ts` = dw.json registry routes + workspace index
  + the big admin/share router; `sessionio.ts` = hostFor (the ONE session→acp
  resolver: dedicated → sessionHost pin → cwd pool), load/replay dedup, live
  config, attachmentBlocks, promptWithRetry (the ONE retry policy: cool
  acp.account → rotate → resend once → 429 when all cooling; also the
  busy-tracking + turn-silence watchdog per attempt), dispatchPrompt,
  beginDrain/isDraining (deploy drain gate — 503s new sends, no-ops
  internal dispatchers, queue preserved), subagents, session listing;
  `dwtimeline.ts` = log→DwItem
  builder + tlCache + noteUpdate deltas + tail snapshots; `dwstore.ts` =
  dw.json registry (meta/folders/pins/lastConfig). `sessionSubs` in localweb.ts
  is the shared admin/share subroute table — add identical-semantics subs there
  (message/upload/file-contents/dashboard), keep sanitized share-only or
  admin-only subs in the branches.
- `automations.ts` = local scheduled sessions (official "Automations" parity):
  dw.json `automations` holds 5-field cron entries (Vixie dom/dow OR rule,
  impossible exprs rejected at save); a 30s tick fires due ones via the
  canonical sessions/new recipe — real session per run titled `⚙ <name>` in
  `.automations` folder. REST: GET/POST `/api/admin/automations`, POST `/:id`
  patch, DELETE `/:id`, POST `/:id/run`. `pr.ts` = gh-backed PR endpoints;
  `pr-analyze` dispatches the diff to a persistent pr-review acp session.
- Attachments are STRUCTURED: dispatchPrompt stores `attachments[]` on the
  `_local` log entry → `DwItem.attachments` → `TimelineItem.attachments`.
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
  Durable-state seam: `setCfgCacheDir(<dataDir>)` (called BEFORE adoption in
  index.ts) restores every piece of memory a restart used to drop —
  `agent-cfg.json` (agent cfg + commands + `bySession` per-session picks,
  LRU 40), `queues.json` (message queue — broker turns survive restarts so
  queued drafts must too; they flush on the next settle, never a blind boot
  sweep), `send-errors.json` (diagnose evidence). Write-through on mutation.
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
- `dw.json` `lastConfig` remembers the last model/mode/effort/speed pick and
  `POST /api/admin/sessions/new` applies it (desktop carries the pick forward).
- New-session flow mirrors desktop: `/` redirects to `/admin/new`, which is the
  `id === 'new'` draft sentinel inside AdminMirror — centered composer
  (`mt-auto` empty state + `mb-auto` footer), no session endpoints fire, first
  send POSTs `/api/admin/sessions/new` {task,folder,cwd,ssh?} then `nav(replace)`
  into `/admin/<id>`. Draft model/mode pills mutate `lastSeenLocalCfg` +
  `draftPicks` (replayed via /config after create); `dw-new-session-draft`
  sessionStorage hands text between pages. `composer-meta` response carries
  `primary_cwd` for the draft workspace picker + `ssh_hosts` for the run-target
  picker. `/admin/new` must stay out of every session-scoped fetch (main.tsx
  boot prefetch excludes it — 'sessions' too: `/admin/sessions` is the
  management page, not a session id). Draft layout: composer narrowed to
  `max-w-[692px]` to line up with the cards below; run-target/workspace/model
  live in the BeardBand chin (wax area), never inside the card.
- `本地+SSH` run target (desktop local↔cloud parity, minus cloud): the draft
  chin's LocalPicker lists `prefs.sshHosts` [{name?,target,cwd?}] (managed via
  POST /api/admin/prefs — target must match ^[\w.@%:+-]{1,200}$). `sessions/new
  {ssh: <target>}` REJECTS targets not in that list (unauthenticated web →
  never accept arbitrary ssh). When set, the manager pools as
  `agent:ssh:<target>:<cwd>` and spawns `ssh <target> <agentCmd>` (stdio = the
  ACP pipe); `cwd` is a REMOTE path. ACP terminal/* calls route through the
  same ssh via a per-process TerminalRunner(sshTarget); /ws/term for an ssh
  session becomes `ssh -tt <target>`; meta.ssh persists so hostFor/sessionSsh
  re-resolve the remote pool after restart. Local fs-dependent features
  (workspace browse, @file index, upload resource paths) degrade on remote
  sessions — they read the server fs, not the remote one.
- `/admin/sessions` (`web/src/pages/SessionsPage.tsx`) = pixel-parity clone of
  the official sessions-management page (measured live on app.devin.ai):
  300px sidebar mounting the REAL SessionTree + LocalDock; h-12 header;
  removable filter chips + ☰ add-filter + Clear filters; sticky 36px
  "Active sessions"/"Inactive sessions" group heads (archived rows sit in
  Inactive with an orange Archive icon — there is no separate Archived group
  on the official page; isolate via Status filter); 44px rounded rows with
  hover Pin/Archive slide-ins; dark floating bulk pill; Display menu
  (Sort/Direction/Grouping/Flat-Tree view/Display properties/Export CSV).
  Pure frontend — all data/actions ride `/api/admin/mirror/sessions` +
  `session-archive|session-pin|session-folder`; no server change. Archiving
  a session from its page navigates here so archived rows stay discoverable.
  `text-text-orange`/`bg-accent-primary` tokens added for exact palette.
- Any "复刻官方 X" / pixel-parity task MUST go through the `devin-parity`
  skill (`.devin/skills/devin-parity/`): forensics capture against the live
  official page first (`test/parity/capture-official.mjs`), spec gate via
  `test/parity/diff-spec.mjs`. `_devin_assets/` bundles are for LOGIC
  forensics only — never eyeball visuals from minified class names alone.
- Header settings menu is LOCAL-only: Send-with (localStorage), Rename/Folder/
  Archive (dw.json), Copy link (`/s/<id>?t=local`), Share-to-cloud + End session
  (verified `_cognition.ai/*` ext), Restart agent process (`POST .../restart` →
  `restartSession` kills the hosting acp; next op respawns + replays — pooled
  hosts shared by other sessions heal via hostFor's exited-pin check. When
  the host has OTHER sessions' turns in flight it is unpooled + retired on
  idle instead of killed outright — otherwise an agent "restarting" a
  poolmate kills its own process mid-turn). The
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
- Public access: Cloudflare Tunnel `devin-web` (id cb705fa8) runs as the
  `Cloudflared` Windows service (token-managed, survives reboots). Ingress maps
  `devin-web.zalize.com` (+ `devin.zalize.com`) → http://127.0.0.1:7791. Any
  new public hostname MUST also be added to DEVIN_WEB_ALLOWED_HOSTS.
  NOTE: the web has no auth — anyone with the URL has full control.
  `devin.zalize.com` itself 404s: its DNS is a read-only AAAA→100:: record
  managed by another CF product (undeletable via API key).
  `devin-local.zalize.com` (pre-rename hostname) was removed from the tunnel
  ingress and its DNS record deleted — do not re-add.
- `session/load` counts as ACTIVITY — it bumps the session's `updatedAt` and
  replays the full history. Sidebar prefetch (`prefetchSession`) must only hit
  memory-only endpoints (slim detail); never prefetch timeline/config or every
  hover loads history + marks sessions "just now".
- Load dedup: `loadInflight` in sessionio.ts shares one replay per session —
  the entry records the acp that STARTED the load; joiners resolving a
  different pool (sessionCwd empty → primaryCwd fallback vs real cwd) MUST
  pin to that recorded host, never mark their own — a wrong mark makes every
  later op hit an acp that never opened the session ("Session not found").
  `promptWithRetry` self-heals `session_not_found` once (drops mark+pin,
  re-resolves through loadOnce) AND transport-dead once (Connection closed /
  EPIPE / destroyed stream — recycles the suspect host, sparing busy
  poolmates via unpool+retire, then replays on a fresh acp; this is what
  un-wedges "loaded_here but every prompt dies" half-dead hosts).
  /timeline kicks `ensureLoaded` without
  awaiting (progressive fill, shows "Loading history…" via `loadInflight.has`).
  Only timeline/config/mutations trigger loads; detail/changes/messages/
  todos are memory-only.
- Full history lives in `<dataDir>/sessionlog.db` (node:sqlite, WAL) via
  `SessionDb` (server/src/sessiondb.ts): `events(session_id,gen,seq,ts,kind,
  bytes,data)` is the query side — `readDisk`/seq-resume/`diskSize`/`diskMtime`
  go through it and serve only the MAX generation; `blobs(sha,data)` is a
  content-addressed claim-check store — strings >16KB inside a >64KB update
  persist as `{"$blob": sha}` refs and identical payloads dedup to ONE row.
  Message text (user/agent/thought) NEVER offloads — the timeline renders
  chat without blob reads; tool_call diffs are precomputed at store time
  into `_dwFileUpdates` so `fileUpdates` needs no blobs either. Consumers
  that genuinely need a payload call `sessionLog.resolveBlobs(update)`
  (export, read/terminal text via `st.resolve` in dwtimeline).
  Replay is GEN-ISOLATED: `clear()` only bumps `gens`, replayed appends
  write the new gen alongside the old; `restoreFile` (failed load) deletes
  the partial gen so the old resurfaces — no file dependency — and
  `dropBackup` (success) deletes all older gens. A boot-time sweep +
  lazy first-touch both import legacy `.jsonl` (`ensureImported`/
  `importLegacy`), then DELETE the file — the DB is the history; new
  appends re-create a fresh mirror. Subagent sidecars are built by a
  seq-based DB scan (`scanSubsFromDb`, marker `.subscan` `{seq:N}`,
  LIKE '%subagent%' prefilter); legacy byte-offset `{off}` markers and
  the chunked file scan remain only as the `db==null` fallback. The
  in-memory ring (5000) is still only the live window.
  `tlCache`/`buildTimeline` seeds from `readDisk` on cold start, log
  `gen` bump (clear before re-replay), or an unconsumed-eviction gap
  (`headSeq > seenSeq+1`) — so /timeline backfill reaches the complete
  history. Entries carry `seq` (per-session monotonic, resumes from the db
  max/file tail across restarts) → item ids are `e<seq>`, stable across
  rebuilds; the
  client cursor stays an index into the items array either way. `clear()`
  still renames the file to `.jsonl.bak` before a re-replay (file-level
  mirror hygiene), and a
  constructor sweep restores a fuller `.bak` after a mid-replay crash
  (file side; the DB side self-heals via gens).
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
  `dw.json` meta (`m.updatedAt`); never fall back to `new Date()`.
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
  web has no auth, and the tunnel URL would become remote control
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
  `killPooled(agent, keep)` spares processes already on the target AND
  processes mid-turn (`acp.busySessions`, tracked per-attempt in
  promptWithRetry) — a busy acp is unpooled + `retireAfterIdle` so its live
  turns survive rotation, and releaseBusy kills it when the last one
  settles. The failed acp's own busy mark releases in act's .finally BEFORE
  the catch policy runs, so rotation still recycles it and the retry lands
  on a fresh account.
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
  localweb.ts serves the whole per-session contract for the `sub:` id
  (detail/timeline/messages/message/control/end/subagents/changes/todos/
  config/files via `cwdFor`→parent cwd). Children populate via
  `GET mirror/session-children?root=<id|sub:id>` (lazy per row) and
  `mirror/parent` for the breadcrumb. Parent/child ownership comes from the
  SPAWN CALL's stream tag (originTag), never from the child's own lifecycle
  stream (which is tagged with its own id — self-as-child → infinite
  recursion otherwise). Resumability is process-bound: the acp subagent
  registry lives in HOST-PROCESS memory and is emptied by every
  session/load replay (post-replay resumes answer "doesn't exist in my
  current session") — a child is `resumable` only while its registering
  event's `cognition.ai/timestamp` (replay-proof; our append ts would fake
  liveness) is newer than `loadEpoch` in sessionio, its host is alive, and
  no failed resume condemned it (`deadSubs`). POST `sub:…/message` 409s on
  a dead handle rather than burn a lead turn; `{respawn:1}` makes the lead
  spawn a SUCCESSOR carrying title/profile/task + a 1.5KB stream-tail
  excerpt — the successor lands as a NEW child row. UI greys dead rows
  with a 已失效 badge and the child page offers the respawn button.
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
  Coverage-hole rules (0-byte-file audit): `append` only bumps `.subscan`
  when EVERY routed sidecar write landed — a failed open must leave
  coverage behind so `subFilesStale` schedules a healing rescan;
  `wipeSidecars` bumps the gen counter (a wipe IS a generation change, so
  `restoreFile` wipes also invalidate in-flight scans) and closes live
  scan fds registered in `scanOuts` BEFORE rmSync — an rm on an open fd is
  delete-pending on Windows (name lingers at 0 bytes, writes land in a
  doomed file object: the observed ghost), and the `dead` flag stops the
  killed scan repopulating. Scan-end `fileEnd` is Math.max-clamped so
  mid-scan appends aren't regressed, and torn-tail truncation drops the
  coverage marker since a shrunken prefix invalidates it.
- **Log durability**: `writer()` opens each `<id>.jsonl` `'a+'` and on first
  open scans the last 8KB for a torn tail (crash mid-write → partial final
  line) and truncates back to the last newline via `fs.truncateSync(path)`
  — two Windows/Node quirks dictated this: plain `'a'` fds throw EBADF on
  readSync, and append-mode fds throw EPERM on ftruncateSync, so the
  truncate MUST go through the path API while the fd stays `'a+'`. Writes
  then append behind complete lines only. `fsyncSync` runs at turn
  boundaries (`dw_turn_end`/`dw_notice`) — per-append fsync would tax the
  event loop; intra-turn loss is bounded by OS cache and recovery treats
  an unfinished turn the same either way.
- `DEVIN_WEB_NO_AUTORESUME=1` disables the boot open-turns sweep —
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

`POST /api/admin/cli/run {cmd, arg?}` — whitelist table in localweb.ts maps
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

## Multi-agent ACP (server/src/agents.ts)

Any ACP-capable CLI can host sessions, not just `devin acp`. Registry = two
layers merged by `listAgents()`: builtins `AGENTS` (devin, prime) + user file
`<dataDir>/agents.json` (`{agents:[{id,label,command,args,multiSession,
versionArgs,env,shell,enabled}]}`, user entries override builtins by id —
mtime-cached, so edits affect NEW spawns with no restart). `agentById()`
falls back to devin; `disabled` entries hide from pickers but keep serving
existing sessions.

- **Process topology**: `manager.get(cwd, agent)` pools per
  `${agent.id}:${cwd}`; `multiSession:false` agents get ONE dedicated process
  per session (`startForSession` + `bindSession` + `store.addAgentSession`).
  Dedicated agents can't `session/load` — `hostFor` 409s once the process is
  gone (history stays readable from disk).
- **Ownership**: pooled non-devin sessions persist `meta.agent` in dw.json;
  dedicated ones live in `store.agentSessions`. `hostFor` resolves
  dedicated-pin → store → meta → devin. BOTH creation paths write it
  (`/api/admin/sessions/new`, native `POST /api/sessions`) — a missing
  `meta.agent` routes pooled non-devin sessions to the devin pool = wrong
  process.
- **Windows**: npm-global CLIs are `.cmd`/`.ps1` shims Node ≥20.12 refuses to
  spawn (EINVAL). Either `"shell": true` (routes through %ComSpec%,
  `agentCommandLine` hand-quotes to dodge DEP0190) or point `command` at a
  real `.exe`. The same flag is honored by `probeAgent` (registry ?probe=1)
  and `agentCheck` in index.ts.
- **Credentials**: `manager.envFor` injects `WINDSURF_API_KEY` (account pool)
  ONLY for `agent.id === 'devin'` — rotation never touches other agents; any
  agent's `env` map always merges into its child env.
- **API**: `GET /api/admin/agents` (?probe=1 runs `versionArgs`) and `PUT`
  (rewrites the user layer). `composer-meta` returns enabled agents for the
  draft pill; session detail + tree rows carry `agent` so the client shows
  the owner and hides `_cognition.ai`-only UI (share/end/subagent) on
  non-devin sessions.
- Verified live: OpenCode (`opencode.exe acp`, stdio) — initialize + new +
  loadSession/list/resume + configOptions(model select) all answer.

## 分身 persona (server/src/persona.ts)

A dedicated `devin acp` session on cwd `<dataDir>/persona/` answers questions
from working sessions on the user's behalf — its `AGENTS.md` skeleton is the
owner-authored persona spec (principles / samples / red lines); `decisions.log`
there is the append-only audit trail (`{ts,kind:answer|escalate|error,…}`).
The persona session id lives in `dw.json` `persona.sessionId` and is created
lazily via `ensurePersonaSession` (standard pool + sessionHost pin — never
hand it a different cwd or the registry lookup misses).

Modes (`off|semi|auto`): per-session override `meta.personaMode` > global
`prefs.persona.mode`. Auto only fires from `dispatchPrompt`'s settle hook —
`turnEndHooks` in sessionio.ts (persona registers on import; the direction is
always persona→sessionio so no cycle). Detection = tail scan since the last
user/boundary entry for `agent_message_chunk`s: ends `?`/`？` or matches the
QUESTION_RE phrase list (请确认/需要你/should i/…). `personaLastSeq` dedupes
re-detection of the same question; `maxPerHour` (default 4) caps asks and the
`asking` set prevents concurrent asks per session.

Answers go back through `dispatchPrompt` with the `[分身] ` prefix. `[升级]`
(or an empty reply) sets `meta.personaEscalated` → amber UI row + optional
`prefs.persona.webhook` POST (generic JSON, not DingTalk-bound). ANY human
`message:POST` clears the escalation via `personaHumanMessage`. Routes:
`GET/POST /api/admin/persona` (cfg + `decisions` tail),
`POST /api/admin/session-persona` `{id,mode:'off'|'semi'|'auto'|'inherit'}`,
`POST /api/admin/session-persona-ask` `{id}` (the semi-mode 问分身 button).
Timeline responses carry `persona:{mode,escalated}`; tree rows too; ws event
`persona_state` triggers the client's reload. Permission cards NEVER route to
the persona — requestPermission stays human-only by design.

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
