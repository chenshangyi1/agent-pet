# Agent Pet

复用现有蓝发小女仆桌宠，独立运行于 macOS，连接 DSH、WorkBuddy、Antigravity 和 Codex。鼠标移入或点击 Mac 摄像头所在的原生刘海区域可展开面板，选择跟随工具以及收起、放出宠物。也可通过菜单栏图标打开。

当前是**一只共享宠物**：可以固定跟随 DSH、WorkBuddy、Antigravity、Codex，或自动优先显示等待处理、受阻、工作中的任务。切换来源复用同一形象和桌面位置。没有控制 Codex 官方宠物窗口，也没有额外启动模型。

## 使用

打开 `~/Applications/Agent Pet.app`，或在本项目执行 `npm start`。

- 刘海面板的「放出」：显示宠物并跟随该工具；「收起」：隐藏宠物，后台仍接收状态。
- 「自动跟随」：合并两种工具的活动，优先显示需要处理的任务。
- 右键宠物可选择来源、大小、仅控制条模式、重置位置、收回刘海。
- DSH 仍支持原有快速聊天、会话回复、停止、通知及已配置的语音识别。
- WorkBuddy、Antigravity 与 Codex 提供状态提醒与打开应用。回复、停止、审批在各自应用内处理；不会显示无效按钮。
- DSH 退出时宠物继续运行；DSH 重新启动后自动重连。

WorkBuddy 的 `Stop` 只说明本轮结束，不能证明任务成功，因此显示「本轮结束」；Antigravity 的 `Stop` 会按 `terminationReason` 区分「本轮结束」「已取消」和「遇到问题」。30 分钟没有新事件的工作/等待状态显示「状态待更新」，不会推测任务成功。未收到任何事件时显示「等待首个任务」。

## 本机安装

要求：macOS、Node.js 22+、Python 3，以及已有 DSH Electron 和 dsh-pet 素材。本项目是针对当前本机安装的版本，不是自带 Electron/角色素材的独立分发包。

```sh
npm run build:notch
npm run check
npm test
npm run install:local
npm start
```

安装器备份原配置到 `~/.dsh/companion/backups/agent-pet-时间/`，合并 WorkBuddy Hooks、安装 Antigravity 插件到 `~/.gemini/config/plugins/agent-pet/`、合并 Codex Hooks 到 `~/.codex/hooks.json`，并配置 DSH 插件链接，保留其他插件/设置。WorkBuddy 已开启的会话可能需要重启应用后创建新任务，才能加载新 Hooks；Antigravity 与 Codex Hooks 在新回合或新会话生效。

## 结构

- `runtime/main.cjs`：独立桌面窗口、宠物位置、来源选择、托盘。
- `runtime/NotchPanel.swift`：AppKit 原生刘海窗口，使用真实屏幕刘海区域触发展开；收起时不绘制额外黑条。
- `runtime/notch.cjs`：桌宠与原生面板的进程通信及生命周期。
- `scripts/screen-info.swift`：读取真实刘海宽度和安全高度的诊断工具；原生面板自行读取屏幕几何，没有刘海的显示器使用菜单栏入口。
- `runtime/providers.cjs`：汇总 DSH、WorkBuddy、Antigravity 与 Codex 会话，处理断线和重新连接。
- `src/`：DSH 连接插件，保留原会话 API。
- `connectors/{workbuddy,antigravity,codex}/emit.py`：观察 Hooks，只保存事件类型、会话编号、工具名称/编号、工作区目录名和时间，不保存提示词、工具参数或输出（Antigravity 与 Codex Hook 始终输出 `{}` 且退出码为 `0`）。
- `runtime/hook-state.cjs` / `runtime/workbuddy-state.cjs`：将 Hook 事件转换为状态，按会话隔离，兼容迟到的 SessionStart 和并发工具。

新增工具时增加对应接入器，转换成统一会话字段：`sessionId`（带来源前缀）、`provider`、`status`、`detail`、`updatedAt`、`capabilities`。只在接入器明确支持时启用回复/停止等操作。不要把能播放素材当作已经完成工具接入。

DSH 和桌宠之间的本机接口仅监听 `127.0.0.1`，使用随机凭据验证；发现文件权限为 0600，凭据不进入网页。WorkBuddy 使用每事件独立文件，避免并发写入冲突；事件消费后删除，状态最多保留 24 小时（下次读取时清理）。宠物退出不会阻断 WorkBuddy 任务。

## 验证与边界

见 [验证记录](docs/verification.md)。旧版功能说明保留在 [原 DSH 桌宠说明](docs/legacy-dsh-companion.md)。

本次未接入 WorkBuddy / Antigravity / Codex 的任意聊天、停止或审批接口；未控制 Codex 官方宠物；未设置开机自启。多外接屏、全屏空间切换与真实触控板手势需要进一步验收；本机真实鼠标移入、移出物理刘海已验证。本版“上滑到刘海”指鼠标指针移入摄像头刘海区域，不监听全局触控板手势。
