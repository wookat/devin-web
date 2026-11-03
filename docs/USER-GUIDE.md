# devin-web 使用文档（用户手册）

版本：v0.4.0 ｜ 读者：最终用户 ｜ 代码基线：`main @ 07abfcd` ｜ 核对日期：2026-11-03

> 本文是**使用者视角**的完整手册：装好、打开、用顺、出问题自助。
> 开发者请看 `docs/DEVELOPMENT.md`；架构与需求见 `docs/SDD.md` /
> `docs/SRS.md`。

---

## 1. 这是什么

devin-web 把你本机的 Devin CLI（`devin acp`）变成一个**云端风格的 Web 工
作台**：在浏览器里开会话、看 agent 干活、翻文件、跑终端——并且可以从
局域网或公网（手机、平板、另一台电脑）访问同一个工作台。

三个你可以放心的事实：

- **刷新不丢**：浏览器关掉再开，时间线原样回来
- **服务重启不丢**：后端崩溃/重启时，正在跑的回合继续跑（acp 由独立的
  broker 进程持有）
- **agent 死掉也能救**：acp 进程被杀后，未完成的回合自动在新进程上续跑

---

## 2. 安装与首次启动

```bash
git clone https://github.com/wookat/devin-web.git
cd devin-web
npm install
node devin-web.mjs deploy      # 构建 + 装开机自启 + 启动
```

打开 **http://localhost:7791**。

前置条件：

- Node.js ≥ 22.5
- 已登录的 Devin CLI（`devin` 命令能正常用）
- Windows / Linux / macOS 均支持

### 验证装好了

```bash
node devin-web.mjs status      # supervisor / backend / 持久化状态一览
```

浏览器打开页面能看到会话列表（或空列表+新建入口）即正常。

---

## 3. 服务管理

全部走单一入口 `node devin-web.mjs`：

| 命令 | 作用 |
|---|---|
| `run` | 前台跑 supervisor（调试用） |
| `start` | 后台启动 |
| `stop` | 停止（watchdog 尊重，不会复活） |
| `restart [--build]` | 重启；`--build` 先重新构建 |
| `status` | 状态总览 |
| `install` / `uninstall` | 装/卸开机自启（win 计划任务、linux systemd、mac launchd） |
| `deploy` | 一键：构建 + install + start |
| `logs [supervisor\|server\|broker]` | 看日志 |

也可以在 **Settings → 服务** 页点按钮：重启服务 / 重新构建并重启 /
硬重启 / 停止——页面会自动等服务回来再刷新。

---

## 4. 从哪访问

| 方式 | 地址 | 说明 |
|---|---|---|
| 本机 | `http://localhost:7791` | 默认 |
| 局域网 | `http://<本机IP>:7791` | 手机/平板同 Wi-Fi 直接开；首次非本机访问顶部会有黄色 LAN 提示条 |
| 公网 | Cloudflare Tunnel | `cloudflared` 指到 7791，隧道域名自动进 Host 白名单 |

**锁门（可选但推荐）**：设 `DEVIN_WEB_ADMIN_KEY` 后，非本机访问需带
key。不设则 LAN 上任何知道地址的人都能用你的 agent。

---

## 5. 会话使用

### 5.1 会话列表（首页 `/admin/sessions`）

- 按文件夹/mirror 分组，可搜索
- 未读徽标：agent 有新输出你没看时计数
- 每条会话的 `⋯` 菜单：**重命名 / 归档 / 移入文件夹 / 复制本地分享链
  接 / 分享到云端 / 回放 / 新窗口打开 / 重启 agent / Fork 会话 /
  结束会话**；子代理条目另有 后台运行/召回前台/终止；会话设置子面
  板里有标签等

### 5.2 新建会话

`+` 或"新会话"→ 选工作目录（本地路径或已配置的 SSH 目标）→ 输入第一
条指令。草稿会记住，手滑刷新不丢。

### 5.3 会话页（`/admin/:id`）

**时间线**：agent 的回复、思考（斜体折叠）、工具调用（脚本折叠、shell
命令+输出配对卡片）、你的消息。Markdown 全渲染，数学公式（`$..$`/
`$$..$$`）走 KaTeX。长输出可点"翻译"。

**输入框（composer）**：

| 操作 | 效果 |
|---|---|
| `Enter` | 发送（默认；可在 Settings → 偏好 改成 `Ctrl+Enter` 发送） |
| `Ctrl+Enter`（agent 正在跑时） | **立即插队发送**——打断当前回合发新指令 |
| `↑`（空输入或建议列表未开时） | 逐条回忆本会话发过的 prompt；到最老一条停住，`↓` 回到草稿 |
| `Tab`/`Enter`（建议列表开着） | 采纳建议 |
| `!` 开头 | 触发 playbook 宏（`!macro`） |
| `@` → Secrets | 选一个密钥插入 `@secrets:NAME` pill——agent 在终端命令里用 `$NAME` 取到值，值不出现在对话里 |
| 拖文件进输入框 | 上传附件随消息发送 |

**模型选择器**：输入框附近切换模型；"最近使用"区会同步你在桌面端选过
的模型（本地记录优先）。

### 5.4 工作区面板

会话页右侧/抽屉里：

- **文件**：浏览会话目录，点开即编辑（代码高亮）
- **Git**：当前分支、改动文件、diff
- **终端**：本地 PowerShell + agent 侧终端，多 tab
- **预览**：本地浏览器面板（agent 跑起来 web 服务时）

### 5.5 中断与恢复

agent 回合跑到一半服务重启过？页面顶部会出现**琥珀色横幅**：

- `继续`（continue）——回合已到达 agent，让它接着跑
- `重发`（resend）——消息没送达，原样重发（含附件）

`prefs.autoResume` 开着时**不需要你点**——重启 4 秒后自动续
跑，最多试 2 次。该开关**默认关闭**，在 Settings → 偏好 里手动开启
（`dw.json` 持久化）。

### 5.6 回放（Replay）

会话菜单 → 回放（或直开 `/admin/:id/replay`）：把整条历史按真实时间间
隔**放电影**——播放/暂停/单步/拖进度条/0.5–4 倍速，`空格`和方向键可
控。适合复盘 agent 怎么一步步做的。

---

## 6. 通知

侧边栏**铃铛**：未读会话计数 + 通知流（回合完成、权限请求、账户事件、
MCP 授权等）。

页面不在前台时，新通知会弹**系统桌面通知**（浏览器需授权通知权限；
官方偏好同款行为）。

---

## 7. 自动化（Automations）

`/admin/automations`（侧栏入口）：**定时跑会话**——官方 Automations 的
本地等价物，不依赖云端。

- **创建**：名字 + prompt + **5 段 cron**（`分 时 日 月 周`，例
  `0 9 * * *` = 每天 9:00；`*/30 * * * *` = 每半小时）+ 工作目录。
  非法或不可能的表达式保存即报错。
- **每次触发建一个全新会话**（标题 `⚙ <名字>`，归入 `.automations`
  文件夹）——不是往已有会话里塞消息。点条目旁边的"运行"可立即试跑。
- **多步工作流**：一条自动化可配 steps[]——第一步的会话跑完后自动发
  下一步，上下文延续。中途重启后端会接着断点续。
- **批量**：`POST /api/admin/automations/:id/run {inputs:[…]}` 每个
  输入起一个会话，`{{input}}` 占位会替换进 prompt。
- **防重叠**：同一条自动化上一跑没完不会重复触发；失败会进通知铃铛。
- **Playbooks**（`/api/admin/playbooks`）：可复用 prompt 模板，设了
  `macro` 后在 composer 输 `!名字` 直接展开。

---

## 8. Settings 各页

`/settings`，左栏十个页签：

| 页签 | 干什么 |
|---|---|
| 偏好 | 发送快捷键、主题、autoResume 等——和会话页 localStorage 同源 |
| Persona | agent 人格（wake/thinking 语气） |
| 账户 | 多账户轮换（SWE 限额时切换） |
| 资源 | **密钥** + **云端账户** + 系统资源 + 用量洞察 + 插件 + Agent 规则 + 计划 + Agent 资源 |
| SSH | 远程主机目标管理 |
| CLI | 本机 `devin` CLI 状态/参数 |
| Agents | subagent profile 浏览 |
| 服务 | 重启/重新构建/硬重启/停止 + 版本 |
| 诊断 | `diagnose` 全量导出 + 一键修复（杀孤儿/停回合/清恢复标记/vacuum） |
| 关于 | 版本与链接 |

### 资源页里的"密钥"

Devin 云端 org secrets 的本地等价物。添加 name + value + 描述后，在会话输
入框打 `@` → Secrets 选它，消息里出现 `@secrets:NAME` 锁定图标——发送后
agent 的终端命令里 `$NAME` 就是这个值。**值永远只进环境变量，不进对话
记录**；列表只显示名字和描述，写进去的值后端也不回读。会话绑定是累加
的：同一会话里提过的密钥都持续可用（每轮 prompt 都会带上可用名提示）。
即使 agent 执行 `echo $NAME`，输出里的值（含 base64 编码形态）也会被替换成 `••••••` 后才进入
对话记录（终端输出与文件读取通道都脱敏）。注意：SSH 远程会话不注入（值
会泄漏进远端命令行），但绑定值在 SSH 输出里仍会脱敏。TOTP/2FA：勾选
TOTP 存 base32 种子，agent 收到的环境变量是当前 6 位验证码。同名再添加
即轮换值；点行尾铅笔回填表单、会话数徽标展开可单独解绑某会话。环境
关键名（PATH/HOME/NODE_OPTIONS/DEVIN_WEB_* 等）被保留名拒绝——它们
会覆盖子进程同名变量。授权操作（建/改/删/绑/解绑）记入
`~/.devin-web/secrets-audit.jsonl`。**脱敏只防记录不防外泄**：若 agent 被
诱导把 `$KEY` 发到自己控制的网络端点，值照样出去——这和所有 env 密钥
方案（GitHub Actions 同）的限制一致，绑定前请确认信任当前会话。
Windows 下文件本体是 DPAPI 加密的（绑定当前用户+机器）——拷到别的机器
/别的用户打不开，防的是云同步和文件拷贝外泄；同机同用户的进程仍可解，
这是 DPAPI 的固有边界。数据迁移提示：加密文件**不能跨机带走**——目标
机器上重新录入，或迁移前设 `DEVIN_WEB_SECRETS_PLAIN=1` 让文件存明文再
拷贝（拷完记得删掉该变量）。会话绑定按 sessionId 记录，不随迁移生效。

### 资源页里的"云端账户"

展示 app.devin.ai 侧真实数据：组织名、套餐（如 `pro` + `past_due` 琥珀
警示）、账单数、成员列表、已开启的产品开关、自动化事件类型数。

**要它显示数据**：把浏览器里登录态的 `auth1_session.token` 和 org id
分别存到 `<数据目录>/devin-web.token` 和 `devin-web.org`（默认
`~/.devin-web/`）。token 过期后面板单项显示错误，不影响任何本地功能；
token 内容不会出现在前端。

### 诊断页自助修复

遇到怪异状态先到 **Settings → 诊断**：一键导出全量状态，修复动作白名
单——杀孤儿 acp / 停僵尸回合 / 清恢复标记 / 立即重启 / vacuum 日志库。

---

## 9. 分享会话

两档分享，别混：

- **复制链接**（本地）：`POST …/share-link {enabled:true}` 生成
  `/s/:id?t=local` 只读链接，对方能看到完整时间线但不能操作。链接只
  在 `meta.shared` 开着时有效——`{enabled:false}` 即失效（吊销走
  API；菜单目前只有"开"入口）
- **分享到云端**：`session/share` 把 transcript 上传到 Cognition 返回
  app.devin.ai 链接（仅 devin agent 会话显示此入口）——上传后不在本
  地控制范围

---

## 10. 常见问题

**Q：页面打不开 / API 502**
服务在重启中（静态页还在但 API 返回 `backend_unavailable`）。等几秒；
持续不通→ `node devin-web.mjs status` + `logs server`。

**Q：回合卡住不动了**
先看诊断页有没有孤儿/僵尸；`repair` 的 `stop-turns` 可清。底层 acp 若
已死，重启服务会自动 resume。

**Q：内存/提交量暴涨**
devin ≤3000.11.92 有 PTY commit 泄漏；broker 每 30s 扫一遍，单个 acp
超 8GB（跑回合时 16GB）自动回收，你只会看到回合自动重连。Settings →
资源 → 系统资源可看每个 acp 的 commitMb。

**Q：云端账户显示"未配置"**
缺 `devin-web.token`/`devin-web.org`（见 §7）。不配也能正常用本地全
部功能。

**Q：时间线很卡**
已知要求：长会话必须走增量 delta。若每帧都卡，多半是看了没有 ref 稳
定性的旧版——升级到最新 build。

**Q：换电脑/重装后历史还在吗**
全部状态在 `<数据目录>`（默认 `~/.devin-web`）：`sessionlog.db`
（时间线）、`dw.json`（设置）、通知等。备份/迁移整个目录即可。

**Q：agent 提醒"session_locked"**
上一个 acp 还占着会话。等它退出，或诊断页 `kill-orphans`。

**Q：macOS/Linux 上 install 失败**
需要用户级 systemd/launchd 权限；linux 还需 `loginctl enable-linger`
（文档 AGENTS.md 有命令）。

---

## 11. 数据目录速查

`~/.devin-web/`（可用 `DEVIN_WEB_DATA_DIR` 改）：

| 文件 | 内容 |
|---|---|
| `sessionlog.db` | 全部会话时间线（SQLite，可几 GB） |
| `dw.json` | 偏好/快照/设置 |
| `open-turns.json` | 未结算回合（正常应为空数组） |
| `send-errors.json` | 消息派发失败记录 |
| `notifications.json` | 通知中心 |
| `devin-web.token` / `.org` | 云端凭证（手动放置） |
| `supervisor.log` / `server.log` / `broker.log` | 三层日志 |

> 排障金句：**先看 `status`，再看 `logs server`，不行就诊断页导一份。**
