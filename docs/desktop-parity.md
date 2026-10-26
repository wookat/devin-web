# Devin Desktop 逆向评估与移植立项（2026-10-26）

目标：把 Devin Desktop 1.126.0（Windsurf fork）新增的云端能力移植进 devin-web。

## 已探明的事实（非推测）

| 资产 | 位置 | 规模 |
|---|---|---|
| 完整最新 webapp bundle | `resources/app/out/vs/workbench/devin-webapp-host/assets/` | 2078 个文件（含 CSS/字体/视频），比 `_devin_assets` 缓存（930）多 ~185 个功能模块 |
| ACP 客户端 | `resources/app/extensions/windsurf/dist/extension.js` | 6.7MB minified，引用 **187** 个 `_cognition.ai/*` 方法 |
| ACP 服务端 | `…/windsurf/devin/bin/devin.exe` | 204MB，**3000.11.216**（本机已装 3000.11.205）；二进制内可确认 ~93 个方法 |
| 官方 CLI/ACP 文档 | `…/devin/share/devin/docs/` + `man/man1/` | acp/*.mdx、extensibility、permissions、changelog |
| IDE 会话面板 | `out/vs/sessions/sessions.desktop.main.js` | 39MB |
| Cascade 聊天客户端 | `out/vs/workbench/windsurf-chat-client/index.js` | 21MB |
| 官方 skills | `out/vs/sessions/skills/*/SKILL.md` | 11 个（commit/create-pr/fix-ci/merge/sync/update-pr…） |

devin-web 现状：仅调用 **14** 个 `_cognition.ai/*` 方法 → 方法面缺口 ~170。

## 桌面 exe 已证实本地实现（字符串直查 devin.exe）

- **revert/ 全套**：listSteps, preview, execute, resume, forkFromStep, stepsUpdated, historyRewound —— 检查点回退 + 从任意步 fork
- **session/**：loadPage（分页时间线）, brief, defaultConfigOptions
- **plugins/**：install, list, remove, changed —— 本地插件管理
- **mcp/**：connectServer, installServer, listTools, toggleServer, toggleTool, serversChanged, authorizationPending —— 本地 MCP 管理 + OAuth
- **subagent/background, subagent/foreground**
- **terminal/commandCompleted**（比 commandStarted 更完整的绑定依据）
- **workspace/didChangeFiles, didChangeRevision** —— fs 变更推送
- **goal/set|get, scope_search, repos/list, reads/promptHistory, reads/recentModelUids, turn_stats, loadStats, compaction, processMemory, tail, browserPreview/capture, clipboard/write, showModal, agentNotification, agent_stopped, output, after, config/write, workflows/migrate, snapshot-setup/trigger-build**

未在 exe 命中的多为云端 REST（notifications/*、secret/*、wiki/*、pr/*、folder/*、session org 操作、ephemeral、live-activities、push-devices、auth/*）或动态拼接 —— 需走 app.devin.ai auth1 通道（可复用现有 `devin-web.token`/`devin-web.org` 凭证机制）。

## 工作流

### W1 — ACP 方法面扩展（最高 ROI，先行）

协议不用逆向：仍是 `devin acp` stdio JSON-RPC + `session_update` 通知流，devin-web 的 broker/manager 直接吸收新 RPC。每个方法的工作量 = 从 extension.js/webapp bundle 读参数与响应形状 → index.ts 加薄转发 → 前端 UI。

分批建议（按价值/依赖排序）：
1. **P0 revert/**：检查点回退/fork —— 全新能力，用户感知最强 ✅ 已落地
2. ~~**P0 session/loadPage + brief**~~：❌ 实机确认是云端复合路由，本地 acp 崩 `.slice`——W1 无解
3. **P1 workspace/document 事件推送** ✅ 已落地（didOpen/didChangeFiles）；subagent bg/fg、terminal/commandCompleted、queuedMessages/update 待做
4. **P1 plugins/* + mcp/***：本地插件/MCP 管理 UI（exe 已实现全部端点）—— plugins/list 已通（只读）
5. **P2 goal/*、turn_stats/loadStats/compaction、scope_search、reads/*、browserPreview/capture、processMemory**
6. **P3 云端 REST**（需 auth1）：notifications、secrets、wiki、session folders/tags/pin、plan/*

### W2 — webapp bundle 收割（复用 devin-parity 管线）

- `devin-webapp-host/assets/` 复制进 `_devin_assets_desktop/` → `test/parity/deobfuscate-all.mjs` 全量反混淆 → 与现有 `_deob/` diff，得到增量功能清单
- 优先模块：SessionPanes（多窗格）、SessionTimeline 新版、Playbooks/PlaybookPage、Oncall、Wiki、ReplaySessionPage、InsightsPage、plugins 编辑器、KaTeX、MarkdownEditor、通知中心、HomePage
- 走既有三阶段：证据 → 移植 → 对拍

### W3 — 桌面集成层（低优先级，情报为主）

`installDevinHost`/`mountDevinSessionPane`/`editor-mode-menu`/`shortcuts.js` 揭示官方"webapp 宿主嵌入"契约；sessions.desktop.main.js 是 IDE 侧边会话面板实现参考。仅在需要 IDE 嵌入或官方会话窗格交互时深读。

### W0 — 前置：升级/切换 devin.exe

- 本机 CLI 3000.11.205 → 桌面捆绑 3000.11.216（二进制确认方法面更全，且可能修掉 acp PTY/commit 泄漏）
- 两条路：`devin` CLI 升级；或 agents.json 注册桌面捆绑 exe 为独立 agent（registry 已支持自定义 command 路径）

## 风险与边界

- **云端依赖法**：约一半 `_cognition.ai/*` 实为 cloud REST（需 auth1 token+org；401 时需刷新凭证文件）。落地前用 exe 字符串 + 实机 acp `initialize`/`session/new` 探测逐个确认。
- **bundle 版本漂移**：桌面 bundle 与线上 app.devin.ai 可能有 build 差；对拍仍以桌面 bundle 为准（它就是我们装的版本）。
- **法务**：逆向仅限本地个人互操作；不分发反混淆产物（`_deob/`、`docs/parity/` 均已 gitignore）。桌面 assets 同理留在 gitignore 目录。
- **体量**：extension.js 6.7MB + 39MB sessions 为 minified；按"方法→锚点字符串→上下文"取证，不要整体阅读。

## 验收参考线

- 每个 ACP 方法：参数/响应 shape 与官方 bundle 一致，wire 字节级对齐（parity 门禁第 4 条）
- 每个 UI 功能：devin-parity 五阶段 + 截图对拍
- 全程 `npm run typecheck && npm run test:unit && npm run build` 绿

---

## 已验证落地：revert/*（checkpoint 回退 + fork）

对 devin-web 后端/前端已端到端实装并经 API + 重启持久性验证（devin 3000.11.216）。

### 协议（实机探测确认）

| 方法 | 请求 | 响应 |
|---|---|---|
| `_cognition.ai/revert/listSteps` | `{sessionId, limit?, cursor?}` | `{steps:[{stepId, stepNumber, kind:"prompt", userMessageId, revertTargetNodeId, forkTargetNodeId, summary}]}` |
| `_cognition.ai/revert/preview` | `{sessionId, userMessageId}` | `{fileActions[], irreversibleWarnings[], conflicts[]}` |
| `_cognition.ai/revert/execute` | `{sessionId, userMessageId, ...opts}` | `{forkedSessionId, outcomes[]}`（同会话原地回退时 forkedSessionId===sessionId） |
| `_cognition.ai/revert/forkFromStep` | `{sessionId, userMessageId}` | `{forkedSessionId}`（新会话，含至该步的历史；源会话不动） |

通知：`_cognition.ai/revert/stepsUpdated`（`{sessionId, steps}`，权威全量推送）、`_cognition.ai/revert/historyRewound`（`{sessionId, revertTargetNodeId, firstRemovedUserMessageId}`）。

- `preview` 对不在当前链上的目标报 `Invalid params: Target step is no longer on the current chain`。
- `execute` 语义：删除目标步及其后全部内容（含用户消息本身）——回退后 listSteps 为空。
- prompt 响应 `_meta["cognition.ai/userMessageId"]` 即回退锚点；echo 的 `user_message_chunk` 在 `_meta["cognition.ai/clientMessageId"]` 携带同值。

### devin-web 实现要点

- 路由：`GET /api/sessions/:id/revert-steps`（push 缓存优先，miss 则 pull）；`POST /api/sessions/:id/revert`（`{userMessageId, action:"preview"|"execute"|"fork", ...opts}`）。
- 锚点持久化：`session/prompt` 返回时把 `userMessageId` 回填到 `_local` 镜像行的 `clientMessageId`（`sessionLog.tagUserMessage`），不等 echo。
- 截断：`historyRewound` → `sessionLog.rewind` → 内存环 splice（**最早**匹配行，镜像+echo 可同锚点）+ `db.deleteFromSeq(seq>=)` + **.jsonl 镜像物理截断**（流式复制 seq<cutSeq 行→临时文件→重命名）+ tail snapshot drop + hydrated/seqs 失效。
- 前端：WS `revert_steps`/`history_rewound`（已入 SCOPED_EVENTS）→ steps map 重建 + `load()` resync；MessageToolbar 回退按钮 → preview 安全则直执行，有 warnings/conflicts 弹确认框；fork 独立入口跳转新会话。
- 能力门：initialize `_meta` 需声明桌面式 capability（revert 等），否则 216 不注册相关方法。

### 216 行为差异（重要）

- **必须 authenticate**：ACP 模式不再自动读 credentials.toml，须 `authenticate(meta.api_key=<账号池 key>)`，否则 `session/new` 报 "ACP host has not authenticated"。direct/brokered/adopted 三条路径都已接。
- **session/new 不落盘**：新会话是内存态，`session/load` 报 "Session not found"，首次 `session/prompt` 成功后才持久化。devin-web 用 `sessionplace.memOnly` 标记跳过 load，prompt 成功后清除；宿主进程死亡则该会话丢失（与桌面一致）。
- 会话锁冲突照旧：`session/load` 对已被占用的会话报 "already open in another process"（桌面应用打开着同一 session 时 API 会 500，正常）。

---

## 已验证落地：IDE 上下文推送（document/workspace 通知）+ plugins/list

### 方向澄清（2026-10-26 实机确认）

`document/*`、`workspace/*`、`terminal/commandStarted|Completed` 是 **client→agent**
上下文推送（IDE 侧通知 agent "用户在编辑器/终端里干了什么"），不是 server→client
事件流。对 devin-web 的意义：用户在 web 编辑器里打开/保存文件时同步给 agent，
桌面端 agent 据此感知用户手动改动。

### 实机探测结论

- `conn.extNotification(method, params)` 发送被 216 正常接收派发（stderr `ext_notification` dispatch，无协议错误）。
- `workspace/didChangeFiles` serde schema：`{created?: string[]}`（file:// URI 列表）。
- `document/didOpen`：`{uri, languageId?}`。
- `terminal/commandStarted`：`{terminalId, commandLine, cwd?}`；`terminal/commandCompleted`：`{commandLine, cwd?, exitCode?, output?}`。
- `plugins/list`：实机返回账号级插件清单（pluginKey/state/source/assets.skills/mcpServers/pin），任一池化 acp 可答——**P1 插件管理只实现了只读 list，install/remove UI 未做**。
- **session/loadPage|loadSpine|brief|loadStats 本地全部不可用**：对已认证持久会话调用一律在 handler 内 `.slice` 崩 undefined——它们是桌面端走云端会话服务的复合路由（`toWireRequest`），本地 acp 未实装。大会话分页加载在 W1 无解，需走云端 REST 或放弃。

### devin-web 实现要点

- `DevinAcp.sendExtNotification` → `conn.extNotification`（SDK 返回 Promise<void>）。
- `sessionplace.notifySessionCtx(id, method, params)`：**被动**发送——只走 `sessionHost.get(id)` 已绑定的 host，绝不触发 session/load（未加载的会话上下文本已过期）；fire-and-forget，发送失败不回污染文件操作。envelope 带 `sessionId`。
- 挂点（`lweb/admin/sessionfiles.ts`）：
  - `file-write` 成功后 → `workspace/didChangeFiles {created:[file:///uri]}`
  - `file-ops` 成功后 → 同上（rename/move/copy 带上 dest）
  - `GET /file` 读到文本 → `document/didOpen {uri}`（60s/(session,path) 去抖——GET 也是程序化读取，只把首个 hit 当"打开"）
- `GET /api/admin/plugins` → `plugins/list` 转发。
- `document/didClose|didChangeDirty|didFocus|didBlur`：新增 `POST /api/admin/session/:id/file-notify {kind,path,dirty?,languageId?}` 转发端点；前端 TabStrip closeTab→didClose、tab click→didFocus、Viewer 脏状态转换→didChangeDirty（挂载基线=clean）。
- `terminal/commandStarted|Completed`：`powershell -Command -` 管道不调 prompt，采用**哨兵行注入**——每条用户行前排队 `$global:LASTEXITCODE=$null` 重置、行后排队 `[Console]::Out.Write(ESC]6973;C;<ec>BEL)` 哨兵；顺序执行使哨兵成为真实完成边界，exitCode = LASTEXITCODE ?? ($? ? 0 : 1)（实机验证 7/0/1 正确）；stdout 流正则剥离哨兵，FIFO 配对 commandLine。仅 localPs。
- `workspace/didChangeRevision {branch,uri}`：file-git 轮询路径内比对 `branch@sha` 基线（per-session），变化时推送。

### mcp/*（2026-10-26 第二轮实机探测）

- **已证实**：`mcp/listServers {}`→`{servers:[{serverId,disabled,disabledTools,connectionStatus,sourcePath,transport,url}]}`；`mcp/listTools {serverId}`→`{tools:[{name,title,description}]}`；`mcp/connectServer {serverId}`→`{connectionStatus:"connected"}`；`mcp/installServer {serverId,config:{transport,url,…}}`→`{}`（真写入 mcp_config.json）。
- **未破**：toggleServer/toggleTool/removeServer/disconnectServer——30+ 字段变体全 Invalid params，schema 待后续从 bundle 还原；路由已就位（`/api/admin/mcp/call` 白名单转发）。
- 路由：`GET /api/admin/mcp/servers`、`GET /api/admin/mcp/tools?server=`、`POST /api/admin/mcp/call {method,params}`。
- 通知：`_cognition.ai/mcp/serversChanged`→WS `mcp_servers_changed`；`authorizationPending|Required|Finished`→`mcp_auth_pending`（unscoped 广播）。
