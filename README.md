# devin-web

**A self-hosted web workbench for local Devin agents** — cloud-style sessions,
timeline, editor, terminals and subagents, driven over the
[Agent Client Protocol](https://agentclientprotocol.com), served from your own
machine and reachable anywhere (LAN or Cloudflare Tunnel).

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node >= 22.5](https://img.shields.io/badge/node-%E2%89%A5%2022.5-brightgreen?logo=node.js&logoColor=white)](https://nodejs.org)

## Architecture

```
                        ┌─────────────────────────────────────────────┐
cloudflared / browser → │ :7791  supervisor (scripts/supervisor.mjs)  │
                        │         · static frontend (dist/web)        │
                        │         · /api/* + /ws* reverse proxy       │
                        │         · /api/health probe every 4s        │
                        │         · crash / wedge → auto-respawn      │
                        └──────────────┬──────────────────────────────┘
                                       │
                        ┌──────────────▼──────────────────────────────┐
                        │ :7792  backend (dist/server/index.js)       │
                        │         · ACP session orchestration         │
                        │         · multi-account rate-limit rotation │
                        │         · SQLite event store + blob dedup   │
                        └──────────────┬──────────────────────────────┘
                                       │ stdio JSON-RPC (ACP)
                        ┌──────────────▼──────────────────────────────┐
                        │ devin acp / opencode acp / … agent pools    │
                        └─────────────────────────────────────────────┘
```

Three-layer self-healing: the **watchdog task** revives the supervisor,
the **supervisor** revives the backend, and the backend drains in-flight
turns before any restart. The page stays served even while the backend is
down — APIs return `502 backend_unavailable` until it is back.

## The CLI

```bash
node devin-web.mjs deploy     # build + install persistence + smart restart
node devin-web.mjs run        # foreground supervisor (dev mode)
node devin-web.mjs start      # detached supervisor, waits until healthy
node devin-web.mjs stop       # graceful full stop (watchdog respects it)
node devin-web.mjs restart [--build]
node devin-web.mjs status     # supervisor + backend + persistence state
node devin-web.mjs logs [supervisor|server|respawn]
node devin-web.mjs install    # platform persistence:
                              #   win32 → Scheduled Tasks (onlogon + 1-min watchdog)
                              #   linux → systemd --user (Restart=always, linger)
                              #   darwin → launchd LaunchAgent (RunAtLoad+KeepAlive)
node devin-web.mjs uninstall
```

`deploy.bat` is a thin Windows wrapper for `deploy`.

## Features

- **Sessions** — every local Devin session, grouped/searchable, resume with
  full history replay; session branching on the roadmap.
- **Timeline** — streaming markdown (GFM, KaTeX, Mermaid), thinking blocks,
  per-file diff summaries, permission cards, terminal output.
- **Modes & models** — live mode switching and the full Devin model catalog.
- **Multi-account rotation** — SWE rate-limits cool the account and the next
  prompt lands on another identity, on the same pooled acp.
- **Multi-agent** — pluggable ACP agents (`devin acp` by default; presets for
  opencode and others).
- **Subagents** — `run_subagent` in-session delegation with relay/successor
  handling and derived sidecar transcripts.
- **Durable event store** — `<dataDir>/sessionlog.db` (SQLite, WAL):
  generation-isolated replay (failed loads roll back), content-addressed
  blobs dedup large tool payloads, bounded cold-start reads.
- **Self-managing deploys** — `POST /api/admin/redeploy` builds then
  drain-restarts; `/api/_super/restart|stop|status|log` on the supervisor.
- **Settings** — grouped preferences (general / session / sidebar / accounts
  / agent resources / service / logs / about) at `/settings`.

## Requirements

- Node.js ≥ 22.5 (`node:sqlite` — built-in, no native deps)
- [Devin CLI](https://docs.devin.ai/cli) installed and authenticated
- (optional) `cloudflared` for public access

## Public access

The service has **no authentication** — anyone with the URL has full control.
We expose it through a Cloudflare Tunnel (`devin-web` runs as an OS service);
new hostnames must be added to `DEVIN_WEB_ALLOWED_HOSTS`. Prefer private
networks (LAN, tailnet) unless you accept that exposure.

## Development

```bash
npm install
npm run dev         # backend :7781 (tsx watch) + web :5173 (vite)
npm run build       # web → dist/web, server → dist/server
npm run typecheck
npm test            # read-only API smoke
```

Stack: Node + TypeScript (`@agentclientprotocol/sdk`, `ws`, `node:sqlite`),
React + Vite (Tailwind v4, KaTeX, Mermaid, xterm.js).

See `AGENTS.md` for the full module map and operational runbook.

## License

MIT
