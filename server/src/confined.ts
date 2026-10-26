// confined — workspace path confinement, shared by lweb/session.js (file-raw,
// uploads, file browser) and dwtimeline (media-reference attachment lookup).
// Kept dependency-free so both directions of the session↔timeline edge can
// import it without a module cycle.
import fs from "node:fs";
import path from "node:path";

/** Resolve a workspace-relative path strictly INSIDE cwd — rejects absolutes
 *  and `..` escapes, then re-checks the REAL path: a symlink/junction inside
 *  the workspace pointing outside must not escape (lexical resolve alone
 *  doesn't chase links). Returns the absolute path or null. */
export function confined(cwd: string, p: unknown): string | null {
  if (typeof p !== "string" || !p) return null;
  const full = path.resolve(cwd, p);
  const root = path.resolve(cwd);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  try {
    const real = fs.realpathSync(full);
    const realRoot = fs.realpathSync(root);
    return real === realRoot || real.startsWith(realRoot + path.sep) ? real : null;
  } catch {
    // Target doesn't exist yet (new file/dir writes go through here) —
    // confine via the nearest EXISTING ancestor instead: the lexical check
    // already passed, so if the resolved ancestor sits inside the real root,
    // no symlink along the way drops the write outside the workspace.
    const realRoot = (() => { try { return fs.realpathSync(root) } catch { return null } })();
    if (!realRoot) return null;
    for (let anc = path.dirname(full); anc === root || anc.startsWith(root + path.sep); anc = path.dirname(anc)) {
      try {
        const ra = fs.realpathSync(anc);
        if (ra === realRoot || ra.startsWith(realRoot + path.sep)) return full;
        return null; // ancestor escapes the real root → symlink escape
      } catch { /* keep walking up */ }
    }
    return null;
  }
}
