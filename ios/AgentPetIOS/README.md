# 小鑫 · Agent Pet iOS Companion (`AgentPetIOS`)

原生 **Swift / SwiftUI** 编写的 iPhone 配套应用，通过局域网或 Tailscale 连接 Mac 上运行的 **Agent Pet `MobileBridgeServer`**（默认端口 `18472`），随时查看小鑫实时动态并向 Mac 本地的 `Claude Code`、`Codex`、`OpenCode`、`DSH` 等 AI Agent 派活。

## 目录结构

```text
ios/AgentPetIOS/
├── Package.swift
├── README.md
└── Sources/AgentPetIOS/
    ├── AgentPetIOSApp.swift          # @main SwiftUI 应用入口
    ├── Models.swift                  # API 模型、Agent 品牌元数据、状态样式
    ├── AgentPetClient.swift          # AgentPetStore（HTTP + WebSocket + 3s 轮询兜底）
    └── Views/
        ├── ContentView.swift         # 4 Tab 主框架与全局 Toast
        ├── PetDashboardView.swift    # Tab 1：小鑫动态（灵动岛状态头 + 叠放/展开活动卡片）
        ├── DirectChatView.swift      # Tab 2：对话派活（Agent / 项目目录 / 会话三合一上下文栏）
        ├── AgentsGridView.swift      # Tab 3：AI Agents 全览与 Mac 一键唤起
        ├── ConnectionSettingsView.swift # Tab 4：Mac IP、6 位配对码验证与连接诊断
        └── SharedComponents.swift    # 共享徽章与跨平台背景色辅助
```

## 对接接口 (`bot/mobile-bridge.cjs`)

- `GET /api/mobile/ping`：连通性探测
- `POST /api/mobile/pair`：6 位配对码换取 Bearer Token
- `GET /api/mobile/state`：拉取工作区、会话、活动卡片、已接入 Agents 与运行中任务
- `POST /api/mobile/workspace`：切换当前 Mac 项目目录
- `POST /api/mobile/session`：切换或新建（`sessionId: "new"`）项目会话
- `GET /api/mobile/conversation?sessionId=...`：拉取完整会话消息记录
- `POST /api/mobile/chat`：向指定 `targetAgent` + `cwd` + `sessionId` 发送指令
- `POST /api/mobile/command`：远程执行 `/diff`、`/log`、`/status`、`/stop`、`/pet show|hide|reset`、`/open <agentId>`
- `WS /api/mobile/ws?token=<token>`：实时状态推送（断线自动重连，辅以 3 秒轮询兜底）

## 在 Xcode 中运行到 iPhone / 模拟器

1. 使用 Xcode 15+ 打开 `ios/AgentPetIOS/Package.swift`（或新建一个 iOS App 工程并将 `Sources/AgentPetIOS` 作为依赖 / 源码加入）。
2. 由于局域网 `MobileBridgeServer` 默认使用明文 `http://` 与 `ws://`，如通过 Xcode iOS App Target 运行到真机，请在 Target 的 `Info.plist` 中添加：
   - `NSAppTransportSecurity` -> `NSAllowsLocalNetworking = YES`（或 `NSAllowsArbitraryLoads = YES`）
   - `NSLocalNetworkUsageDescription`：说明用于连接同一局域网内 Mac 上的小鑫桌面端。
3. 在「连接设置」页输入 Mac 局域网 IP（如 `192.168.1.88:18472`）及 `~/.dsh/companion/bot-config.json` 中的 6 位 `pairingCode` 即可配对。

## 本地编译验证

```bash
cd ios/AgentPetIOS
swift build
```
