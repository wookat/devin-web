// Offline unit tests for the local secrets store, TOTP, and the stream
// redactor that keeps bound values out of the transcript.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tsImport } from "tsx/esm/api";

const secrets = await tsImport("../server/src/secrets.ts", import.meta.url);
const { scrubSecrets, makeStreamRedactor, SECRET_MASK } = await tsImport("../server/src/terminal.ts", import.meta.url);

function tmpCtx(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-secrets-"));
  t.after(() => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} });
  return { store: { dataDir } };
}

test("store: upsert/list redacts values; delete removes bindings", (t) => {
  const ctx = tmpCtx(t);
  assert.equal(secrets.upsertSecret(ctx, "MY_KEY", "s3cret-value-9", "test key").ok, true);
  assert.equal(secrets.upsertSecret(ctx, "BAD-NAME!", "x").ok, false);
  assert.equal(secrets.upsertSecret(ctx, "1LEADING", "x").ok, false);
  // env-critical names are refused — a PATH secret would clobber the child's PATH
  for (const n of ["PATH", "Path", "HOME", "COMSPEC", "NODE_OPTIONS", "LD_PRELOAD", "DEVIN_WEB_PORT"]) {
    assert.deepEqual(secrets.upsertSecret(ctx, n, "x").ok, false, n);
  }
  const list = secrets.listSecrets(ctx);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "MY_KEY");
  assert.deepEqual(Object.keys(list[0]).sort(), ["createdAt", "description", "name", "sessions", "updatedAt"]);
  assert.equal("value" in list[0], false); // values never leave the backend

  // rotate: same-name upsert keeps createdAt, updates value
  assert.equal(secrets.upsertSecret(ctx, "MY_KEY", "rotated-2", "").ok, true);
  assert.equal(secrets.sessionSecretEnv(ctx, "s1").MY_KEY, undefined); // unbound → no env

  // bind + env resolution
  assert.deepEqual(secrets.bindSessionSecrets(ctx, "s1", ["MY_KEY", "NOPE"]), ["MY_KEY"]);
  assert.deepEqual(secrets.bindSessionSecrets(ctx, "s1", ["MY_KEY"]), []); // dup → no-op
  assert.equal(secrets.sessionSecretEnv(ctx, "s1").MY_KEY, "rotated-2");
  assert.deepEqual(secrets.listSecrets(ctx)[0].sessions, ["s1"]);

  // unbind revokes one session's access
  assert.deepEqual(secrets.unbindSessionSecret(ctx, "s1", "MY_KEY"), { ok: true, removed: true });
  assert.equal(secrets.sessionSecretEnv(ctx, "s1").MY_KEY, undefined);
  assert.deepEqual(secrets.unbindSessionSecret(ctx, "s1", "MY_KEY"), { ok: true, removed: false });

  // delete scrubs the binding everywhere
  secrets.bindSessionSecrets(ctx, "s1", ["MY_KEY"]);
  secrets.bindSessionSecrets(ctx, "s2", ["MY_KEY"]);
  const del = secrets.deleteSecret(ctx, "MY_KEY");
  assert.equal(del.ok, true);
  assert.deepEqual(del.deletedBound.sort(), ["s1", "s2"]);
  assert.deepEqual(secrets.listSecrets(ctx), []);
});

test("totp: RFC 6238 test vector, injected env gets the live code", (t) => {
  const ctx = tmpCtx(t);
  // RFC 6238 SHA-1 seed "12345678901234567890" in base32; T=59s → 94287082 (8-digit) → 287082
  const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(secrets.totpCode(seed, 30, 8, 59_000), "94287082");
  assert.equal(secrets.totpCode(seed, 30, 6, 59_000), "287082");
  assert.equal(secrets.totpCode("not a seed!!"), "");
  assert.equal(secrets.upsertSecret(ctx, "OTP_KEY", seed, "", "totp").ok, true);
  assert.equal(secrets.upsertSecret(ctx, "OTP_BAD", "has spaces & bad chars", "", "totp").ok, false);
  secrets.bindSessionSecrets(ctx, "s1", ["OTP_KEY"]);
  const env = secrets.sessionSecretEnv(ctx, "s1");
  assert.match(env.OTP_KEY, /^\d{6}$/);
  assert.notEqual(env.OTP_KEY, seed); // the seed itself never reaches env
  assert.equal(secrets.listSecrets(ctx)[0].type, "totp");
  // the live code is in the masking set — `echo $OTP_KEY` must not reach transcripts
  assert.ok(secrets.sessionSecretValues(ctx, "s1").includes(env.OTP_KEY));
});

test("stream redactor masks values across chunk boundaries", () => {
  const secret = "sk-live-abcdef0123456789";
  // every possible split point across two chunks
  for (let split = 0; split <= secret.length; split++) {
    const r = makeStreamRedactor([secret]);
    const out = r.push(`prefix ${secret.slice(0, split)}`) + r.push(`${secret.slice(split)} suffix`);
    const flushed = out + r.flush();
    assert.equal(flushed.includes(secret), false, `split ${split}`);
    assert.ok(flushed.includes(SECRET_MASK));
    assert.ok(flushed.includes("prefix") && flushed.includes("suffix"));
  }
  // multiple occurrences + multiple values in one buffer
  const r2 = makeStreamRedactor(["tok_AAAA", "tok_BBBB"]);
  const s2 = r2.push("a=tok_AAAA b=tok_BBBB c=tok_AAAA") + r2.flush();
  assert.equal(s2.includes("tok_"), false);
  assert.equal(s2.split(SECRET_MASK).length - 1, 3);
  // short values are not masked
  const r3 = makeStreamRedactor(["ab"]);
  assert.equal(r3.push("x ab y") + r3.flush(), "x ab y");
  // no secrets → passthrough
  const r4 = makeStreamRedactor([]);
  assert.equal(r4.push("anything") + r4.flush(), "anything");
});

test("scrubSecrets redacts for the fs read channel", () => {
  assert.equal(scrubSecrets("KEY=topsecret1\nOTHER=ok", ["topsecret1"]), `KEY=${SECRET_MASK}\nOTHER=ok`);
});

test("redactor also masks the base64 echo form", () => {
  const secret = "sk-live-abcdef0123456789";
  const b64 = Buffer.from(secret, "utf8").toString("base64");
  const r = makeStreamRedactor([secret]);
  const out = r.push(`plain:${secret} enc:${b64} done`) + r.flush();
  assert.equal(out.includes(secret), false);
  assert.equal(out.includes(b64), false);
  assert.equal(out.split(SECRET_MASK).length - 1, 2);
});

test("audit journal records grant mutations without values", (t) => {
  const ctx = tmpCtx(t);
  secrets.upsertSecret(ctx, "AUD_KEY", "aud-val-1");
  secrets.bindSessionSecrets(ctx, "s9", ["AUD_KEY"]);
  secrets.unbindSessionSecret(ctx, "s9", "AUD_KEY");
  secrets.deleteSecret(ctx, "AUD_KEY");
  const lines = fs.readFileSync(path.join(ctx.store.dataDir, "secrets-audit.jsonl"), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.op), ["create", "bind", "unbind", "delete"]);
  assert.equal(lines[1].sessionId, "s9");
  assert.equal(JSON.stringify(lines).includes("aud-val-1"), false); // no values in audit
});

test("at-rest: v2 envelope, dpapi ciphertext on win32, v1 migration, poisoned file", (t) => {
  const ctx = tmpCtx(t);
  secrets.upsertSecret(ctx, "ENC_KEY", "enc-val-7", "", undefined);
  const f = path.join(ctx.store.dataDir, "secrets.json");
  const raw = fs.readFileSync(f, "utf8");
  const j = JSON.parse(raw);
  assert.equal(j.version, 2);
  if (process.platform === "win32" && process.env.DEVIN_WEB_SECRETS_PLAIN !== "1") {
    assert.equal(j.enc, "dpapi");
    assert.equal(raw.includes("enc-val-7"), false); // ciphertext at rest
    assert.equal(typeof j.data, "string");
    // decrypts back through the mtime-cached load path
    secrets.bindSessionSecrets(ctx, "s1", ["ENC_KEY"]);
    assert.equal(secrets.sessionSecretEnv(ctx, "s1").ENC_KEY, "enc-val-7");
  } else {
    assert.equal(j.enc, "plain");
    assert.equal(j.data.secrets.ENC_KEY.value, "enc-val-7");
  }

  // legacy v1 flat file still loads and upgrades to v2 on the next write
  const ctx2 = tmpCtx(t);
  const f2 = path.join(ctx2.store.dataDir, "secrets.json");
  fs.writeFileSync(f2, JSON.stringify({ secrets: { OLD_KEY: { value: "oldval-1" } }, sessions: { s1: ["OLD_KEY"] } }));
  assert.equal(secrets.sessionSecretEnv(ctx2, "s1").OLD_KEY, "oldval-1");
  secrets.upsertSecret(ctx2, "NEW_KEY", "newval-1");
  assert.equal(JSON.parse(fs.readFileSync(f2, "utf8")).version, 2);

  // poisoned: an undecodable file reads empty but is never overwritten
  const ctx3 = tmpCtx(t);
  const f3 = path.join(ctx3.store.dataDir, "secrets.json");
  fs.writeFileSync(f3, "{ not json at all !!!");
  assert.deepEqual(secrets.listSecrets(ctx3), []);
  secrets.upsertSecret(ctx3, "X_KEY", "x-val-1"); // must NOT clobber the file
  assert.equal(fs.readFileSync(f3, "utf8"), "{ not json at all !!!");
});
