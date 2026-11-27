# 工具箱（v0.0.16）

一个 bundle 放七个小工具，设置统一在左下角 **设置 → 工具箱**（与「通用 / 模型 / 账号」同级的独立栏）。主对话框不放任何控件。

设置页分六张卡片（都可点标题折叠）：

- 🎛️ **总开关** —— 每个工具一个 master 开关，某个工具和别的插件冲突时可单独关掉。
- 🔔 **任务通知** —— 通知模式、提示音、子代理开关、测试通知、自动续作。
- ✂️ **划词工具栏** —— 按钮启停、搜索引擎、翻译方向。
- 🛠️ **工具** —— 四个 host agent 工具的运行按钮。
- 📡 **远程连接巡检** —— ds-harness-remote 状态、连接日志、保活看门狗。
- 🔖 **引用角标** —— 让模型在有出处的事实后附可点来源角标。

四个 host 工具（系统信息 / 编码安全 Shell / Token 成本 / 冲突检查）的 master 开关都在 🎛️ 总开关卡片里。

## 🎛️ 总开关

八个 master 开关各自独立，改完即时生效（volatile 配置，执行时判开关，无需重启）：

| 开关 | 默认 | 关掉后的效果 |
| --- | --- | --- |
| 任务通知 | 开 | 完成/出错/产物/工作流通知全部静默（含测试通知按钮禁用） |
| 划词工具栏 | 开 | 划词/右键都不再弹出工具栏 |
| 自动续作 | 关 | 任务完成后不追加续作消息 |
| 系统信息工具 | 开 | `sysinfo` agent 工具拒绝调用 |
| 编码安全 Shell | 开 | `encoding_run` agent 工具拒绝调用 |
| Token 成本工具 | 开 | `token_cost` agent 工具拒绝调用 |
| 冲突检查工具 | 开 | `config_conflicts` agent 工具拒绝调用 |
| 引用角标 | 关 | 不再向系统提示词注入引用角标规则 |

## ① 任务通知

DSH 后台任务完成 / 出错时，弹 **系统级通知**（窗口最小化也可见）+ 播放一段短提示音。

- 数据来自 DSH 核心转发的会话事件 `api-session/status` / `error` / `added` / `removed`，**不轮询、不写 host RPC**。
- 通知走浏览器 Notification API（与 dsh-cost-meter 同一通道）；提示音用 Web Audio 现场合成。
- **通知模式**：仅后台（默认，窗口失焦/隐藏才通知）/ 始终 / 从不。
- **通知提示音**：经典双音（默认）/ 单音 / 三连音 / 关闭（静音）。浏览器 Notification API 本身不支持指定声音，提示音由页面用 Web Audio 现场合成，所以可在这里换音色或静音。**按事件分音**：一条通知按其最重内容挑音色——有 `present` 产物响清脆三连音、有工作流响中速三连音、任务出错响低沉下行警示音、普通完成/测试通知用你选的预设；选「关闭」则全部静音。这几种事件音写死在代码里、不受你选的预设影响，只有「关闭」能全关。音量峰值已从 0.18 提到 0.45（约 2.5 倍）。
- **子代理完成也通知**：默认关（子代理作为独立 session 走 `api-session/*`，用 `origin/parentId` 识别）。
- **点通知跳会话**：默认开。点系统通知正文，`ctx.uiWorkspace.openSession(sessionId)` 把那条通知对应的会话切成当前会话。窗口开着或在后台时有效；**窗口最小化时网页通知无法把它拉回前台**，此时点击不起作用。
- **Agent 等我输入时提醒**：默认开。agent 弹出提问（ask_user_question）、授权确认、计划审阅时，会话仍是 running，常规"完成通知"不会触发；本功能用 `MutationObserver` 盯官方卡片的 `data-question-key` / `data-approval-key` / `data-plan-review-key` 标记出现，弹一条系统通知（柔和双音，点它跳回对应会话）。窗口在前台也会提醒（避免最小化时 `document.hidden`/`hasFocus()` 不准导致漏报）；另有 1.5 秒轮询兜底，防观察器漏事件。开关在 🔔 通知卡里，存 localStorage。按标记去重防刷屏。
- **产物与工作流增强**：任务完成时，通过 `ctx.sessions.retain()` 读该会话的 durable 事件流，把本轮 `present` 产物文件名、`tool-workflow/run-end` 结果一并写进通知正文。
- 「测试通知」按钮在设置页里，点了应当立即弹出一条系统通知。
- 「测试自动续作」按钮往当前会话发那条自动续作气泡，让 agent 立刻自己接着跑——用来绕过"产物+回合结束+失焦必须同一刻"的时序死结，验证续作链路。

### 已知边界

- 工作流通知来自父会话的 durable 事件 `tool-workflow/run-end`，只含 `runId / stopReason`（完成/取消/出错），不含 host 侧的完整结果与报错文本。
- 产物通知只列本轮 `present` 交付的文件；write/edit 改的文件、Git 级变更全集不在此列（那些要 host 侧服务或额外推导）。
- 若 Windows 开了「专注助手 / 免打扰」，系统通知可能被系统压住——不是插件故障。
- 「点通知跳会话」依赖窗口处于可见/后台状态；网页通知没有解除最小化（restore）的能力，最小化窗口拉起需要改 DSH 主进程，本插件不做。
- 「Agent 等待提醒」靠官方卡片的 DOM `data-*` 标记识别，是取巧实现；官方改了标记名或结构就会失效。前台后台都会提醒，若你正盯着屏幕仍弹通知，可在 🔔 通知卡里关掉此开关。
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

## 📡 远程连接巡检（Remote health）

读取 `ds-harness-remote` 的连接状态 + 一键重连 + 连接日志 + 保活看门狗。走 DSH WebServer 的同源控制路由 `/ds-harness-remote`（浏览器自动带 HttpOnly cookie，无 token / 无 CORS / 无 host.call），所以纯客户端实现、刷新即生效。展开卡片时才拉一次状态。

- **状态字段**（都来自 host `hostStatus()`，真实存在）：在线/重连中、已配置/已授权、设备名、账号、最后活跃、恢复截止、最近错误、需重新授权、已连接客户端列表（名称 · 平台 · 模式）。**手机 App「网络详情」里的 TURN / RTT / ICE IP / 回落原因属于手机侧连接诊断，主机端拿不到，卡片不会显示。**
- **连接日志**：只读按钮，拉 `settings.logs.get`（filter=warn），显示最近 8 条 warning 行（`settings.logs.get` 只接受 `all`|`warn`，limit 1–1000）。
- **保活看门狗**：默认开（localStorage `dsh-toolbox.remoteWatchdog` 持久化，不进 Config、不触发重装）。每 20s 检查一次状态；仅当**明确离线**（`online===false`）且**未在重连**（`reconnecting!==true`）、**不需重新授权**（`accountRequired!==true`）时，才请求一次 `host.reconnect`，60s 冷却、可随时暂停。只补一层应用层保险，不改插件底层的心跳/重连参数（那些要重输账号密码重新授权，风险大）。
- `ds-harness-remote@0.6.6` **自带**连接级自恢复：`reconnect` 默认开（full-jitter 0–30s）、控制连接心跳超时重连、LAN→P2P→TURN→Relay 回退。看门狗不重复造这套，只在它没兜住时补一次重连。
- **修不了**（只提示人工处理）：token 过期 / 授权撤销 / 设备吊销（需重新配对）、凭据锁残留目录 `SERVER_CREDENTIALS_BUSY`、DSH 进程崩溃、网络/TURN 本身不通。
- DSH core 没有 Remote 连接状态事件（`remoteAccess` 是权限注册表、`connection` 是认证路由），所以状态只能从插件自己的控制面拿。
- **进程守护**（插件内做不到，需外部）：见 [REMOTE-GUARD.md](REMOTE-GUARD.md)——核对过的 Windows 任务计划程序配方；不要用 NSSM 包 Electron Desktop exe（Session 0 隔离，GUI 不可见）。

## 🔖 引用角标（默认关）

让模型在**有明确出处的事实**后附一个可点来源角标，提升可读性。与 AGENTS.md 规则文件相比，本功能把指令经 `ctx.systemPrompt.section()` 注入到**每一步的系统提示词**，不依赖模型主动去读文件。

- **格式三选一**：上标 `[¹](来源)` / 数字 `[1](来源)` / 文字 `[来源](来源)`。上标字符仅 `¹²³⁴⁵⁶⁷⁸⁹⁰`，单条回答超过 9 处不同来源时退回普通数字。
- **来源写法**：网页贴完整 URL；本地笔记贴**正斜杠绝对路径**（如 `D:/path/to/note.md`）且必须先检索确认文件存在，不凭记忆编造；通用常识 / 推理不标。
- **为什么不用脚注 / `<details>`**：本版 DSH 实测标准 Markdown 脚注 `[^1]` 渲染成不可点纯文本、内联 HTML `<details>` 被整段转义，只有 Markdown 链接可点——所以格式一律是 `[角标](链接)`。
- **边界**：插件只保证"指令每次都在"，不保证模型 100% 照做；来源真实性取决于模型是否真检索。关闭时 section 返回空串，系统提示词不受影响。
- 旧的 `~/.dsh/cite-rules.md` 仅作存档保留，`~/.dsh/AGENTS.md` 里的指针已撤销（避免重复指令、省 token）。

## ⌨️ 快捷操作（全部默认关）

把官方语音输入 bundle 的麦克风按钮接到一个按住说话的快捷键上，不另做录音实现：

- **用法**：先在设置页打开本开关 → 确保官方 `@deepseek-ai/dsh-experimental-voice-input-bundle` 已启用并完成模型准备 → **按住 Alt** 开始录音，**松开 Alt** 自动点「停止并识别」，转写文字插入草稿（不自动发送）。
- **实现**：原生 `keydown`/`keyup` 监听，按住 180ms 后才开始（避免 Alt+Tab / 轻点误触），窗口失焦自动停止。通过本地化 `aria-label` 找官方按钮并 `.click()`，中/英/日/西四种界面文案都匹配。
- **输错了怎么办**：转写文字是一次性插入草稿的，**按一次 Ctrl+Z 就整段撤回**，不用手动删。（输入框底层是 Lexical，一段语音 = 一条撤销记录。）
- **静音 10 秒自动掐断**：全新安装默认关（老用户此前开着的保留）。录音时工具箱每 300ms 读一次官方波形 SVG 的 `<line>` 高度判断音量，连续 10 秒静音就自动点"停止并识别"转写，不用一直按着 Alt。靠官方波形 DOM 结构，官方改了结构后只是不再自动掐断（无害）。持续背景噪声可能让它一直判定"有人在说"而不掐断。开关在 ⌨️ 卡里，存 localStorage（键 `dsh-toolbox.voiceSilence`）。
- **边界**：官方按钮没有稳定 `data-*` 钩子，只靠 aria-label，官方 UI 改标签会失灵；Windows 上单独按 Alt 可能激活窗口菜单栏（如出现请反馈换键）；窗口失焦会取消录音；语音识别全靠官方 bundle（本机 SenseVoice，约 239MB 模型、CPU 本地跑，不出网）。
- **Ctrl+点击文件用外部软件打开**：全新安装默认关（老用户此前开着的保留）。设置页 ⌨️ 卡一个开关（键 `dsh-toolbox.ctrlOpen`）。按住 Ctrl 点击**生成的文件卡片**（deliverables/present）或**正文里的文件链接**（Markdown 路径），工具箱在捕获阶段拦下这次点击，改用 DSH 自己的 `session.openWorkspacePath({path})` 走系统默认应用打开，而不是右侧栏预览。文档卡片有稳定标记 `data-presented-file`，正文链接靠按钮的 `title` 路径识别——官方若改这两处 DOM，功能会失效（只是 Ctrl+点击退回预览，无害）。

  **路径必须先解析成绝对路径**：Host 的 `workspaceFiles.stat()` 返回字段是 `absolutePath`（不是 `path`）；拿不到就退用会话 `cwd` 拼接；两次都失败就放弃这次外开。原因是 `openWorkspacePath` 会让 Host 用 `resolve()` 解相对路径（相对的是 Host 进程 cwd，不是工作区），而 `explorer.exe` 收到一个不存在或不可解析的目标时会静默退回打开「文档」文件夹——表现就是"Ctrl+点击打开的是资源管理器文档"。普通点击（不按 Ctrl）完全不受影响。

- **开关持久化**：走 localStorage（键 `dsh-toolbox.voicePtt`、`dsh-toolbox.voiceSilence`、`dsh-toolbox.ctrlOpen`），不为它们单独改 Config 触发重装。
- **默认关 + 老用户保留**：这三个快捷操作对全新安装默认关闭。一次性迁移逻辑：若本地已存过任意 `dsh-toolbox.*` 标记（老用户），会把此前默认开的 Ctrl+点击外开、静音掐断补记为 `on`，保留原有行为；全新安装（无任何标记）维持默认关。迁移只跑一次（键 `dsh-toolbox.shortcutMigrated`）。

## 设置存储

绝大部分开关走 DSH 原生 Config（host `index.js` 的 `export const Config`，字段全部 `.volatile()`，改完即时生效、无需重启插件）。设置页通过 `settings.section` 挂载，读写走 `ctx.configForms`。host 工具的 master 开关在**执行时**判断，所以关掉后立即生效，不必重装。几个例外走 localStorage 持久化（避免为它们单独改 Config 触发重装）：远程看门狗、长按 Alt 语音、静音自动掐断、Agent 等待提醒、Ctrl+点击外部打开。没有把控件塞进主对话框。

## 回滚

设置 → 插件 → 找到 `dsh-toolbox-gjkt` → 关闭/卸载；或删除本插件源码目录后卸载。

## 版本

当前 **0.0.16** — 含总开关 / 任务通知（含点通知跳会话、按事件分音、Agent 等待输入提醒）/ 划词工具栏 / 自动续作 / 四个 host agent 工具 / 远程巡检 / 引用角标 / 长按 Alt 语音输入（push-to-talk，含静音 10 秒自动掐断）/ Ctrl+点击文件用外部软件打开。版本约定：推送 GitHub 前统一保持 0.0.1；首次推送记为 0.0.2，此后每次变动 +0.0.1。旧包配置不迁移（都是默认值，影响小）。
