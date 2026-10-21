# devin-web — system architecture & module graph

Design doctrine: **short-lived control plane × long-lived execution plane ×
seams over patches**. Every process, file and Map answers three questions:
what does it own, what kills it, what rebuilds it.

## Process topology

```
supervisor :7791  (BIOS — owns port, static, proxy, health probe, respawn)
 ├─ backend  :7792  (control plane — disposable; any restart/crash is legal)
 └─ acp-broker     (execution plane — owns every local `devin acp` child;
                     NDJSON ctl + raw data sockets + ring replay)
```

Invariant: **nothing user-visible may die with the backend.** Acp turns
stream through the broker; everything the backend held in memory is either
persisted (durable files), rebuilt (adoption), or deliberately ephemeral.

## Module graph (server/src) — dependency direction strictly downward

```
                 index.ts          process entry: wiring + boot order only
                    │
   ┌────────┬───────┼─────────┬──────────────┬─────────────┐
   ▼        ▼       ▼         ▼              ▼             ▼
 lweb/    routes  diagnose  automations   persona / pr / security / wiki
 index    (native (repair   (scheduler)    (domain features)
 shell    ACP     routes)
 +admin+   API)
 share)
   │        │
   └────┬───┘
        ▼
  sessionload  ────── the load/recovery ENGINE: hostFor (the ONE session→acp
        │              resolver), doLoad/loadOnce + replayGuard dedup,
        │              interruptedTurn evidence, adoptBrokerAcps +
        │              watchAdoptedTurn, autoResumeInterrupted,
        │              setCfgCacheDir boot hook. Binds BOTH injections.
        │
   ┌────┼─────────────┬─────────────┐
   ▼    ▼             ▼             ▼
sessionprompt    sessionsub     sessionview    ── level-1 engines/read-models
(dispatch,       (subagent        (sessionStatus, sessionConfig,
 retry policy,    registry,        terminalBuf, listLocalSessions,
 attachments,     subPing,         snippetFromLog)
 sendPreflight)   subagentTimeline)
   │                │               │
   └────┬───────────┴───────────────┘
        ▼
  level-0 leaves (storage + volatile state, no server-side consumers):
  sessioncfg    config caches + persistJson primitive (agent-cfg.json)
  sessionqueue  promptQueues FIFO (queues.json) — busy/dispatch INJECTED
  sessionturns  openTurns journal (open-turns.json)
  sessionplace  loadedOn / sessionHost / loadEpoch / loadInflight / isSessionPinned
  sessionlive   inflight / adoptedTurns / lastActivity / drain gate /
                gracefulExit + broker offset journal
  sendhealth    sendErrors journal (send-errors.json)
        │
        ▼
  manager (pool/pins) · acp (one acp) · acpbroker (broker client)
  dwtimeline (log→DwItem, tlCache) → sessionlog/sessiondb (SQLite store)

Foundations (no server imports): store dwstore uploads terminal ssh
                                 screen localbrowser ws export modelcat
                                 accounts agents edition authn types
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
sessionload (top) ──binds──▶ sessionqueue.isBusy + .dispatch
                   ──binds──▶ sessionprompt.resolveAcp / .statusOf / .pingSubagent
```

Storage never imports its consumers. The dispatch↔resolve bidirectionality
(dispatch needs a host; resolution+resume dispatch prompts) is inverted
into two `bind*Deps` calls at module-init in sessionload.

## Durable-state registry (what survives what)

| State | File / mechanism | Restored by |
|---|---|---|
| open turns | `open-turns.json` | sessionturns at boot (openTurnsLoad) |
| stream offsets | `acp-offsets.json` | sessionlive writes; attach `after` |
| config caches | `agent-cfg.json` | initCfgState (sessioncfg) |
| message queue | `queues.json` | restoreQueues via setCfgCacheDir |
| send diagnostics | `send-errors.json` | restoreSendErrors via setCfgCacheDir |
| registry/meta/prefs | `dw.json` | dwstore |
| sessions/cwd | store.json + adoption `session/list` | store + sessionload |
| broker journal | `broker-state.json` | broker itself |
| **ephemeral by design** | inflight, replayGuard, loadInflight, terminalBuf, draining, subPing | — |

## Route family (lweb/)

| File | Owns |
|---|---|
| `lweb/index.ts` | thin shell: flags, admin auth seam, SSH host resolver, media/coach/dashboard prologue, tree dispatch |
| `lweb/admin.ts` | `/api/admin/*` tree — handleAdminTree |
| `lweb/share.ts` | `/api/share/*` tree — handleShareTree, visitor-permission enforcement |
| `lweb/session.ts` | sessionSubs table (shared admin/share subroutes), handleSubSession, fork/handoff, sub-agent rows, cwd confinement |
| `lweb/common.ts` | json/readBody/readJson/UNSUPPORTED/gitStatusCache |

## Known design debt (deliberate, recorded)

- `(account ?)` display: adopted broker acps don't carry spawn-time account
  attribution — broker journal doesn't record it yet.
- Hard-crash offset recovery: offsets are journaled only on graceful exit;
  a killed backend re-attaches at the live edge (gaps heal via next load).
- Queue-without-open-turn: persisted queue entries whose turn evidence is
  gone are never auto-replayed (queue non-empty implies a turn was in
  flight; that turn's settle path flushes it — correct but worth a proof).
- Bounded legacy `~/.devin-remote` migration in store.ts — remove once the
  installed base has all migrated.
