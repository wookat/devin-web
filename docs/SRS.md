# devin-web 系统需求规格说明书（SRS）

版本：v0.4.0 ｜ 状态：已实现基线 ｜ 代码基线：`main @ 07abfcd`（其后仅文档提交）｜ 核对日期：2026-11-03

> 本文档描述 devin-web **已交付系统**的需求基线（as-built SRS），而非立项时
> 的前瞻性规格。每条需求均可追溯到现有实现与验证记录。

---

## 1. 引言

### 1.1 目的

devin-web 为本地 `devin acp`（Devin CLI 的 Agent Client Protocol 端点）提供
一个云端风格、可通过 LAN/隧道访问的 Web 控制面。`devin acp` 只提供协议端点，
devin-web 是承载它的工作台（workbench）。

### 1.2 范围

**在内**：本地会话生命周期、回合执行与崩溃恢复、时间线渲染、工作区（文件/终
端/git）、桌面 ACP 方法面复刻、云端账户只读面、通知中心、系统资源诊断、服务
自管理（supervisor/watchdog/开机自启）。

**不在内**：云端写操作（创建 Devin Cloud session、修改组织设置）、多用户协
作、官方 Insights 计费页（本地等价物已提供）。

### 1.3 定义与缩略语

| 术语 | 含义 |
|---|---|
| ACP | Agent Client Protocol，`devin acp` 子进程上的 JSON-RPC over stdio |
| supervisor | `scripts/supervisor.mjs`，BIOS 级守护进程，持有 :7791 |
| backend | `dist/server/index.js`，控制面，持有 :7792，可随时被回收 |
| acp-broker | `scripts/acp-broker.mjs`，执行面，长期持有所有本地 acp 子进程 |
| turn | 一次 prompt→完成 的完整 agent 回合 |
| open-turn | `open-turns.json` 中未结算的回合记录（崩溃恢复证据） |
| gen | sessionlog.db 中会话日志的代际号（append/replace 迁移用） |
| admin route | `/api/admin/*` 后端管理面 HTTP API |

### 1.4 参考

- `AGENTS.md` — 权威架构与运维约束
- `docs/architecture.md` — 模块依赖图与不变式
- `docs/desktop-parity.md` — `_cognition.ai/*` 方法面探测定案
- `README.md` / `README.zh-CN.md` — 用户面说明

---

## 2. 总体描述

### 2.1 产品定位

| 维度 | 描述 |
|---|---|
| 用户 | 单机安装 Devin CLI 的开发者；可通过手机/其他设备经 LAN 或 Cloudflare Tunnel 访问自己的 agent |
| 部署形态 | 单进程族常驻服务（supervisor + backend + broker），平台原生开机自启 |
| 核心卖点 | 后端可随便死、浏览器可随便刷、acp 可中途被杀——用户发起的回合都不丢 |

### 2.2 运行环境

- Node.js ≥ 22.5（使用内建 `node:sqlite`，无原生依赖）
- Windows / Linux / macOS；Windows 上使用 PowerShell resident helper、
  Scheduled Tasks + watchdog 实现常驻
- 已认证的 `devin` CLI（`devin-3000.11.x` 版本线，ACP 入口）
- 可选：`cloudflared`（公网隧道）；系统代理（云端 REST，CN 出口直连 403）

### 2.3 约束

- 单用户模型：无登录体系，LAN 访问用 `DEVIN_WEB_ADMIN_KEY` 与
  `DEVIN_WEB_ALLOWED_HOSTS` 约束；LanKeyBanner 负责提醒
- 后端启动到 `/api/health` 可达必须在 supervisor 启动宽限（~60s + 3 探针）
  内完成——**任何模块初始化阶段的同步工作（DB 迁移、大文件扫描）必须低于
  该窗口或延迟到 listen 之后**（2026-11 uv2→uv3 迁移事故定案）
- 端口分配：`:7791` 公共入口（supervisor）、`127.0.0.1:7792` 后端、
  broker 走 named pipe / unix socket（`devin-web-acp-*`）

### 2.4 假设与依赖

- `devin acp` 行为兼容 ACP；CLI 已登录（token 存在于 Devin CLI 自身存储）
- 云端 REST 依赖 `<dataDir>/devin-web.token` + `devin-web.org`（auth1
  token，过期则云端面降级而非报错）；出口需走系统代理
- 数据目录 `DEVIN_WEB_DATA_DIR`（默认 `~/.devin-web`）可写且不落 Sync
  文件夹深处（锁定竞争会拖慢 sessionlog.db）

---

## 3. 功能需求

### 3.1 服务生命周期（FR-SVC）

| 编号 | 需求 | 实现 |
|---|---|---|
| FR-SVC-1 | 单一入口管理全部生命周期：`node devin-web.mjs run\|start\|stop\|restart [--build]\|status\|install\|uninstall\|deploy\|logs` | `devin-web.mjs` |
| FR-SVC-2 | supervisor 持有 :7791，自服务静态前端，反代 `/api/*` 与 `/ws*` upgrade 至 127.0.0.1:7792 | `scripts/supervisor.mjs` |
| FR-SVC-3 | 每 4s 探测 `GET /api/health`；后端退出或 3 次失败 → 清理孤儿 acp + 重拉；>5 exits/5min → 60s 退避 | supervisor.mjs |
| FR-SVC-4 | broker 死亡 → 1.5s 后重拉，pid journal 清扫其遗留 acp | supervisor.mjs + `broker-state.json` |
| FR-SVC-5 | 开机自启：win32 Scheduled Tasks（onlogon supervisor + 每分钟 watchdog）、linux systemd --user（Restart=always + linger）、darwin launchd（RunAtLoad+KeepAlive） | `devin-web.mjs install` |
| FR-SVC-6 | 自重启/自部署：`POST /api/admin/restart`（graceful journal）、`POST /api/admin/redeploy`（build ~1-3min，失败保旧进程）、`POST /api/_super/restart`（硬重启，broker+acp 存活）、`POST /api/_super/stop`（写 stopped 标记，watchdog 不复活） | registry.ts / supervisor.mjs |
| FR-SVC-7 | 后端死亡期间静态页仍可达，API 返回 502 `backend_unavailable` | supervisor.mjs |

### 3.2 会话管理（FR-SES）

| 编号 | 需求 | 实现 |
|---|---|---|
| FR-SES-1 | 本地会话列表：分组、搜索、状态徽标、unread 计数 | `GET /api/admin/sessions` + SessionsPage |
| FR-SES-2 | 新会话：cwd 选择、SSH 目标、草稿持久化 | `POST /api/admin/sessions/new` |
| FR-SES-3 | 会话操作：rename/end/archive/folder/tags/share-link(本地)/share(云端)/restart(kill acp+replay=本地 reboot)/fork(transcript-seed handoff)；子代理 subagentControl(cancel/foreground/background) | `sessioncontrol.ts` + `sessionlifecycle.ts`（rename/share 经 acp 直通；本地 acp 无原生 fork） |
| FR-SES-4 | 会话恢复：冷会话经 `session/load`；恢复证据（open-turns + log 尾）给出 `continue`/`resend` 提示 | `sessionload.ts` + interrupted banner |
| FR-SES-5 | 文件夹/mirror 分组与索引路径 | `mirror/*` 路由族 |

### 3.3 回合执行与恢复（FR-TRN）

| 编号 | 需求 | 实现 |
|---|---|---|
| FR-TRN-1 | prompt 派发前写入 `<dataDir>/open-turns.json`，结算后清除——条目在 boot 时存活 = 服务器死于回合中 | `dispatchPrompt` |
| FR-TRN-2 | 结算时向 session log 追加 `dw_turn_end`（错误追加 `dw_notice`）；两者在 tail re-append 后存活且不进 timeline | `sessionturns.ts` / `tlPush` |
| FR-TRN-3 | 崩溃恢复：adopt 后 `watchAdoptedTurn` 伪 inflight + busy 保护；broker `pendingPrompts` 账本证明已应答 → `settleDeadAdoptedTurn` 立即结算；早于该 acp 生命期的回合保留 ~30s 静默结算底 | `sessionadopt.ts` |
| FR-TRN-4 | `autoResumeInterrupted`：listen 后 4s，prefs.autoResume 开时最多重试 2 次，无需 tab 打开 | `sessionload.ts` |
| FR-TRN-5 | acp 进程死亡 → open turn 自动在新 acp 上 resume（ev:exit 正常路径） | manager + dispatchPrompt |
| FR-TRN-6 | prompt 丢帧检测：`promptWithRetry` 每 30s 对 journaled reqId 轮询 broker ledger，缺席 + SDK promise 悬挂 → `lost-response` reject | acp.ts |

### 3.4 时间线（FR-TL）

| 编号 | 需求 | 实现 |
|---|---|---|
| FR-TL-1 | 全量历史经 `next_cursor` 链式分页；delta 经 WS `timeline_delta` 增量推送 | `sessiontimeline.ts` + ws.ts |
| FR-TL-2 | 渲染路径 strict ref-stability：`mergeItems` 保对象引用 → merge pass WeakMap 缓存折叠 → `TimelineGroup` memo 结构化比较 | `timelineUtil.tsx` / `TimelineMerges.ts` / `TimelineGroups.tsx` |
| FR-TL-3 | 折叠：scripted runs 折叠、shell 命令+输出成对、thinking/persona 分组 | TimelineMerges |
| FR-TL-4 | 翻译：`POST /api/admin/mirror/translate`，provider 链 devin-chat → MyMemory → gtx | `translate.ts` |
| FR-TL-5 | Markdown + GFM + KaTeX 数学管线（`strict:ignore`，渲染失败降级原文） | `Markdown.tsx` |
| FR-TL-6 | 回放：`/admin/:id/replay` 全量拉取 + 真实间隔缩放播放（0.5–4×）+ 进度条 + 键盘快捷键 | `ReplayPage.tsx` |

### 3.5 工作区（FR-WS）

| 编号 | 需求 | 实现 |
|---|---|---|
| FR-WS-1 | 文件浏览/读/写（本地 + SSH） | `sessionfiles.ts` / `ssh.ts` |
| FR-WS-2 | 集成终端：本地 PowerShell + agent sidecar + 多会话 tab | `term/*` + `terminal.ts` |
| FR-WS-3 | git 状态/diff/分支轮询（`workspace/didChangeRevision` 推送） | `file-git` / registry |
| FR-WS-4 | 本地浏览器面板（LiveDesktop/screen input） | `localbrowser.ts` / `screen.ts` |
| FR-WS-5 | Composer：附件、引用 chip、`!macro` playbook 触发、↑ 键 prompt 历史回溯（建议优先、到顶停住、↓ 回草稿） | `ComposerFooter.tsx` |

### 3.6 桌面 ACP 方法面（FR-EXT）

| 编号 | 需求 | 实现 |
|---|---|---|
| FR-EXT-1 | `_cognition.ai/*` 已注册方法全部分类：已路由 / schema 已破未路由 / 本地未注册三档，文档诚实标注 | `docs/desktop-parity.md` |
| FR-EXT-2 | 全局方法（rules/skills/plans/subagents/hooks/workflows/config/plugins/reads.recentModelUids）走池化 acp，不强制 session/load | registry.ts `manager.get(primaryCwd)` |
| FR-EXT-3 | 会话级方法（goal/*、scope_search、promptHistory）经 acpForId | persession.ts |
| FR-EXT-4 | mcp 全族：listServers/listTools/install/toggle/remove/connect/disconnect + `serversChanged`/`authorizationPending` 通知 → WS | `mcp/call` + ws |
| FR-EXT-5 | IDE 上下文推送：didOpen/didChangeFiles/didClose/didChangeDirty/didFocus/didBlur/didChangeRevision/terminal 命令标记 | `file-notify` + 前端 wiring |
| FR-EXT-6 | config/read 只读面 + config/write `{path[],config}` 树导航写 | `/api/admin/devin-config` |
| FR-EXT-7 | 前端暴露：Settings → 资源 各面板（rules/plans/plugins/agent resources）、ModelPicker 最近模型种子（localStorage 空时拉 agent recents）、composer ↑ 历史 | ResourcesSection / ModelPicker / ComposerFooter |

### 3.6b Secrets（FR-SEC，云端 org secrets 的本地等价物）

| 编号 | 需求 | 实现 |
|---|---|---|
| FR-SEC-1 | 密钥存储 `<dataDir>/secrets.json`（0600）：name→{value,description,ts} + 会话绑定表 | `secrets.ts` |
| FR-SEC-2 | 值永不出后端：列表/composer-meta 只含 name+description | 路由 + `listSecrets` |
| FR-SEC-3 | composer `@` → Secrets 选择器 → 锁定图标 pill → 序列化 `@secrets:NAME` | AT_CATEGORIES + `sec-` pill |
| FR-SEC-4 | 派发时提取 `@secrets:NAME` → 绑定到会话（并集、持久化）+ prompt 追加 env-var 提示（含描述，无值） | `dispatchPrompt` |
| FR-SEC-5 | agent terminal/create 的 env 合并会话绑定密钥（值覆盖 params.env）；SSH 远端不注入（避免命令行泄漏） | `TerminalRunner.secretEnv` |
| FR-SEC-6 | CRUD：`GET/POST /api/admin/secrets`、`POST /api/admin/secrets/delete`；`POST …/secret-response` 应答 request_secret 卡（存值+绑定+`send_secrets` 标记） | registry + sessioncontrol |
| FR-SEC-7 | Settings → 资源 Secrets 面板：列表（name/desc）+ 新增（name/value write-only/desc）+ 删除 | SecretsPanel |

### 3.7 云端 REST 面（FR-CLD）

| 编号 | 需求 | 实现 |
|---|---|---|
| FR-CLD-1 | cloudapi 抽象：代理感知 fetch（`NODE_USE_ENV_PROXY`）、`Authorization: Bearer <token>` + `x-cog-org-id` 头、token/org 来源 env 或 dataDir 文件 | `cloudapi.ts` |
| FR-CLD-2 | `GET /api/admin/cloud/account`：9 读端点聚合（org/settings/members/session-tags/slash-commands/billing×2/account prefs/notif prefs/automation schemas），每端点独立 `{error}` 降级 | registry.ts |
| FR-CLD-3 | `GET /api/admin/cloud/proxy?path=`：`CLOUD_READ_PATHS` 白名单内任意读转发 | registry.ts |
| FR-CLD-4 | Settings → 资源 "云端账户"面板：org/套餐状态/账单/通知组/自动化事件类型/布尔开关/成员列表；无凭证诚实提示 | `CloudPanel` |
| FR-CLD-5 | token 不落前端；无凭证/过期 → 面板降级不影响本地功能 | cloudapi + UI |

### 3.8 通知（FR-NTF）

| 编号 | 需求 | 实现 |
|---|---|---|
| FR-NTF-1 | 通知中心：环形缓冲 + `notifications.json` 持久化 + WS 广播 | `notifcenter.ts` |
| FR-NTF-2 | 事件源：turn 完成、permission/account/rewind/mcp_auth | index.ts 接线 |
| FR-NTF-3 | Sidebar bell 下拉含通知分区 + unread sessions 计数 | `AppSidebar.tsx` |
| FR-NTF-4 | 桌面系统通知：页面不可见 + 新通知到达时触发（官方 prefs 同款） | web 端 Notification API |

### 3.9 诊断与安全（FR-OPS）

| 编号 | 需求 | 实现 |
|---|---|---|
| FR-OPS-1 | `GET /api/admin/diagnose` 全量状态 + `POST /api/admin/repair`（kill-orphans/stop-turns/clear-open-turns/restart-now/vacuum-logs） | `diagnose.ts` |
| FR-OPS-2 | `GET /api/admin/resources/system`：RSS/commit（acp commitMb 可见 PTY 泄漏）+ metrics | `resources/system` |
| FR-OPS-3 | commit watchdog：acp 超 8GB（in-flight 16GB）回收；系统 free commit < 3GB 时每轮回收最肥 acp | broker `memScan` |
| FR-OPS-4 | foreign devin.exe 清扫：supervisor 每 60s 杀超阈值的非 broker acp | supervisor.mjs |
| FR-OPS-5 | Insights-lite：`GET /api/admin/insights?days=` 本地用量聚合（日活/top-kind/top-session） | `SessionDb.usageStats` |
| FR-OPS-6 | WS 背压：bufferedAmount > 8MB 丢/断；重流 `session_update`/`agent_log`/`terminal_output`/`timeline_delta` 按 `{type:"sub",sessions}` 订阅 | ws.ts |
| FR-OPS-7 | Share 链接 `/s/:id` 只读时间线 | `lweb/share.ts` |

---

## 4. 非功能需求

### 4.1 可用性

| 编号 | 需求 | 度量/验证 |
|---|---|---|
| NFR-A1 | 后端崩溃/重启不丢 in-flight turn（broker 持有 acp） | ev:exit 路径实测 |
| NFR-A2 | 浏览器刷新/断网重连后时间线完整恢复 | timeline cursor 分页 |
| NFR-A3 | acp 进程被杀后 open turn 自动 resume | autoResume 测试 |
| NFR-A4 | 后端重启周期 ≤ 数秒；启动到 healthy < 60s（含 db 打开） | 迁移修复后实测 ~1.2s |

### 4.2 性能

| 编号 | 需求 | 度量 |
|---|---|---|
| NFR-P1 | 时间线 delta 帧不重渲染未变行（ref-stability 链） | 长会话滚动 ~60-80ms 长任务消除 |
| NFR-P2 | sessionlog.db 支持 ≥3GB / ≥1M 行：迁移必须 index-only 检测 + 单 JOIN pass，禁逐行关联子查询 | 3.4GB/1.24M 行库 109ms 迁移实测 |
| NFR-P3 | 高频事件环形缓冲（broker ring ~4MB/acp），附加重放不超内存 | broker ring |
| NFR-P4 | 周期性探测复用常驻 PowerShell 管道，禁 spawn-per-scan | `pshelper.mjs` |

### 4.3 可靠性

| 编号 | 需求 | 机制 |
|---|---|---|
| NFR-R1 | 用户可见状态 = durable 文件 或 可重建，禁止仅存内存 | dw.json/open-turns/acp-offsets/sessionlog |
| NFR-R2 | 写路径幂等：schema 迁移可重入、prompt journal 去重 | sessiondb uvN + open-turns |
| NFR-R3 | broker ↔ backend 断连后 attach 精确续流（after=N 字节位） | acp-offsets.json |
| NFR-R4 | 应答归属证明：agent 应答以 client reqId 还原，跨 attach 不错配 | broker id remux |

### 4.4 安全

| 编号 | 需求 | 机制 |
|---|---|---|
| NFR-S1 | LAN 访问提醒 + ADMIN_KEY 可选强制 | LanKeyBanner / authn |
| NFR-S2 | Allowed Hosts 白名单（supervisor 注入隧道默认） | DEVIN_WEB_ALLOWED_HOSTS |
| NFR-S3 | 云端 token 只驻留后端，任何路由不回传 token 本体 | cloudapi 出站注入 |
| FR-S4 → NFR-S4 | share 链接只读、可吊销 | share.ts |

### 4.5 可维护性

- 模块依赖方向**严格向下**（见 `docs/architecture.md` 图）
- 修改文件优先于新建文件；文档反映真实实现而非愿景
- i18n：UI 文案全部走 `en.json`/`zh.json` 键，禁硬编码
- 探测脚本（根目录 `*.mjs`）是一次性取证工具，不进测试套件

---

## 5. 接口需求

### 5.1 HTTP API

54 个 admin 路由（50 字面 + 4 表驱动模板）+ 会话级 `:id` 模式（`docs/SDD.md` §5 给出分类表）。公共入口全部经
supervisor :7791 反代；后端直连 :7792 仅诊断用。

### 5.2 WebSocket

- `/ws` 主 hub：`session_update`/`timeline_delta`/`agent_log`/`mcp_servers_changed`/`notification` 等；客户端 `{type:"sub",sessions:[id]}` 限域
- `/ws/term*` 终端流
- `/s/:id` share 只读流

### 5.3 ACP

- JSON-RPC over stdio（broker 数据通道）；客户端为 ACP client，`devin acp` 为 agent
- `_cognition.ai/*` 扩展方法面见 `docs/desktop-parity.md` 终态表

### 5.4 云端 REST

- `https://app.devin.ai/api/*`：`Authorization: Bearer` + `x-cog-org-id` + 代理
- 仅白名单读端点；写面未启用

### 5.5 文件系统

`<dataDir>`（默认 `~/.devin-web`）下的 durable 文件族见 SDD §4。

---

## 6. 验收基线

| 项 | 标准 | 现状 |
|---|---|---|
| 构建 | `npm run build` 零错误 | ✅ |
| 类型 | `npm run typecheck` 零错误 | ✅ |
| 单测 | `node --test test/unit-*.mjs` 44/44 | ✅ |
| 启动 | boot → `/api/health` 200 < 60s | 实测 ~1.2s |
| 稳定 | 后端运行 ≥ 24h 无探针重启 | 迁移修复后持续 |
| 崩溃恢复 | kill -9 backend 中回合 → 重启后 auto-resume | open-turns + adopt 路径 |
