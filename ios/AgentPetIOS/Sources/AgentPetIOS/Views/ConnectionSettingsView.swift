import SwiftUI

struct ConnectionSettingsView: View {
    @EnvironmentObject private var store: AgentPetStore
    @State private var pairingCodeInput: String = ""

    var body: some View {
        NavigationStack {
            Form {
                statusSection
                serverAddressSection
                pairingSection
                guideSection
            }
            .navigationTitle("连接设置")
            .onAppear {
                if pairingCodeInput.isEmpty && !store.authToken.isEmpty {
                    pairingCodeInput = store.authToken
                }
            }
        }
    }

    // MARK: - Connection Status

    private var statusSection: some View {
        Section("连接状态") {
            HStack(spacing: 12) {
                Circle()
                    .fill(statusColor)
                    .frame(width: 10, height: 10)

                VStack(alignment: .leading, spacing: 2) {
                    Text(store.connectionStatus.label)
                        .font(.subheadline.weight(.semibold))

                    if !store.normalizedBaseURLString().isEmpty {
                        Text(store.normalizedBaseURLString())
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }

                Spacer()

                if store.isPaired {
                    Text(store.isWebSocketConnected ? "WS 实时" : "HTTP 轮询")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(store.isWebSocketConnected ? .green : .orange)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(
                            Capsule()
                                .fill((store.isWebSocketConnected ? Color.green : Color.orange).opacity(0.14))
                        )
                }
            }

            if store.isPaired {
                LabeledContent("当前项目目录") {
                    Text(store.effectiveCwd.isEmpty ? "未设置" : store.effectiveCwd)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                LabeledContent("当前对话 Agent") {
                    Text(store.selectedAgentMeta.label)
                        .font(.caption.weight(.medium))
                }

                Button(role: .destructive) {
                    store.disconnect()
                } label: {
                    Label("断开当前配对", systemImage: "link.badge.plus")
                }
            }

            if let err = store.lastError, !err.isEmpty {
                Label(err, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
    }

    private var statusColor: Color {
        switch store.connectionStatus {
        case .connected: return .green
        case .connecting: return .orange
        case .disconnected: return .gray
        case .error: return .red
        }
    }

    // MARK: - Server Address

    private var serverAddressSection: some View {
        Section("Mac 服务地址") {
            TextField("例如：192.168.1.88:18472", text: $store.serverHost)
                #if os(iOS)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                #endif
                .autocorrectionDisabled()

            HStack {
                Button {
                    Task { await store.pingServer() }
                } label: {
                    Label("测试连通性 (Ping)", systemImage: "antenna.radiowaves.left.and.right")
                }
                .disabled(store.normalizedBaseURLString().isEmpty)

                Spacer()

                if !store.serverVersion.isEmpty {
                    Text("v\(store.serverVersion)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    // MARK: - Pairing

    private var pairingSection: some View {
        Section("配对码验证 (/api/mobile/pair)") {
            HStack {
                TextField("6 位配对码（如 ABC123）", text: $pairingCodeInput)
                    #if os(iOS)
                    .textInputAutocapitalization(.characters)
                    #endif
                    .autocorrectionDisabled()
                    .font(.system(.body, design: .monospaced))

                Button {
                    Task {
                        let ok = await store.pair(code: pairingCodeInput)
                        if ok {
                            store.selectedTab = .dashboard
                        }
                    }
                } label: {
                    if store.isPairing {
                        ProgressView()
                    } else {
                        Text("配对连接")
                            .fontWeight(.semibold)
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(
                    store.isPairing
                    || store.normalizedBaseURLString().isEmpty
                    || pairingCodeInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                )
            }
        }
    }

    // MARK: - Setup Guide

    private var guideSection: some View {
        Section("使用说明") {
            VStack(alignment: .leading, spacing: 8) {
                guideRow(step: "1", text: "确保 Mac 上已运行 小鑫 · Agent Pet，其 MobileBridgeServer 默认监听 18472 端口。")
                guideRow(step: "2", text: "iPhone 与 Mac 连接同一局域网（或 Tailscale 虚拟局域网），填写 Mac IP:18472（如 192.168.1.25:18472）。")
                guideRow(step: "3", text: "在 Mac 的 ~/.dsh/companion/bot-config.json 或机器人设置中查看 6 位配对码（pairingCode），输入后点击「配对连接」。")
                guideRow(step: "4", text: "若使用 Xcode 真机运行，请在 Target Info.plist 中允许局域网 HTTP（NSAllowsArbitraryLoads / NSAllowsLocalNetworking = YES）。")
            }
            .padding(.vertical, 4)
        }
    }

    private func guideRow(step: String, text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(step)
                .font(.caption2.weight(.bold))
                .foregroundStyle(.white)
                .frame(width: 18, height: 18)
                .background(Circle().fill(Color.accentColor))
            Text(text)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}
