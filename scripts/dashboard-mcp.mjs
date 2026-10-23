// dashboard-mcp — stdio MCP server exposing the devin-web dashboard to
// agents. Injected into every session/new as mcpServers[]; the agent sees
// three tools (push_dashboard / push_widget / clear_dashboard). Writes go
// to <cwd>/.devin-web-dashboard.json — the backend's dashboard GET reads
// it as a fallback when dw.json has no entry for the session.
//
// Resolution order for the target file:
//   1. tool arg `cwd`            — explicit override
//   2. DEVIN_WEB_SESSION_CWD env — injected by the backend at session/new
//   3. process.cwd()             — standalone runs
// Wire: newline-delimited JSON-RPC 2.0 (MCP stdio). No deps.
import fs from "node:fs";
import path from "node:path";

const NAME = ".devin-web-dashboard.json";

function targetDir(cwd) {
  const d = (typeof cwd === "string" && cwd.trim())
    || process.env.DEVIN_WEB_SESSION_CWD
    || process.cwd();
  return path.resolve(d);
}

function board(cwd) {
  const f = path.join(targetDir(cwd), NAME);
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}

function writeBoard(cwd, data) {
  const f = path.join(targetDir(cwd), NAME);
  const tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ ...data, updated: new Date().toISOString() }, null, 1));
  fs.renameSync(tmp, f);
  return { ok: true, path: f, widgets: (data.widgets ?? []).length };
}

const TOOLS = [
  {
    name: "push_dashboard",
    description: "Replace this workspace's devin-web dashboard (看板) with the given title + widgets. Widget types: metric {title,value,unit?}, progress {title,percent,value?}, table {title,columns,rows}, log {title,lines}, chart {title,series:[{name,points:[[x,y]]}]}.",
    inputSchema: { type: "object", properties: { title: { type: "string" }, widgets: { type: "array", items: { type: "object" } }, cwd: { type: "string" } }, required: ["widgets"] },
  },
  {
    name: "push_widget",
    description: "Upsert one widget (matched by title) into the existing dashboard.",
    inputSchema: { type: "object", properties: { widget: { type: "object" }, cwd: { type: "string" } }, required: ["widget"] },
  },
  {
    name: "clear_dashboard",
    description: "Clear this workspace's dashboard.",
    inputSchema: { type: "object", properties: { cwd: { type: "string" } } },
  },
];

const ok = (v) => ({ content: [{ type: "text", text: JSON.stringify(v) }] });
const fail = (e) => ({ content: [{ type: "text", text: `error: ${e instanceof Error ? e.message : e}` }], isError: true });

let buf = Buffer.alloc(0);
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const nl = buf.indexOf(10);
    if (nl < 0) break;
    const line = buf.subarray(0, nl).toString("utf8").trim();
    buf = buf.subarray(nl + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.id === undefined) continue; // notifications — ignore
    try {
      if (m.method === "initialize") {
        send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "devin-web-dashboard", version: "1.0.0" } } });
      } else if (m.method === "tools/list") {
        send({ jsonrpc: "2.0", id: m.id, result: { tools: TOOLS } });
      } else if (m.method === "tools/call") {
        const a = m.params?.arguments ?? {};
        let out;
        if (m.params?.name === "push_dashboard") {
          const widgets = Array.isArray(a.widgets) ? a.widgets : [];
          out = ok(writeBoard(a.cwd, { title: String(a.title ?? ""), widgets }));
        } else if (m.params?.name === "push_widget") {
          const w = a.widget && typeof a.widget === "object" ? a.widget : null;
          if (!w || typeof w.title !== "string") out = fail("widget.title required");
          else {
            const cur = board(a.cwd) ?? { title: "", widgets: [] };
            const ws = cur.widgets.filter((x) => x?.title !== w.title);
            ws.push(w);
            out = ok(writeBoard(a.cwd, { ...cur, widgets: ws }));
          }
        } else if (m.params?.name === "clear_dashboard") {
          out = ok(writeBoard(a.cwd, { title: "", widgets: [] }));
        } else {
          out = fail(`unknown tool ${m.params?.name}`);
        }
        send({ jsonrpc: "2.0", id: m.id, result: out });
      } else {
        send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
      }
    } catch (e) {
      send({ jsonrpc: "2.0", id: m.id, result: fail(e) });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
