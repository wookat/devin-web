import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Devin Desktop keeps a protobuf model catalog per account at
 *   %LOCALAPPDATA%\devin\cli\model_configs_v*.<digest>.bin
 * (JSON wrapper, base64 `payload`).
 *
 * The catalog is a list of variant entries, each carrying its own control
 * set — e.g. "SWE-2 High" (swe-2-high) lists `Reasoning Effort` + `Fast Mode`,
 * while "Gemini 4 Argon Medium" lists only `Reasoning Effort`. Family ids
 * prefix their variants (`claude-opus-4-8` → `claude-opus-4-8-high-fast`).
 * Per-family data reconstructed here:
 *   efforts  — union of variant effort suffixes + the base variant's effort
 *              parsed from its display name ("GLM-5.2 High" → high)
 *   fast     — `Fast Mode`/`Speed` control present or `-fast`/`-lightning`
 *              variants exist
 *   ctx1m    — `1M Context` control present or `-1m` variants exist
 *
 * ACP only exposes global `thought_level`/`speed` groups; this map lets the
 * UI gate those sections per family like the desktop picker.
 */

const EFFORT_LEVELS = new Set([
  "none", "min", "minimal", "low", "medium", "high", "xhigh", "max",
]);
const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9.]+)+$/;
const CONTROL_NAMES = new Set([
  "Reasoning Effort", "Effort", "Thinking", "Fast Mode", "1M Context",
  "Prompt Cache Retention", "Speed", "Extended Thinking", "Cache",
]);

/** Control names that mean "this family has an effort/thinking control". */
const EFFORT_CONTROL_NAMES = new Set([
  "Reasoning Effort", "Effort", "Thinking", "Extended Thinking",
]);

interface FamilyEntry {
  efforts: Set<string>;
  effortCtl: boolean;
  fast: boolean;
  ctx1m: boolean;
}

export interface ModelPrices {
  input?: number;
  cached?: number;
  output?: number;
}

export interface CatalogInfo {
  family: string;
  efforts: string[];
  effortCtl: boolean;
  fast: boolean;
  ctx1m: boolean;
  prices?: ModelPrices;
}

let cache: {
  loadedAt: number;
  families: Map<string, FamilyEntry>;
  varToFam: Map<string, string>;
  varPrices: Map<string, ModelPrices>;
} | null = null;
const CACHE_TTL = 60_000;

function cliDir(): string {
  const local = process.env.LOCALAPPDATA;
  if (local) return path.join(local, "devin", "cli");
  return path.join(os.homedir(), ".local", "share", "devin", "cli");
}

/** Extract printable ASCII runs ≥3 chars from the decoded protobuf payload. */
function payloadStrings(buf: Buffer): { s: string; off: number }[] {
  const out: { s: string; off: number }[] = [];
  let cur = "";
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b >= 0x20 && b < 0x7f) {
      if (!cur) start = i;
      cur += String.fromCharCode(b);
    } else {
      if (cur.length >= 3) out.push({ s: cur, off: start });
      cur = "";
    }
  }
  if (cur.length >= 3) out.push({ s: cur, off: start });
  return out;
}

/** Last effort word in a display name ("GPT-6 Astra Medium Thinking" → medium). */
function nameEffort(name: string): string | null {
  const words = name.toLowerCase().split(/[\s-]+/);
  for (let i = words.length - 1; i >= 0; i--) {
    if (EFFORT_LEVELS.has(words[i])) return words[i];
  }
  return null;
}

function ingestFile(
  families: Map<string, FamilyEntry>,
  varToFam: Map<string, string>,
  varPrices: Map<string, ModelPrices>,
  raw: Buffer,
) {
  const strs = payloadStrings(raw);
  const N = strs.length;

  // Entry = display name (starts uppercase/digit, 2–6 words) followed within
  // 4 strings by its kebab-case variant id.
  const entries: { i: number; name: string; vid: string }[] = [];
  for (let i = 0; i < N - 1; i++) {
    const s = strs[i].s;
    if (
      /^[A-Z0-9]/.test(s) &&
      !KEBAB_RE.test(s) &&
      s.split(" ").length >= 2 &&
      s.split(" ").length <= 6 &&
      !CONTROL_NAMES.has(s)
    ) {
      let vid = "";
      for (let j = i + 1; j < Math.min(i + 5, N); j++) {
        if (KEBAB_RE.test(strs[j].s)) { vid = strs[j].s; break; }
      }
      if (vid) entries.push({ i, name: s, vid });
    }
  }

  for (let k = 0; k < entries.length; k++) {
    const { i, name, vid } = entries[k];
    const end = k + 1 < entries.length ? entries[k + 1].i : Math.min(i + 60, N);
    const block = strs.slice(i + 1, end).map((x) => x.s);

    // Per-variant pricing: the entry's byte span holds up to three
    // `{name} <fixed32 price> "1M tokens" ...` sub-blocks, in Input →
    // Cached input → Output order. The price is the float right after the
    // label's length-delimited string field.
    {
      const spanStart = strs[i].off;
      const spanEnd = k + 1 < entries.length ? strs[entries[k + 1].i].off : raw.length;
      const prices: ModelPrices = {};
      const grab = (label: string, key: keyof ModelPrices) => {
        const p = raw.indexOf(label, spanStart);
        if (p >= 0 && p + label.length < spanEnd) {
          const v = raw.readFloatLE(p + label.length + 1);
          if (v > 0 && v < 10000) prices[key] = v;
        }
      };
      grab("Output", "output");
      grab("Cached input", "cached");
      // "Input" is a suffix of "Cached input" — scan for a standalone hit.
      for (let p = spanStart; p < spanEnd;) {
        const q = raw.indexOf("Input", p);
        if (q < 0 || q >= spanEnd) break;
        if (!raw.subarray(Math.max(spanStart, q - 12), q).toString().endsWith("Cached ")) {
          const v = raw.readFloatLE(q + 5 + 1);
          if (v > 0 && v < 10000) { prices.input = v; break; }
        }
        p = q + 5;
      }
      if (prices.input !== undefined || prices.cached !== undefined || prices.output !== undefined) {
        varPrices.set(vid, prices);
      }
    }

    // Family id: longest kebab string in the block that is a strict prefix of vid.
    let fam = "";
    for (const t of block) {
      if (KEBAB_RE.test(t) && vid.startsWith(t + "-") && t.length > fam.length) fam = t;
    }
    if (!fam) fam = vid;
    varToFam.set(vid, fam);

    // Variant effort: effort-token at the start of the suffix, else the base
    // variant's effort word from its display name.
    let effort: string | null = null;
    if (vid !== fam && vid.startsWith(fam + "-")) {
      const first = vid.slice(fam.length + 1).split("-")[0];
      if (EFFORT_LEVELS.has(first)) effort = first;
    }
    if (!effort) effort = nameEffort(name);

    const hasEffortCtl = block.some((t) => EFFORT_CONTROL_NAMES.has(t));
    const hasFastCtrl = block.some((t) => t === "Fast Mode" || t === "Speed");
    const hasCtxCtrl = block.includes("1M Context");
    const fastVariant = /(^|-)fast(-|$)|-lightning$/.test(vid.slice(fam.length));
    const ctxVariant = /(^|-)1m$/.test(vid.slice(fam.length));

    const e = families.get(fam) ?? { efforts: new Set<string>(), effortCtl: false, fast: false, ctx1m: false };
    if (effort) e.efforts.add(effort);
    e.effortCtl = e.effortCtl || hasEffortCtl;
    e.fast = e.fast || hasFastCtrl || fastVariant;
    e.ctx1m = e.ctx1m || hasCtxCtrl || ctxVariant;
    families.set(fam, e);
  }
}

function load() {
  const families = new Map<string, FamilyEntry>();
  const varToFam = new Map<string, string>();
  const varPrices = new Map<string, ModelPrices>();
  const dir = cliDir();
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^model_configs_v\d+\.[0-9a-f]+\.bin$/.test(f));
  } catch {
    return { families, varToFam, varPrices };
  }
  for (const f of files) {
    try {
      const wrap = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { payload?: string };
      if (!wrap.payload) continue;
      ingestFile(families, varToFam, varPrices, Buffer.from(wrap.payload, "base64"));
    } catch {
      /* corrupt/partial cache file — skip */
    }
  }
  // Fixpoint merge: newer catalog files store variants flattened as one
  // family per entry (`gpt-5-6-sol-high`, `claude-opus-4-6-thinking-1m`).
  // Repeatedly fold `<root>-<suffix>` into `<root>` so each family's effort
  // set / fast / ctx flags are complete. `lightning` is deliberately NOT a
  // merge suffix — SWE Lightning is a distinct model line.
  const STRIP = /-(none|min|minimal|low|medium|high|xhigh|max|1m|thinking|fast|lite|priority)$/;
  let changed = true;
  while (changed) {
    changed = false;
    for (const [f, e] of [...families]) {
      const root = f.replace(STRIP, "");
      if (root === f) continue;
      const t = families.get(root) ?? { efforts: new Set<string>(), effortCtl: false, fast: false, ctx1m: false };
      for (const x of e.efforts) t.efforts.add(x);
      t.effortCtl = t.effortCtl || e.effortCtl;
      t.fast = t.fast || e.fast;
      t.ctx1m = t.ctx1m || e.ctx1m;
      families.set(root, t);
      families.delete(f);
      for (const [v, fm] of varToFam) if (fm === f) varToFam.set(v, root);
      changed = true;
    }
  }
  return { families, varToFam, varPrices };
}

function maps() {
  if (!cache || Date.now() - cache.loadedAt > CACHE_TTL) {
    cache = { loadedAt: Date.now(), ...load() };
  }
  return cache;
}

/**
 * Catalog info for an ACP model value (`swe-2-high` → family `swe-2`).
 * Returns null when the catalog doesn't know the family — callers should
 * fall back to the agent-advertised groups as-is.
 */
export function catalogInfo(modelValue: string): CatalogInfo | null {
  const { families, varToFam, varPrices } = maps();
  // Longest family key that is a strict prefix (or exact) — groups flattened
  // variant entries under their family (glm-5-2-1m → glm-5-2).
  let fam = "";
  for (const k of families.keys()) {
    if ((modelValue === k || modelValue.startsWith(k + "-")) && k.length > fam.length) fam = k;
  }
  if (!fam) fam = varToFam.get(modelValue) ?? "";
  if (!fam) return null;
  const e = families.get(fam);
  if (!e) return null;
  const efforts = new Set(e.efforts);
  // The ACP value's own effort suffix counts too (swe-1-7-lightning-medium →
  // family swe-1-7-lightning gets {max} ∪ {medium}).
  if (modelValue !== fam && modelValue.startsWith(fam + "-")) {
    const first = modelValue.slice(fam.length + 1).split("-")[0];
    if (EFFORT_LEVELS.has(first)) efforts.add(first);
  }
  // Variant-specific prices win; the first priced variant in the family is
  // the fallback for values that carry no price block of their own.
  const variantPrices = varPrices.get(modelValue)
    ?? (() => { for (const [v, fm] of varToFam) { if (fm === fam && varPrices.has(v)) return varPrices.get(v); } return undefined })();
  return { family: fam, efforts: [...efforts], effortCtl: e.effortCtl, fast: e.fast, ctx1m: e.ctx1m, prices: variantPrices };
}
