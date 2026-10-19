import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Multi-account pool for the Devin CLI.
 *
 * Shares the account list with the Python rotation daemon
 * (devin-rotate/accounts.toml) so both front-ends rotate the same
 * credentials. Cooldown state is merged from the daemon's state.json
 * plus our own accounts-state.json — either process may mark an
 * account limited and both will respect it.
 */

export interface AccountEntry {
  name: string;
  key: string;
}

interface AccountsFile {
  settings: Record<string, number | string>;
  account: AccountEntry[];
}

const RATE_LIMIT_RE =
  /resource_exhausted|-?32011|RateLimited|QuotaExhausted|quota_exhausted|UsageLimitReached|SubscriptionLimitReached|rate_limit_exceeded|invalid api key|free model rate limit|limit will reset/i;
const RETRY_AFTER_RE = /retry[_ ]?after["' :=]+(\d+)/i;

export function isRateLimitError(msg: string): boolean {
  return RATE_LIMIT_RE.test(msg);
}

export function retryAfterSeconds(msg: string): number | null {
  const m = RETRY_AFTER_RE.exec(msg);
  return m ? Number(m[1]) : null;
}

/** Minimal TOML reader for our flat accounts.toml schema. */
function parseAccountsToml(text: string): AccountsFile {
  const out: AccountsFile = { settings: {}, account: [] };
  let section = "";
  let cur: AccountEntry | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "[[account]]") {
      section = "account";
      cur = { name: "", key: "" };
      out.account.push(cur);
      continue;
    }
    if (line === "[settings]") {
      section = "settings";
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v: string | number = line.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) {
      // A malformed quoted value must not sink the whole account list.
      try { v = JSON.parse(v as string) as string; } catch { /* keep raw */ }
    }
    else if (/^\d+(\.\d+)?$/.test(String(v))) v = Number(v);
    if (section === "account" && cur) {
      if (k === "name" || k === "key") cur[k] = String(v);
    }
    else if (section === "settings") out.settings[k] = v;
  }
  return out;
}

export class AccountPool {
  private rotateHome: string;
  private accountsFile: string;
  private daemonStateFile: string;
  private ownStateFile: string;
  private credFile: string;
  private current: string | null = null;
  private ownLimited: Record<string, number> = {};

  constructor(dataDir: string) {
    this.rotateHome =
      process.env.DEVIN_ROTATE_HOME ??
      path.resolve(__dirname, "..", "..", "..", "devin-rotate");
    this.accountsFile =
      process.env.DEVIN_ACCOUNTS_FILE ?? path.join(this.rotateHome, "accounts.toml");
    this.daemonStateFile = path.join(this.rotateHome, "state.json");
    this.ownStateFile = path.join(dataDir, "accounts-state.json");
    this.credFile = path.join(
      process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
      "devin",
      "credentials.toml",
    );
    try {
      const s = JSON.parse(fs.readFileSync(this.ownStateFile, "utf8")) as {
        current?: string;
        limited_until?: Record<string, number>;
      };
      this.current = s.current ?? null;
      this.ownLimited = s.limited_until ?? {};
    } catch {
      /* first run */
    }
  }

  private saveOwn() {
    try {
      fs.mkdirSync(path.dirname(this.ownStateFile), { recursive: true });
      fs.writeFileSync(
        this.ownStateFile,
        JSON.stringify({ current: this.current, limited_until: this.ownLimited }, null, 2),
      );
    } catch {
      /* best effort */
    }
  }

  list(): AccountEntry[] {
    try {
      const text = fs.readFileSync(this.accountsFile, "utf8");
      return parseAccountsToml(text).account.filter((a) => a.name && a.key && !a.key.includes("PASTE"));
    } catch {
      return [];
    }
  }

  /** Union of cooldown marks from our state and the Python daemon's.
   *  Expired marks are pruned so stale entries can't re-cool an account. */
  private limitedUntil(): Record<string, number> {
    const now = Date.now() / 1000;
    const merged = { ...this.ownLimited };
    try {
      const s = JSON.parse(fs.readFileSync(this.daemonStateFile, "utf8")) as {
        current?: string;
        limited_until?: Record<string, number>;
      };
      for (const [k, v] of Object.entries(s.limited_until ?? {})) {
        merged[k] = Math.max(merged[k] ?? 0, v);
      }
      if (!this.current && s.current) this.current = s.current;
    } catch {
      /* daemon state optional */
    }
    for (const k of Object.keys(merged)) if (merged[k] <= now) delete merged[k];
    return merged;
  }

  status() {
    const limited = this.limitedUntil();
    const now = Date.now() / 1000;
    const picked = this.pick(); // hoisted — pick() re-reads state files per call
    // `current` is a DISPLAY concept: the account in use may be cooling, and
    // showing "无账号" while every account cools is wrong. Spawn selection
    // still goes through pick() (healthy-only).
    const displayCurrent = this.current ?? picked;
    return this.list().map((a) => ({
      name: a.name,
      current: a.name === displayCurrent,
      picked: a.name === picked,
      limitedUntil: limited[a.name] ?? 0,
      cooling: (limited[a.name] ?? 0) > now,
    }));
  }

  /** Clear a cooldown mark (bogus/stale mark, or user knows it's healthy). */
  clearLimited(name: string): void {
    delete this.ownLimited[name];
    this.saveOwn();
    try {
      const s = JSON.parse(fs.readFileSync(this.daemonStateFile, "utf8")) as Record<string, unknown>;
      const lu = (s.limited_until ?? {}) as Record<string, number>;
      delete lu[name];
      s.limited_until = lu;
      fs.writeFileSync(this.daemonStateFile, JSON.stringify(s, null, 2));
    } catch {
      /* daemon not running */
    }
  }

  healthy(): string[] {
    const limited = this.limitedUntil();
    const now = Date.now() / 1000;
    return this.list()
      .filter((a) => (limited[a.name] ?? 0) <= now)
      .map((a) => a.name);
  }

  /** The nominally-selected account (may be cooling) — what rotate() moves. */
  get currentName(): string | null {
    return this.current;
  }

  /** Current healthy account (null when every account is cooling). */
  pick(): string | null {
    const ok = this.healthy();
    if (ok.length === 0) return null;
    if (this.current && ok.includes(this.current)) return this.current;
    return ok[0];
  }

  /** API key of the currently-picked account — injected at spawn. */
  apiKey(): string | null {
    const name = this.pick();
    const a = this.list().find((x) => x.name === name);
    return a?.key ?? null;
  }

  /** Which pool account the credentials.toml key belongs to — the real
   *  attribution for a process spawned with no injected env key (e.g. every
   *  account was cooling at spawn). Without this, its failures would mark
   *  whatever pick() happens to return — the wrong account. */
  accountForCredFile(): string | null {
    try {
      const txt = fs.readFileSync(this.credFile, "utf8");
      const m = /windsurf_api_key\s*=\s*"([^"]*)"/.exec(txt);
      if (!m) return null;
      return this.list().find((a) => a.key === m[1])?.name ?? null;
    } catch {
      return null;
    }
  }

  /** Earliest cooldown expiry — when the next account recovers. */
  nextRecoveryAt(): number | null {
    const limited = this.limitedUntil();
    const times = this.list()
      .map((a) => limited[a.name] ?? 0)
      .filter((t) => t > Date.now() / 1000);
    return times.length ? Math.min(...times) : null;
  }

  /** Mark an account rate-limited; also writes through to the daemon's state. */
  markLimited(name: string, retryAfterSec?: number | null, defaultCooldownMin = 15) {
    const cooldown = retryAfterSec ?? defaultCooldownMin * 60;
    const until = Date.now() / 1000 + cooldown;
    this.ownLimited[name] = until;
    this.saveOwn();
    try {
      const s = JSON.parse(fs.readFileSync(this.daemonStateFile, "utf8")) as Record<string, unknown>;
      const lu = (s.limited_until ?? {}) as Record<string, number>;
      lu[name] = Math.max(lu[name] ?? 0, until);
      s.limited_until = lu;
      fs.writeFileSync(this.daemonStateFile, JSON.stringify(s, null, 2));
    } catch {
      /* daemon not running — fine */
    }
  }

  /** Write the picked key into credentials.toml so any spawned devin picks it up. */
  applyCredentials(key: string) {
    try {
      let txt = "";
      try {
        txt = fs.readFileSync(this.credFile, "utf8");
      } catch {
        /* absent */
      }
      if (/windsurf_api_key\s*=\s*"[^"]*"/.test(txt)) {
        txt = txt.replace(/windsurf_api_key\s*=\s*"[^"]*"/, `windsurf_api_key = ${JSON.stringify(key)}`);
      } else {
        txt = txt.trimEnd() + `\nwindsurf_api_key = ${JSON.stringify(key)}\n`;
      }
      fs.mkdirSync(path.dirname(this.credFile), { recursive: true });
      fs.writeFileSync(this.credFile, txt);
    } catch {
      /* best effort */
    }
  }

  /** Rotate to the next healthy account (or an explicit target). Returns the new name. */
  rotate(target?: string): string | null {
    const ok = this.healthy();
    if (ok.length === 0) return null;
    let next: string;
    if (target && ok.includes(target)) next = target;
    else if (this.current && ok.includes(this.current) && ok.length > 1)
      next = ok[(ok.indexOf(this.current) + 1) % ok.length];
    else next = ok[0];
    this.current = next;
    const key = this.list().find((a) => a.name === next)?.key;
    if (key) this.applyCredentials(key);
    this.saveOwn();
    return next;
  }

  // ---- account identity & quota (SeatManagementService/GetUserStatus) ------

  private statusCache = new Map<string, { at: number; info: AccountStatusInfo | null }>();

  /** Cached remote identity/quota for an account key; kicks a refresh when stale. */
  info(name: string): AccountStatusInfo | null {
    const a = this.list().find((x) => x.name === name);
    if (!a) return null;
    const c = this.statusCache.get(a.key);
    if (c && Date.now() - c.at < 60_000) return c.info;
    void this.refreshInfo(a.key);
    return c?.info ?? null;
  }

  private refreshInfo(key: string): Promise<void> {
    return fetchUserStatus(key)
      .then((info) => void this.statusCache.set(key, { at: Date.now(), info }))
      .catch(() => void this.statusCache.set(key, { at: Date.now(), info: null }));
  }

  /** Force a fresh quota read for one account. */
  async refresh(name: string): Promise<AccountStatusInfo | null> {
    const a = this.list().find((x) => x.name === name);
    if (!a) return null;
    const info = await fetchUserStatus(a.key).catch(() => null);
    this.statusCache.set(a.key, { at: Date.now(), info });
    return info;
  }

  /** Append an account to accounts.toml (shared with the Python daemon). */
  add(name: string, key: string): void {
    const safe = (s: string) => s.replace(/["\\\r\n]/g, "");
    fs.mkdirSync(path.dirname(this.accountsFile), { recursive: true });
    const block = `\n[[account]]\nname = ${JSON.stringify(safe(name))}\nkey = ${JSON.stringify(safe(key))}\n`;
    fs.appendFileSync(this.accountsFile, block);
  }

  /** Remove an account block by name (rebuilds the file from parsed entries). */
  remove(name: string): boolean {
    try {
      const text = fs.readFileSync(this.accountsFile, "utf8");
      const entries = parseAccountsToml(text);
      const keep = entries.account.filter((a) => a.name !== name);
      if (keep.length === entries.account.length) return false;
      const head = ["[settings]", ...Object.entries(entries.settings).map(([k, v]) => `  ${k} = ${typeof v === "number" ? v : JSON.stringify(String(v))}`)];
      const blocks = keep.map((a) => `\n[[account]]\nname = ${JSON.stringify(a.name)}\nkey = ${JSON.stringify(a.key)}`);
      fs.writeFileSync(this.accountsFile, head.join("\n") + "\n" + blocks.join("\n") + "\n");
      if (this.current === name) this.current = null;
      delete this.ownLimited[name];
      this.saveOwn();
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Remote account status (SeatManagementService/GetUserStatus, Connect JSON-RPC)

export interface AccountStatusInfo {
  email: string | null;
  userName: string | null;
  userId: string | null;
  plan: string | null;
  tier: string | null;
  dailyQuotaRemainingPercent: number | null;
  weeklyQuotaRemainingPercent: number | null;
  availablePromptCredits: number | null;
  monthlyPromptCredits: number | null;
  overageBalanceUsd: number | null;
  planStart: string | null;
  planEnd: string | null;
  dailyResetAt: number | null;
  weeklyResetAt: number | null;
}

const CODEIUM_API = "https://server.codeium.com";

/** Connect-JSON GetUserStatus; the token rides in request metadata.api_key. */
export async function fetchUserStatus(apiKey: string): Promise<AccountStatusInfo> {
  const res = await fetch(
    `${CODEIUM_API}/exa.seat_management_pb.SeatManagementService/GetUserStatus`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "connect-protocol-version": "1",
      },
      body: JSON.stringify({
        metadata: {
          api_key: apiKey,
          ide_name: "cli",
          ide_version: "0.0.0",
          extension_name: "devin",
          extension_version: "0.0.0",
          os_name: process.platform,
        },
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) throw new Error(`GetUserStatus ${res.status}`);
  const data = (await res.json()) as Record<string, any>;
  const us = data.userStatus ?? {};
  const ps = us.planStatus ?? {};
  const pi = ps.planInfo ?? {};
  const micros = Number(ps.overageBalanceMicros ?? NaN);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    email: str(us.email),
    userName: str(us.name),
    userId: str(us.userId ?? us.user_id),
    plan: str(pi.planName),
    tier: str(us.teamsTier ?? pi.teamsTier),
    dailyQuotaRemainingPercent: num(ps.dailyQuotaRemainingPercent),
    weeklyQuotaRemainingPercent: num(ps.weeklyQuotaRemainingPercent),
    availablePromptCredits: num(ps.availablePromptCredits),
    monthlyPromptCredits: num(pi.monthlyPromptCredits),
    overageBalanceUsd: Number.isFinite(micros) ? micros / 1e6 : null,
    planStart: str(ps.planStart),
    planEnd: str(ps.planEnd),
    dailyResetAt: num(Number(ps.dailyQuotaResetAtUnix)),
    weeklyResetAt: num(Number(ps.weeklyQuotaResetAtUnix)),
  };
}

// ---------------------------------------------------------------------------
// PKCE login (mirrors devin_rotate.py's pkce_start/pkce_finish)

interface PendingPkce {
  verifier: string;
  createdAt: number;
}
const pendingPkce = new Map<string, PendingPkce>();

const b64url = (buf: Buffer) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Returns {url, id}; the id is passed back to pkceFinish along with the code. */
export function pkceStart(): { url: string; id: string } {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const id = crypto.randomBytes(8).toString("hex");
  const state = b64url(crypto.randomBytes(16));
  pendingPkce.set(id, { verifier, createdAt: Date.now() });
  // expire pending flows after 10min
  for (const [k, v] of pendingPkce) {
    if (Date.now() - v.createdAt > 600_000) pendingPkce.delete(k);
  }
  const url =
    "https://app.devin.ai/auth/cli/continue" +
    `?state=${state}&prompt=select_account&code_challenge=${challenge}` +
    "&code_challenge_method=S256&cli_pkce_marker=1";
  return { url, id };
}

/** Exchange the code for a `devin-session-token$…` key. Throws on failure. */
export async function pkceFinish(id: string, code: string): Promise<string> {
  const p = pendingPkce.get(id);
  if (!p) throw new Error("登录会话已过期，请重新生成链接");
  const res = await fetch("https://app.devin.ai/api/auth/cli/token", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://app.devin.ai",
      "user-agent": "Mozilla/5.0",
    },
    body: JSON.stringify({ code: code.trim(), code_verifier: p.verifier }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = String((await res.json() as Record<string, unknown>).detail ?? "");
    } catch {
      /* ignore */
    }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new Error("响应中没有 token");
  pendingPkce.delete(id);
  return `devin-session-token$${data.token}`;
}
