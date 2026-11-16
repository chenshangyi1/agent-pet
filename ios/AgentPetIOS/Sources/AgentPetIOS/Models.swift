import Foundation
import SwiftUI

// MARK: - API Responses & Models

struct PingResponse: Codable, Equatable, Sendable {
    let ok: Bool?
    let name: String?
    let version: String?
    let error: String?
}

struct PairResponse: Codable, Equatable, Sendable {
    let ok: Bool?
    let token: String?
    let defaultEngine: String?
    let currentCwd: String?
    let error: String?
}

struct EngineStatus: Codable, Equatable, Sendable {
    let available: Bool
    let label: String?
    let path: String?

    init(available: Bool, label: String? = nil, path: String? = nil) {
        self.available = available
        self.label = label
        self.path = path
    }
}

struct WorkspaceOption: Codable, Identifiable, Equatable, Hashable, Sendable {
    let path: String
    let name: String
    let active: Bool?

    var id: String { path }

    init(path: String, name: String, active: Bool? = nil) {
        self.path = path
        self.name = name
        self.active = active
    }
}

struct SessionOption: Codable, Identifiable, Equatable, Hashable, Sendable {
    let sessionId: String
    let cliSessionId: String?
    let provider: String?
    let cwd: String?
    let title: String?
    let updatedAt: Double?
    let active: Bool?
    let matchesCwd: Bool?

    var id: String { sessionId }

    var displayTitle: String {
        if let title, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return title
        }
        return String(sessionId.prefix(16))
    }

    var shortCwdName: String {
        guard let cwd, !cwd.isEmpty else { return "" }
        return URL(fileURLWithPath: cwd).lastPathComponent
    }
}

struct ActivityCardItem: Codable, Identifiable, Equatable, Sendable {
    let sessionId: String
    let provider: String?
    let providerLabel: String?
    let title: String?
    let status: String?
    let statusText: String?
    let detail: String?
    let cwd: String?
    let updatedAt: Double?

    var id: String {
        let p = provider ?? "agent"
        return "\(p):\(sessionId)"
    }

    var normalizedProvider: String {
        (provider ?? "dsh").lowercased()
    }

    var normalizedStatus: String {
        (status ?? "idle").lowercased()
    }

    var displayTitle: String {
        if let title, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return title
        }
        return providerLabel ?? AgentVisualMeta.meta(for: normalizedProvider).label
    }
}

struct AgentSourceItem: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let label: String?
    let connected: Bool?
    let status: String?
    let detail: String?
    let sessionCount: Int?
    let activityCount: Int?
    let sessionTitle: String?

    var normalizedStatus: String {
        (status ?? (connected == true ? "idle" : "offline")).lowercased()
    }

    var displayLabel: String {
        if let label, !label.isEmpty { return label }
        return AgentVisualMeta.meta(for: id).label
    }
}

struct JobItem: Codable, Identifiable, Equatable, Sendable {
    let jobId: String
    let engine: String?
    let cwd: String?
    let promptPreview: String?
    let status: String?
    let startedAt: Double?

    var id: String { jobId }
}

struct ChatTargetOption: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let label: String?
    let mode: String?
    let available: Bool?
}

struct MobileStateResponse: Codable, Equatable, Sendable {
    let ok: Bool?
    let currentCwd: String?
    let engines: [String: EngineStatus]?
    let workspaces: [WorkspaceOption]?
    let sessions: [SessionOption]?
    let activities: [ActivityCardItem]?
    let sources: [AgentSourceItem]?
    let jobs: [JobItem]?
    let targets: [ChatTargetOption]?
    let activeSource: String?
    let error: String?
}

struct WorkspaceSwitchResponse: Codable, Equatable, Sendable {
    let ok: Bool?
    let currentCwd: String?
    let workspaces: [WorkspaceOption]?
    let sessions: [SessionOption]?
    let error: String?
}

struct SessionSwitchResponse: Codable, Equatable, Sendable {
    let ok: Bool?
    let sessionId: String?
    let cliSessionId: String?
    let cwd: String?
    let title: String?
    let isNew: Bool?
    let error: String?
}

struct ChatMessageItem: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let role: String
    let text: String
    let createdAt: Double?
    let toolStatus: String?

    init(id: String = UUID().uuidString, role: String, text: String, createdAt: Double? = nil, toolStatus: String? = nil) {
        self.id = id
        self.role = role
        self.text = text
        self.createdAt = createdAt
        self.toolStatus = toolStatus
    }

    enum CodingKeys: String, CodingKey {
        case id, role, text, createdAt, toolStatus
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        self.role = (try? c.decode(String.self, forKey: .role)) ?? "assistant"
        self.text = (try? c.decode(String.self, forKey: .text)) ?? ""
        self.createdAt = try? c.decode(Double.self, forKey: .createdAt)
        self.toolStatus = try? c.decode(String.self, forKey: .toolStatus)
    }

    var isUser: Bool {
        role.lowercased() == "user"
    }
}

struct ConversationResponse: Codable, Equatable, Sendable {
    let ok: Bool?
    let sessionId: String?
    let title: String?
    let status: String?
    let provider: String?
    let cwd: String?
    let messages: [ChatMessageItem]?
    let error: String?
}

struct ChatDispatchResponse: Codable, Equatable, Sendable {
    let ok: Bool?
    let sessionId: String?
    let cliSessionId: String?
    let reply: String?
    let text: String?
    let launched: Bool?
    let targetAgent: String?
    let providerLabel: String?
    let error: String?

    var resolvedReply: String? {
        if let reply, !reply.isEmpty { return reply }
        if let text, !text.isEmpty { return text }
        return nil
    }
}

struct CommandResponse: Codable, Equatable, Sendable {
    let ok: Bool?
    let text: String?
    let error: String?
}

struct MobileWSFrame: Codable, Sendable {
    let type: String?
    let event: String?
    let state: MobileStateResponse?
    let currentCwd: String?
    let engines: [String: EngineStatus]?
    let workspaces: [WorkspaceOption]?
    let sessions: [SessionOption]?
    let activities: [ActivityCardItem]?
    let sources: [AgentSourceItem]?
    let jobs: [JobItem]?

    var extractedState: MobileStateResponse? {
        if let state { return state }
        if activities != nil || sources != nil || sessions != nil || workspaces != nil || currentCwd != nil || engines != nil || jobs != nil {
            return MobileStateResponse(
                ok: true,
                currentCwd: currentCwd,
                engines: engines,
                workspaces: workspaces,
                sessions: sessions,
                activities: activities,
                sources: sources,
                jobs: jobs,
                targets: nil,
                activeSource: nil,
                error: nil
            )
        }
        return nil
    }
}

// MARK: - App Navigation & Connection State

enum AppTab: String, Hashable, CaseIterable, Sendable {
    case dashboard
    case chat
    case agents
    case settings
}

enum ConnectionStatus: Equatable, Sendable {
    case disconnected
    case connecting
    case connected
    case error(String)

    var label: String {
        switch self {
        case .disconnected: return "未连接"
        case .connecting: return "连接中…"
        case .connected: return "已连接"
        case .error(let msg): return msg
        }
    }

    var isConnected: Bool {
        if case .connected = self { return true }
        return false
    }
}

// MARK: - Agent Visual Metadata

struct AgentVisualMeta: Equatable, Sendable {
    let id: String
    let label: String
    let shortTag: String
    let symbolName: String
    let color: Color
    let supportsDirectCLI: Bool

    static let defaultDirectOrder: [String] = ["claude", "codex", "opencode", "dsh"]

    static let catalog: [AgentVisualMeta] = [
        AgentVisualMeta(id: "claude", label: "Claude Code", shortTag: "C", symbolName: "sparkles", color: Color(red: 0.88, green: 0.45, blue: 0.25), supportsDirectCLI: true),
        AgentVisualMeta(id: "codex", label: "Codex", shortTag: "X", symbolName: "terminal.fill", color: Color(red: 0.16, green: 0.65, blue: 0.47), supportsDirectCLI: true),
        AgentVisualMeta(id: "opencode", label: "OpenCode", shortTag: "OC", symbolName: "chevron.left.forwardslash.chevron.right", color: Color(red: 0.30, green: 0.56, blue: 0.96), supportsDirectCLI: true),
        AgentVisualMeta(id: "dsh", label: "DSH", shortTag: "D", symbolName: "pawprint.fill", color: Color(red: 0.48, green: 0.40, blue: 0.94), supportsDirectCLI: true),
        AgentVisualMeta(id: "antigravity", label: "Antigravity", shortTag: "AG", symbolName: "atom", color: Color(red: 0.25, green: 0.52, blue: 0.95), supportsDirectCLI: false),
        AgentVisualMeta(id: "cursor", label: "Cursor", shortTag: "Cu", symbolName: "cursorarrow.rays", color: Color(red: 0.20, green: 0.22, blue: 0.28), supportsDirectCLI: false),
        AgentVisualMeta(id: "zcode", label: "ZCode", shortTag: "Z", symbolName: "bolt.horizontal.fill", color: Color(red: 0.58, green: 0.32, blue: 0.92), supportsDirectCLI: false),
        AgentVisualMeta(id: "workbuddy", label: "WorkBuddy", shortTag: "WB", symbolName: "person.2.fill", color: Color(red: 0.14, green: 0.60, blue: 0.85), supportsDirectCLI: false),
        AgentVisualMeta(id: "workbuddy-ai", label: "WorkBuddy AI", shortTag: "WA", symbolName: "person.crop.circle.badge.checkmark", color: Color(red: 0.18, green: 0.54, blue: 0.88), supportsDirectCLI: false),
        AgentVisualMeta(id: "kiro", label: "Kiro", shortTag: "K", symbolName: "wand.and.stars", color: Color(red: 0.56, green: 0.34, blue: 0.89), supportsDirectCLI: false),
        AgentVisualMeta(id: "trae", label: "Trae", shortTag: "T", symbolName: "square.stack.3d.up.fill", color: Color(red: 0.13, green: 0.72, blue: 0.58), supportsDirectCLI: false),
        AgentVisualMeta(id: "trae-cn", label: "Trae CN", shortTag: "TC", symbolName: "square.stack.3d.up.fill", color: Color(red: 0.10, green: 0.68, blue: 0.55), supportsDirectCLI: false),
        AgentVisualMeta(id: "qoder", label: "Qoder", shortTag: "Q", symbolName: "cube.fill", color: Color(red: 0.27, green: 0.48, blue: 0.92), supportsDirectCLI: false),
        AgentVisualMeta(id: "qoder-cn", label: "Qoder CN", shortTag: "QC", symbolName: "cube.transparent.fill", color: Color(red: 0.24, green: 0.45, blue: 0.88), supportsDirectCLI: false),
        AgentVisualMeta(id: "windsurf", label: "Windsurf", shortTag: "W", symbolName: "wind", color: Color(red: 0.08, green: 0.68, blue: 0.76), supportsDirectCLI: false),
        AgentVisualMeta(id: "copilot", label: "GitHub Copilot", shortTag: "GH", symbolName: "airplane", color: Color(red: 0.22, green: 0.26, blue: 0.34), supportsDirectCLI: false),
        AgentVisualMeta(id: "gemini-cli", label: "Gemini CLI", shortTag: "G", symbolName: "sparkle", color: Color(red: 0.26, green: 0.52, blue: 0.96), supportsDirectCLI: false),
        AgentVisualMeta(id: "codebuddy", label: "CodeBuddy", shortTag: "CB", symbolName: "hammer.fill", color: Color(red: 0.16, green: 0.55, blue: 0.86), supportsDirectCLI: false),
        AgentVisualMeta(id: "codebuddy-cn", label: "CodeBuddy CN", shortTag: "CC", symbolName: "hammer.circle.fill", color: Color(red: 0.16, green: 0.50, blue: 0.82), supportsDirectCLI: false),
        AgentVisualMeta(id: "qwen-code", label: "Qwen Code", shortTag: "Qw", symbolName: "brain.head.profile", color: Color(red: 0.42, green: 0.34, blue: 0.90), supportsDirectCLI: false),
        AgentVisualMeta(id: "droid", label: "Factory Droid", shortTag: "FD", symbolName: "cpu.fill", color: Color(red: 0.90, green: 0.46, blue: 0.20), supportsDirectCLI: false),
        AgentVisualMeta(id: "cline", label: "Cline", shortTag: "Cl", symbolName: "command.square.fill", color: Color(red: 0.34, green: 0.44, blue: 0.62), supportsDirectCLI: false),
    ]

    static let byId: [String: AgentVisualMeta] = Dictionary(
        uniqueKeysWithValues: catalog.map { ($0.id, $0) }
    )

    static func meta(for id: String) -> AgentVisualMeta {
        let key = id.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if let found = byId[key] { return found }
        return AgentVisualMeta(
            id: key.isEmpty ? "dsh" : key,
            label: id.isEmpty ? "DSH" : id.capitalized,
            shortTag: String(id.prefix(2)).uppercased(),
            symbolName: "cpu",
            color: Color.accentColor,
            supportsDirectCLI: false
        )
    }
}

// MARK: - Activity Status Helpers

struct ActivityStatusMeta: Equatable, Sendable {
    let status: String
    let label: String
    let symbolName: String
    let color: Color
    let isSpinning: Bool

    static func from(_ raw: String?) -> ActivityStatusMeta {
        switch (raw ?? "idle").lowercased() {
        case "running", "working", "busy":
            return ActivityStatusMeta(status: "running", label: "正在工作", symbolName: "arrow.triangle.2.circlepath", color: .blue, isSpinning: true)
        case "waiting", "confirm", "pending":
            return ActivityStatusMeta(status: "waiting", label: "待确认", symbolName: "questionmark.circle.fill", color: .orange, isSpinning: false)
        case "blocked", "error", "failed":
            return ActivityStatusMeta(status: "blocked", label: "遇到问题", symbolName: "exclamationmark.triangle.fill", color: .red, isSpinning: false)
        case "ready", "completed", "done":
            return ActivityStatusMeta(status: "ready", label: "已完成", symbolName: "checkmark.circle.fill", color: .green, isSpinning: false)
        case "cancelled", "canceled", "stopped":
            return ActivityStatusMeta(status: "cancelled", label: "已取消", symbolName: "xmark.circle.fill", color: .secondary, isSpinning: false)
        case "offline", "disconnected":
            return ActivityStatusMeta(status: "offline", label: "未接入", symbolName: "circle.dashed", color: .secondary, isSpinning: false)
        default:
            return ActivityStatusMeta(status: "idle", label: "空闲", symbolName: "circle.fill", color: .gray, isSpinning: false)
        }
    }
}

// MARK: - Formatting Helpers

enum DateFormatters {
    static func relativeString(fromEpochMs ms: Double?) -> String {
        guard let ms, ms > 0 else { return "" }
        let date = Date(timeIntervalSince1970: ms / 1000.0)
        let seconds = Int(Date().timeIntervalSince(date))
        if seconds < 15 { return "刚刚" }
        if seconds < 60 { return "\(seconds)秒前" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)分钟前" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)小时前" }
        let days = hours / 24
        return "\(days)天前"
    }
}
