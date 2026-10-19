import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "node:http";
import type { WsServerEvent } from "./types.js";

const KEEPALIVE_MS = 30_000;

/** Broadcast hub: one WebSocket endpoint, every event goes to every client. */
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
      const client = ws as WebSocket & { isAlive?: boolean };
      client.isAlive = true;
      client.on("pong", () => {
        client.isAlive = true;
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
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  }

  clients(): number {
    return this.wss.clients.size;
  }
}
