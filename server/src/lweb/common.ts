/**
 * lweb/common — shared HTTP utilities for the lweb route family:
 * json/readBody/readJson + the UNSUPPORTED placeholder body. Leaf module.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import zlib from "node:zlib";

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

export function json(res: ServerResponse, status: number, body: unknown) {
  const buf = Buffer.from(JSON.stringify(body));
  const headers: Record<string, string | number> = { "content-type": "application/json" };
  // Big responses (timelines reach several MB uncompressed) get gzip when the
  // client accepts it — cuts transfer and parse pressure on LAN clients.
  const ae = String(res.req?.headers?.["accept-encoding"] ?? "");
  if (buf.length > 4096 && /\bgzip\b/.test(ae)) {
    headers["content-encoding"] = "gzip";
    res.writeHead(status, headers).end(zlib.gzipSync(buf));
    return;
  }
  res.writeHead(status, headers).end(buf);
}

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 50 * 1024 * 1024) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const buf = await readBody(req);
  return buf.length ? (JSON.parse(buf.toString("utf8")) as Record<string, unknown>) : {};
}

export const UNSUPPORTED = { error: "not supported on local web" };

/** file-git response cache — 8s per session. */
export const gitStatusCache = new Map<string, { at: number; body: unknown }>();
