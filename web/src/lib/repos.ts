// Official initial-message repo extraction (transcriptHostGlobals `ua` + app-initial repo hint parser/stripper).

const REPO_LINE_RE = /\n\nYou only need to look in the following repo(?:s)?: [^\n]+/g
const NO_REPO_NOTE_RE = /\n\nNote: You may not need any repos for this task\./g
const REPO_HINT_RE = /You only need to look in the following repo(?:s)?: ([^\n]+)/g

/** Official `C`: the repo hint lines are never shown as message text. */
export function stripRepoHints(text: string): string {
  return text.replace(REPO_LINE_RE, '').replace(NO_REPO_NOTE_RE, '')
}

/**
 * Official `ua`: repos named in the message's repo hint, then the session's
 * repos, in that order; an explicit `@repo` mention already in the text wins.
 */
export function extractRepos(text: string, sessionRepos: readonly string[] | undefined): string[] {
  const mentioned = new Set(Array.from(text.matchAll(/(^|\s)@([\w.-]+(?:\/[\w.-]+)+)/g), (m) => m[2]))
  const out: string[] = []
  for (const m of text.matchAll(REPO_HINT_RE)) {
    for (const raw of m[1].split(',')) {
      const name = decodeRepoName(raw.trim())
      if (name && !mentioned.has(name) && !out.includes(name)) out.push(name)
    }
  }
  for (const r of sessionRepos ?? []) if (!out.includes(r) && !mentioned.has(r)) out.push(r)
  return out
}

function decodeRepoName(s: string): string {
  return s.split('/').map((p) => { try { return decodeURIComponent(p) } catch { return p } }).join('/')
}
