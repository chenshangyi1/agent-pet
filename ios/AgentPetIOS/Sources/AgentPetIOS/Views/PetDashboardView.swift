import SwiftUI

struct PetDashboardView: View {
    @EnvironmentObject private var store: AgentPetStore
    @State private var isStackExpanded: Bool = true
    @State private var expandedCardIds: Set<String> = []

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    dynamicIslandHeader

                    if !store.isPaired {
                        unpairedCalloutCard
                    } else {
                        if !store.jobs.isEmpty {
                            activeJobsSection
                        }

                        activitiesSection
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .background(PlatformColors.groupedBackground)
            .navigationTitle("小鑫动态")
            .refreshable {
                await store.refreshState()
            }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        Task { await store.refreshState() }
                    } label: {
                        if store.isRefreshing {
                            ProgressView()
                        } else {
                            Image(systemName: "arrow.clockwise")
                        }
                    }
                    .disabled(!store.isPaired || store.isRefreshing)
                }
            }
        }
    }

    // MARK: - Dynamic Island Header

    private var dynamicIslandHeader: some View {
        VStack(spacing: 14) {
            HStack(spacing: 14) {
                petStatusAvatar

                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 8) {
                        Text("小鑫 · Agent Pet")
                            .font(.headline.weight(.bold))
                            .foregroundStyle(.white)

                        Spacer()

                        liveSyncPill
                    }

                    HStack(spacing: 8) {
                        Text(store.summaryStatusText)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(summaryPillForeground)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 4)
                            .background(
                                Capsule(style: .continuous)
                                    .fill(store.summaryStatusColor.opacity(0.22))
                            )
                            .overlay(
                                Capsule(style: .continuous)
                                    .stroke(store.summaryStatusColor.opacity(0.45), lineWidth: 0.8)
                            )

                        if !store.effectiveCwdName.isEmpty && store.isPaired {
                            Label(store.effectiveCwdName, systemImage: "folder.fill")
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(.white.opacity(0.74))
                                .lineLimit(1)
                        }
                    }
                }
            }

            // Quick remote desktop controls
            HStack(spacing: 10) {
                petActionButton(title: "放出小鑫", systemImage: "sparkles", command: "/pet show")
                petActionButton(title: "收回刘海", systemImage: "chevron.up.circle", command: "/pet hide")
                petActionButton(title: "位置归位", systemImage: "arrow.uturn.backward.circle", command: "/pet reset")
            }
        }
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [
                            Color(red: 0.08, green: 0.09, blue: 0.12),
                            Color(red: 0.13, green: 0.15, blue: 0.21),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .shadow(color: .black.opacity(0.22), radius: 14, y: 6)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(.white.opacity(0.1), lineWidth: 1)
        )
    }

    private var petStatusAvatar: some View {
        let glowColor = store.summaryStatusColor == .secondary ? Color.indigo : store.summaryStatusColor
        return ZStack {
            Circle()
                .fill(glowColor.opacity(0.22))
                .frame(width: 54, height: 54)

            Circle()
                .fill(
                    LinearGradient(
                        colors: [glowColor, glowColor.opacity(0.7)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .frame(width: 44, height: 44)

            Image(systemName: "pawprint.fill")
                .font(.system(size: 20, weight: .bold))
                .foregroundStyle(.white)
        }
    }

    private var liveSyncPill: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(store.isWebSocketConnected ? Color.green : (store.isPaired ? Color.orange : Color.gray))
                .frame(width: 6, height: 6)
            Text(store.isWebSocketConnected ? "实时" : (store.isPaired ? "轮询" : "离线"))
                .font(.caption2.weight(.medium))
                .foregroundStyle(.white.opacity(0.75))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(Capsule().fill(.white.opacity(0.1)))
    }

    private var summaryPillForeground: Color {
        store.summaryStatusColor == .secondary ? .white.opacity(0.85) : store.summaryStatusColor
    }

    private func petActionButton(title: String, systemImage: String, command: String) -> some View {
        Button {
            Task { await store.sendCommand(command) }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: systemImage)
                    .font(.caption.weight(.semibold))
                Text(title)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 9)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(.white.opacity(0.11))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(.white.opacity(0.08), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .disabled(!store.isPaired)
        .opacity(store.isPaired ? 1 : 0.5)
    }

    // MARK: - Unpaired Card

    private var unpairedCalloutCard: some View {
        VStack(spacing: 12) {
            Image(systemName: "iphone.and.arrow.forward")
                .font(.system(size: 34))
                .foregroundStyle(Color.accentColor)

            Text("尚未连接到 Mac 上的小鑫")
                .font(.headline)

            Text("请前往「连接设置」输入 Mac 局域网 IP（端口 18472）和 6 位配对码即可同步实时动态并远程派活。")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            Button {
                store.selectedTab = .settings
            } label: {
                Text("前往连接设置")
                    .font(.subheadline.weight(.semibold))
                    .padding(.horizontal, 18)
                    .padding(.vertical, 10)
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(22)
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(PlatformColors.cardBackground)
        )
    }

    // MARK: - Active Jobs Section

    private var activeJobsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("远程派活任务")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 4)

            ForEach(store.jobs) { job in
                HStack(spacing: 12) {
                    AgentAvatarBadge(agentId: job.engine ?? "claude", size: 32, cornerRadius: 9)

                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(AgentVisualMeta.meta(for: job.engine ?? "claude").label)
                                .font(.subheadline.weight(.semibold))
                            ActivityStatusBadge(status: job.status, showLabel: true)
                        }
                        if let preview = job.promptPreview, !preview.isEmpty {
                            Text(preview)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                    }

                    Spacer()

                    if let startedAt = job.startedAt {
                        Text(DateFormatters.relativeString(fromEpochMs: startedAt))
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
                .padding(12)
                .background(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(PlatformColors.cardBackground)
                )
            }
        }
    }

    // MARK: - Live Activity Cards

    private var activitiesSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("实时活动卡片")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)

                Spacer()

                if store.activities.count > 1 {
                    Button {
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                            isStackExpanded.toggle()
                        }
                    } label: {
                        Label(
                            isStackExpanded ? "收起叠放" : "展开全部 (\(store.activities.count))",
                            systemImage: isStackExpanded ? "rectangle.compress.vertical" : "rectangle.expand.vertical"
                        )
                        .font(.caption.weight(.medium))
                    }
                }
            }
            .padding(.horizontal, 4)

            if store.activities.isEmpty {
                VStack(spacing: 10) {
                    Image(systemName: "moon.stars.fill")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                    Text("当前没有活跃的 AI Agent 任务")
                        .font(.subheadline.weight(.medium))
                    Text("可以在「对话派活」直接给 Claude Code / Codex / OpenCode 发任务")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(24)
                .frame(maxWidth: .infinity)
                .background(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(PlatformColors.cardBackground)
                )
            } else if isStackExpanded {
                LazyVStack(spacing: 10) {
                    ForEach(store.activities) { activity in
                        activityCard(activity)
                    }
                }
            } else {
                // Stacked deck preview when collapsed
                ZStack(alignment: .top) {
                    ForEach(Array(store.activities.prefix(3).enumerated().reversed()), id: \.element.id) { index, activity in
                        activityCard(activity)
                            .scaleEffect(1.0 - CGFloat(index) * 0.03)
                            .offset(y: CGFloat(index) * 10)
                            .opacity(index == 0 ? 1.0 : max(0.55, 0.9 - Double(index) * 0.18))
                            .allowsHitTesting(index == 0)
                    }
                }
                .padding(.bottom, CGFloat(min(store.activities.count - 1, 2) * 10))
            }
        }
    }

    private func activityCard(_ activity: ActivityCardItem) -> some View {
        let statusMeta = ActivityStatusMeta.from(activity.normalizedStatus)
        let isExpanded = expandedCardIds.contains(activity.id)
        let detailText = activity.detail ?? activity.statusText ?? statusMeta.label

        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                AgentAvatarBadge(agentId: activity.normalizedProvider, size: 38, cornerRadius: 11)

                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(activity.displayTitle)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.primary)
                            .lineLimit(1)

                        Spacer()

                        ActivityStatusBadge(status: activity.normalizedStatus)
                    }

                    HStack(spacing: 6) {
                        Text(activity.providerLabel ?? AgentVisualMeta.meta(for: activity.normalizedProvider).label)
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.secondary)

                        if let ts = activity.updatedAt {
                            Text("· \(DateFormatters.relativeString(fromEpochMs: ts))")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                }
            }

            if !detailText.isEmpty {
                Text(detailText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(isExpanded ? nil : 2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            HStack {
                if detailText.count > 48 {
                    Button {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            if isExpanded {
                                expandedCardIds.remove(activity.id)
                            } else {
                                expandedCardIds.insert(activity.id)
                            }
                        }
                    } label: {
                        Text(isExpanded ? "收起详情" : "展开详情")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }

                Spacer()

                Label("查看并续聊", systemImage: "arrow.right.circle.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
            }
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(PlatformColors.cardBackground)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(
                    activity.normalizedStatus == "running"
                        ? Color.blue.opacity(0.35)
                        : (activity.normalizedStatus == "waiting"
                            ? Color.orange.opacity(0.45)
                            : (activity.normalizedStatus == "blocked"
                                ? Color.red.opacity(0.45)
                                : Color.primary.opacity(0.06))),
                    lineWidth: 1
                )
        )
        .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .onTapGesture {
            Task { await store.openActivityConversation(activity) }
        }
    }
}
