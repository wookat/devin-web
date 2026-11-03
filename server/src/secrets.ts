/**
 * Local secrets store — devin-web's answer to Devin cloud org secrets.
 *
 * `<dataDir>/secrets.json` (0600):
 *   { secrets: { NAME: { value, description, createdAt, updatedAt } },
 *     sessions: { sessionId: [NAME, …] } }
 *
 * Invariants:
 *  - Values NEVER leave the backend: list/composer-meta carry name+description
 *    only. The agent receives values as env vars on its terminal spawns
 *    (TerminalRunner merges `sessionSecretEnv(sessionId)`), so the value never
 *    enters the transcript or session log unless the agent echoes it.
 *  - Bindings accumulate per session: every `@secrets:NAME` mention in a
 *    dispatched prompt unions NAME into `sessions[id]` — a session only ever
 *    gains access, matching the cloud model (once granted, granted).
 *  - The store is read-modify-write per call; writes are rare and user-driven,
 *    so a plain writeFileSync + chmod 0600 is enough.
 */
import fs from "node:fs";
import path from "node:path";
import type { ApiContext } from "./routes.js";

export interface SecretEntry {
  value: string;
  description: string;
  createdAt: number;
  updatedAt: number;
}

interface SecretsFile {
  secrets?: Record<string, Partial<SecretEntry>>;
  sessions?: Record<string, string[]>;
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function file(ctx: ApiContext): string {
  return path.join(ctx.store.dataDir, "secrets.json");
}

function load(ctx: ApiContext): Required<SecretsFile> {
  try {
    const j = JSON.parse(fs.readFileSync(file(ctx), "utf8")) as SecretsFile;
    return { secrets: j.secrets ?? {}, sessions: j.sessions ?? {} };
  } catch {
    return { secrets: {}, sessions: {} };
  }
}

function save(ctx: ApiContext, d: Required<SecretsFile>): void {
  const f = file(ctx);
  fs.writeFileSync(f, JSON.stringify(d, null, 2), { mode: 0o600 });
  try { fs.chmodSync(f, 0o600); } catch { /* best effort — win32 acl */ }
}

export function listSecrets(ctx: ApiContext): { name: string; description: string; createdAt: number; updatedAt: number }[] {
  const d = load(ctx);
  return Object.entries(d.secrets)
    .map(([name, s]) => ({
      name,
      description: s.description ?? "",
      createdAt: s.createdAt ?? 0,
      updatedAt: s.updatedAt ?? 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function upsertSecret(ctx: ApiContext, name: string, value: string, description = ""): { ok: boolean; error?: string } {
  if (!NAME_RE.test(name)) return { ok: false, error: "invalid_name" };
  if (!value) return { ok: false, error: "empty_value" };
  const d = load(ctx);
  const prev = d.secrets[name];
  d.secrets[name] = {
    value,
    description: description || prev?.description || "",
    createdAt: prev?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };
  save(ctx, d);
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
  }
  return added;
}

export function sessionSecretNames(ctx: ApiContext, sessionId: string): string[] {
  return load(ctx).sessions[sessionId] ?? [];
}

/** Names + descriptions for the agent-facing hint (values stay out of text). */
export function sessionSecretHints(ctx: ApiContext, sessionId: string, only?: string[]): { name: string; description: string }[] {
  const d = load(ctx);
  const names = only ?? d.sessions[sessionId] ?? [];
  return names
    .filter((n) => d.secrets[n])
    .map((n) => ({ name: n, description: d.secrets[n].description ?? "" }));
}

/** Resolved env for terminal spawns on this session — name → value. */
export function sessionSecretEnv(ctx: ApiContext, sessionId: string): Record<string, string> {
  const d = load(ctx);
  const env: Record<string, string> = {};
  for (const n of d.sessions[sessionId] ?? []) {
    const s = d.secrets[n];
    if (s?.value) env[n] = s.value;
  }
  return env;
}

export const SECRET_NAME_RE = NAME_RE;
