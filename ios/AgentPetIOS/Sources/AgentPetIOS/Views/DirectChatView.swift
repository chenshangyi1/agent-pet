import SwiftUI

struct DirectChatView: View {
    @EnvironmentObject private var store: AgentPetStore
    @State private var draftText: String = ""
    @State private var showCustomPathSheet: Bool = false
    @State private var customPathInput: String = ""
    @State private var showAgentSheet: Bool = false
    @FocusState private var isComposerFocused: Bool

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                contextPickersBar
                Divider()
                quickEngineeringChipsBar

                if let cmdOutput = store.lastCommandOutput, !cmdOutput.isEmpty {
                    commandOutputCard(cmdOutput)
                }

                messageListArea

                Divider()
                bottomComposerBar
            }
            .background(PlatformColors.groupedBackground)
            .navigationTitle("对话派活")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .sheet(isPresented: $showCustomPathSheet) {
                customWorkspaceSheet
            }
            .sheet(isPresented: $showAgentSheet) {
                agentPickerSheet
            }
        }
    }

    // MARK: - Top 3 Context Pickers

    private var contextPickersBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                // 1) Compact Agent Icon Picker
                Menu {
                    Section("切换目标 AI Agent") {
                        ForEach(store.availableChatAgents, id: \.id) { agent in
                            Button {
                                Task { await store.selectAgent(agent.id) }
                            } label: {
                                Label(
                                    agent.id == store.selectedAgent ? "\(agent.label) ✓" : agent.label,
                                    systemImage: agent.symbolName
                                )
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 5) {
                        AgentAvatarBadge(agentId: store.selectedAgent, size: 22, cornerRadius: 6)
                        Image(systemName: "chevron.down")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 6)
                    .background(
                        Capsule(style: .continuous)
                            .fill(PlatformColors.cardBackground)
                    )
                    .overlay(
                        Capsule(style: .continuous)
                            .stroke(Color.primary.opacity(0.08), lineWidth: 1)
                    )
                }
                .accessibilityLabel("目标 AI Agent：\(store.selectedAgentMeta.label)")

                // 2) 项目目录 Picker (📁 pet ▾) + custom path sheet
                Menu {
                    if !store.workspaces.isEmpty {
                        Section("Mac 项目目录") {
                            ForEach(store.workspaces) { ws in
                                Button {
                                    Task { await store.selectWorkspace(ws.path) }
                                } label: {
                                    if ws.path == store.effectiveCwd {
                                        Label("\(ws.name) ✓", systemImage: "folder.fill")
                                    } else {
                                        Label(ws.name, systemImage: "folder")
                                    }
                                }
                            }
                        }
                    }

                    Divider()

                    Button {
                        customPathInput = store.effectiveCwd
                        showCustomPathSheet = true
                    } label: {
                        Label("输入自定义路径…", systemImage: "pencil.and.outline")
                    }
                } label: {
                    HStack(spacing: 5) {
                        Text("📁")
                            .font(.caption)
                        Text(store.effectiveCwdName)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                        Image(systemName: "chevron.down")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .background(
                        Capsule(style: .continuous)
                            .fill(PlatformColors.cardBackground)
                    )
                    .overlay(
                        Capsule(style: .continuous)
                            .stroke(Color.primary.opacity(0.08), lineWidth: 1)
                    )
                }

                // 3) 项目会话 Picker (💬 新建会话 / 历史会话 ▾)
                Menu {
                    Button {
                        Task { await store.selectSession(nil) }
                    } label: {
                        Label(
                            store.selectedSessionId.isEmpty ? "＋ 新建会话 ✓" : "＋ 新建会话",
                            systemImage: "plus.bubble"
                        )
                    }

                    if !store.filteredSessionsForPicker.isEmpty {
                        Section("最近项目会话") {
                            ForEach(store.filteredSessionsForPicker) { session in
                                Button {
                                    Task { await store.selectSession(session) }
                                } label: {
                                    let prefix = session.sessionId == store.selectedSessionId ? "✓ " : ""
                                    let prov = AgentVisualMeta.meta(for: session.provider ?? "claude").shortTag
                                    Text("\(prefix)[\(prov)] \(session.displayTitle)")
                                }
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 5) {
                        Text("💬")
                            .font(.caption)
                        Text(currentSessionLabel)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                            .frame(maxWidth: 150, alignment: .leading)
                        Image(systemName: "chevron.down")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .background(
                        Capsule(style: .continuous)
                            .fill(PlatformColors.cardBackground)
                    )
                    .overlay(
                        Capsule(style: .continuous)
                            .stroke(Color.primary.opacity(0.08), lineWidth: 1)
                    )
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
        }
        .background(PlatformColors.groupedBackground)
    }

    private var currentSessionLabel: String {
        if store.selectedSessionId.isEmpty {
            return "新建会话"
        }
        if !store.activeSessionTitle.isEmpty {
            return store.activeSessionTitle
        }
        if let match = store.sessions.first(where: { $0.sessionId == store.selectedSessionId }) {
            return match.displayTitle
        }
        return String(store.selectedSessionId.prefix(14))
    }

    // MARK: - Quick Engineering Action Chips

    private var quickEngineeringChipsBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                quickChipButton(title: "/diff 查看改动", icon: "doc.text.magnifyingglass") {
                    await store.sendCommand("/diff")
                }
                quickChipButton(title: "/log 提交记录", icon: "clock.arrow.circlepath") {
                    await store.sendCommand("/log")
                }
                quickChipButton(title: "/status 状态", icon: "waveform.path.ecg") {
                    await store.sendCommand("/status")
                }
                quickChipButton(title: "/stop 停止", icon: "stop.circle", tint: .red) {
                    await store.sendCommand("/stop")
                }
                quickChipButton(title: "＋ 新建会话", icon: "plus.bubble", tint: .accentColor) {
                    await store.selectSession(nil)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
        }
    }

    private func quickChipButton(
        title: String,
        icon: String,
        tint: Color = .primary,
        action: @escaping @Sendable () async -> Void
    ) -> some View {
        Button {
            Task { await action() }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.caption2.weight(.semibold))
                Text(title)
                    .font(.caption.weight(.medium))
            }
            .foregroundStyle(tint)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
                Capsule(style: .continuous)
                    .fill(PlatformColors.cardBackground)
            )
            .overlay(
                Capsule(style: .continuous)
                    .stroke(tint.opacity(0.18), lineWidth: 0.8)
            )
        }
        .buttonStyle(.plain)
        .disabled(!store.isPaired)
    }

    private func commandOutputCard(_ output: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label("命令输出", systemImage: "terminal")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    store.lastCommandOutput = nil
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }

            ScrollView {
                Text(output)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.primary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 150)
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(PlatformColors.cardBackground)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color.primary.opacity(0.08), lineWidth: 1)
        )
        .padding(.horizontal, 14)
        .padding(.bottom, 6)
    }

    // MARK: - Message List

    private var messageListArea: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 12) {
                    if store.messages.isEmpty && !store.isLoadingConversation {
                        chatEmptyState
                    } else {
                        ForEach(store.messages) { msg in
                            messageBubble(msg)
                                .id(msg.id)
                        }
                    }

                    if store.isSending || store.activeSessionStatus == "running" {
                        liveExecutionIndicator
                            .id("live-indicator")
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 14)
            }
            .onChange(of: store.messages.count) { _, _ in
                if let lastId = store.messages.last?.id {
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo(lastId, anchor: .bottom)
                    }
                }
            }
            .onChange(of: store.isSending) { _, sending in
                if sending {
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo("live-indicator", anchor: .bottom)
                    }
                }
            }
        }
    }

    private var chatEmptyState: some View {
        VStack(spacing: 14) {
            AgentAvatarBadge(agentId: store.selectedAgent, size: 52, cornerRadius: 16)

            Text("向 \(store.selectedAgentMeta.label) 派活")
                .font(.headline)

            Text("当前目录：\(store.effectiveCwd.isEmpty ? "默认工作区" : store.effectiveCwd)")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 20)

            HStack(spacing: 8) {
                suggestionPill("总结当前项目最近改动")
                suggestionPill("检查并运行测试")
            }
        }
        .padding(.vertical, 48)
        .frame(maxWidth: .infinity)
    }

    private func suggestionPill(_ text: String) -> some View {
        Button {
            draftText = text
            isComposerFocused = true
        } label: {
            Text(text)
                .font(.caption.weight(.medium))
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(
                    Capsule(style: .continuous)
                        .fill(PlatformColors.cardBackground)
                )
        }
        .buttonStyle(.plain)
    }

    private func messageBubble(_ msg: ChatMessageItem) -> some View {
        HStack(alignment: .bottom, spacing: 8) {
            if msg.isUser {
                Spacer(minLength: 44)
                VStack(alignment: .trailing, spacing: 4) {
                    Text(msg.text)
                        .font(.subheadline)
                        .foregroundStyle(.white)
                        .textSelection(.enabled)
                        .padding(.horizontal, 13)
                        .padding(.vertical, 10)
                        .background(
                            RoundedRectangle(cornerRadius: 16, style: .continuous)
                                .fill(Color.accentColor)
                        )

                    if let ts = msg.createdAt {
                        Text(DateFormatters.relativeString(fromEpochMs: ts))
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            } else {
                AgentAvatarBadge(agentId: store.selectedAgent, size: 26, cornerRadius: 8)
                VStack(alignment: .leading, spacing: 4) {
                    Text(msg.text)
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                        .textSelection(.enabled)
                        .padding(.horizontal, 13)
                        .padding(.vertical, 10)
                        .background(
                            RoundedRectangle(cornerRadius: 16, style: .continuous)
                                .fill(PlatformColors.cardBackground)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 16, style: .continuous)
                                .stroke(Color.primary.opacity(0.06), lineWidth: 1)
                        )

                    if let status = msg.toolStatus, !status.isEmpty {
                        Text(status)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 36)
            }
        }
    }

    private var liveExecutionIndicator: some View {
        HStack(spacing: 10) {
            ProgressView()
                .controlSize(.small)
            Text("\(store.selectedAgentMeta.label) 正在处理任务…")
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(PlatformColors.cardBackground)
        )
    }

    // MARK: - Bottom Composer

    private var bottomComposerBar: some View {
        HStack(alignment: .bottom, spacing: 10) {
            // Compact Agent icon button in composer
            Button {
                showAgentSheet = true
            } label: {
                AgentAvatarBadge(agentId: store.selectedAgent, size: 34, cornerRadius: 17)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("切换 AI Agent")

            TextField(
                "在 \(store.effectiveCwdName) 向 \(store.selectedAgentMeta.label) 派活…",
                text: $draftText,
                axis: .vertical
            )
            .lineLimit(1...5)
            .textFieldStyle(.plain)
            .focused($isComposerFocused)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(PlatformColors.cardBackground)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(Color.primary.opacity(0.08), lineWidth: 1)
            )
            .onSubmit {
                submitDraft()
            }

            Button {
                submitDraft()
            } label: {
                Image(systemName: store.isSending ? "hourglass.circle.fill" : "arrow.up.circle.fill")
                    .font(.system(size: 32))
                    .foregroundStyle(canSend ? Color.accentColor : Color.secondary.opacity(0.4))
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(PlatformColors.groupedBackground)
    }

    private var canSend: Bool {
        store.isPaired && !store.isSending && !draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func submitDraft() {
        let text = draftText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, store.isPaired, !store.isSending else { return }
        draftText = ""
        isComposerFocused = false
        Task { await store.sendChat(text: text) }
    }

    // MARK: - Sheets

    private var customWorkspaceSheet: some View {
        NavigationStack {
            Form {
                Section("输入 Mac 上的项目绝对路径") {
                    TextField("/Users/name/AI/Codex/pet", text: $customPathInput)
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                        .autocorrectionDisabled()
                }
                if !store.workspaces.isEmpty {
                    Section("常用工作区") {
                        ForEach(store.workspaces) { ws in
                            Button {
                                customPathInput = ws.path
                            } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(ws.name).font(.subheadline.weight(.medium))
                                    Text(ws.path).font(.caption2).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("切换项目目录")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { showCustomPathSheet = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("确定") {
                        let path = customPathInput.trimmingCharacters(in: .whitespacesAndNewlines)
                        showCustomPathSheet = false
                        if !path.isEmpty {
                            Task { await store.selectWorkspace(path) }
                        }
                    }
                }
            }
        }
    }

    private var agentPickerSheet: some View {
        NavigationStack {
            List {
                Section("选择对话派活的目标 AI Agent") {
                    ForEach(store.availableChatAgents, id: \.id) { agent in
                        Button {
                            showAgentSheet = false
                            Task { await store.selectAgent(agent.id) }
                        } label: {
                            HStack(spacing: 12) {
                                AgentAvatarBadge(agentId: agent.id, size: 34, cornerRadius: 10)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(agent.label)
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(.primary)
                                    Text(agent.supportsDirectCLI ? "CLI 直连执行" : "Mac 唤起应用")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if agent.id == store.selectedAgent {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundStyle(Color.accentColor)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("选择 AI Agent")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { showAgentSheet = false }
                }
            }
        }
    }
}
