import SwiftUI

struct AgentsGridView: View {
    @EnvironmentObject private var store: AgentPetStore

    private var mergedAgents: [AgentSourceItem] {
        var seen = Set<String>()
        var list: [AgentSourceItem] = []

        for src in store.sources {
            let key = src.id.lowercased()
            if seen.insert(key).inserted {
                list.append(src)
            }
        }

        for (rawId, engine) in store.engines.sorted(by: { $0.key < $1.key }) where engine.available {
            let key = rawId.lowercased()
            if seen.insert(key).inserted {
                list.append(AgentSourceItem(
                    id: key,
                    label: engine.label ?? AgentVisualMeta.meta(for: key).label,
                    connected: true,
                    status: "idle",
                    detail: "CLI 已就绪，可直连派活",
                    sessionCount: 0,
                    activityCount: 0,
                    sessionTitle: nil
                ))
            }
        }

        return list
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 12) {
                    if !store.isPaired {
                        ContentUnavailableView(
                            "未连接 Mac",
                            systemImage: "cpu",
                            description: Text("请先在「连接设置」配对 Mac 上的 Agent Pet，即可查看并控制所有已接入的 AI Agents。")
                        )
                        .padding(.top, 40)
                    } else if mergedAgents.isEmpty {
                        ContentUnavailableView(
                            "暂无已接入的 AI Agent",
                            systemImage: "tray",
                            description: Text("可在 Mac 上小鑫刘海面板点击「＋ 接入」启用本地 AI Agent。")
                        )
                        .padding(.top, 40)
                    } else {
                        ForEach(mergedAgents) { item in
                            agentCard(item)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .background(PlatformColors.groupedBackground)
            .navigationTitle("AI Agents")
            .refreshable {
                await store.refreshState()
            }
        }
    }

    private func agentCard(_ item: AgentSourceItem) -> some View {
        let statusMeta = ActivityStatusMeta.from(item.normalizedStatus)
        let isSelectedTarget = store.selectedAgent == item.id.lowercased()
        let sessionCount = item.sessionCount ?? 0
        let activityCount = item.activityCount ?? 0

        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                AgentAvatarBadge(agentId: item.id, size: 42, cornerRadius: 12)

                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text(item.displayLabel)
                            .font(.headline)
                            .foregroundStyle(.primary)

                        if isSelectedTarget {
                            Text("当前对话目标")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(Color.accentColor)
                                .padding(.horizontal, 7)
                                .padding(.vertical, 2)
                                .background(Capsule().fill(Color.accentColor.opacity(0.14)))
                        }

                        Spacer()

                        HStack(spacing: 5) {
                            Circle()
                                .fill(statusMeta.color)
                                .frame(width: 8, height: 8)
                            Text(statusMeta.label)
                                .font(.caption.weight(.medium))
                                .foregroundStyle(statusMeta.color)
                        }
                    }

                    HStack(spacing: 10) {
                        Label("会话 \(sessionCount)", systemImage: "bubble.left.and.bubble.right")
                            .font(.caption2)
                            .foregroundStyle(.secondary)

                        if activityCount > 0 {
                            Label("活动 \(activityCount)", systemImage: "bolt.fill")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }

                        if let engine = store.engines[item.id.lowercased()], engine.available {
                            Label("CLI 直连", systemImage: "terminal")
                                .font(.caption2)
                                .foregroundStyle(.green)
                        }
                    }
                }
            }

            if let detail = item.detail, !detail.isEmpty {
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            HStack(spacing: 10) {
                Button {
                    Task {
                        await store.selectAgent(item.id)
                        store.selectedTab = .chat
                    }
                } label: {
                    Label(
                        isSelectedTarget ? "去对话" : "设为对话目标",
                        systemImage: "paperplane.fill"
                    )
                    .font(.caption.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 9)
                }
                .buttonStyle(.borderedProminent)
                .tint(isSelectedTarget ? .green : .accentColor)

                Button {
                    Task {
                        await store.sendCommand("/open \(item.id)")
                    }
                } label: {
                    Label("在 Mac 上打开", systemImage: "macwindow")
                        .font(.caption.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 9)
                }
                .buttonStyle(.bordered)
            }
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(PlatformColors.cardBackground)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(
                    isSelectedTarget ? Color.accentColor.opacity(0.45) : Color.primary.opacity(0.06),
                    lineWidth: isSelectedTarget ? 1.4 : 1
                )
        )
    }
}
