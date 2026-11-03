/**
 * Local secrets store — devin-web's answer to Devin cloud org secrets.
 *
 * `<dataDir>/secrets.json` (0600), v2 envelope:
 *   { version: 2, enc: "dpapi"|"plain", data: <b64 blob | object> }
 *   inner = { secrets: { NAME: { value, description, createdAt, updatedAt,
 *            type? } }, sessions: { sessionId: [NAME, …] } }
 * On win32 the inner JSON is DPAPI-encrypted (CurrentUser scope — the file
 * is unreadable on another machine/user, which blocks cloud-sync and
 * file-copy exfiltration; a same-user local process can still decrypt,
 * that's DPAPI's documented boundary). Non-win32 and
 * DEVIN_WEB_SECRETS_PLAIN=1 store `enc:"plain"`. Legacy v1 flat files
 * (no `version`) read as plaintext and upgrade on the next write.
 *
 * Invariants:
 *  - Values NEVER leave the backend: list/composer-meta carry name+description
 *    only. The agent receives values as env vars on its terminal spawns
 *    (TerminalRunner merges `sessionSecretEnv(sessionId)`), so the value never
 *    enters the transcript or session log unless the agent echoes it.
 *  - Bindings accumulate per session: every `@secrets:NAME` mention in a
 *    dispatched prompt unions NAME into `sessions[id]` — a session only ever
 *    gains access, matching the cloud model (once granted, granted).
 *  - The store is read-modify-write per call. Reads are mtime-cached: DPAPI
 *    decryption costs one PowerShell spawn and only happens when the file
 *    actually changed, so every terminal spawn stays sync and cheap.
 *  - An unreadable file (corrupt, or encrypted by another user/machine)
 *    reads as empty AND is poisoned — save() refuses to clobber it, so a
 *    migrated file can't be silently wiped by the next mutation.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import type { ApiContext } from "./routes.js";

export interface SecretEntry {
  value: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  /** "totp" → `value` is the base32 seed; sessionSecretEnv injects the
   *  CURRENT 6-digit code (RFC 6238), not the seed — matching cloud's
   *  "Devin never sees your TOTP seed" semantics. */
  type?: "totp";
}

interface SecretsFile {
  secrets?: Record<string, Partial<SecretEntry>>;
  sessions?: Record<string, string[]>;
}

interface SecretsEnvelope {
  version?: number;
  enc?: string;
  data?: unknown;
}

const FILE_VERSION = 2;

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Reserved env names — a secret named PATH would clobber the child's PATH
 *  (secrets merge last, over process.env AND params.env), and names like
 *  NODE_OPTIONS/LD_PRELOAD would inject into runtime loaders. Same class of
 *  guardrail as GitHub's GITHUB_* prefix ban. */
const RESERVED = new Set([
  "PATH", "Path", "PATHEXT", "COMSPEC", "SHELL", "HOME", "HOMEDRIVE", "HOMEPATH",
  "USERPROFILE", "SystemRoot", "SystemDrive", "windir", "TEMP", "TMP",
  "PSModulePath", "NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "PYTHONPATH", "RUBYOPT",
  "BASH_ENV", "ENV", "CDPATH", "IFS", "PS1", "PS2",
]);
const isReserved = (n: string) =>
  RESERVED.has(n) || n.toUpperCase() === "PATH" || n.startsWith("DEVIN_WEB_") || n.startsWith("_DEVIN");

function file(ctx: ApiContext): string {
  return path.join(ctx.store.dataDir, "secrets.json");
}

// ---- at-rest encryption: DPAPI via PowerShell (win32) --------------------
// ProtectedData lives in System.Security — no native addon needed. One
// process call per decrypt, amortised by the mtime cache below.

function psExe(): string {
  const root = process.env.SystemRoot;
  return root ? path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";
}

function dpapi(op: "Protect" | "Unprotect", data: Buffer): Buffer {
  const script =
    "Add-Type -AssemblyName System.Security;" +
    "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd());" +
    `[Console]::Out.Write([Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::${op}($b,$null,'CurrentUser')))`;
  const out = execFileSync(psExe(), ["-NoProfile", "-NonInteractive", "-Command", script], {
    input: data.toString("base64"),
    timeout: 15_000,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return Buffer.from(out.toString("utf8").trim(), "base64");
}

let dpapiState: "unknown" | "ok" | "broken" = "unknown";

/** Whether this process should encrypt at rest. Self-tests once, then
 *  remembers — a broken DPAPI must not retry a PowerShell spawn per call. */
function wantDpapi(): boolean {
  if (process.env.DEVIN_WEB_SECRETS_PLAIN === "1") return false;
  if (process.platform !== "win32") return false;
  if (dpapiState === "unknown") {
    try {
      dpapiState = dpapi("Unprotect", dpapi("Protect", Buffer.from("dw-probe"))).toString("utf8") === "dw-probe" ? "ok" : "broken";
    } catch {
      dpapiState = "broken";
    }
    if (dpapiState === "broken") console.warn("[secrets] DPAPI unavailable — secrets.json stays 0600 plaintext");
  }
  return dpapiState === "ok";
}

// Decrypted-state cache keyed by file mtime+size — DPAPI only runs when the
// file actually changed, so per-spawn env resolution stays sync and cheap.
const readCache = new Map<string, { mtimeMs: number; size: number; d: Required<SecretsFile> }>();
/** Files that failed to decode — read as empty but never overwritten. */
const poisoned = new Set<string>();

function load(ctx: ApiContext): Required<SecretsFile> {
  const f = file(ctx);
  try {
    const st = fs.statSync(f);
    const hit = readCache.get(f);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.d;
    const j = JSON.parse(fs.readFileSync(f, "utf8")) as SecretsFile & SecretsEnvelope;
    let inner: SecretsFile;
    if (j.version === FILE_VERSION && j.enc === "dpapi" && typeof j.data === "string") {
      inner = JSON.parse(dpapi("Unprotect", Buffer.from(j.data, "base64")).toString("utf8")) as SecretsFile;
    } else if (j.version === FILE_VERSION && j.enc === "plain" && j.data && typeof j.data === "object") {
      inner = j.data as SecretsFile;
    } else {
      inner = j; // v1 flat file
    }
    const d = { secrets: inner.secrets ?? {}, sessions: inner.sessions ?? {} };
    readCache.set(f, { mtimeMs: st.mtimeMs, size: st.size, d });
    return d;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { secrets: {}, sessions: {} };
    poisoned.add(f); // corrupt or foreign-machine file — never clobber it
    console.warn(`[secrets] ${f} unreadable (${(e as Error).message}) — treating as empty, refusing to overwrite`);
    return { secrets: {}, sessions: {} };
  }
}

function save(ctx: ApiContext, d: Required<SecretsFile>): void {
  const f = file(ctx);
  if (poisoned.has(f)) {
    console.warn(`[secrets] ${f} is unreadable — refusing to overwrite (delete it manually to start fresh)`);
    return;
  }
  const inner = { secrets: d.secrets, sessions: d.sessions };
  const out = wantDpapi()
    ? JSON.stringify({ version: FILE_VERSION, enc: "dpapi", data: dpapi("Protect", Buffer.from(JSON.stringify(inner), "utf8")).toString("base64") }) + "\n"
    : JSON.stringify({ version: FILE_VERSION, enc: "plain", data: inner }, null, 2) + "\n";
  const tmp = f + ".tmp";
  fs.writeFileSync(tmp, out, { mode: 0o600 });
  fs.renameSync(tmp, f); // atomic — no torn writes on crash
  try { fs.chmodSync(f, 0o600); } catch { /* best effort — win32 acl */ }
  const st = fs.statSync(f);
  readCache.set(f, { mtimeMs: st.mtimeMs, size: st.size, d });
}

/** Access audit — every grant mutation leaves a line in
 *  `<dataDir>/secrets-audit.jsonl` (Vault/GitHub-style access log; values
 *  are never logged). Over 512 KiB the file is halved — audit is a bounded
 *  journal, not an archive. */
function audit(ctx: ApiContext, op: string, name: string, extra?: Record<string, unknown>): void {
  try {
    const f = path.join(ctx.store.dataDir, "secrets-audit.jsonl");
    const line = JSON.stringify({ ts: new Date().toISOString(), op, name, ...extra }) + "\n";
    fs.appendFileSync(f, line, { mode: 0o600 });
    if (fs.statSync(f).size > 512 * 1024) {
      const lines = fs.readFileSync(f, "utf8").split("\n");
      fs.writeFileSync(f, lines.slice(Math.floor(lines.length / 2)).join("\n"), { mode: 0o600 });
    }
  } catch { /* audit must never break the mutation it records */ }
}

export function listSecrets(ctx: ApiContext): { name: string; description: string; createdAt: number; updatedAt: number; type?: "totp"; sessions: string[] }[] {
  const d = load(ctx);
  return Object.entries(d.secrets)
    .map(([name, s]) => ({
      name,
      description: s.description ?? "",
      createdAt: s.createdAt ?? 0,
      updatedAt: s.updatedAt ?? 0,
      ...(s.type ? { type: s.type } : {}),
      sessions: Object.entries(d.sessions).filter(([, names]) => names.includes(name)).map(([sid]) => sid),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const B32 = /^[A-Za-z2-7]+=*$/;

export function upsertSecret(ctx: ApiContext, name: string, value: string, description = "", type?: string): { ok: boolean; error?: string } {
  if (!NAME_RE.test(name)) return { ok: false, error: "invalid_name" };
  if (isReserved(name)) return { ok: false, error: "reserved_name" };
  if (!value) return { ok: false, error: "empty_value" };
  if (type === "totp" && !B32.test(value.replace(/\s/g, ""))) return { ok: false, error: "invalid_totp_seed" };
  const d = load(ctx);
  const prev = d.secrets[name];
  d.secrets[name] = {
    value,
    description: description || prev?.description || "",
    createdAt: prev?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    ...(type === "totp" ? { type: "totp" as const } : {}),
  };
  save(ctx, d);
  audit(ctx, prev ? "rotate" : "create", name);
  return { ok: true };
}

export function deleteSecret(ctx: ApiContext, name: string): { ok: boolean; deletedBound: string[] } {
  const d = load(ctx);
  if (!d.secrets[name]) return { ok: false, deletedBound: [] };
  delete d.secrets[name];
  const deletedBound: string[] = [];
  for (const [sid, names] of Object.entries(d.sessions)) {
    const next = names.filter((n) => n !== name);
    if (next.length !== names.length) {
      d.sessions[sid] = next;
      deletedBound.push(sid);
    }
  }
  save(ctx, d);
  audit(ctx, "delete", name, { sessions: deletedBound.length });
  return { ok: true, deletedBound };
}

/** Union `names` into the session's bound set; unknown names are dropped so a
 *  typo'd @secrets:FOO can't bind a nonexistent grant. */
export function bindSessionSecrets(ctx: ApiContext, sessionId: string, names: string[]): string[] {
  const d = load(ctx);
  const known = new Set(Object.keys(d.secrets));
  const cur = new Set(d.sessions[sessionId] ?? []);
  const added: string[] = [];
  for (const n of names) {
    if (known.has(n) && !cur.has(n)) {
      cur.add(n);
      added.push(n);
    }
  }
  if (added.length) {
    d.sessions[sessionId] = [...cur];
    save(ctx, d);
    for (const n of added) audit(ctx, "bind", n, { sessionId });
  }
  return added;
}

/** Remove one session's access to one secret — the revoke path that doesn't
 *  require deleting the secret for everyone. */
export function unbindSessionSecret(ctx: ApiContext, sessionId: string, name: string): { ok: boolean; removed: boolean } {
  const d = load(ctx);
  const cur = d.sessions[sessionId];
  if (!cur?.includes(name)) return { ok: true, removed: false };
  d.sessions[sessionId] = cur.filter((n) => n !== name);
  if (!d.sessions[sessionId].length) delete d.sessions[sessionId];
  save(ctx, d);
  audit(ctx, "unbind", name, { sessionId });
  return { ok: true, removed: true };
}

/** Names of secrets that exist — for flagging @secrets:TYPO mentions. */
export function knownSecretNames(ctx: ApiContext): Set<string> {
  return new Set(Object.keys(load(ctx).secrets));
}

export function sessionSecretNames(ctx: ApiContext, sessionId: string): string[] {
  return load(ctx).sessions[sessionId] ?? [];
}

/** Raw bound values — used by the output redactor (terminal/fs channels) so
 *  an echoed $NAME never reaches the transcript, session log, or the agent's
 *  own read-back. Values shorter than 4 chars are excluded from masking: a
 *  1-3 char pattern would shred normal output. */
export function sessionSecretValues(ctx: ApiContext, sessionId: string): string[] {
  const d = load(ctx);
  const out: string[] = [];
  for (const n of d.sessions[sessionId] ?? []) {
    const s = d.secrets[n];
    if (!s?.value) continue;
    out.push(s.value);
    // TOTP: `echo $NAME` prints the live 6-digit code, not the seed — mask the
    // code for the current step ±1 so a boundary-crossing echo is covered.
    if (s.type === "totp") {
      const now = Date.now();
      for (const dt of [-30_000, 0, 30_000]) {
        const c = totpCode(s.value, 30, 6, now + dt);
        if (c) out.push(c);
      }
    }
  }
  return out;
}

// ---- TOTP (RFC 6238, HMAC-SHA1, 30s step, 6 digits) — zero-dependency ----

function b32decode(seed: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = seed.toUpperCase().replace(/[\s=]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) return Buffer.alloc(0); // strict: malformed seed → no code
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Current TOTP code for a base32 seed; "" when the seed is malformed. */
export function totpCode(seed: string, step = 30, digits = 6, at = Date.now()): string {
  const key = b32decode(seed);
  if (!key.length) return "";
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / step)));
  const h = crypto.createHmac("sha1", key).update(counter).digest();
  const off = h[h.length - 1] & 0x0f;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 10 ** digits).padStart(digits, "0");
}

/** Names + descriptions for the agent-facing hint (values stay out of text). */
export function sessionSecretHints(ctx: ApiContext, sessionId: string, only?: string[]): { name: string; description: string }[] {
  const d = load(ctx);
  const names = only ?? d.sessions[sessionId] ?? [];
  return names
    .filter((n) => d.secrets[n])
    .map((n) => ({ name: n, description: d.secrets[n].description ?? "" }));
}

/** Resolved env for terminal spawns on this session — name → value. TOTP
 *  entries inject the live code (rotating), not the seed. */
export function sessionSecretEnv(ctx: ApiContext, sessionId: string): Record<string, string> {
  const d = load(ctx);
  const env: Record<string, string> = {};
  for (const n of d.sessions[sessionId] ?? []) {
    const s = d.secrets[n];
    if (!s?.value) continue;
    env[n] = s.type === "totp" ? totpCode(s.value) : s.value;
  }
  return env;
}

export const SECRET_NAME_RE = NAME_RE;
