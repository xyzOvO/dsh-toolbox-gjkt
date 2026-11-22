# DSH Remote 稳定性：进程守护配方（Windows）

> 核对日期：2026-11-22。以下区分**确证**（本机实测 / 安装包源码）与**推断 / 未实测**。
> 这份文档只给配方，**没有替你创建计划任务、没有装 NSSM、没有改注册表**。

---

## 先说清楚三件事的边界

你选的三项目标里，只有一项插件能真正解决：

| 目标 | 插件能否做 | 结论 |
|---|---|---|
| 掉线自动重连 / 看门狗 | `ds-harness-remote` **自带** | `reconnect` 默认开：full-jitter 重连（0–30s）、控制连接心跳超时检测、LAN→P2P→TURN→Relay 回退。**不用重复造**。 |
| 状态面板 + 自检自修 | 工具箱已加「📡 远程连接巡检」卡片 | 能看状态、能一键重连、能提示人工处理；**修不了** token 过期 / 设备吊销 / 凭据锁残留 / 进程崩溃。 |
| 进程守护 / 自动拉起 | **插件内做不到**，只能靠外部 | 见本配方。远程跑在 DSH 主进程树里，进程 `exit(1)` 后插件一起没，无法自己复活自己。 |

---

## 一、核对过的事实（照此配方的前提）

### 确证

- **主 exe**：`D:\Deepseek\DeepSeek Harness.exe`（约 246 MB）。这是唯一同时被开始菜单快捷方式、当前进程命令行、Electron 清单支持的路径。
- **快捷方式启动不带参数**：TargetPath=`D:\Deepseek\DeepSeek Harness.exe`，Arguments=空，WorkingDirectory=`D:\Deepseek`。
- **当前主进程**：命令行就是 `"D:\Deepseek\DeepSeek Harness.exe"`，父进程是 `explorer.exe`，**无 `--type=` / 无 `--expose-internals`**（这两个是子进程）。
- **Electron 应用**：appId `com.deepseek.dsh`，`main: lib/main.js`，带 `electron-updater`。OS 层多进程，应用层单实例。
- **单实例锁**：主进程 `requestSingleInstanceLock()`；再启动一次 exe 通常只会**聚焦已有窗口**，不会开第二个实例。这对"重启挂死实例"很关键。
- **Web 后端不是独立 daemon**：`127.0.0.1:52949`（本次实测端口，**不固定**）由 host 子进程持有，该子进程由 Electron 主进程 spawn，命令行带 `--expose-internals ... dsh-desktop-host\lib\index.js`。
- **崩溃行为**：host 致命错误走 fatal recovery——写报告、弹**可见对话框**，只有用户点 restart 才 `app.relaunch()`。**没有无界面自动重启**；auto-updater 的 `autoDownload` / `autoInstallOnAppQuit` 都是关的。

### 推断 / 未实测

- 主进程退出后，host 子进程**应该**随应用树一起不可用，但没做强杀实验，不写成确证。
- 外部 issue [liguobao/ds-harness-remote#241](https://github.com/liguobao/ds-harness-remote/issues/241) 称 TURN 超时触发 `process.exit(1)` 一天崩 5 次——这是**社区报告，未证实**，只能当作"和你描述一致"的旁证。

---

## 二、推荐方案：任务计划程序（带 GUI，登录会话内）

> **不要**用 NSSM 直接包 `DeepSeek Harness.exe`：NSSM 跑服务在 Session 0，和交互桌面隔离，Electron 窗口/托盘/fatal recovery 的 restart 按钮都不可见；profile 路径（形如 `C:\Users\<你的用户名>\.dsh\profiles\desktop`）也可能被服务账号读错。要纯后台 daemon 得另走 headless CLI（本轮未验证，别照抄）。

### 任务 A：登录时启动

- **名称**：`DSH Desktop Start`
- **触发器**：At log on of specific user → `YangJiaJi`
- **General**：选 **Run only when user is logged on**（不要选 "Run whether user is logged on or not"）；默认不勾 highest privileges。
- **Action**：
  - Program/script：`D:\Deepseek\DeepSeek Harness.exe`
  - Add arguments：（空）
  - Start in：`D:\Deepseek`
- **Settings**：If the task is already running → **Do not start a new instance**。

### 任务 B：轮询守护主进程

- **名称**：`DSH Desktop Guard`
- **触发器**：用户登录后每 1–5 分钟重复，持续 indefinitely。
- **条件**：Only run when user is logged on。
- **Settings**：If the task is already running → Do not start a new instance。
- **Action** → Start a program：
  - Program/script：`powershell.exe`
  - Add arguments（整段照抄）：

```powershell
-NoProfile -WindowStyle Hidden -Command "$e=(Get-CimInstance Win32_Process -Filter 'Name=''explorer.exe''').ProcessId; $m=Get-CimInstance Win32_Process -Filter 'Name=''DeepSeek Harness.exe'' | Where-Object { $_.ParentProcessId -in $e -and $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch '--expose-internals' }; if (-not $m) { Start-Process -FilePath 'D:\Deepseek\DeepSeek Harness.exe' -WorkingDirectory 'D:\Deepseek' }"
```

**为什么不用简单的 `Get-Process -Name 'DeepSeek Harness'`**：Electron 的 GPU/renderer/utility/host 子进程全都同名，按名字判断会把残留子进程当成"主进程还在"。上面按**父进程是 explorer + 排除 `--type=` / `--expose-internals`** 才接近实测的主进程。

### 只读检查命令（排错用）

```powershell
# 看端口归谁（端口每次可能不同，先查再用）
Get-NetTCPConnection -LocalPort 52949 | Select-Object LocalAddress,LocalPort,State,OwningProcess

# 看 host 子进程
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*dsh-desktop-host*' } | Select-Object ProcessId,ParentProcessId,CommandLine
```

---

## 三、风险（必须知道，别踩）

1. **你主动关掉 DSH，guard 也会把它拉回来。** 需要一个临时禁用/暂停手段：在任务计划程序里右键该任务 → Disable，或者把触发器先停用。
2. **guard 只处理"主进程树没了"。** 如果 host 子进程死了、主进程还停在 recovery 对话框，guard 不会动；此时再启动 exe 也因单实例锁只会聚焦旧窗口，不会真正重启 host。
3. **要自动处理第 2 种情况**，只能：点 UI 的 restart，或强杀整个主进程树后重启——后者会打断会话，**不建议默认启用**。
4. **端口不固定**：配方里的 `52949` 是本次实测，别写死进守护逻辑。

---

## 四、一句话建议

要 GUI → **任务计划程序**（登录会话启动 + 轮询主进程），不要 NSSM。要纯后台服务 → 先验证 headless CLI（`npx @deepseek-ai/dsh web --no-open` 之类，本轮**未在本机验证**具体参数/端口），再考虑 NSSM 包 CLI 进程。
