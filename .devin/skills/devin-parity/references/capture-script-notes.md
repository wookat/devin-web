# capture-official.mjs 细节备忘

## 鉴权

- 持久化 profile 在 `test/parity/.auth/`（gitignore 已含 `test/parity/`）。
  官方页首次打开会要求登录——用你平时的登录方式过一次，之后所有取证
  会话免登。Playwright 的 persistent context 复用同一份 cookies。
- `--disable-blink-features=AutomationControlled` 减少被官方 bot
  检测拦的概率；别改 UA。

## 选取器策略（probes）

capture 默认打三组探针，按 feature 需要改 `probes` 对象：

- `fixedOverlays`：`[class*="fixed"], [role="tooltip"], [data-state="open"]`
  —— 浮动 pill、tooltip、展开的菜单。选中引用浮层就在这里。
- `toolbar`：`[class*="group"] [class*="absolute"] button` —— 消息悬停
  工具栏按钮组。
- `composer`：`form, textarea, [contenteditable="true"]` —— composer
  本体和 staged chips。

抓**官方**页面时注意：quote 浮层是 `dark` 类挂到临界的 portal，确认
`fixedOverlays` 能采到；采不到就加 `--probe` 自定义 selector。

## 多态捕获

按 Enter 拍一次 = 一个状态（快照 + spec push 进 captures[]）。惯例：
1. 先拍 idle（无浮层）
2. 触发交互（选中/悬停）→ 拍
3. 展开态（caption 输入框出现）→ 拍
4. hover 每个按钮 → 拍

diff-spec 默认只比最后一个 capture（最终态），capture 数相同时逐对
比。要逐态对比就在两侧按同样顺序拍同样的状态。

## 本地侧

```
node test/parity/capture-official.mjs \
  --url http://127.0.0.1:7791/admin/<sid> --feature <name> --local
```

`--local` 写 `local-spec.json` + `shots-local/`，不覆盖官方证据。
本地的"官方侧"基准永远用先拍的那份，别反过来。

## bundle 逻辑取证配合

运行态抓不到的东西（wire 格式、状态机内部、能力检测）在 `_devin_assets/`
用临时脚本搜——别用 `node -e` 单行（`=>` 会被 cmd 吃掉）。惯例是
`_qscanN.cjs`，用完即弃，不进 git。
