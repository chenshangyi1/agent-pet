# 小鑫 · Agent Pet

复用蓝发小女仆桌宠「小鑫」，独立运行于 macOS 桌面与刘海区域，内置 **22 个主流 AI Agent 状态感知** 与 **QQ / 企业微信 Bot 远程派活网关**。

> **独立运行，不强制依赖 DSH**：项目仓库已内置桌宠 WebM 动画与完整独立启动/安装流程；DSH 未运行时，桌面快速聊天与语音对话可通过 `LocalChatBridge` 直连本机 **Claude Code** / **Codex**，所有 22 个 AI Agent 监听、刘海面板、本地语音播报/识别与 QQ / 企微 Bot 派活网关仍可 **100% 独立运行**，DSH 启动后自动重连。

## 架构概览

```text
+-------------------------------------------------------------------------+
|                           macOS Desktop / Notch                         |
|  +-----------------------+    +---------------------+    +-----------+  |
|  |   桌宠悬浮窗口 (ui.js) |    | 原生刘海面板 (Swift) |    | 托盘/管理 |  |
|  |  快捷聊天 · 语音 · 卡片 |    |  多 Agent 实时状态   |    | 控制中心  |  |
|  +-----------+-----------+    +----------+----------+    +-----+-----+  |
|              |                           |                     |        |
|              v                           v                     v        |
|  +-------------------------------------------------------------------+  |
|  |                    runtime/main.cjs (Electron 主进程)              |  |
|  |  · LocalSpeech (macOS STT/TTS)   · AutoStartManager (LaunchAgent) |  |
|  |  · Providers (状态聚合器)         · ConnectorRegistry (22 Agents)  |  |
|  +------------------+-----------------------------------+------------+  |
|                     | (DSH 在线优先 RPC，离线自动回退)   |               |
|                     v                                   v               |
|  +-----------------------------------+   +---------------------------+  |
|  |     bot/local-chat.cjs            |   |    bot/service.cjs        |  |
|  |  LocalChatBridge (桌面直连对话)    |   |  QQ (OneBot v11) / 企业微信 |  |
|  +-----------------+-----------------+   +-------------+-------------+  |
|                    |                                   |                |
|                    +-----------------+-----------------+                |
|                                      v                                  |
|                    +-----------------------------------+                |
|                    |   bot/dispatcher.cjs (多引擎调度)  |                |
|                    |  Claude Code · Codex · Agy · DSH  |                |
|                    +-----------------------------------+                |
+-------------------------------------------------------------------------+
```

## 核心能力

### 1. 桌面快捷聊天与语音直连（零 DSH 依赖）
- **开箱即聊**：在桌宠胶囊栏点击编辑按钮或直接输入（快捷键 `Alt+Space`），即可发起文字对话、图片附件、模型/技能/文件上下文选择以及多轮语音对话（macOS 原生语音识别 + 播报）。
- **智能路由与自动回退**：当跟随模式为 **自动跟随 (`auto`)** 或 **`dsh`** 时，若 DSH 在线则优先走 DSH 桥接，DSH 未启动时自动无缝切换至 `LocalChatBridge`（调用本机 `Claude Code` / `Codex`）；若直接切换跟随 **`Claude Code`** 或 **`Codex`**，则由本地引擎直接驱动，无需启动 DSH。
- **实时活动卡片**：本地快捷聊天生成的会话（`local:*`）会自动同步到桌宠活动卡片，支持直接点击查看对话记录、继续追问或随时停止任务。

### 2. 22 个本地 AI Agent 状态感知（开箱不侵扰）
新安装或从 GitHub 克隆运行时，默认不主动修改本机其他 AI Agent 的配置；打开刘海面板右上角 **`＋ 接入`**（或托盘菜单 **`管理 AI Agent...`**），即可在「AI Agent 连接器」页面自动检测本机已安装工具，支持 **`一键接入已安装`** 或按需单个 **`+ 接入`** / **`− 移除`**（自动备份原配置）。

| Agent | 接入机制 | 说明 |
| --- | --- | --- |
| **DSH**（默认内置） | 本地桥接 (`dsh-bridge.json`) | 支持快捷聊天、新建/回复会话、停止任务、语音交互与远程派活 |
| **Claude Code** | Hooks (`~/.claude/settings.json`) | 生命周期状态提醒、打开应用、Bot 远程派活 |
| **Codex** | Hooks (`~/.codex/hooks.json`) + 只读会话索引 (`~/.codex/sessions`) | 兼容 CLI 与 Codex Desktop，状态提醒、打开应用、Bot 远程派活 |
| **Cursor** | Hooks (`~/.cursor/hooks.json`) | 状态提醒与打开 Cursor |
| **OpenCode** | Plugin (`~/.config/opencode/plugins/agent-pet.js`) | 状态提醒与打开 OpenCode |
| **Antigravity** | Plugin (`~/.gemini/config/plugins/agent-pet`) | 状态提醒与打开 Antigravity（若装有 `agy` CLI 或 SDK 也支持派活） |
| **WorkBuddy / WorkBuddy AI** | Hooks (`~/.workbuddy*/settings.json`) | 状态提醒与打开应用 |
| **Kiro** | Hooks (`~/.kiro/hooks/agent-pet.json`) | 状态提醒与打开 Kiro |
| **Trae / Trae CN** | Hooks (`~/.trae*/hooks.json`) | 状态提醒与打开 Trae |
| **Qoder / Qoder CN** | Hooks (`~/.qoder*/settings.json`) | 状态提醒与打开 Qoder |
| **ZCode** | Plugin (`~/.zcode/cli/plugins/agent-pet`) | 状态提醒与打开 ZCode |
| **CodeBuddy / CodeBuddy CN** | Hooks (`~/.codebuddy*/settings.json`) | 状态提醒与打开 CodeBuddy |
| **GitHub Copilot** | Hooks (`~/.copilot/hooks/agent-pet.json`) | Copilot CLI 状态提醒 |
| **Gemini CLI** | Hooks (`~/.gemini/settings.json`) | Gemini CLI 状态提醒 |
| **Windsurf** | Cascade Hooks (`~/.codeium/windsurf/hooks.json`) | 状态提醒与打开 Windsurf |
| **Qwen Code** | Hooks (`~/.qwen/settings.json`) | Qwen Code 状态提醒 |
| **Factory Droid** | Hooks (`~/.factory/settings.json`) | Factory Droid 状态提醒 |
| **Cline** | Hooks (`~/Documents/Cline/Rules/Hooks`) | Cline 状态提醒 |

> 所有连接器均为**只读生命周期观察**，不保存提示词、工具参数或模型输出正文。

### 3. QQ / 企业微信 Bot 派活网关
打开托盘菜单 **`Bot 派活与通知...`**（或管理窗口切换到 **`Bot 派活网关 (QQ / 企微)`** Tab），即可配置并启用远程交互：
- **远程派活与多轮追问**：直接把任务发给本机 `Claude Code`、`Codex`、`DSH`（或 `Antigravity` CLI/SDK），按会话保留上下文。
- **截图与图片调试**：在 QQ / 企业微信中直接发送报错截图或界面图片（可附带文字说明），网关会自动下载并传递给 `Claude Code` / `Codex` 进行视觉排错与界面修改。
- **远程 Git 变更检查与提交**：支持通过 `/diff`、`/log`、`/commit`、`/revert` 在手机端直接审查代码改动、提交或回滚。
- **状态自动推送**：当本机任一已接入 Agent 进入 **待确认 (`waiting`)**、**异常 (`blocked`)** 或 **本轮结束 (`ready`)** 时，主动推送提醒到 QQ / 企微。
- **安全配对与工作区边界**：随机生成一次性 **配对码**（私聊/群聊发送 `/pair 配对码` 后才可操作），支持用户/群白名单与工作区根目录沙盒校验。
- **纯后台无桌面模式**：支持 `npm run bot` 在不启动 Electron 桌宠的情况下独立运行 Bot 网关与状态哨兵。

#### 通道接入说明
1. **QQ（OneBot v11 WebSocket）**：兼容 NapCat / Lagrange / go-cqhttp。
   - **正向 WebSocket**：填写 OneBot WS 地址（如 `ws://127.0.0.1:3001`）与可选 `Access Token`。
   - **反向 WebSocket**：切换为反向监听模式，填写监听端口/路径（默认 `127.0.0.1:8080/onebot/v11/ws`），由 QQ 客户端主动连入。
   - **默认推送目标**：填写如 `private:123456, group:654321`。
2. **企业微信（WeCom 智能机器人长连接）**：
   - 默认连接官方长连接地址 `wss://openws.work.weixin.qq.com`，填入智能机器人 `BotID` 与 `Secret` 即可实时收发消息并流式更新回复；
   - 可选配置群机器人 `Webhook URL` 与默认推送目标（`userid` / `chatid`）。

#### 常用 Bot 指令
- `/pair <配对码>`：完成当前用户/会话安全配对授权
- `/help`：查看指令清单
- `/status`：查看所有已接入 AI Agent 的实时状态与当前 Bot 任务
- `/engines`：查看 `claude` / `codex` / `antigravity` / `dsh` 引擎可用状态
- `/claude <任务>` 或 `@claude <任务>`：使用 Claude Code 执行任务
- `/codex <任务>` 或 `@codex <任务>`：使用 Codex 执行任务
- `/dsh <内容>` 或 `@dsh <内容>`：向 DSH 发送任务/消息
- `/agy <任务>` 或 `@agy <任务>`：使用 Antigravity CLI/SDK 执行任务
- `/cd <目录>` / `/use <引擎>`：切换当前会话工作目录或默认执行引擎
- `/new`：开启新会话（清除当前上下文会话 ID）
- `/jobs` / `/stop [jobId]`：查看最近派活任务或停止运行中任务
- `/diff [文件或参数]`：查看当前工作区 Git diff（含未暂存/已暂存变更）
- `/log [条数]`：查看当前工作区最近 Git 提交记录
- `/commit <提交说明>`：暂存并提交当前工作区变更
- `/revert <目标>`：回滚指定文件或提交的改动
- `/pet <show|hide|reset>` / `/open <agentId>`：控制桌面小鑫显示/隐藏/归位或打开对应 AI 工具
- **发送图片 / 截图**：在 QQ 或企业微信直接发送截图并附带提问，将自动传给当前引擎调试

### 4. macOS 开机自动启动（LaunchAgent）
- 支持通过托盘右键菜单 **`开机自动启动`** 或控制中心 **`默认派活配置 -> 开机自动启动`** 一键开关。
- 启用后会在 `~/Library/LaunchAgents/local.chenmingxin.agent-pet.plist` 写入标准 macOS LaunchAgent（`Label: local.chenmingxin.agent-pet`，`RunAtLoad: true`），优先拉起 `~/Applications/Agent Pet.app`，未打包时自动回退至 `node scripts/start.cjs`，登录 macOS 即自动唤醒小鑫与 Bot 网关。

## 安装与运行

要求：macOS、Node.js 22+、Python 3，以及 Electron 运行时（启动器会自动按 `AGENT_PET_ELECTRON` → 项目 `node_modules` → `/Applications/Electron.app` → `PATH` → `~/.dsh/electron` 顺序查找；纯后台 `npm run bot` 无需 Electron）。

```sh
npm run build:notch
npm run check
npm test
npm run install:local
npm start
```

- **纯后台启动 Bot 网关**：`npm run bot`
- **安装时一键接入本机已安装的全部 AI Agent**：`python3 scripts/install.py --all`（或 `--enable claude,codex,cursor`）
- **独立运行桌面 app**：打开 `~/Applications/Agent Pet.app` 或执行 `npm start`

## 目录结构

- `assets/webm/`：内置小鑫 5 套状态 WebM 动画，无需外部 DSH 资源目录即可独立播放。
- `connectors/`：22 个 AI Agent 的单一数据源目录（`catalog.cjs`）、备份/幂等注册器（`registry.cjs`）及非阻塞 Hook / Plugin 观察器。
- `bot/`：零外部依赖的 QQ (OneBot v11) / 企业微信长连接通道（`channels/`）、多引擎调度器（`dispatcher.cjs`）、桌面本地直连桥接（`local-chat.cjs`）、指令路由（`commands.cjs`）、状态哨兵服务（`service.cjs`）与无头入口（`server.cjs`）。
- `runtime/`：Electron 桌宠主进程（`main.cjs`）、开机自启管理器（`autostart.cjs`）、AppKit 原生刘海面板（`NotchPanel.swift` / `notch.cjs`）、管理与 Bot 控制中心窗口（`manager.*`）、状态聚合器（`providers.cjs`）与本地语音服务（`local-speech.cjs`）。
- `scripts/`：独立安装器（`install.py`）与跨方式 Electron 启动器（`start.cjs`）。
- `src/`：可选 DSH 宿主插件与本地鉴权桥接。

## 隐私与安全边界

- 所有 Hook、Plugin 与只读会话读取器只提取生命周期元数据，**绝不保存用户提示词、工具参数或模型回复正文**。
- Bot 网关配置（`~/.dsh/companion/bot.json`）、连接器状态与运行态文件均以 `0600`/`0700` 权限保存在本地，工作区路径经 `realpath` 校验防止目录逃逸。
- 写入或卸载第三方工具配置时自动生成时间戳备份至 `~/.dsh/companion/backups/`，并保留用户原有的其他 Hooks 与插件配置。
