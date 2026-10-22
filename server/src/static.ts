/**
 * static — dev-mode static file serving for the built web UI. In production
 * the supervisor serves dist/web itself and proxies only /api + /ws here;
 * this module covers the bare-backend path (`node dist/server/index.js`)
 * and any direct hit on :7792. SPA fallback + pre-compressed asset support.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WEB_DIRS = [path.join(__dirname, "..", "web"), path.join(__dirname, "..", "..", "dist", "web")];
const webDir = WEB_DIRS.find((d) => fs.existsSync(path.join(d, "index.html")));

const STATIC_MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

export function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  if (!webDir) {
    res.writeHead(200, { "content-type": "text/html" }).end(
      `<h1>devin-web</h1><p>Web UI not built. Run <code>npm run build</code>, or use <code>npm run dev</code> and open <a href="http://localhost:5173">http://localhost:5173</a>.</p>`,
    );
    return;
  }
  let file = path.join(webDir, path.normalize(decodeURIComponent(url.pathname)));
  const rel = path.relative(webDir, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    res.writeHead(403).end();
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(webDir, "index.html"); // SPA fallback
  }
  const ext = path.extname(file).toLowerCase();
  const mime = STATIC_MIME[ext] ?? "application/octet-stream";

  const send = (p: string, headers: http.OutgoingHttpHeaders) => {
    const stream = fs.createReadStream(p);
    // A file swapped/removed mid-request (e.g. rebuild) must not crash the process.
    stream.on("error", () => {
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    });
    stream.once("open", () => {
      res.writeHead(200, headers);
      stream.pipe(res);
    });
  };

  // Serve pre-compressed assets (scripts/compress.mjs) when the client accepts them.
  const accept = String(req.headers["accept-encoding"] ?? "");
  for (const [enc, suffix] of [["br", ".br"], ["gzip", ".gz"]] as const) {
    if (accept.includes(enc) && fs.existsSync(file + suffix)) {
      send(file + suffix, { "content-type": mime, "content-encoding": enc });
      return;
    }
  }
  send(file, { "content-type": mime });
}
