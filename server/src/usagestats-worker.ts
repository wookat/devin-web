/**
 * usagestats-worker — runs the heavy usageStats aggregations off the main
 * thread. The 3 GROUP BY scans over a multi-GB events table take 10s+ and
 * node:sqlite is synchronous — on the request path that froze the event
 * loop past the supervisor's probe window (3×4s) and put the backend in a
 * restart loop every time the resources page polled. A read-only WAL
 * connection in a worker leaves writers + the loop untouched; the caller
 * serves a cached snapshot while this refreshes.
 */
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

const { file, days } = workerData as { file: string; days: number };
const since = Date.now() - days * 86_400_000;
try {
  const db = new DatabaseSync(file, { readOnly: true });
  const dayRows = db.prepare(
    `SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch') AS day,
            COUNT(*) AS events, COUNT(DISTINCT session_id) AS sessions,
            COALESCE(SUM(bytes),0) AS bytes
     FROM events WHERE ts >= ? GROUP BY day ORDER BY day`,
  ).all(since);
  const kindRows = db.prepare(
    `SELECT kind, COUNT(*) AS n FROM events WHERE ts >= ?
     GROUP BY kind ORDER BY n DESC LIMIT 15`,
  ).all(since);
  const topRows = db.prepare(
    `SELECT session_id AS id, COUNT(*) AS events, COALESCE(SUM(bytes),0) AS bytes,
            MIN(ts) AS firstTs, MAX(ts) AS lastTs
     FROM events WHERE ts >= ? GROUP BY session_id ORDER BY events DESC LIMIT 20`,
  ).all(since);
  db.close();
  parentPort?.postMessage({ days: dayRows, kinds: kindRows, topSessions: topRows });
} catch (e) {
  parentPort?.postMessage({ error: String((e as Error)?.message ?? e) });
}
