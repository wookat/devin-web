# devin-web 开发文档（Development Guide）

版本：v0.4.0 ｜ 读者：维护者与贡献者

> 前置阅读：`AGENTS.md`（权威约束）、`docs/architecture.md`（模块图）、
> `docs/SDD.md`（子系统设计）。本文是"动手改代码"的操作手册。

---

## 1. 环境准备

```bash
# 依赖：Node.js ≥ 22.5（node:sqlite），已认证的 devin CLI
git clone https://github.com/wookat/devin-web.git && cd devin-web
npm install
```

可选：
- `cloudflared`（公网隧道测试）
- 云端 REST 联调：把 auth1 token / org id 放入 `<dataDir>/devin-web
  .token` / `devin-web.org`（或 `DEVIN_WEB_DEVIN_TOKEN|ORG` env）；
  出口需系统代理（`NODE_USE_ENV_PROXY` 已在进程内生效）

## 2. 开发模式

```bash
npm run dev          # tsx watch server + vite dev server，热重载
```

- 生产拓扑必须经 supervisor：`node devin-web.mjs run`（或 `deploy`）
- **裸后端仅限调试**：`node dist/server/index.js --port 7794 --host
  127.0.0.1`；注意无 `DEVIN_WEB_ACP_BROKER` 时走 direct 模式，restart 会杀
  acp（行为不同！）
- 复刻生产环境变量手动起后端（诊断用）：
  `DEVIN_WEB_SUPERVISED=1 DEVIN_WEB_ACP_BROKER=<pipe> DEVIN_WEB_DATA_DIR
  =<dir> node dist/server/index.js --port 7796`

## 3. 构建与验证

```bash
npm run build        # vite build + compress + tsc → dist/{web,server}
npm run typecheck    # server + web 两套 tsconfig，要求零错误
npm run test:unit    # node --test test/unit-*.mjs（基线 44/44）
npm run smoke        # tsx scripts/smoke.ts（起服务自检）
npm test             # unit + api-smoke
```

**重启生效**（改完后端）：

```bash
curl -X POST http://127.0.0.1:7791/api/_super/restart   # 硬重启，最快
curl -X POST http://127.0.0.1:7791/api/admin/restart    # graceful（journal offsets）
curl -X POST http://127.0.0.1:7791/api/admin/redeploy   # 完整 build + 重启
```

> ⚠ `redeploy` 会杀掉调用者自己的 acp（经 auto-resume 接管）——从
> devin-web 会话内触发时预期断流重连。

**健康验证**（重启后）：

```bash
curl -s http://127.0.0.1:7791/api/health                  # 200
curl -s http://127.0.0.1:7791/api/_super/status           # supervisor 视角
curl -s http://127.0.0.1:7791/api/admin/sessions | head   # 真实数据
```

日志：`<dataDir>/{supervisor,server,broker}.log`；
`node devin-web.mjs logs [supervisor|server|broker]`。

---

## 4. 目录结构与模块导览

```
devin-web.mjs            服务 CLI 单一入口（run/install/status/logs/…）
scripts/
  supervisor.mjs         BIOS：:7791、静态、反代、探针、respawn
  acp-broker.mjs         执行面：acp 子进程持有、id remux、ledgers、ring、watchdog
  env.mjs                DEVIN_WEB_* 环境变量注册表（默认值单一来源）
  watchdog.mjs           :7791 静默复活
  pshelper.mjs           常驻 PowerShell 探测管道（与 server/src/pshelper.ts 镜像）
server/src/
  index.ts               进程入口：wiring + boot 顺序（adopt→清扫→autoResume→listen）
  acp.ts                 DevinAcp：init/握手/stdio tee sniffer/promptWithRetry
  acpbroker.ts           broker 客户端：spawn/attach/list/offset journal
  manager.ts             acp 池：get(cwd)/forSession/adopt/bindSession
  session*.ts            会话管线：load/log/db/view/cfg/queue/sub/adopt/place/…
  lweb/admin/registry.ts admin 路由注册表（~60 路由）
  lweb/admin/*.ts        路由分域：sessioncontrol/sessionfiles/sessiontimeline/…
  cloudapi.ts            云端只读面（凭证/代理/白名单）
  notifcenter.ts         通知中心（环形缓冲 + 持久化 + WS）
  sessiondb.ts           node:sqlite sessionlog.db（gen 模型 + 迁移）
  translate.ts           翻译 provider 链
  routes.ts / ws.ts      native HTTP 路由 / WS hub
  diagnose.ts / metrics.ts / security.ts / …
web/src/
  main.tsx               前端路由表
  pages/                 SessionsPage/AdminSession/Settings/ReplayPage/…
  pages/mirror/          会话页组件（ComposerFooter/ModelPicker/Timeline…）
  pages/settings/        Settings 各 section（ResourcesSection 等资源面板）
  components/            Markdown（KaTeX）/Timeline/AppSidebar/term/…
  lib/api.ts             adminFetch 等
  i18n/locales/{en,zh}.json
test/unit-*.mjs          node:test 单测
docs/                    architecture.md / desktop-parity.md / SRS / SDD / 本文
```

**模块依赖方向严格向下**（index → lweb/routes → session*/manager →
acp/acpbroker → store/env），禁止反向 import——加代码前先对图。

---

## 5. 编码规约

| 规约 | 说明 |
|---|---|
| 文件优先 | 改已有文件 > 新建；新建文件需明确归属某层 |
| durable-or-ephemeral | 新状态必须回答：持久化到哪/从哪重建/为何可丢 |
| i18n | UI 文案一律 `t('key')` + en/zh 双文件同键 |
| Tailwind | 沿用现有类风格（`px-[12px] py-[7px] text-13 text-secondary` 等设计 token） |
| 错误处理 | 错误边界在接缝层；单端点失败降级 `{error}` 不拖垮聚合（cloud/account 模式） |
| 探针脚本 | 根目录一次性 `*.mjs` 取证工具，不进测试、不进生产路径 |
| 注释 | 非自明机制写"为什么"（设计动机），不写"是什么" |
| 同步纪律 | listen 前禁重活：DB 迁移 index-only 检测先行、大文件扫描延迟 |

## 6. 常见任务 How-to

### 6.1 新增一个 admin 路由

```ts
// server/src/lweb/admin/registry.ts 内，按域找位置插入
{ method: 'GET', path: '/api/admin/foo', handler: async ({ res, ctx }) => {
  const mgr = ctx.manager.get(ctx.primaryCwd)          // 池级 acp
  const out = await mgr.extMethod('_cognition.ai/foo', { cwd: ctx.primaryCwd })
  json(res, out)
}}
```

前端侧：

```tsx
// Settings → 资源新面板（ResourcesSection.tsx 模式）
const [data, setData] = useState<T[] | null>(null)
useEffect(() => {
  void adminFetch<{ items: T[] }>('/api/admin/foo')
    .then(r => setData(r.items ?? [])).catch(() => setData([]))
}, [])
if (!data) return <p className="…">{t('common.loading')}</p>
```

### 6.2 接入一个新 `_cognition.ai/*` 方法

1. **探测 schema**：独立 spawn `devin acp`（**勿 attach 生产 acp**——
   latest-wins 会顶掉后端连接）。探针模式见根目录 `probe-*.mjs` 残骸与
   parity 文档"判定法"节
2. **参数取证**：`Invalid params` 只报通用码；**真实 serde 错误在 acp
   stderr**——给探针接上 stderr 逐轮补 `missing field 'x'`；
   资源类方法用 "Resource not found" vs "Invalid params" 区分 schema
   通过与否
3. **选接入档**：全局方法 → 池级 `manager.get(primaryCwd)`；会话方法 →
   `acpForId(id)`（promptHistory 教训：`load:true` 触发 session/load 超时
   的场景一律走池级 + 显式 sessionId 参数）
4. **验证**：重启后端 → curl 实机返回真实数据 → 记 parity 文档

### 6.3 加一个 WS 事件

后端 `ctx.ws.emit({type:'my_event',…})`；重流量频道需检查 scoping：
未限域客户端收全部，已限域只收 `sessions` 交集。前端 `useWs`/`hub`
订阅 type。

### 6.4 加 i18n 键

`web/src/i18n/locales/{en,zh}.json` 对应命名空间（`set.*`/`menu.*`/
`replay.*` 等）加同名键；键名短横线风格沿用现有。

### 6.5 改 sessionlog.db schema

1. `user_version` 递增 + 幂等迁移块（`BEGIN IMMEDIATE`）
2. **先 index-only 检测**是否需要工作；正常库必须近零成本跳过
3. 全程同步耗时 < 60s 启动窗口（3.4GB 库实测标准）

### 6.6 broker 协议联调

ctl 通道：ndjson `{cmd:"list"}`/`{cmd:"spawn",…}`；data 通道首行
`{attach,after,token}`。**探针陷阱**：attach 是 latest-wins，会顶掉
backend 对该 acp 的连接；`{ok:false}` 握手行无 `id` 字段，脚本要注意
过滤逻辑。取证一律 spawn 专用 acp。

## 7. 调试手册

| 症状 | 第一检查点 |
|---|---|
| 后端反复被 supervisor 杀 | `supervisor.log` 探针行 + `server.log` 本 boot 是否有 "listening"——没有则是 init 阶段同步烧（db 迁移/大扫描）；有则是 listen 后事件循环堵 |
| curl 7792 全 refused 但日志说 listening | 日志是**旧 boot**的；当前 boot 可能从未 listen（查 server.log 时间戳） |
| acp 方法 Invalid params | 探针接 stderr 看 serde `missing field` |
| 会话 turn 不结算 | `open-turns.json` 条目 + broker `list` 的 `pendingPrompts` + server.log `resolveTurnByReq`/`settleDead` 行 |
| WS 不推某事件 | 客户端是否 `sub` 限域；频道是否在 scoped 集合 |
| 云端端点 401/403 | token 过期（刷新 devin-web.token）或直连未走代理 |
| 路由 500 刷屏 | `server.log` 栈顶函数；旧 dist 残留先 `npm run build` 排除 |

**诊断路由**：`GET /api/admin/diagnose`（全量状态）、`POST
/api/admin/repair {fix}`、`GET /api/_super/status`、`GET
/api/admin/resources/system`（含 per-acp commitMb）、`POST
/api/admin/heapdump`。

## 8. 测试策略

- `test/unit-*.mjs`：纯函数/协议层单测（node:test，无框架）
- `test/api-smoke.mjs`：起服务打路由
- **实机验证 > 单测**：ACP 方法、路由、UI 面板都以真实数据为准
  （`curl` 实返 + 面板目视）；单测覆盖可离线逻辑
- 提交前基线：typecheck 零错 + build 绿 + 44/44 + 关键路由 200

## 9. 发布流程

```bash
git add -A && git commit -m "<imperative, 说明 why>"
git push origin main
```

- 无 CI；`main` 直推。破坏性变更先本地全绿
- parity 文档/AGENTS.md 随实现同步更新（文档反映现状不画饼）
- commit message 风格：`lowercase 模块: 动作`，正文写动机与坑

## 10. 已知坑速查（血泪清单）

1. **uv2→uv3 迁移死循环**：同步迁移超 60s → SIGTERM → 回滚 → 无限重启。
   任何 init 期重活都是同类雷
2. **`catalogInfo(undefined)` 崩溃**：sessionview 传 undefined；防护已在
   `modelcat.ts`——新调用点注意守卫
3. **attach latest-wins**：探针 attach 生产 acp = 把后端顶掉
4. **`promptHistory` 经 acpForId**：`load:true` 会 session/load 超时；
   池级 acp + sessionId 参数秒回
5. **curl 与 supervisor 探针结论可能不一致**：curl 走系统代理/解析差异
   时要 `127.0.0.1` + 显式端口复核
6. **redeploy 杀自己**：从 devin-web 会话内 `curl redeploy` 会终结该会话
   的 acp
7. **223MB MCP 通知洪流**：单个 acp 可发巨量通知；ring 有界因此 backend
   adopt 安全，但**同步解析**仍是事件循环风险——新增通知 handler 保持
   O(1)
8. **git push 网络抖动**：github.com 443 偶发超时，重试即可；提交不丢
9. **stale dist 幻觉**：旧 build 的报错栈在新代码里可能已修——排障先
   rebuild
