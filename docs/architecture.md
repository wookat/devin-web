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
            index.ts              process entry: wiring + boot order only
              │
   ┌──────────┼───────────┬────────────┐
   ▼          ▼           ▼            ▼
localweb   routes      diagnose   automations / pr / persona / security
 (admin+   (generic                 (domain features — may touch sessionio)
  share     API)
  router)
   │          │
   └─────┬────┘
         ▼
   sessionio ──────────── the session engine (today's split target)
         │
   ┌─────┼──────────┬───────────┬───────────────┐
   ▼     ▼          ▼           ▼               ▼
 manager  acp    acpbroker   sessioncfg     dwtimeline
 (pool/   (one   (broker     (config       (log→DwItem,
  pins)   acp)    client)     caches +      tlCache)
                             persistJson)      │
         │                                     ▼
         └── types ──► pure contracts     sessiondb / sessionlog
                                               (SQLite event store)

Foundations (no server imports): store dwstore uploads terminal ssh
                                 screen localbrowser ws ws exports modelcat
                                 accounts agents edition authn types
```

Rules:
- **No cycles.** A module that needs something "up" the graph receives it
  via constructor/ctx injection or an event, never an import back.
- **No barrels.** Consumers import the owning module directly; when a file
  is split, its consumers are updated and the shell is deleted — not left
  as a re-export facade.
- **`ApiContext` is the only cross-layer object** — assembled once in
  index.ts; modules receive what they need, they don't reach for globals.
- One file = one responsibility ≈ one domain noun. >~800 lines is a smell.

## sessionio split plan (each step = one green commit)

| Module | Owns | Moves from sessionio.ts |
|---|---|---|
| `sessioncfg.ts` ✓ | config caches, persistJson, lock-retry | done (82e50a8) |
| `sessionqueue.ts` | promptQueues, queueAdd/Remove/List/Flush, QueuedMsg | queue block |
| `sendhealth.ts` | sendErrors, noteSendError, preflight, send-check | diagnostics block |
| `sessionturns.ts` | openTurns file, interruptedTurn, dw_turn_end, autoResume | recovery block |
| `sessionload.ts` | loadedOn, sessionHost, loadInflight, replayGuard, doLoad, adoptBrokerAcps, watchAdoptedTurn | load+adopt block |
| `sessionprompt.ts` | inflight, drain, dispatchPrompt, promptWithRetry, rotation | dispatch block |
| `sessionio.ts` → **deleted** | — | residual: hostFor stays in sessionload (the ONE resolver) |

Dependency order of extraction: leaves first (queue/sendhealth — they only
need persistJson + noteUpdate) → turns → load → prompt last (it imports
everything). No re-exports after the final cut; index.ts + routes.ts +
localweb.ts + diagnose.ts import the owning modules directly.

## localweb split plan (after sessionio)

`localweb.ts` keeps `handleLocalWb` as a ~150-line dispatch shell:
path parsing → authn → delegate to `routes/admin.ts`, `routes/session.ts`
(sessionSubs), `routes/share.ts`, `routes/files.ts` (fs/browse/editor),
`routes/mirror.ts`, `routes/prefs.ts` (prefs/persona/agents). Shared
helpers (readBody/json/parseSubId) move to `routes/http.ts`.

## Durable-state registry (what survives what)

| State | File / mechanism | Restored by |
|---|---|---|
| open turns | `open-turns.json` | sessionturns at boot |
| stream offsets | `acp-offsets.json` | attach `after` param |
| config caches | `agent-cfg.json` | initCfgState |
| message queue | `queues.json` | setCfgCacheDir |
| send diagnostics | `send-errors.json` | setCfgCacheDir |
| registry/meta/prefs | `dw.json` | dwstore |
| sessions/cwd | store.json + adoption `session/list` | store + sessionload |
| broker journal | `broker-state.json` | broker itself |
| **ephemeral by design** | inflight, replayGuard, loadInflight, terminalBuf, draining | — |
