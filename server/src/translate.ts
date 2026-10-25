/**
 * translate — message/selection translation for the mirror UI.
 *
 * Provider chain (first hit wins):
 *  1. DEVIN_WEB_TRANSLATE_URL — an upstream endpoint (the official devin
 *     web service, or any compatible gateway) called with the account
 *     Bearer token, same contract as the transcribe-audio proxy:
 *     POST {text,target} → {result|text|translation}.
 *  2. MyMemory (api.mymemory.translated.net) — anonymous, no key, reachable
 *     where Google isn't. ~450 chars per query, chunked on paragraphs.
 *  3. Google gtx — last resort; unreachable on some networks (times out).
 *
 * Results memoize in a small LRU — the toolbar button is clicked more
 * than once for the same message.
 */
import { translateUrl } from "./env.js";

/** Client sends display names ("Chinese"/"English") or BCP-47 codes —
 *  map the names, pass everything else through verbatim. */
function langCode(target: string): string {
  const t = target.trim().toLowerCase();
  if (t === "chinese" || t === "zh" || t === "中文") return "zh-CN";
  if (t === "english" || t === "en" || t === "英文") return "en";
  return target.trim() || "auto";
}

/** Split on paragraph boundaries, hard-cut only when a single paragraph
 *  exceeds the cap. */
function chunkText(text: string, cap: number): string[] {
  if (text.length <= cap) return [text];
  const parts: string[] = [];
  let cur = "";
  for (const para of text.split(/(\n\s*\n)/)) {
    if (cur.length + para.length > cap && cur) { parts.push(cur); cur = ""; }
    if (para.length > cap) {
      for (let i = 0; i < para.length; i += cap) parts.push(para.slice(i, i + cap));
    } else cur += para;
  }
  if (cur) parts.push(cur);
  return parts.filter((p) => p.length);
}

const CACHE_MAX = 200;
const cache = new Map<string, string>();
function cacheGet(k: string) { const v = cache.get(k); if (v != null) { cache.delete(k); cache.set(k, v); } return v; }
function cacheSet(k: string, v: string) { if (cache.has(k)) cache.delete(k); else if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!); cache.set(k, v); }

export interface TranslateResult { result: string | null; error: string | null }

async function viaUpstream(ctx: { accounts: { apiKey(): string | null } }, text: string, target: string): Promise<string | null> {
  const url = translateUrl();
  const key = ctx.accounts.apiKey();
  if (!url || !key) return null;
  const r = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ text, target }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) return null;
  const j = (await r.json().catch(() => null)) as { result?: string; text?: string; translation?: string } | null;
  return j?.result ?? j?.text ?? j?.translation ?? null;
}

/** MyMemory anonymous quota is ~450 chars per query — chunk tighter than
 *  gtx. langpair needs BCP codes ("en|zh-CN"); "auto" source isn't a thing
 *  here, so detect CJK presence for the source side. */
function srcCode(text: string): string {
  return /[぀-ヿ㐀-䶿一-鿿豈-﫿]/.test(text) ? "zh-CN" : "en";
}

async function viaMyMemory(text: string, tl: string): Promise<string> {
  const src = srcCode(text);
  if (src === tl) return text;
  const out: string[] = [];
  for (const c of chunkText(text, 450)) {
    const r = await fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(c)}&langpair=${encodeURIComponent(`${src}|${tl}`)}`,
      { signal: AbortSignal.timeout(12_000) },
    );
    if (!r.ok) throw new Error(`mymemory ${r.status}`);
    const j = (await r.json()) as { responseData?: { translatedText?: string }; quotaFinished?: boolean };
    if (j.quotaFinished) throw new Error("mymemory daily quota exhausted");
    const seg = j.responseData?.translatedText;
    if (!seg) throw new Error("mymemory empty response");
    out.push(seg);
  }
  return out.join("\n\n");
}

async function viaGtx(text: string, tl: string): Promise<string> {
  const out: string[] = [];
  for (const c of chunkText(text, 4500)) {
    const r = await fetch(
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(c)}`,
      { signal: AbortSignal.timeout(12_000) },
    );
    if (!r.ok) throw new Error(`translate upstream ${r.status}`);
    const data = (await r.json()) as [[string?, string?][] | null] | null;
    out.push(((data?.[0] ?? []) as ([string?, string?] | null)[]).map((seg) => seg?.[0] ?? "").join(""));
  }
  return out.join("\n\n");
}

export async function translateText(ctx: { accounts: { apiKey(): string | null } }, text: string, target: string): Promise<TranslateResult> {
  const trimmed = text.trim();
  if (!trimmed) return { result: null, error: "empty text" };
  const tl = langCode(target);
  const ck = `${tl} ${trimmed.length} ${trimmed.slice(0, 48)}`;
  const hit = cacheGet(ck);
  if (hit != null) return { result: hit, error: null };
  try {
    const up = await viaUpstream(ctx, trimmed, target);
    if (up != null) { cacheSet(ck, up); return { result: up, error: null }; }
  } catch { /* upstream dead — fall through */ }
  const providers: [string, (t: string, l: string) => Promise<string>][] = [["mymemory", viaMyMemory], ["gtx", viaGtx]];
  let lastErr = "no provider";
  for (const [name, fn] of providers) {
    try {
      const result = await fn(trimmed, tl);
      if (!result.trim()) { lastErr = `${name}: empty translation`; continue; }
      cacheSet(ck, result);
      return { result, error: null };
    } catch (e) {
      lastErr = `${name}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return { result: null, error: lastErr };
}
