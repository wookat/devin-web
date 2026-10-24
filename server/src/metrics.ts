// Process-lifetime counters — the cheapest observability there is. Reset
// on every backend restart (deliberately: a restart is itself a counted
// event the supervisor reports separately via recentExits). Surface them
// on /api/admin/resources/system so the UI can answer "restarts today /
// ws drops / recycles" without log scraping.
const counters = new Map<string, number>();

export function incMetric(name: string, n = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + n);
}

export function metricsSnapshot(): Record<string, number> {
  return Object.fromEntries(counters);
}
