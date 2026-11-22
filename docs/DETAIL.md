# 工具箱（测试版 0.0.1）

一个 bundle 放七个小工具，设置统一在左下角 **设置 → 工具箱**（与「通用 / 模型 / 账号」同级的独立栏）。主对话框不放任何控件。

设置页分四张卡片：

- 🎛️ **总开关** —— 每个工具一个 master 开关，某个工具和别的插件冲突时可单独关掉。
- 🔔 **任务通知** —— 通知模式、子代理开关、测试通知、自动续作。
- ✂️ **划词工具栏** —— 按钮启停、搜索引擎、翻译方向。
- 四个 host 工具（系统信息 / 编码安全 Shell / Token 成本 / 冲突检查）的 master 开关都在 🎛️ 总开关卡片里。

## 🎛️ 总开关

七个 master 开关各自独立，改完即时生效（volatile 配置，执行时判开关，无需重启）：

| 开关 | 默认 | 关掉后的效果 |
| --- | --- | --- |
| 任务通知 | 开 | 完成/出错/产物/工作流通知全部静默（含测试通知按钮禁用） |
| 划词工具栏 | 开 | 划词/右键都不再弹出工具栏 |
| 自动续作 | 关 | 任务完成后不追加续作消息 |
| 系统信息工具 | 开 | `sysinfo` agent 工具拒绝调用 |
| 编码安全 Shell | 开 | `encoding_run` agent 工具拒绝调用 |
| Token 成本工具 | 开 | `token_cost` agent 工具拒绝调用 |
| 冲突检查工具 | 开 | `config_conflicts` agent 工具拒绝调用 |

## ① 任务通知

DSH 后台任务完成 / 出错时，弹 **系统级通知**（窗口最小化也可见）+ 播放一段短提示音。

- 数据来自 DSH 核心转发的会话事件 `api-session/status` / `error` / `added` / `removed`，**不轮询、不写 host RPC**。
- 通知走浏览器 Notification API（与 dsh-cost-meter 同一通道）；提示音用 Web Audio 现场合成。
- **通知模式**：仅后台（默认，窗口失焦/隐藏才通知）/ 始终 / 从不。
- **子代理完成也通知**：默认关（子代理作为独立 session 走 `api-session/*`，用 `origin/parentId` 识别）。
- **产物与工作流增强**：任务完成时，通过 `ctx.sessions.retain()` 读该会话的 durable 事件流，把本轮 `present` 产物文件名、`tool-workflow/run-end` 结果一并写进通知正文。
- 「测试通知」按钮在设置页里，点了应当立即弹出一条系统通知。

### 已知边界

- 工作流通知来自父会话的 durable 事件 `tool-workflow/run-end`，只含 `runId / stopReason`（完成/取消/出错），不含 host 侧的完整结果与报错文本。
- 产物通知只列本轮 `present` 交付的文件；write/edit 改的文件、Git 级变更全集不在此列（那些要 host 侧服务或额外推导）。
- 若 Windows 开了「专注助手 / 免打扰」，系统通知可能被系统压住——不是插件故障。
- 铁律：这类通知只在任务真正结束（running→idle）那一瞬触发，会话内等待不会弹，验收要结束回合等。

## ✂️ 划词工具栏

在对话里选中文字后 **右键**，弹出四个按钮（普通划词作兜底，核心「引用」插件优先）：

- **搜索** — 可选 Bing / 百度 / Google（默认 Bing），新标签页打开。
- **翻译** — 百度翻译网页；方向可选自动检测 / 中→英 / 英→中。
- **复制** — 写入剪贴板。
- **问 agent** — 把选中文字填进输入框（附一句提示语）。

四个按钮可单独开关。工具栏纯客户端：不申请权限、不碰 host half。

## 🤖 自动续作（默认关）

任务产出文件或工作流结束时，自动向该会话追加一条用户消息「【自动续作】上一步已完成，请检查结果并继续。」让它继续跑。

- 与系统通知**并存**：先弹通知，再按条件续作，互不替代。
- 纯客户端：走 `ctx.remote.session.prompt`（官方 Session 远端），不动 host、不改架构，刷新即生效。
- 幂等：用 `requestId`（由产物/工作流内容 hash 得出）去重，服务端也按 requestId 幂等。
- 只在**窗口失焦/隐藏**且本轮确实有产物或工作流结算时触发。

### 已知边界

- 续作消息会以一条**用户气泡**出现在会话里（不是隐形的后台 steer）。
- 需要本 DSH 窗口保持打开；页面关掉后不会触发。
- 若会话正被 goal（目标自动续跑）接管，本版**未做让路判断**——可能与 goal 的续跑竞争；需要的话后续再加。

## 🧰 四个 host agent 工具

在 `tools.js` 里用原生 raw JSON Schema 工具定义注册（零外部 import 依赖，绕开 profile 里缺失的 `dsh-tools`）。只读工具默认不弹授权。

| 工具 | 作用 |
| --- | --- |
| `sysinfo` | 查 OS / CPU / 内存 / 负载 / 网卡 / 主机名等；CPU 使用率两次采样计算。 |
| `encoding_run` | 自己 spawn 命令、接原始字节，启发式识别 UTF-8 / UTF-16LE / GBK / GB18030 / Latin-1 后解码，解决 DSH 核心 `toString('utf8')` 把中文变乱码的问题。 |
| `token_cost` | 按 tokenMeter 同款密度启发式（`ceil(chars/4)+4`）估算 AGENTS.md 指令链、Skill 正文、工具 Schema 的 token 开销。 |
| `config_conflicts` | 扫描重复指令段落、同名 Skill、重复工具名。 |

### 怎么运行

设置页 **🛠️ 工具** 卡片里每个工具有一个「运行」按钮。点它 = 往**当前主会话**发一句「请用 X 工具……」的用户消息（通过 `ctx.remote.session.prompt`，以 `queue` 模式入队），agent 会调用对应工具并把结果写在那个对话里。

- 结果**不显示在设置页**，只出现在你点按钮时所在的那个会话——因为本包是静态 pnpm-link 插件，浏览器半区拿不到 `host.call`，内嵌结果面板需要另造一条 Typert Remote（成本高、脆），所以选了「发消息到当前会话」这条最稳的路。
- 按钮在对应 master 开关关闭时变灰；需要至少打开一个会话（主视图会话以 `retainedBy.mainView > 0` 判定，与 DSH 自身一致）。
- 也可以在对话里直接说「用 token_cost 统计一下」，不依赖这些按钮。

### 已知边界

- `encoding_run` 只救**新执行命令**的输出；已经进 Harness 变成 U+FFFD 的乱码无法还原。
- `token_cost` 是启发式估算，不是精确 tokenizer / 按类别计费；Skill 正文默认不全量进上下文（只有 catalog 摘要 + 被调用的正文进）。
- `config_conflicts` 的「冲突」是机械规则（重复文本 / 同名）；DSH 原生没有语义冲突检测，规则由本工具定义。
- `sysinfo` 的网络收发流量 `node:os` 拿不到（需额外装 `systeminformation`，未装）。

## 设置存储

所有开关走 DSH 原生 Config（host `index.js` 的 `export const Config`，字段全部 `.volatile()`，改完即时生效、无需重启插件）。设置页通过 `settings.section` 挂载，读写走 `ctx.configForms`。host 工具的 master 开关在**执行时**判断，所以关掉后立即生效，不必重装。没有用 localStorage，也没有把控件塞进主对话框。

## 回滚

设置 → 插件 → 找到 `@local/dsh-toolbox` → 关闭/卸载；或直接删除 `D:\AI库\dsh-toolbox` 目录后卸载。

## 版本

0.0.1 — 合并自原 `@local/dsh-task-notify-test` 与 `@local/dsh-selection-toolbar`，含总开关 / 任务通知 / 划词工具栏 / 自动续作 + 四个 host agent 工具。版本约定：推送 GitHub 前统一保持 0.0.1；从推送那天起每次变动 +0.0.1（0.0.2、0.0.3…）。旧包配置不迁移（都是默认值，影响小）。
