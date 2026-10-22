# devin-web — system architecture & module graph

Design doctrine: **short-lived control plane × long-lived execution plane ×
seams over patches**. Every process, file and Map answers three questions:
what does it own, what kills it, what rebuilds it.

## Process topology

```
supervisor :7791  (BIOS — owns port, static, proxy, health probe, respawn,
                   pidfile for the watchdog, periodic log rotation)
 ├─ backend  :7792  (control plane — disposable; any restart/crash is legal)
 └─ acp-broker     (execution plane — owns every local `devin acp` child;
                     NDJSON ctl + raw data sockets + ring replay)
```

Invariant: **nothing user-visible may die with the backend.** Acp turns
stream through the broker; everything the backend held in memory is either
persisted (durable files), rebuilt (adoption), or deliberately ephemeral.

### Broker is a protocol-aware multiplexer

- **JSON-RPC id remux** — client→agent request ids are rewritten to a
  per-acp `brokerSeq`; `idMap` restores the client id before the frame
  enters the ring, so ring/replay/live stream all carry client-side ids.
  A re-attached backend's reused counter can't collide with ids still
  outstanding from the dead connection, and journaled client reqIds
  (`notePromptReq`) stay meaningful across the hop.
- **pending-request ledger** — agent→client requests (permission/fs/
  terminal) are indexed by frame byte-offset; client→agent responses
  clear them. Attach re-emits requests the previous backend never
  answered (dead-window zombie turns unblock) while ring replay covers
  frames inside the window — no double delivery.
- **pendingPrompts ledger + ev:prompt-start/prompt-done** — session/prompt
  req→resp pairs tracked on the wire; ctl `list` reports them per acp and
  ctl subscribers get an event the moment the answer passes. This is the
  authoritative "did the answer leave the agent" evidence.
- **Attach protocol** — first line `{"attach":id,"after":N,"token":T}`;
  ack → ring replay → pending-req re-emit → stdin feed, strictly ordered
  before the data handler attaches. `broker.token` (0600, dataDir) gates
  every channel.

## Module graph (server/src) — dependency direction strictly downward

```
                 index.ts          process entry: wiring + boot order only
                    │
   ┌────────┬───────┼─────────┬──────────────┬─────────────┐
   ▼        ▼       ▼         ▼              ▼             ▼
 lweb/    routes  diagnose  automations   persona / pr / security / wiki
 index    (native (repair   (scheduler)    (domain features)
 shell    ACP     routes)
 +admin/   API)
 +share)
   │        │
   └────┬───┘
        ▼
  sessionload  ────── the load/recovery ENGINE: hostFor (the ONE session→acp
        │              resolver), doLoad/loadOnce + replayGuard dedup,
        │              interruptedTurn evidence, claimLockedHolder
        │              (session_locked forensics), autoResumeInterrupted,
        │              setCfgCacheDir boot hook. Binds BOTH injections.
        │
  sessionadopt ───── the broker-adoption engine (imports loadOnce for resync
        │              only): adoptBrokerAcps boot scan, watchAdoptedTurn
        │              (silence floor ~30s post-attach), settleDeadAdoptedTurn
        │              (ledger evidence → instant), resolveTurnByReq/
        │              sniffedSettles (wire-sniffed late responses →
        │              instant settle), settleRecoveredTurn shared cleanup.
        │
   ┌────┼─────────────┬─────────────┐
   ▼    ▼             ▼             ▼
sessionprompt    sessionsub     sessionview    ── level-1 engines/read-models
(dispatch,       (subagent        (sessionStatus, sessionConfig,
 retry policy +   registry,        terminalBuf, listLocalSessions,
 30s ledger probe subCalls,        snippetFromLog)
 + prompt-done   watchSubRateLimit,
 fast path →      subPing,
 lost-response)   subagentTimeline)
   │                │               │
   └────┬───────────┴───────────────┘
        ▼
  level-0 leaves (storage + volatile state, no server-side consumers):
  sessioncfg    config caches + persistJson primitive (tmp+rename atomic)
  sessionqueue  promptQueues FIFO (queues.json) — imports sessionlive
                directly; dispatch bound via bindQueueDeps
  sessionturns  openTurns journal (open-turns.json) — entries carry
                reqId+acpId (notePromptReq) for late-response matching
  sessionplace  loadedOn / sessionHost / loadEpoch / loadInflight +
                markLoadedOn (the ONE placement write)
  sessionlive   inflight / adoptedTurns / lastActivity / drain gate /
                gracefulExit + broker offset journal (single-use)
  sendhealth    sendErrors journal (send-errors.json)
        │
        ▼
  manager (pool/pins) · acp (one acp — passive wire sniffer in init:
                stdin write-wrap + stdout Transform tee, pendingReqs,
                onPromptRequest/Response events; sniffing can never
                disturb the wire)
              · acpbroker (broker client: spawn/attach/list/exit-events,
                ctl Buffer framing, 10s call timeout)
  dwtimeline (log→DwItem, tlCache, noteUpdate) → sessionlog /
                sessiondb (SQLite WAL store)
  dwtailsnap (timeline tail snapshots: persistTail/snapshotItems/
                tl/*.json disk cache) → dwtimeline, sessionlog
  sessionlog = append + ring + disk mirror. The ring is a BOUNDED CACHE:
                get() lazy-hydrates 5k entries from readDisk on miss once
                per process; replayHold blanks reads between clear() and
                the first replay append (stale-gen rows can't double a
                reloaded transcript); .jsonl rotates .1/.2 at
                DEVIN_WEB_LOG_MAX_MB=128. Hydration never materializes
                sqlite synchronously — bounded tail reads + async chunked
                backfill (the sync path froze the loop 25s → watchdog
                SIGTERM crash-loop).
  sessionsidecars = subagent sidecar projection on sessionLog.sidecars
                (.sub.<aid>/.subs/.subscan files, URI-encoded aid)

Foundations (no server imports): store dwstore uploads terminal ssh
                                 screen localbrowser ws export modelcat
                                 accounts agents edition authn types
                                 httputil (the ONE json/readBody/readJson)
                                 env (the ONE DEVIN_WEB_* reader — scripts
                                 mirror it via scripts/env.mjs)
                                 static (dev-mode dist/web serving)
```

Rules:
- **No cycles.** A module that needs something "up" the graph receives it
  via injection (`bindQueueDeps`, `bindPromptDeps`) or an event, never an
  import back.
- **No barrels / no facades.** Consumers import the owning module
  directly; a split deletes its mother file, never leaves re-exports.
- **`ApiContext` is the only cross-layer object** — assembled once in
  index.ts; modules receive what they need, they don't reach for globals.
- One file = one responsibility ≈ one domain noun.

## The injection contract (the only upward edge, inverted)

```
sessionload (top) ──binds──▶ sessionqueue.dispatch
                   ──binds──▶ sessionprompt.resolveAcp / .statusOf / .pingSubagent
```

Storage never imports its consumers. The dispatch↔resolve bidirectionality
(dispatch needs a host; resolution+resume dispatch prompts) is inverted
into two `bind*Deps` calls at module-init in sessionload.

## Turn settlement — evidence first, silence last

Three evidence layers resolve an adopted/interrupted turn; the silence
watchdog is now strictly the deadlock fallback:

| Evidence | Source | Latency |
|---|---|---|
| `pendingPrompts` ledger miss at adoption | broker ctl `list` | instant |
| `ev:prompt-done` + response absent on our wire | broker ctl event | ~250ms |
| late response matches journaled `reqId` (sniffer → `resolveTurnByReq`) | backend wire tee | instant |
| ledger probe during live turn → `lost-response` reject | `promptWithRetry` | ≤30s |
| **silence settle** (no bytes ~30s post-attach, 90s from activity) | `watchAdoptedTurn` | fallback only |

`settleRecoveredTurn` runs the same cleanup for every path: bounded resync
(heals crash-attach transcript gaps via replay dedup), `dw_turn_end`
append, open-turn delete, busy/inflight release, queue flush, status
broadcast.

`claimLockedHolder` resolves `session_locked`: stamped `lockHolderPid`
names our own/broker acp → join/adopt without replay; dead pid → bounded
stale retry; live foreign pid → annotated error. Unstamped locks fall to
a load-probe over live acps before giving up.

## Durable-state registry (what survives what)

| State | File / mechanism | Restored by |
|---|---|---|
| open turns (+reqId/acpId) | `open-turns.json` | sessionturns at boot |
| stream offsets (single-use) | `acp-offsets.json` | sessionlive writes; attach `after`; cleared on adopt |
| config caches | `agent-cfg.json` | initCfgState (sessioncfg) |
| message queue | `queues.json` | restoreQueues via setCfgCacheDir |
| send diagnostics | `send-errors.json` | restoreSendErrors via setCfgCacheDir |
| registry/meta/prefs | `dw.json` | dwstore (meta.shared gates share links) |
| sessions/cwd | store.json + adoption `session/list` | store + sessionload |
| broker journal (+account) | `broker-state.json` | broker itself; pid-verify sweep |
| broker auth | `broker.token` (0600) | generated per dataDir |
| session events | `sessionlog.db` (SQLite WAL) + `.jsonl` mirrors | sessionlog/sessiondb |
| **ephemeral by design** | inflight, replayGuard, loadInflight, terminalBuf, draining, subPing, sniffedSettles, ring | — |

## Route family (lweb/)

| File | Owns |
|---|---|
| `lweb/index.ts` | thin shell: flags, admin auth seam, SSH host resolver, dashboard prologue (auth-gated writes), tree dispatch |
| `lweb/admin/` | `/api/admin/*` — coordinator + system/registry/fsbrowse/newsession families; persession.ts = per-session dispatcher over sessionfiles/sessiontimeline/sessioncontrol/sessionlifecycle |
| `lweb/share.ts` | `/api/share/*` — opt-in via meta.shared, workspace-confined+realpath file-contents |
| `lweb/session.ts` | sessionSubs table (shared admin/share subroutes), handleSubSession, fork/handoff, sub-agent rows |
| `httputil.ts` | the ONE json/readBody/readJson/UNSUPPORTED set (gzip, 50MB) |

## Security model

`DEVIN_WEB_ADMIN_KEY` unset = open local mode; set = `x-admin-key` header
(or `?key=` on WS) gates `/api/admin/*`, `/api/_super/*` (supervisor-side
Origin/Host check too), `/ws`, `/ws/term`, `/ws/browser`, dashboard
writes, and share trees honor `meta.shared`. `broker.token` gates the
local control socket. Audit log entries strip newlines; sidecar names
URI-encode agent ids.

## Known design debt (deliberate, recorded)

- **Production broker version lag** — the running broker predates remux/
  ledger code; the backend degrades gracefully (one `pre-ledger broker`
  error, probe skipped, silence+sniffer layers carry settle). Activates
  on the broker's next natural respawn — force-killing it would take
  every acp's turn with it.
- **At-least-once replay boundary** — a dead-window request whose side
  effect already ran can't be distinguished from an unexecuted one;
  pending-request re-emit guarantees delivery, not idempotency (same
  limit as pgbouncer/LSP-daemon designs).
- **Hard-crash offset recovery** — offsets are journaled only on graceful
  exit; a killed backend re-attaches at the live edge and resync heals
  the transcript gap (bounded loadOnce inside settle).
- **Queue-without-open-turn** — parked by design; startup scan logs them,
  admin queue POST flushes on idle, settle paths drain on completion.
