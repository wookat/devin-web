import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "./store.js";

export const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".zip": "application/zip",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".wav": "audio/wav",
  ".heic": "image/heic",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
};

const MAX_UPLOAD = 25 * 1024 * 1024;

export interface UploadMeta {
  id: string;
  name: string;
  mime: string;
  size: number;
}

/**
 * Accepts a raw binary body (`POST /api/uploads?filename=x.png`) — no
 * multipart parsing needed. Returns metadata used to build ACP content blocks.
 *
 * The body is streamed to disk (never buffered whole in memory). Oversize
 * bodies are drained rather than destroyed: destroying the request socket
 * would also kill the response, so the client would see a connection reset
 * instead of the 413.
 */
async function saveUpload(
  req: IncomingMessage,
  store: Store,
  filename: string,
): Promise<UploadMeta> {
  // Keep the user's real name (CJK included) — strip only filesystem-illegal
  // chars and Windows edge cases; basename already removed path segments.
  const clean =
    path
      .basename(filename)
      .replace(/[<>:"\/\\|?*\x00-\x1f]/g, "_")
      .replace(/^[\s.]+|[\s.]+$/g, "")
      .slice(0, 120) || "file";
  const id = `${randomUUID()}-${clean}`;
  const dest = path.join(store.uploadsDir, id);
  const out = createWriteStream(dest, { flags: "wx" });
  // Persistent listener: most of a slow upload is spent awaiting the client
  // (`for await` on req), and a WriteStream error in that window (ENOSPC,
  // uploads dir removed, EACCES) with no listener attached is an unhandled
  // 'error' event — it would crash the whole process.
  let streamErr: Error | null = null;
  out.on("error", (err) => {
    streamErr = err;
  });
  const waitDrain = () =>
    new Promise<void>((resolve, reject) => {
      if (streamErr) return reject(streamErr);
      const onDrain = () => {
        out.off("error", onErr);
        resolve();
      };
      const onErr = (e: Error) => {
        out.off("drain", onDrain);
        reject(e);
      };
      out.once("drain", onDrain);
      out.once("error", onErr);
    });
  let size = 0;
  let oversize = false;
  try {
    for await (const chunk of req) {
      if (streamErr) throw streamErr;
      if (oversize) continue; // drain the rest so the 413 can be delivered
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > MAX_UPLOAD) {
        oversize = true;
        continue;
      }
      if (!out.write(buf)) await waitDrain();
    }
    if (streamErr) throw streamErr;
    out.end();
    await finished(out);
  } catch (err) {
    out.destroy();
    await fs.unlink(dest).catch(() => {});
    throw err;
  }
  if (oversize) {
    await fs.unlink(dest).catch(() => {});
    throw Object.assign(new Error("upload too large (25 MiB max)"), { status: 413 });
  }
  if (size === 0) {
    await fs.unlink(dest).catch(() => {});
    throw Object.assign(new Error("empty upload"), { status: 400 });
  }
  const mime = MIME[path.extname(clean).toLowerCase()] ?? "application/octet-stream";
  return { id, name: clean, mime, size };
}

export async function serveUpload(
  store: Store,
  id: string,
  res: ServerResponse,
): Promise<void> {
  const clean = path.basename(id);
  const file = path.join(store.uploadsDir, clean);
  const ext = path.extname(clean).toLowerCase();
  const mime = MIME[ext] ?? "application/octet-stream";
  try {
    const stat = await fs.stat(file);
    const headers: Record<string, string | number> = {
      "content-type": mime,
      "content-length": stat.size,
      "cache-control": "immutable, max-age=31536000",
      // Uploads are user-supplied bytes served from our origin — never let
      // the browser sniff them into something executable.
      "x-content-type-options": "nosniff",
    };
    if (ext === ".svg") {
      // SVG can carry script; neuter it when rendered from this origin.
      headers["content-security-policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
    }
    const stream = createReadStream(file);
    stream.on("error", () => {
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    });
    stream.once("open", () => {
      res.writeHead(200, headers);
      stream.pipe(res);
    });
  } catch {
    res.writeHead(404).end("not found");
  }
}

export function uploadPath(store: Store, id: string): string {
  return path.join(store.uploadsDir, path.basename(id));
}

/** Shared handler for every raw-body staging endpoint: save + uniform response
 *  shape (`{ok,id,url,name,size,mime}`). Contract: raw bytes + `?filename=` —
 *  never FormData (see AGENTS.md). */
export async function stageUpload(
  req: IncomingMessage,
  store: Store,
  filename: string | null,
): Promise<Record<string, unknown>> {
  const meta = await saveUpload(req, store, filename || "file");
  return {
    ok: true,
    id: meta.id,
    url: `/api/uploads/${encodeURIComponent(meta.id)}`,
    name: meta.name,
    size: meta.size,
    mime: meta.mime,
  };
}
