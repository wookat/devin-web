import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "node:http";
import type { WsServerEvent } from "./types.js";
import { incMetric } from "./metrics.js";

const KEEPALIVE_MS = 30_000;
/** Per-socket outbound queue ceiling — ~80 screencast frames or minutes of
 *  event chatter of slack; past it the peer can't drain and we're just
 *  buffering memory we'll never deliver. */
const MAX_BUFFERED = 8 * 1024 * 1024;
/** High-rate session streams — scoped to subscribers; everything else is
 *  tiny and stays global (sidebar status dots, account notices, …). */
const SCOPED_EVENTS = new Set(["session_update", "agent_log", "terminal_output", "timeline_delta"]);

type WsClient = WebSocket & { isAlive?: boolean; subs?: Set<string> | null };

/** Broadcast hub: one WebSocket endpoint. Session-scoped heavy events go
 *  only to clients that subscribed (`{type:"sub",sessions:[id,…]}`); a
 *  client that never scopes receives everything (legacy). */
export class WsHub {
  private wss: WebSocketServer;

  constructor(
    server: Server,
    private hello: () => WsServerEvent,
    opts?: { verifyOrigin?: (req: IncomingMessage) => boolean },
  ) {
    // noServer + manual upgrade routing: a ws WebSocketServer bound with
    // `server`/`path` aborts (400) every upgrade that doesn't match its path,
    // so coexisting endpoints (e.g. /ws/term) must each route themselves.
    this.wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      let pathname = "";
      try { pathname = new URL(req.url ?? "", "http://x").pathname; } catch { socket.destroy(); return; }
      if (pathname !== "/ws") return; // another endpoint's listener handles it
      // Same CSRF/DNS-rebinding guard as the HTTP API — a WS connection can
      // send prompts and approve permissions, so it must not be reachable
      // from arbitrary web pages.
      if (!(opts?.verifyOrigin?.(req) ?? true)) { socket.destroy(); return; }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req));
    });
    this.wss.on("connection", (ws) => {
      const client = ws as WsClient;
      client.isAlive = true;
      client.on("pong", () => {
        client.isAlive = true;
      });
      ws.on("message", (data) => {
        // Client→server is only the subscription message; inbound traffic
        // is rare so a lazy parse is fine. sessions:null resets to all.
        let m: { type?: string; sessions?: unknown };
        try { m = JSON.parse(String(data)); } catch { return; }
        if (m?.type !== "sub") return;
        client.subs = m.sessions == null ? null : new Set((Array.isArray(m.sessions) ? m.sessions : []).map(String));
      });
      ws.send(JSON.stringify(this.hello()));
    });
    // Keepalive: phones and proxies drop idle sockets silently; ping every
    // 30s and terminate peers that never pong so broadcast() stops queueing
    // into dead connections.
    const timer = setInterval(() => {
      for (const ws of this.wss.clients) {
        const client = ws as WebSocket & { isAlive?: boolean };
        if (client.isAlive === false) {
          client.terminate();
          continue;
        }
        client.isAlive = false;
        client.ping();
      }
    }, KEEPALIVE_MS);
    timer.unref();
  }

  broadcast(event: WsServerEvent) {
    const msg = JSON.stringify(event);
    const scopeId = SCOPED_EVENTS.has(event.type) ? (event as { sessionId?: string }).sessionId : undefined;
    for (const ws of this.wss.clients) {
      const client = ws as WsClient;
      if (client.readyState !== WebSocket.OPEN) continue;
      // Scoped events only reach subscribers; subs==null means the client
      // never scoped itself (legacy/other pages) → receives everything.
      if (scopeId !== undefined && client.subs && !client.subs.has(scopeId)) { incMetric("ws.scopedSkips"); continue; }
      // Backpressure: a suspended tab still answers pings at the protocol
      // level, so keepalive can't reap it — but its JS never drains the
      // socket and send() queues forever (backend RSS watchdog's recurring
      // 1.5-1.9GB restarts). Over the cap the client is unreachable anyway;
      // terminate → it reconnects and re-syncs at the live edge.
      if (client.bufferedAmount > MAX_BUFFERED) { incMetric("ws.droppedClients"); client.terminate(); continue; }
      client.send(msg);
      incMetric("ws.sent");
    }
  }

  clients(): number {
    return this.wss.clients.size;
  }
}
