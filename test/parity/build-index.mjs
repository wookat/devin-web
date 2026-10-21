#!/usr/bin/env node
/**
 * Scan `_deob/all/*.js` (or `_devin_assets` fallback) for feature-anchor strings
 * and emit `_deob/INDEX.md` — a module→feature map for parity forensics.
 * Extend FEATURES freely; each entry lists files that contain the anchor.
 */
import fs from 'node:fs'
import path from 'node:path'

const DIR = fs.existsSync('_deob/all') ? '_deob/all' : '_devin_assets'
const FEATURES = {
  quote: ['quoted_artifact', 'data-quotable', 'data-quote-anchor', 'data-quote-exclude', 'data-message-event-id', 'quote-affordance', 'stageQuote', 'sendQuote'],
  composer: ['focusInputBox', 'inputBox', 'Write optional caption', 'stageShortcut', 'Send immediately', 'emitUserMessage'],
  transcript: ['transcript-message-actions', 'transcript-worklog-row', 'data-md-source-start', 'user_message_chunk', 'agent_message'],
  selection: ['data-find-exclude', 'selectionchange', 'getClientRects', 'TreeWalker'],
  voice: ['transcribe-audio', 'audio_file', 'MediaRecorder', 'getUserMedia'],
  markdown: ['react-markdown', 'streamdown', 'remarkGfm', 'rehype'],
  auth: ['pkce', 'devin-session-token', 'x-cog-org-id', 'refresh_token'],
  api: ['api.devin.ai', 'ky.create', 'prefixUrl', 'session/prompt', 'session/load'],
  fork: ['session/fork', 'forkSession', 'parentSessionId'],
  sidechat: ['sidechain', 'anchorEventId', 'Sidechat'],
  worklog: ['worklog', 'shell_output', 'replayIndex', 'exitFocusMode'],
  settings: ['Preferences', 'theme', 'colorScheme'],
  drag: ['dataTransfer', 'dragstart', 'drop'],
  shortcuts: ['keybinding', 'hostBindings', 'StageQuoteCaption'],
  telemetry: ['onQuoteEvent', 'Quote:Stage', 'Message:Send:Quotes', 'telemetryId'],
  richcontent: ['rich_content', 'rich-content-node', 'meta.quote'],
  iframe: ['contentDocument', 'frameInputRef'],
}

const rows = []
for (const f of fs.readdirSync(DIR).filter((f) => f.endsWith('.js')).sort()) {
  const s = fs.readFileSync(path.join(DIR, f), 'utf8')
  const hits = []
  for (const [feat, anchors] of Object.entries(FEATURES)) {
    const n = anchors.filter((a) => s.includes(a)).length
    if (n) hits.push(`${feat}(${n}/${anchors.length})`)
  }
  if (hits.length) rows.push(`| \`${f}\` | ${(s.length / 1024).toFixed(0)}KB | ${hits.join(', ')} |`)
}

fs.writeFileSync('_deob/INDEX.md', `# _deob module index — feature anchors per deobfuscated bundle\n\n| module | size | features |\n|---|---|---|\n${rows.join('\n')}\n`)
console.log(`wrote _deob/INDEX.md — ${rows.length} modules with feature hits`)
