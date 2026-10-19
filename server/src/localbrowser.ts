/**
 * localbrowser — interactive browser embedded in the admin UI.
 *
 * A dedicated Edge/Chrome instance (its own profile dir, CDP bound to
 * 127.0.0.1) is launched on demand. Page.startScreencast JPEG frames are
 * forwarded to /ws/browser clients; their pointer/keyboard events go back
 * through Input.dispatch*. Only this window is controllable — the host
 * desktop itself stays read-only (see screen.ts).
 *
 * Client → server JSON:  {t:'open',url?} {t:'navigate',url} {t:'close'}
 *                        {t:'mouse',type,u,v,button?,clickCount?,mods?}
 *                        {t:'wheel',u,v,dx,dy}
 *                        {t:'key',type,key,code,vk,mods}
 *                        {t:'text',text}
 * Server → client JSON:  {t:'status',running,url,exe}
 *                        {t:'frame',d:<b64>,m:{deviceWidth,deviceHeight,...}}
 *                        {t:'nav',url} {t:'closed'} {t:'error',error}
 * (u,v are normalized frame coords; the server scales by the last
 * screencast metadata so client/display size never desync.)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";

const CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

function findBrowser(): string | null {
  for (const p of CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

let profileDir = "";
export function initLocalBrowser(dataDir: string): void {
  profileDir = dataDir;
}

// ---- CDP plumbing ------------------------------------------------------------

type CdpSocket = {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  close: () => void;
};

function connectCdp(wsUrl: string, onEvent: (method: string, params: Record<string, unknown>) => void): Promise<CdpSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    let nextId = 0;
    const pending = new Map<number, (r: { result?: unknown; error?: unknown }) => void>();
    ws.on("open", () => resolve({
      send: (method, params = {}) => new Promise((res, rej) => {
        const id = ++nextId;
        pending.set(id, (r) => (r.error ? rej(new Error(JSON.stringify(r.error))) : res(r.result)));
        ws.send(JSON.stringify({ id, method, params }));
      }),
      close: () => { try { ws.close(); } catch { /* gone */ } },
    }));
    ws.on("message", (data) => {
      let m: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
      try { m = JSON.parse(String(data)); } catch { return; }
      if (m.id != null) {
        const p = pending.get(m.id);
        if (p) { pending.delete(m.id); p({ result: m.result, error: m.error }); }
      } else if (m.method) {
        onEvent(m.method, m.params ?? {});
      }
    });
    ws.on("error", reject);
    ws.on("close", () => { onEvent("__closed__", {}); });
  });
}

// ---- browser lifecycle -------------------------------------------------------

type PageMeta = { deviceWidth?: number; deviceHeight?: number; offsetTop?: number; scrollOffsetX?: number; scrollOffsetY?: number };

let httpPort = 0;
let browserWsPath = "";
let page: CdpSocket | null = null;
let lastMeta: PageMeta = {};
let lastFrame: string | null = null;
let currentUrl = "";
let screencasting = false;
let launching: Promise<void> | null = null;
const clients = new Set<WebSocket>();

const broadcast = (o: Record<string, unknown>) => {
  const s = JSON.stringify(o);
  for (const c of clients) if (c.readyState === c.OPEN) c.send(s);
};

async function waitTargets(): Promise<{ id: string; type: string; url: string; webSocketDebuggerUrl: string }[]> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${httpPort}/json/list`);
      const list = (await r.json()) as { id: string; type: string; url: string; webSocketDebuggerUrl: string }[];
      if (list.some((t) => t.type === "page")) return list;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("browser devtools endpoint never came up");
}

function onPageEvent(method: string, params: Record<string, unknown>): void {
  if (method === "__closed__") {
    page = null;
    screencasting = false;
    broadcast({ t: "closed" });
    return;
  }
  if (method === "Page.screencastFrame") {
    const p = params as { sessionId?: number; data?: string; metadata?: PageMeta };
    lastMeta = p.metadata ?? lastMeta;
    lastFrame = typeof p.data === "string" ? p.data : lastFrame;
    broadcast({ t: "frame", d: p.data, m: lastMeta });
    if (page && p.sessionId != null) {
      void page.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => { /* page gone */ });
    }
    return;
  }
  if (method === "Page.frameNavigated") {
    const frame = (params as { frame?: { url?: string } }).frame;
    if (frame?.url && frame.url !== currentUrl) {
      currentUrl = frame.url;
      broadcast({ t: "nav", url: currentUrl });
    }
  }
}

async function attachPage(): Promise<void> {
  const targets = await waitTargets();
  const target = targets.find((t) => t.type === "page");
  if (!target) throw new Error("no page target");
  currentUrl = target.url || currentUrl;
  page = await connectCdp(target.webSocketDebuggerUrl, onPageEvent);
  await page.send("Page.enable");
  if (clients.size) startCast();
}

function startCast(): void {
  if (screencasting || !page) return;
  screencasting = true;
  void page.send("Page.startScreencast", {
    format: "jpeg", quality: 60, maxWidth: 1600, maxHeight: 1000, everyNthFrame: 1,
  }).catch(() => { screencasting = false; });
}

function stopCast(): void {
  if (!screencasting || !page) return;
  screencasting = false;
  void page.send("Page.stopScreencast").catch(() => { /* page gone */ });
}

/** Adopt a still-running instance (browser survives server restarts). */
async function adopt(portFile: string): Promise<boolean> {
  try {
    const [portS, wsPath] = fs.readFileSync(portFile, "utf8").split("\n").map((s) => s.trim());
    const port = Number(portS);
    if (!port || !wsPath) return false;
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    httpPort = port;
    browserWsPath = wsPath;
    return true;
  } catch { return false; }
}

/** Kill browsers holding our profile dir but unreachable over devtools —
 * they'd swallow the next launch via the profile singleton. */
async function killStale(): Promise<void> {
  const pattern = profileDir.replace(/\\/g, "\\\\").replace(/'/g, "''").replace(/%/g, "[%]%") + "%";
  const ps = spawn("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    `Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'msedge.exe' -or $_.Name -eq 'chrome.exe') -and $_.CommandLine -like '${pattern}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
  ], { stdio: "ignore", windowsHide: true });
  await new Promise<void>((r) => { ps.on("exit", r); ps.on("error", r); setTimeout(r, 8000); });
}

async function launch(url: string): Promise<void> {
  if (page) return;
  const exe = findBrowser();
  if (!exe) throw new Error("no Edge/Chrome installation found");
  // The launcher hands off to the real browser process and exits, so neither
  // its lifetime nor its stderr is usable — the debug endpoint is published
  // in <user-data-dir>/DevToolsActivePort instead (same as Selenium).
  const portFile = path.join(profileDir, "DevToolsActivePort");
  if (!(await adopt(portFile))) {
    await killStale();
    try { fs.rmSync(portFile, { force: true }); } catch { /* absent */ }
    spawn(exe, [
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-session-crashed-bubble",
      "--hide-crash-restore-bubble",
      "--start-maximized",
      url,
    ], { stdio: "ignore", windowsHide: false }).on("error", () => { /* covered by the poll below */ });
    httpPort = 0;
    browserWsPath = "";
    for (let i = 0; i < 60 && !httpPort; i++) {
      try {
        const [portS, wsPath] = fs.readFileSync(portFile, "utf8").split("\n").map((s) => s.trim());
        const port = Number(portS);
        if (port > 0 && wsPath) { httpPort = port; browserWsPath = wsPath; }
      } catch { /* not written yet */ }
      if (!httpPort) await new Promise((r) => setTimeout(r, 250));
    }
    if (!httpPort) throw new Error("devtools endpoint never came up");
  }
  await attachPage();
}

/** Idempotent — safe to call from every client message. */
async function ensure(url: string): Promise<void> {
  if (page) return;
  if (!launching) {
    launching = launch(url).finally(() => { launching = null; });
  }
  await launching;
  // page socket dropped while the browser lived on — re-attach to it
  if (!page && httpPort) {
    try { await attachPage(); } catch { httpPort = 0; throw new Error("browser unreachable"); }
  }
}

async function closeBrowser(): Promise<void> {
  page = null;
  screencasting = false;
  lastFrame = null;
  if (httpPort && browserWsPath) {
    try {
      const b = await connectCdp(`ws://127.0.0.1:${httpPort}${browserWsPath}`, () => {});
      await b.send("Browser.close").catch(() => { /* already gone */ });
      b.close();
    } catch { /* devtools already down */ }
    httpPort = 0;
    browserWsPath = "";
  }
  broadcast({ t: "closed" });
}

// ---- client protocol ---------------------------------------------------------

async function onClientMsg(o: Record<string, unknown>): Promise<void> {
  const t = o.t;
  if (t === "open") {
    await ensure(typeof o.url === "string" && o.url ? o.url : "about:blank");
    // adopted instance + explicit url → take the user where they asked
    if (page && typeof o.url === "string" && o.url && o.url !== "about:blank") {
      const nav = /^[a-z][a-z0-9+.-]*:/i.test(o.url) ? o.url : `https://${o.url}`;
      await page.send("Page.navigate", { url: nav }).catch(() => { /* page gone */ });
    }
    broadcast({ t: "status", running: !!page, url: currentUrl, exe: true });
    return;
  }
  if (t === "close") { await closeBrowser(); return; }
  if (!page) return;
  const meta = lastMeta;
  const dw = meta.deviceWidth || 1280;
  const dh = meta.deviceHeight || 800;
  const xy = () => ({
    x: Math.round(Number(o.u ?? 0) * dw),
    y: Math.round(Number(o.v ?? 0) * dh),
  });
  switch (t) {
    case "navigate":
      if (typeof o.url === "string" && o.url) {
        const url = /^[a-z][a-z0-9+.-]*:/i.test(o.url) ? o.url : `https://${o.url}`;
        await page.send("Page.navigate", { url });
      }
      break;
    case "mouse":
      await page.send("Input.dispatchMouseEvent", {
        type: String(o.type ?? "mouseMoved"),
        ...xy(),
        button: typeof o.button === "string" ? o.button : "none",
        clickCount: Number(o.clickCount ?? 0),
        modifiers: Number(o.mods ?? 0),
      });
      break;
    case "wheel":
      await page.send("Input.dispatchMouseEvent", {
        type: "mouseWheel", ...xy(),
        deltaX: Number(o.dx ?? 0), deltaY: Number(o.dy ?? 0),
        modifiers: Number(o.mods ?? 0),
      });
      break;
    case "key":
      await page.send("Input.dispatchKeyEvent", {
        type: String(o.type ?? "rawKeyDown"),
        key: String(o.key ?? ""),
        code: String(o.code ?? ""),
        windowsVirtualKeyCode: Number(o.vk ?? 0),
        nativeVirtualKeyCode: Number(o.vk ?? 0),
        modifiers: Number(o.mods ?? 0),
      });
      break;
    case "text":
      if (typeof o.text === "string" && o.text) await page.send("Input.insertText", { text: o.text });
      break;
  }
}

/** Wire a /ws/browser connection into the shared browser session. */
export function attachBrowserWs(ws: WebSocket): void {
  clients.add(ws);
  ws.send(JSON.stringify({ t: "status", running: !!page, url: currentUrl, exe: !!findBrowser() }));
  if (page) {
    if (!screencasting) startCast();
    else if (lastFrame) ws.send(JSON.stringify({ t: "frame", d: lastFrame, m: lastMeta }));
  }
  ws.on("message", (data) => {
    let o: Record<string, unknown>;
    try { o = JSON.parse(String(data)); } catch { return; }
    void onClientMsg(o).catch((e) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: "error", error: e instanceof Error ? e.message : String(e) }));
    });
  });
  ws.on("close", () => {
    clients.delete(ws);
    if (!clients.size) stopCast();
  });
}
