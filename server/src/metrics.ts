// Process-lifetime counters — the cheapest observability there is. Reset
// on every backend restart (deliberately: a restart is itself a counted
// event the supervisor reports separately via recentExits). Surface them
// on /api/admin/resources/system so the UI can answer "restarts today /
// ws drops / recycles" without log scraping.
const counters = new Map<string, number>();

export function incMetric(name: string, n = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + n);
}

// HTTP layer — per-route count + cumulative ms (avg = ms/n). Path segments
// that look like ids (hyphen/underscore tokens, >20 chars) collapse to `:x`
// so session ids can't explode the cardinality; a hard cap backstops that.
const httpSeen = new Set<string>();
const HTTP_KEY_CAP = 300;

export function recordHttp(method: string, pathname: string, ms: number, status: number): void {
  const seg = pathname.split("/").filter(Boolean).map((s, i) =>
    i >= 3 && (/^[a-z0-9]{4,}[-_][a-z0-9-]*$/i.test(s) || s.length > 20) ? ":x" : s,
  );
  let key = `${method} /${seg.join("/")}`;
  if (!httpSeen.has(key)) {
    if (httpSeen.size >= HTTP_KEY_CAP) key = `${method} /<other>`;
    else httpSeen.add(key);
  }
  incMetric(`http.req.${key}`);
  incMetric(`http.ms.${key}`, Math.round(ms));
  incMetric(`http.res.${Math.floor(status / 100)}xx`);
  if (ms > 800) incMetric("http.slow");
}

export function metricsSnapshot(): Record<string, number> {
  return Object.fromEntries(counters);
}
