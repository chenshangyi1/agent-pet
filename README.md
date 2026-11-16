# 小鑫 · Agent Pet

复用蓝发小女仆桌宠「小鑫」，独立运行于 macOS 桌面与刘海区域。

**开箱即用默认只接入 DSH**：新安装或从 GitHub 克隆运行时，不会主动修改你电脑里其他 AI Agent 的配置文件；需要监听本机其他 AI Agent 时，可在刘海面板右上角点击 `+`（或菜单栏右键「管理 AI Agent...」）打开管理小窗，小窗会自动检测本机已安装的 AI Agent，点击 `+ 接入` 即自动备份原配置并写入只读生命周期观察配置，点击 `− 移除` 可随时干净卸载。

## 支持检测与接入的 AI Agent

| Agent | 接入机制 | 说明 |
| --- | --- | --- |
| **DSH**（默认内置） | 本地桥接 (`dsh-bridge.json`) | 支持快速聊天、新建/回复会话、停止任务与语音输入 |
| **Claude Code** | Hooks (`~/.claude/settings.json`) | 状态提醒与打开 Claude |
| **Codex** | Hooks (`~/.codex/hooks.json`) + 只读会话索引 (`~/.codex/sessions`) | 兼容 CLI 与 ChatGPT/Codex Desktop，状态提醒与打开 |
| **Cursor** | Hooks (`~/.cursor/hooks.json`) | 状态提醒与打开 Cursor |
| **OpenCode** | Plugin (`~/.config/opencode/plugins/agent-pet.js`) | 状态提醒与打开 OpenCode |
| **Antigravity** | Plugin (`~/.gemini/config/plugins/agent-pet`) | 状态提醒与打开 Antigravity |
| **WorkBuddy** | Hooks (`~/.workbuddy/settings.json`) | 状态提醒与打开 WorkBuddy |
| **WorkBuddy AI** | Hooks (`~/.workbuddy-ai/settings.json`) | 状态提醒与打开 WorkBuddy AI |
| **Kiro** | Hooks (`~/.kiro/hooks/agent-pet.json`) | 状态提醒与打开 Kiro |
| **Trae / Trae CN** | Hooks (`~/.trae/hooks.json`, `~/.trae-cn/hooks.json`) | 状态提醒与打开 Trae |
| **Qoder CN** | Hooks (`~/.qoder-cn/settings.json`) | 状态提醒与打开 Qoder CN |

> 所有新增接入均为**只读生命周期观察**，不在桌面悬浮气泡中伪造聊天回复或审批接口；交互操作在各自应用内完成。

## 使用

打开 `~/Applications/Agent Pet.app`，或在本项目执行 `npm start`。

- **刘海面板**：鼠标移入或点击 Mac 摄像头刘海区域即可展开；可一键「放出 / 收起」小鑫，切换「自动跟随 / 指定工具」，或点击右上角 **`+`** 打开 AI Agent 管理窗口。
- **管理窗口**：自动区分「已启用」「本机已检测到（可 `+ 接入`）」「其他支持的工具」。每次写入或移除外部配置前都会自动备份到 `~/.dsh/companion/backups/`。
- **宠物右键菜单**：可选择跟随工具、管理 AI Agent、调整缩放、仅控制条模式、重置位置、隐藏小鑫。
- **DSH 独立存活**：DSH 未启动或退出时小鑫仍可正常运行其他已接入的工具，DSH 启动后自动重连。

## 本机构建与安装

要求：macOS、Node.js 22+、Python 3，以及本地 DSH / `dsh-pet` 素材或 Electron 运行时。

```sh
npm run build:notch
npm run check
npm test
npm run install:local
npm start
```

- `npm run install:local` 默认只安装 `Agent Pet.app` 和 DSH 桥接，`connectors.json` 初始化为 `["dsh"]`。
- 若希望 CLI 安装时直接接入本机检测到的全部 AI Agent，可执行 `python3 scripts/install.py --all`（或 `--enable claude,cursor`）。

## 目录结构

- `connectors/catalog.cjs`：所有支持接入的 AI Agent 注册目录与检测元信息（单一数据源）。
- `connectors/registry.cjs`：检测本机已安装工具，提供幂等、`0600` 原子写入、自动备份与卸载清理能力。
- `connectors/hooks/emit.py`：统一非阻塞 Hook 观察器（始终输出 `{}`、退出码 `0`），仅写入规范化生命周期字段（事件类型、会话 ID、工具名称/ID、工作区目录名、时间戳）。
- `connectors/opencode/agent-pet.js`：OpenCode 无依赖本地事件插件。
- `runtime/main.cjs`：Electron 桌宠主进程、托盘菜单、全局快捷键、管理小窗与安全 IPC。
- `runtime/NotchPanel.swift`：AppKit 原生刘海面板，根据已启用的接入源动态计算列表高度（超出 7 行自动滚动）并带 `+` 管理入口。
- `runtime/manager.{html,css,js}` / `runtime/manager-preload.cjs`：本机 AI Agent 检测与一键接入管理窗口。
- `runtime/providers.cjs` / `runtime/hook-state.cjs` / `runtime/codex-sessions.cjs`：状态归约、跨来源排序与 Codex 增量会话读取。
- `src/`：DSH 宿主插件与本地鉴权静态/RPC 接口。

## 隐私与安全边界

- 所有 Hook、Plugin 与只读会话读取器只提取生命周期元数据，**绝不保存用户提示词、工具参数或模型回复正文**。
- DSH 本地接口仅绑定 `127.0.0.1` 并使用随机凭据验证；所有运行态与状态文件权限为 `0600`/`0700`。
- 写入或卸载第三方工具配置时自动生成时间戳备份，并保留用户原有的其他 Hooks 与插件配置。
