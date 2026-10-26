// psops — translate POSIX `&&`/`||` operators into Windows PowerShell 5.1
// equivalents. PS 5.1 rejects `&&`/`||` at parse time (`&&` only landed in
// PowerShell 7), and agent-generated commands lean on them constantly.
//
// `a && b` → `a ; if ($?) { b }` · `a || b` → `a ; if (-not $?) { b }`
// For a top-level pipeline chain, after
// each `if ($?) { x }` / `if (-not $?) { x }` block, `$?` still reports the
// last EXECUTED pipeline (a skipped `if` doesn't touch it), so the chain
// `a && b && c` → `a ; if($?){b} ; if($?){c}` runs c iff b ran and passed,
// and `a && b || c` → `a ; if($?){b} ; if(-not $?){c}` runs c iff the
// a&&b group failed — POSIX ((a&&b)||c) semantics both ways.
//
// Semicolons/newlines terminate a chain (they must NOT get moved inside an
// if body). This is intentionally not a general PowerShell parser.
// Only TOP-LEVEL operators outside quotes and bracket groups translate —
// `echo "a && b"`, `if (x && y)`, and `$(a && b)` pass through untouched.

const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

export function translatePsOps(line: string): string {
  let parts: string[] = [];
  let ops: string[] = [];
  let cur = "";
  let q: string | null = null;
  const stack: string[] = [];
  let out = "";
  let invalid = false;
  const flush = () => {
    if (!ops.length) { out += cur; cur = ""; return; }
    parts.push(cur);
    if (parts.some((p) => !p.trim())) { invalid = true; return; }
    out += parts[0];
    for (let i = 0; i < ops.length; i++) {
      out += ops[i] === "&&"
        ? ` ; if ($?) { ${parts[i + 1].trim()} }`
        : ` ; if (-not $?) { ${parts[i + 1].trim()} }`;
    }
    cur = ""; parts = []; ops = [];
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    // Backtick escapes work outside quotes and inside double quotes (not
    // single quotes), including escaped quotes/operators/newlines.
    if (ch === "`" && q !== "'") { cur += ch + (line[++i] ?? ""); continue; }
    if (q) {
      // Nested interpolated expressions need a real parser. Leave unsupported
      // input alone rather than silently changing what it executes.
      if (q === '"' && ch === "$" && line[i + 1] === "(") return line;
      cur += ch;
      // '' escapes a quote inside '..' (powershell single-quote rule)
      if (ch === q) { if (q === "'" && line[i + 1] === "'") { cur += line[++i]; continue } q = null; }
      continue;
    }
    if (ch === "@" && /['"]/.test(line[i + 1] ?? "") && /[\r\n]/.test(line[i + 2] ?? "")) return line; // here-string
    if (ch === "<" && line[i + 1] === "#") {
      const end = line.indexOf("#>", i + 2);
      if (end < 0) return line;
      cur += line.slice(i, end + 2); i = end + 1; continue;
    }
    if (ch === "#" && (i === 0 || /[\s;|&({]/.test(line[i - 1]))) {
      const end = line.indexOf("\n", i);
      const stop = end < 0 ? line.length : end;
      if (!stack.length) { flush(); out += line.slice(i, stop); }
      else cur += line.slice(i, stop);
      i = stop - 1; continue;
    }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    if (OPEN[ch]) { stack.push(OPEN[ch]); cur += ch; continue; }
    if (stack.length && ch === stack[stack.length - 1]) { stack.pop(); cur += ch; continue; }
    if (!stack.length && (ch === "&" || ch === "|") && line[i + 1] === ch) {
      parts.push(cur); ops.push(ch + ch); cur = ""; i++; continue;
    }
    if (!stack.length && (ch === ";" || ch === "\n" || ch === "\r")) {
      if (ch !== ";" && ops.length && !cur.trim()) { cur += ch; continue; }
      flush(); out += ch; continue;
    }
    cur += ch;
  }
  if (q || stack.length) return line;
  flush();
  return invalid ? line : out;
}

/** Complete-command wrapper for local PS stdin (never use for PTY bytes). */
export function translatePsInput(d: string): string {
  return translatePsOps(d);
}
