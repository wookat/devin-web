# devin-web 系统设计说明书（SDD）

版本：v0.4.0 ｜ 状态：as-built 设计记录 ｜ 代码基线：`main @ 07abfcd`（其后仅文档提交）｜ 核对日期：2026-11-03

> 与 `docs/architecture.md`（模块图与不变式）互补：本文按**子系统**展开设
> 计动机、机制与权衡，含数据设计与故障矩阵。

---

## 1. 设计目标与原则

### 1.1 目标

在本地 `devin acp` 之上复刻 Devin 云端工作台体验：会话可管、回合可追、
崩溃可恢复、跨设备可达。

### 1.2 核心原则

| 原则 | 内容 |
|---|---|
| 控制面 × 执行面分离 | backend（短命、可弃）与 acp-broker（长命、持子进程）是两个进程；任何用户可见状态不随 backend 死亡 |
| durable-or-ephemeral 二分 | 内存态要么持久化为文件（durable），要么可从 acp/日志重建（ephemeral）；不存在第三类 |
| seams over patches | 出问题时修接缝（协议、journal、迁移），不在症状上打补丁 |
| 诚实降级 | 云端功能/未注册 acp 方法明确报"不可用"，不伪造成功 |
| 启动窗口纪律 | 模块初始化同步工作必须 < supervisor 60s 宽限；重活延迟到 listen 后或做成可断点续作 |

---

## 2. 进程拓扑与生命周期

```
                 ┌─────────────── supervisor :7791 ───────────────┐
                 │  静态 dist/web · /api/* /ws* 反代 → 127.0.0.1:7792 │
                 │  4s 探针 api/health · 3 败即重拉 · >5 exits/5min   │
                 │  退避 60s · 日志轮转 · pidfile（watchdog 依据）      │
                 └──────┬──────────────────────┬───────────────────┘
              spawn/respawn              spawn/respawn(1.5s)
                 │                            │
        ┌────────▼────────┐         ┌─────────▼─────────┐
        │ backend :7792   │  ctl    │ acp-broker        │   owned children
        │ HTTP/WS/路由/会话│◄───────►│ ndjson ctl 通道    │──► devin acp ×N
        │ 调度/恢复/翻译   │  data   │ per-acp raw socket │   (pool + 会话绑定)
        └─────────────────┘         └───────────────────┘
                 ▲                           ▲
        watchdog（每分钟，win32 计划任务）   broker-state.json 清扫孤儿 acp
                 │
        平台服务：win32 Scheduled Tasks / linux systemd --user / darwin launchd
```

**关键生命周期事件**

- **backend 退出或 3 探针失败** → supervisor 清孤儿 acp + respawn；
  broker/acp **不动**，in-flight turn 流经 broker 不断流
- **broker 退出** → 1.5s respawn；其 pid journal 清扫它生前 spawn 的
  孤儿 acp
- **supervisor 退出**（非 stop） → watchdog 每分钟探测 :7791 静默即复活；
  `POST /api/_super/stop` 写 `supervisor.stopped` 标记，watchdog 尊重
- **后端 unsupervised 裸跑** → exit 时拉起 detached supervisor 交还 :7791
  （除非 `DEVIN_WEB_NO_SUPERVISOR=1`）

**重启语义三级**

| 操作 | 范围 | turn 影响 |
|---|---|---|
| `POST /api/admin/restart` | 后端 graceful：`beginDrain`（~400ms 关闸）→ `markGracefulExit`（open-turns 保留 + acp-offsets journal）→ exit | broker 模式零中断；direct 模式杀 acp 防锁孤儿 |
| `POST /api/admin/redeploy` | npm run build（~1-3min）成功后同上 | 同上；**调用者自己的 acp 一并被杀**（auto-resume 接管） |
| `POST /api/_super/restart` | 硬重启：跳过 offset journal，re-attach 从 live edge 续 | turn 流不断，offset 跳过 → 接 live edge |

---

## 3. 关键子系统设计

### 3.1 acp-broker：协议感知的多路复用器

**动机**：backend 必须可随便死，而 acp 子进程（及其中 in-flight turn）
必须活着。解法是让一个独立长命进程持有它们，backend 只是"接入"。

**通道**

- **ctl 通道**：ndjson，`spawn/kill/list` + `ev:exit`/`ev:mem-recycle`/
  `ev:prompt-start`/`ev:prompt-done` 事件
- **data 通道**：每 acp 一条 raw duplex socket；首行
  `{attach:id, after:N, token:T}` → ack → ring 重放 → pending-req 重发 →
  stdin 直喂，严格有序后才挂 data handler

**机制**

1. **JSON-RPC id remux**：client→agent req id 重写为 per-acp `brokerSeq`，
   agent→client 响应在进入 ring 前经 `idMap` 还原 client id。ring/重放/
   实时流三层一律携带 client 侧 id——backend 重连后复用的计数器不会与死
   连接上未结的请求撞号；`notePromptReq` 记的 reqId 跨 attach 仍有效。
2. **pending-request ledger**：agent→client 请求（permission/fs/terminal）
   按帧字节偏移索引，client→agent 应答即销账。attach 时把上一个 backend
   从未应答的请求重发（死窗僵尸 turn 解堵），ring 重放覆盖窗口内帧——无
   重复投递。
3. **pendingPrompts ledger**：session/prompt req→resp 对在 wire 上追踪；
   ctl `list` 报告、`prompt-done` 事件即时下发。这是"应答是否已离开
   agent"的权威证据（字段缺失 = 旧版 broker → 每次进程一次响亮报错，当
   空账本读）。
4. **Ring buffer**：~4MB/acp，帧按行边界切；attach `after:N` 从字节偏移
   精确续流。
5. **Commit watchdog**：`memScan` 每 30s 读各子进程 commit；acp >8GB
   （in-flight 时 16GB）即回收；系统 free commit <3GB 时每轮回收最肥一
   个。回收走正常 ev:exit 路径 → open turn 自动在新 acp 上 resume。
   防御 `devin acp ≤3000.11.92` PTY commit 气球（实测 ~26GB/2.5h →
   EventID 2004 级系统停滞；3000.11.205 上游修复不完整，watchdog 是真防
   线）。

**权衡**：latest-wins attach——第二个 attach 会把第一个顶掉。这保证
backend 重连简单，但也意味着**探针脚本绝不能 attach 到生产 acp**（取证
用独立 spawn 的 `devin acp` 实例）。

### 3.2 会话恢复：adoption + open-turns + auto-resume

**问题**：backend 崩溃时 agent 侧可能正在跑 turn；重启后既不能假装 turn
不存在（用户看到永远转圈），也不能重复派发（agent 重复执行）。

**证据链（优先级从高到低）**

1. **wire sniffer**（acp.ts，DevinAcp.init 的 stdin wrap + stdout tee，
   纯被动）：记录本连接发出的每个 reqId（`acp.pendingReqs`）；prompt 的
   reqId + broker acpId journal 到 open-turn 条目（`notePromptReq`）。
2. **`resolveTurnByReq`**：入站响应 id 匹配 pending prompt → 直接结算。
3. **`sessionByReqId`**：响应不匹配本连接任何请求（"response to unknown
   request"）→ 扫 open-turns 中同 acp 的 journaled reqId → armed watcher
   的 early-settle 跑同一个 done()（含 resync）。watcher arm 之前嗅到的
   应答存入 `sniffedSettles`（arm 时消费，30s 兜底 flush）。
4. **broker `pendingPrompts` 账本**：open-turn 的 `openTurn.ts ≥ acp
   .startedAt`（账本权威窗口内）且账本证明应答已发出 →
   `settleDeadAdoptedTurn` 立即结算。
5. **静默探测兜底**：attach 后 ~30s 地板 / 末活动 90s——只留给早于该
   acp 生命期的回合（其 prompt 响应死在旧字节流上）。

**启动顺序**（index.ts）：`adoptBrokerAcps`（broker list → per-acp attach
+ `session/list` → 重建 loadedOn/sessionHost/bySession + per-open-turn
watcher）**AWAITED** → 孤儿清扫 → `autoResumeInterrupted`——resume 永远
不会双发一个仍在跑的回合。

**autoResumeInterrupted**：listen 后 4s，`prefs.autoResume` 开时最多
2 次/回合（`resumeCount` 随 dispatchPrompt 传递）；无需 tab 打开。
冷会话无 turn 证据时给 `interrupted` 标注（`continue` 续跑 vs `resend`
重发）→ 前端琥珀色横幅。

### 3.3 SessionLog：sessionlog.db 与代际模型

**schema**（`server/src/sessiondb.ts`）

```sql
events(session_id TEXT, gen INTEGER, seq INTEGER, kind TEXT, ts INTEGER,
       data TEXT, PRIMARY KEY(session_id, gen, seq))
```

- `gen` 使"整段重写"成为 `INSERT gen+1` 而非 UPDATE——append-only 表上
  的 replace 语义；tail 读取按 `(session_id, MAX(gen))` 取当前代。
- `idx_events_kind(session_id,kind,seq DESC)`：按 kind 取数（mcp 通知、
  turn 边界）走索引不回表。
- `auto_vacuum=INCREMENTAL` + 每 checkpoint tick `incremental_vacuum(256)`
  （新库默认；存量库需一次性 VACUUM——repair `vacuum-logs`）。

**uv2→uv3 迁移事故与定案**（2026-11）

- 旧实现：逐行 `SELECT MAX(gen) WHERE session_id=e.session_id` 关联子查
  询 + data 列全表扫描，1.24M 行/3.4GB 上需数分钟同步执行 → 撞上 68s 探
  针窗口 → SIGTERM 中途杀 → **回滚 → `user_version` 永远停在 2 → 无限重
  启循环**。间歇存活的 boot 是 db 被持锁导致 ctor throw → `db=null` 快
  速降级启动的假象。
- 现行实现：`GROUP BY session_id HAVING MIN(gen)<>MAX(gen)` index-only
  stale 检测（正常库 0 → 整体跳过）；有 stale 才单 JOIN pass；
  `BEGIN IMMEDIATE` 包原子。线上库 stale=0，迁移实际 no-op，109ms。
- **教训入需求**：NFR-P2 + §2.3 启动窗口纪律。

**usageStats()**：`GROUP BY date(ts/1000,'unixepoch')` 日聚合 + kind
top-15 + 会话体积 top-20，全 bounded SQL → `GET /api/admin/insights`。

### 3.4 Admin route registry

`server/src/lweb/admin/registry.ts`：函数注册表，路由 handler 接收
`{req,res,ctx}`；`ctx` 暴露 manager/sessionlog/notifcenter/diagnose 等。

**acp 接入两档**

- **池级**（全局方法）：`manager.get(primaryCwd)` 取池化 acp →
  `extMethod(method, params)`——不触发 session/load，适用于
  rules/skills/plans/hooks/workflows/config/plugins/recentModelUids/
  mcp 全族
- **会话级**：`acpForId(id)` 或 `manager.get(...).forSession(id)`——
  session/load 走完整管线，适用于 goal/*、scope_search、promptHistory

**未实现方法的诚实处理**：直通转发把 acp 的 `Method not found` 原样返回
前端（dev-console 类工具显示真实错误）。

### 3.5 cloudapi：云端只读面

`server/src/cloudapi.ts`：

- `cloudCreds()`：`DEVIN_WEB_DEVIN_TOKEN|ORG` env → `<dataDir>/devin-web
  .token|org` 文件；缺任一则 `ok:false`（面板显示无凭证态）
- `cloudGet(path)`：`devinApiBase()`（默认 app.devin.ai/api）+ Bearer +
  `x-cog-org-id`；进程全局 `NODE_USE_ENV_PROXY` 使 fetch 走系统代理
  （CN 出口直连 403）
- `CLOUD_READ_PATHS` 白名单：`cloud/proxy` 只放行登记路径段，禁任意转发
- token **只出站不落地**：任何响应不回传 token 本体

`GET /api/admin/cloud/account` 聚合 9 读端点，每端点独立 try → `{error}`
降级单字段，不影响整体。

### 3.6 通知中心（notifcenter）

`server/src/notifcenter.ts`：内存环形缓冲 + `notifications.json` 持久化
+ WS `notification` 广播。事件源在 index.ts 接线：turn 完成（
`turnEndHooks` 模式注册）、permission 请求、account 事件、rewind、
`mcp_auth_pending`。前端 Sidebar bell 下拉开通知分区 + unread sessions
计数；`Notification` API 在页面不可见时弹系统通知。

### 3.7 WS hub 与背压

- 单一 `/ws` 入口分发 `type` 帧；重流频道（session_update/agent_log/
  terminal_output/timeline_delta）按 `{type:"sub",sessions:[id]}` 限域
  （`setWsSessionScope`）；未限域客户端收全部（legacy 语义）
- `bufferedAmount > 8MB` → drop-or-terminate；`metrics.ts` 计 ws.sent/
  scopedSkips/droppedClients/prompts.dispatched/acp.memRecycles

### 3.8 前端时间线 ref-stability 链

设计不变式（**断任何一环 = 每帧全量重渲**）：

```
mergeItems()              → 未变行保留旧对象引用
TimelineMerges.ts          → WeakMap<sourceItem, folded> 折叠结果同引用
TimelineGroup (React.memo) → 结构化比较（item refs 元素级 + scalar 值 +
                             per-row map lookup 按值比 + callback 按
                             useCallback 身份；inline arrow 有意跳过）
```

翻车案例："vast-comte is laggy"= 折叠处 mint 新对象 → 每 delta 帧重渲所
有挂载行（markdown 重解析 ~60-80ms 长任务）。

### 3.9 其余子系统速览

| 子系统 | 文件 | 要点 |
|---|---|---|
| 翻译 | `translate.ts` | devin-chat(auth1) → DEVIN_WEB_TRANSLATE_URL → MyMemory → gtx 链；`devinChatProbe()` 活性检查；token 过期静默降级 |
| 终端命令标记 | `termprocess.ts` | `powershell -Command -` 管道不调 prompt：行前排 `$global:LASTEXITCODE=$null`、行后排 `ESC]6973;C;<ec>BEL` 哨兵；顺序执行使哨兵=真实完成边界；stdout 流正则剥离，FIFO 配对 |
| git 修订推送 | file-git | 轮询 `branch@sha` 基线，变化时发 `workspace/didChangeRevision` |
| persona | `persona.ts` | turnEndHooks 同款注册模式；wake/thinking persona |
| 上传/附件 | `uploads.ts` | upload-stage 暂存 + session 引用 |
| diagnose/repair | `diagnose.ts` | 全量状态导出 + 修复动作白名单（kill-orphans/stop-turns/clear-open-turns/restart-now/vacuum-logs） |
| 密钥 | `secrets.ts` | `secrets.json` 0600 存储 + 会话绑定并集；值仅经 TerminalRunner env 注入 agent 命令，不进 transcript；SSH 不注入（防命令行泄漏）；`secret-response` 把 request_secret 应答落成新密钥并绑定会话 |
| 多账户轮换 | `accounts.ts` | SWE rate-limit 轮换 |
| security/wiki | `security.ts`/`wiki.ts` | 独立页面后端 |

---

## 4. 数据设计

### 4.1 `<dataDir>`（默认 `~/.devin-web`）durable 文件族

| 文件 | 写者 | 读者 | 生命周期 |
|---|---|---|---|
| `sessionlog.db` | SessionDb | timeline/prompt-history/insights | 长期；auto_vacuum=INCREMENTAL |
| `dw.json` | backend | prefs/快照/设置 | 长期 |
| `open-turns.json` | dispatchPrompt | 恢复管线 | turn 结算即删条目 |
| `send-errors.json` | sendhealth | 派发失败排查 | 有界环形 |
| `acp-offsets.json` | markGracefulExit | adoptBrokerAcps | 每次 graceful 覆盖 |
| `broker-state.json` | broker | supervisor 清扫 | broker 进程期间 |
| `broker.token`（0600） | broker | attach 鉴权 | broker 进程期间 |
| `notifications.json` | notifcenter | 通知中心 | 环形，有界 |
| `secrets.json`（0600） | secrets.ts 路由/terminal env | 密钥值 + 会话绑定 | 手动删除条目 |
| `devin-web.token`/`.org` | 用户手放 | cloudapi/translate | 手动刷新 |
| `supervisor.stopped` | _super/stop | watchdog | 标记文件 |
| `server.log`/`supervisor.log`/`broker.log` | 各进程 | 诊断/轮转 | 轮转 |
| `*.heapsnapshot` | RSS watchdog / heapdump | 排查 | 手动清 |

### 4.2 sessionlog.db 关键不变式

- `(session_id, gen, seq)` 主键；`gen` 单调递增代表"重写一次"
- tail re-append：重启后从 maxSeq 继续 append，dw_ 标记事件不进 timeline
- cursor 分页：`WHERE session_id=? AND gen=? AND seq>? ORDER BY seq LIMIT ?`
  → `next_cursor` 链式拉到底（Replay 全量路径）
- `dw_turn_end`/`dw_notice` 由结算路径写入，是恢复证据不是内容行

### 4.3 容量实测基线

- 1,241,725 行 / 3.4GB：index-only stale 检测 109ms；usageStats 有界
- 日峰值：251,814 events / 74 sessions（insights 实机数据）

---

## 5. 接口设计

### 5.1 HTTP 路由分类表（/api/admin/*：50 个字面路由 + 4 个表驱动模板路由 + 会话级 `:id` 模式）

| 类别 | 代表路由 | 说明 |
|---|---|---|
| 会话 | `GET /api/admin/sessions`、`POST …/new`、`…/session/:id/{config,version,goal,scope-search,prompt-history,resources,file-notify,ext}` | 生命周期 + 会话级 acp |
| 服务管理 | `POST …/{restart,redeploy}`、`GET …/drain`、`GET …/heapdump` | 重启三级见 §2 |
| 池级 acp | `GET …/{rules,skills,plans,hooks,subagents,workflows,plugins,devin-config,recent-models}`、`POST …/devin-config`、`…/mcp/{servers,tools,call}`、`POST …/skill-install` | 全局方法直通（skills/plans/hooks/subagents 走表驱动循环；通用转发仅 `mcp/call` 与会话级 `…/session/:id/ext`） |
| 工作区 | `…/fs/{dirs,list,file}`、`…/ssh/{dirs,fs,test}`、`…/resource-file` | 文件/SSH |
| mirror | `…/mirror/{sessions,members,parent,precheck,folder-*,session-*,indexed-paths,transcribe,translate}` | 分组/语音/翻译 |
| 云端 | `GET …/cloud/{account,proxy}` | §3.5 |
| 通知 | `GET …/notifications`、`POST …/notifications/read` | |
| 诊断 | `GET …/{diagnose,resources/system,insights,modules,send-check,composer-meta}`、`POST …/repair` | |
| 其他 | `…/{prefs,persona,session-persona*,playbooks,cli/run,automations/*,security/*,wiki/*,review/*,screen/*,share*}`、`GET /api/_super/{status}`、`POST /api/_super/{restart,stop}` | 页面后端 + supervisor |

### 5.2 WS 协议帧（客户端→服务端）

`{type:"sub",sessions:[id]}` 限域；`{type:"unsub"}`；其余按频道 type。

服务端→客户端：`session_update`、`timeline_delta`（seq 增量）、
`agent_log`、`terminal_output`、`mcp_servers_changed`、`mcp_auth_pending`、
`notification`、`turn_end` 等。

### 5.3 ACP 扩展方法面终态

完整三档表见 `docs/desktop-parity.md`：**已破解+已路由**（goal 全族/
scope_search/rules/skills/plans/subagents/hooks/workflows/mcp 全族/
reads.{promptHistory,recentModelUids}/config.{read,write}/plugins.list/
IDE 推送族）、**已破解未路由**（workflows/migrate、session/share）、
**本地未注册**（session/loadPage 族、turn_stats、compaction、
browserPreview、plugins 写面、clipboard、repos/list、tail、fork 等——
云端功能）。

### 5.4 云端 REST

白名单读端点（实测状态记入 parity 文档）：organizations 全族、billing、
account prefs、notification-preferences、automations/schemas 200；
notifications/usage-current 404、sessions GET 405、knowledge-
suggestions 422（需 devin_id）。

---

## 6. 部署设计

| 平台 | 机制 | 组件 |
|---|---|---|
| win32 | Scheduled Tasks | `devin-web-supervisor`（onlogon，经隐藏 .vbs 启动器）+ `devin-web-watchdog`（每分钟 → `scripts/watchdog.mjs`） |
| linux | systemd --user | unit `Restart=always` + `loginctl enable-linger` |
| darwin | launchd | LaunchAgent `RunAtLoad` + `KeepAlive` |

`node devin-web.mjs install` 生成平台原生单元；`uninstall` 拆除；
`deploy` = build + install + start。supervisor 在无 shell env 的启动任
务下注入默认 `DEVIN_WEB_ALLOWED_HOSTS`（隧道主机）。windowsHide 全覆
盖 spawn/execFile，pshelper 常驻管道杜绝 conhost 闪烁。

公网可达：Cloudflare Tunnel（`cloudflared`）→ supervisor 静态+反代单端
口天然适配。

---

## 7. 安全设计

- **入口鉴权**：无登录体系；`DEVIN_WEB_ADMIN_KEY` 存在时非 loopback 请
  求需带 key；`LanKeyBanner` 在裸 LAN 访问时一次性警告
- **Host 白名单**：`DEVIN_WEB_ALLOWED_HOSTS`（supervisor 缺省注入隧道
  域名），防 DNS rebinding
- **broker 通道**：`broker.token`（0600）附着于 attach 首行
- **云端凭证**：token/org 仅服务端持有；`cloud/proxy` 白名单只读；
  前端永不见 token
- **share**：`/s/:id` 只读时间线视图，独立 share 层不含 admin 面
- **诊断安全**：diagnose 导出可脱敏字段（token 不出现在导出中）

---

## 8. 故障模式与恢复矩阵

| 故障 | 检测 | 恢复路径 | 用户可见 |
|---|---|---|---|
| backend 崩溃/SIGKILL | supervisor 探针 3 败或 exit | 重拉 → adopt broker acps → open-turns watcher/自动 resume | 静态页仍开，API 502 数秒；in-flight turn 不断流 |
| backend 假死（事件循环堵） | 探针 3 败 | 同上；journal 缺失 → attach live edge | 同上 |
| backend 启动卡死（迁移类） | 60s 宽限 + 3 败 | NFR-P2 设计防复发；修复需人工跑迁移 | 无限循环（事故已修） |
| broker 崩溃 | supervisor 1.5s 检测 | respawn + broker-state 扫孤儿；backend 重 attach live edge | turn 流断（open-turns resume 兜底） |
| acp 进程死亡/commit 超限 | broker ev:exit / memScan | open turn 在新 acp auto-resume；session re-attach | 短暂停顿 → 自动续 |
| supervisor 死亡 | watchdog 每分钟探 :7791 | 复活（stopped 标记除外） | 全站短暂不可达 |
| sessionlog.db 锁竞争 | ctor throw | `db=null` 降级启动（timeline/insights 不可用，其余正常） | 面板显示不可用 |
| 云端 token 过期 | cloudGet 401/403 | 每端点 `{error}` 降级 | Cloud 面板单项提示 |
| acp 通知洪流（223MB 实测） | ring 有界 + 事件循环 | ring 只留 ~4MB；backend adopt 按 offset 接入不背历史包袱 | 无感 |
| orphan acp 残留 | boot 清扫 + foreign-sweep 60s | kill + session 锁释放 | 无感 |

---

## 9. 设计决策记录（ADR 摘要）

| 决策 | 备选 | 结论与理由 |
|---|---|---|
| broker 持 acp vs backend 自持 | backend 自持 + 文件锁 | broker：backend 任意死不死 turn；pgbouncer-tmux-LSP-daemon 模式 |
| id remux vs 全局唯一 id | UUID 请求 id | remux：ring/重放/实时三层天然携带 client id，journaled reqId 跨 attach 有效 |
| open-turns 文件 vs 仅 log 尾 | 只扫 log | 文件：写路径幂等 + 结构化工单；log 尾作补充证据（pre-marker 时代） |
| 立即结算 vs 固定等待 | 统一 90s 静默 | 分层证据：reqId 匹配/ledger 证明立即结算，仅窗口外回合走静默地板 |
| 迁移 index-only 检测 | 每次全量迁移 | 正常库 stale=0 → 109ms；启动窗口纪律 |
| 云端聚合端点 vs 逐端点路由 | 前端逐端点 | account 聚合（1 请求 9 端点，各自降级）+ proxy 白名单兜底 |
| 池级 acp 转发全局方法 | 每请求 spawn acp | 池化：`session/load` 秒级开销不可接受 |
