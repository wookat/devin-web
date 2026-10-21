# devin-parity — 像素级复刻工作流

对 app.devin.ai（云端会话/官方前端）做功能+UI+交互+视觉的逐项复刻。
用于任何"按官方样子实现 X"的任务。目标产出不是"差不多"，是
**spec 全绿 + 截图无肉眼差异 + 行为序列一致**。

## 核心原则

- **三层素材，各管一段**：
  - `_devin_assets/*.css`（编译产物）→ **真值样式**：`:root` token、
    自定义类、选择器组合都是 resolved 值，直接抠，不用猜。
  - `_devin_assets/*.js`（minified）→ **逻辑取证**：状态机、wire 格式、
    能力检测、aria/i18n 文案、Tailwind 类名。能逆成等价可读代码，但
    变量名/注释/类型/模块组织全丢，官方不发 sourcemap。
  - 活页面（Playwright）→ **运行态**：JS 算的坐标、级联终值、交互态
    动态类、真实字体渲染尺寸。CSS/JS 静态覆盖不了的才用它。
- **规格书先于代码存在**：先把官方证据落成 `docs/parity/<feature>/`
  （spec.json + 截图组 + CSS rules + HAR），再动手写实现。
- **对拍是机器做的**：不靠目测收敛，三层 diff 各有阈值（见"验收门禁"）。
- **token 先行**：80% 的精确度来自设计 token 表（颜色/间距/字号/圆角/
  阴影），不是单个组件。

## 五阶段

### Phase 0 — 运行态取证

```cmd
:: 首次：用持久化 profile 打开官方会话页，登录一次（state 存 test/parity/.auth/）
node test/parity/capture-official.mjs --url "https://app.devin.ai/sessions/<sid>" --feature <name>
:: 脚本打开非无头浏览器，你手动做出目标交互（选中文字/悬停消息/打开菜单），
:: 回车 → 落盘：
::   docs/parity/<feature>/official-spec.json   — 匹配元素的 computed-style 树 + rect + aria
::   docs/parity/<feature>/shots/*.png          — 触发前后截图
::   docs/parity/<feature>/official-root-vars.json — :root 设计 token
```

本地侧用 `--local http://127.0.0.1:7791/admin/<sid>` 拍同一份证据。

### Phase 0.5 — 静态样式收割（先于运行态！）

```cmd
node test/parity/extract-css.mjs <keyword1> [keyword2 ...]
:: 例：node test/parity/extract-css.mjs quotable transcript-message-actions
:: 输出每条命中的官方规则原文 → 贴进 docs/parity/<feature>/official-css.md
```

编译 CSS 里是 resolved 值：`:root` token（如 `--pending-quote-highlight`）、
`::selection` 高亮色、`anchor-scope` 定位、工具栏 right/top 偏移——这些
直接照抄，不要从 Tailwind 类名反推。已知官方用了 CSS anchor
positioning（`.transcript-message-actions` + `@position-try`）。

bundle 侧（JS 逻辑取证）：**优先读 `_deob/all/` 的全量反混淆产物**
（webcrack 恢复近源码：JSX 展开、控制流还原、仅变量名混淆）；
`_deob/INDEX.md` 是功能锚点→模块映射（262 模块）。重新生成或增量：

```cmd
node test/parity/deobfuscate-all.mjs [--filter <substr>] [--limit n] [--size kb]
node test/parity/build-index.mjs
```

仅当某个文件没进 `_deob/all` 时才回退到 `_devin_assets/` 人肉读
minified（锚点字符串搜索 + 命中点前后数千字符重建）。写临时
`_qscan*.cjs` 脚本而不是单行 `node -e`（shell 引号会吃 `=>`）。

### Phase 1 — Token 对齐

`official-root-vars.json` 对照本项目 `:root`/tailwind 变量建映射表
（`docs/parity/tokens.md`）。官方私有字体用 metrics 相近的 fallback 栈。

### Phase 2 — 移植

- DOM 结构、aria 属性、class 语义照抄 spec.json。
- 样式写 spec 的 computed 值；对不进 token 的用局部 CSS 变量。
- 交互按状态机搬（事件→迁移→副作用列表化）。
- 动画 duration/easing 从官方 `transition` computed 值抄。
- 消息协议：以官方 HAR payload 为准逐字段对齐（含空白符）。

### Phase 3 — 对拍

```cmd
node test/parity/diff-spec.mjs docs/parity/<f>/official-spec.json docs/parity/<f>/local-spec.json
:: 关键属性集零差异（~40 项：盒模型/字体/颜色/圆角/阴影/间距）
```

- 视觉：官方/本地同视口截图并排（装了 `pngjs`+`pixelmatch` 时自动出
  差异热力图，阈值 <0.5%）。
- 行为：同一事件序列两边回放，断言 DOM 变更序列一致。
- 协议：发出的消息 body 与官方 payload diff，逐字节一致。

### Phase 4 — 收敛

diff → 修 → 重拍，循环到全绿。状态写 `docs/parity/<feature>/STATUS.md`
（绿/黄项 + 已知不可复刻项及原因）。

## 验收门禁

- [ ] spec 关键属性 diff = 0
- [ ] 官方/本地截图同视口无肉眼差异（或 pixelmatch <0.5%）
- [ ] 交互状态迁移表两边一致（含键盘、Esc、focus 边界）
- [ ] wire 格式/payload 逐字节一致
- [ ] hover/active/focus/expanded 各态都拍了
- [ ] `npm run typecheck && npm run build` 过

## 已知天花板（诚实声明）

- 官方私有字体/插画资源：做不到逐字节，只对齐 metrics 和观感。
- 服务端渲染差异：官方 React 直出 vs 本地 Markdown 管线，HTML 层级
  不可能全等——目标是"看起来、用起来无感"，不是 DOM 逐字节。
- 未在 `_devin_assets` 缓存到的页面/端点：只能对运行态取证，拿不到
  源码侧佐证时按 spec.json 为准。

## 参考文件

- `references/capture-script-notes.md` — 取证脚本的选取器/多态/鉴权细节
- `test/parity/capture-official.mjs` — 运行态取证
- `test/parity/diff-spec.mjs` — spec 对拍
- `_devin_assets/` — 官方 bundle 缓存（逻辑取证专用）
