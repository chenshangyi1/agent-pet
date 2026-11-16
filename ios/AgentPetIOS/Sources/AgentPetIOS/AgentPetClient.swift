import Foundation
import SwiftUI

enum AgentPetAPIError: LocalizedError {
    case invalidServerHost
    case unauthenticated
    case badResponse(Int, String)
    case serverMessage(String)

    var errorDescription: String? {
        switch self {
        case .invalidServerHost:
            return "Mac 服务地址格式无效，请填写如 192.168.x.x:18472"
        case .unauthenticated:
            return "尚未配对或配对码已失效，请前往「连接设置」配对"
        case .badResponse(let code, let body):
            if code == 401 || code == 403 {
                return "鉴权失败（\(code)），请重新输入 6 位配对码"
            }
            return body.isEmpty ? "请求失败（HTTP \(code)）" : body
        case .serverMessage(let msg):
            return msg
        }
    }
}

@MainActor
final class AgentPetStore: ObservableObject {
    private enum DefaultsKey {
        static let serverHost = "agentpet.ios.serverHost"
        static let authToken = "agentpet.ios.authToken"
        static let selectedAgent = "agentpet.ios.selectedAgent"
        static let selectedCwd = "agentpet.ios.selectedCwd"
        static let selectedSessionId = "agentpet.ios.selectedSessionId"
    }

    // MARK: - Persisted Configuration

    @Published var serverHost: String {
        didSet { UserDefaults.standard.set(serverHost, forKey: DefaultsKey.serverHost) }
    }

    @Published var authToken: String {
        didSet { UserDefaults.standard.set(authToken, forKey: DefaultsKey.authToken) }
    }

    @Published var selectedAgent: String {
        didSet { UserDefaults.standard.set(selectedAgent, forKey: DefaultsKey.selectedAgent) }
    }

    @Published var selectedCwd: String {
        didSet { UserDefaults.standard.set(selectedCwd, forKey: DefaultsKey.selectedCwd) }
    }

    @Published var selectedSessionId: String {
        didSet { UserDefaults.standard.set(selectedSessionId, forKey: DefaultsKey.selectedSessionId) }
    }

    // MARK: - Live State

    @Published var selectedTab: AppTab = .dashboard
    @Published var connectionStatus: ConnectionStatus = .disconnected
    @Published var isWebSocketConnected: Bool = false
    @Published var serverVersion: String = ""
    @Published var serverName: String = "小鑫 · Agent Pet"

    @Published var currentCwd: String = ""
    @Published var engines: [String: EngineStatus] = [:]
    @Published var workspaces: [WorkspaceOption] = []
    @Published var sessions: [SessionOption] = []
    @Published var activities: [ActivityCardItem] = []
    @Published var sources: [AgentSourceItem] = []
    @Published var jobs: [JobItem] = []
    @Published var serverTargets: [ChatTargetOption] = []

    @Published var messages: [ChatMessageItem] = []
    @Published var activeSessionTitle: String = ""
    @Published var activeSessionStatus: String = "idle"

    @Published var isPairing: Bool = false
    @Published var isSending: Bool = false
    @Published var isRefreshing: Bool = false
    @Published var isLoadingConversation: Bool = false
    @Published var lastError: String?
    @Published var statusBanner: String?
    @Published var lastCommandOutput: String?

    private let urlSession: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    private var webSocketTask: URLSessionWebSocketTask?
    private var webSocketLoopTask: Task<Void, Never>?
    private var pollingTask: Task<Void, Never>?
    private var bannerDismissTask: Task<Void, Never>?
    private var reconnectAttempt: Int = 0
    private var isStarted: Bool = false

    // MARK: - Init

    init(userDefaults: UserDefaults = .standard) {
        self.serverHost = userDefaults.string(forKey: DefaultsKey.serverHost) ?? ""
        self.authToken = userDefaults.string(forKey: DefaultsKey.authToken) ?? ""
        self.selectedAgent = userDefaults.string(forKey: DefaultsKey.selectedAgent) ?? "claude"
        self.selectedCwd = userDefaults.string(forKey: DefaultsKey.selectedCwd) ?? ""
        self.selectedSessionId = userDefaults.string(forKey: DefaultsKey.selectedSessionId) ?? ""

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 120
        self.urlSession = URLSession(configuration: config)
        self.decoder = JSONDecoder()
        self.encoder = JSONEncoder()
    }

    deinit {
        webSocketLoopTask?.cancel()
        pollingTask?.cancel()
        bannerDismissTask?.cancel()
        webSocketTask?.cancel(with: .goingAway, reason: nil)
    }

    // MARK: - Computed Helpers

    var isPaired: Bool {
        !normalizedBaseURLString().isEmpty && !authToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var effectiveCwd: String {
        if !selectedCwd.isEmpty { return selectedCwd }
        return currentCwd
    }

    var effectiveCwdName: String {
        let path = effectiveCwd
        guard !path.isEmpty else { return "选择项目" }
        let name = URL(fileURLWithPath: path).lastPathComponent
        return name.isEmpty ? path : name
    }

    var selectedAgentMeta: AgentVisualMeta {
        AgentVisualMeta.meta(for: selectedAgent)
    }

    /// Ordered list of AI Agents available for selection in pickers.
    var availableChatAgents: [AgentVisualMeta] {
        var seen = Set<String>()
        var result: [AgentVisualMeta] = []

        // 1. Server-advertised targets if present
        for t in serverTargets where t.available != false {
            let id = t.id.lowercased()
            if seen.insert(id).inserted {
                let base = AgentVisualMeta.meta(for: id)
                result.append(AgentVisualMeta(
                    id: id,
                    label: t.label ?? base.label,
                    shortTag: base.shortTag,
                    symbolName: base.symbolName,
                    color: base.color,
                    supportsDirectCLI: (t.mode == "direct") || base.supportsDirectCLI
                ))
            }
        }

        // 2. Direct engines from /api/mobile/state
        for id in AgentVisualMeta.defaultDirectOrder {
            if let status = engines[id], status.available, seen.insert(id).inserted {
                let base = AgentVisualMeta.meta(for: id)
                result.append(AgentVisualMeta(
                    id: id,
                    label: status.label ?? base.label,
                    shortTag: base.shortTag,
                    symbolName: base.symbolName,
                    color: base.color,
                    supportsDirectCLI: true
                ))
            }
        }
        for (rawId, status) in engines.sorted(by: { $0.key < $1.key }) where status.available {
            let id = rawId.lowercased()
            if seen.insert(id).inserted {
                let base = AgentVisualMeta.meta(for: id)
                result.append(AgentVisualMeta(
                    id: id,
                    label: status.label ?? base.label,
                    shortTag: base.shortTag,
                    symbolName: base.symbolName,
                    color: base.color,
                    supportsDirectCLI: base.supportsDirectCLI
                ))
            }
        }

        // 3. Connected sources from Notch/Providers
        for src in sources where src.connected == true {
            let id = src.id.lowercased()
            if seen.insert(id).inserted {
                let base = AgentVisualMeta.meta(for: id)
                result.append(AgentVisualMeta(
                    id: id,
                    label: src.displayLabel,
                    shortTag: base.shortTag,
                    symbolName: base.symbolName,
                    color: base.color,
                    supportsDirectCLI: base.supportsDirectCLI
                ))
            }
        }

        // 4. Always guarantee the core 4 direct engines appear as fallback
        for id in AgentVisualMeta.defaultDirectOrder where seen.insert(id).inserted {
            result.append(AgentVisualMeta.meta(for: id))
        }

        return result
    }

    var filteredSessionsForPicker: [SessionOption] {
        let cwd = effectiveCwd
        return sessions.sorted { lhs, rhs in
            let lMatch = !cwd.isEmpty && (lhs.cwd == cwd || lhs.matchesCwd == true)
            let rMatch = !cwd.isEmpty && (rhs.cwd == cwd || rhs.matchesCwd == true)
            if lMatch != rMatch { return lMatch }
            return (lhs.updatedAt ?? 0) > (rhs.updatedAt ?? 0)
        }
    }

    var summaryStatusText: String {
        let runningCount = activities.filter { $0.normalizedStatus == "running" }.count
            + jobs.filter { ($0.status ?? "").lowercased() == "running" }.count
        let waitingCount = activities.filter { $0.normalizedStatus == "waiting" }.count
        let blockedCount = activities.filter { $0.normalizedStatus == "blocked" }.count

        if runningCount > 0 {
            return "● \(runningCount) 个运行中"
        }
        if waitingCount > 0 {
            return "● \(waitingCount) 个待确认"
        }
        if blockedCount > 0 {
            return "● \(blockedCount) 个遇到问题"
        }
        let connectedCount = sources.filter { $0.connected == true }.count
        if connectedCount > 0 {
            return "已接入 \(connectedCount) 个 · 空闲"
        }
        return "空闲"
    }

    var summaryStatusColor: Color {
        let hasRunning = activities.contains { $0.normalizedStatus == "running" }
            || jobs.contains { ($0.status ?? "").lowercased() == "running" }
        if hasRunning { return .green }
        if activities.contains(where: { $0.normalizedStatus == "waiting" }) { return .orange }
        if activities.contains(where: { $0.normalizedStatus == "blocked" }) { return .red }
        return .secondary
    }

    // MARK: - Lifecycle

    func startIfNeeded() {
        guard !isStarted else { return }
        isStarted = true
        if isPaired {
            connectWebSocket()
            startPollingFallback()
            Task {
                await refreshState()
                if !selectedSessionId.isEmpty {
                    await loadConversation(sessionId: selectedSessionId)
                }
            }
        }
    }

    func stopConnections() {
        webSocketLoopTask?.cancel()
        webSocketLoopTask = nil
        pollingTask?.cancel()
        pollingTask = nil
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        isWebSocketConnected = false
    }

    func disconnect() {
        stopConnections()
        authToken = ""
        connectionStatus = .disconnected
        lastError = nil
        showBanner("已断开配对连接")
    }

    // MARK: - URL Normalization

    func normalizedBaseURLString() -> String {
        var raw = serverHost.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return "" }
        while raw.hasSuffix("/") { raw.removeLast() }
        if !raw.contains("://") {
            raw = "http://\(raw)"
        }
        guard var components = URLComponents(string: raw), let host = components.host, !host.isEmpty else {
            return ""
        }
        if components.port == nil {
            components.port = 18472
        }
        components.path = ""
        components.query = nil
        components.fragment = nil
        return components.string ?? ""
    }

    private func makeHTTPURL(path: String, queryItems: [URLQueryItem] = []) throws -> URL {
        let base = normalizedBaseURLString()
        guard !base.isEmpty, var components = URLComponents(string: base) else {
            throw AgentPetAPIError.invalidServerHost
        }
        components.path = path
        if !queryItems.isEmpty {
            components.queryItems = queryItems
        }
        guard let url = components.url else {
            throw AgentPetAPIError.invalidServerHost
        }
        return url
    }

    private func makeWebSocketURL() throws -> URL {
        let base = normalizedBaseURLString()
        guard !base.isEmpty, var components = URLComponents(string: base) else {
            throw AgentPetAPIError.invalidServerHost
        }
        components.scheme = (components.scheme == "https") ? "wss" : "ws"
        components.path = "/api/mobile/ws"
        components.queryItems = [URLQueryItem(name: "token", value: authToken)]
        guard let url = components.url else {
            throw AgentPetAPIError.invalidServerHost
        }
        return url
    }

    // MARK: - HTTP Requests

    private func performRequest<T: Decodable>(
        path: String,
        method: String = "GET",
        queryItems: [URLQueryItem] = [],
        body: [String: Any]? = nil,
        authenticated: Bool = true
    ) async throws -> T {
        let url = try makeHTTPURL(path: path, queryItems: queryItems)
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if authenticated {
            let token = authToken.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !token.isEmpty else { throw AgentPetAPIError.unauthenticated }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])
        }

        let (data, response) = try await urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw AgentPetAPIError.badResponse(0, "无效的服务端响应")
        }

        if !(200...299).contains(http.statusCode) {
            let message = extractErrorMessage(from: data) ?? String(data: data, encoding: .utf8) ?? ""
            throw AgentPetAPIError.badResponse(http.statusCode, message)
        }

        return try decoder.decode(T.self, from: data)
    }

    private func extractErrorMessage(from data: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return (json["error"] as? String) ?? (json["message"] as? String)
    }

    // MARK: - API Methods

    @discardableResult
    func pingServer() async -> Bool {
        lastError = nil
        connectionStatus = .connecting
        do {
            let res: PingResponse = try await performRequest(path: "/api/mobile/ping", authenticated: false)
            guard res.ok == true else {
                let msg = res.error ?? "服务端返回异常"
                connectionStatus = .error(msg)
                lastError = msg
                return false
            }
            serverName = res.name ?? "小鑫 · Agent Pet"
            serverVersion = res.version ?? ""
            if !isPaired {
                connectionStatus = .disconnected
            }
            showBanner("已发现 \(serverName) \(serverVersion)")
            return true
        } catch {
            let msg = error.localizedDescription
            connectionStatus = .error(msg)
            lastError = msg
            return false
        }
    }

    @discardableResult
    func pair(code: String) async -> Bool {
        let trimmedCode = code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard !trimmedCode.isEmpty else {
            lastError = "请输入 6 位配对码"
            return false
        }
        isPairing = true
        lastError = nil
        connectionStatus = .connecting
        defer { isPairing = false }

        do {
            let res: PairResponse = try await performRequest(
                path: "/api/mobile/pair",
                method: "POST",
                body: ["code": trimmedCode],
                authenticated: false
            )
            guard res.ok == true, let token = res.token, !token.isEmpty else {
                let msg = res.error ?? "配对码验证失败"
                connectionStatus = .error(msg)
                lastError = msg
                return false
            }
            authToken = token
            if let engine = res.defaultEngine, !engine.isEmpty {
                selectedAgent = engine
            }
            if let cwd = res.currentCwd, !cwd.isEmpty {
                selectedCwd = cwd
                currentCwd = cwd
            }
            connectionStatus = .connected
            showBanner("配对成功，已连接 Mac 小鑫")
            isStarted = true
            connectWebSocket()
            startPollingFallback()
            await refreshState()
            return true
        } catch {
            let msg = error.localizedDescription
            connectionStatus = .error(msg)
            lastError = msg
            return false
        }
    }

    func refreshState() async {
        guard isPaired else { return }
        if !isRefreshing { isRefreshing = true }
        defer { isRefreshing = false }

        do {
            let state: MobileStateResponse = try await performRequest(path: "/api/mobile/state")
            applyState(state)
            connectionStatus = .connected
            lastError = nil
        } catch {
            let msg = error.localizedDescription
            lastError = msg
            if case .error = connectionStatus {
                connectionStatus = .error(msg)
            } else if !isWebSocketConnected {
                connectionStatus = .error(msg)
            }
        }
    }

    func applyState(_ state: MobileStateResponse) {
        if let cwd = state.currentCwd, !cwd.isEmpty {
            currentCwd = cwd
            if selectedCwd.isEmpty {
                selectedCwd = cwd
            }
        }
        if let engines = state.engines {
            self.engines = engines
        }
        if let workspaces = state.workspaces {
            self.workspaces = workspaces
        }
        if let sessions = state.sessions {
            self.sessions = sessions
            if !selectedSessionId.isEmpty,
               let active = sessions.first(where: { $0.sessionId == selectedSessionId }) {
                activeSessionTitle = active.displayTitle
            }
        }
        if let activities = state.activities {
            self.activities = activities
            if !selectedSessionId.isEmpty,
               let activeAct = activities.first(where: { $0.sessionId == selectedSessionId }) {
                activeSessionStatus = activeAct.normalizedStatus
            }
        }
        if let sources = state.sources {
            self.sources = sources
        }
        if let jobs = state.jobs {
            self.jobs = jobs
        }
        if let targets = state.targets {
            self.serverTargets = targets
        }
    }

    func selectWorkspace(_ cwd: String) async {
        let trimmed = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        lastError = nil

        do {
            let res: WorkspaceSwitchResponse = try await performRequest(
                path: "/api/mobile/workspace",
                method: "POST",
                body: ["cwd": trimmed]
            )
            if let nextCwd = res.currentCwd, !nextCwd.isEmpty {
                currentCwd = nextCwd
                selectedCwd = nextCwd
            } else {
                selectedCwd = trimmed
                currentCwd = trimmed
            }
            if let list = res.workspaces {
                workspaces = list
            }
            if let sess = res.sessions {
                sessions = sess
            }
            selectedSessionId = ""
            activeSessionTitle = ""
            activeSessionStatus = "idle"
            messages = []
            let folderName = URL(fileURLWithPath: selectedCwd).lastPathComponent
            showBanner("已切换目录：\(folderName)")
            await refreshState()
        } catch {
            lastError = error.localizedDescription
        }
    }

    func selectSession(_ session: SessionOption?) async {
        lastError = nil
        if let session {
            var payload: [String: Any] = [
                "sessionId": session.sessionId,
                "targetAgent": session.provider ?? selectedAgent,
            ]
            if let cli = session.cliSessionId { payload["cliSessionId"] = cli }
            if let cwd = session.cwd { payload["cwd"] = cwd }
            if let title = session.title { payload["title"] = title }

            do {
                let res: SessionSwitchResponse = try await performRequest(
                    path: "/api/mobile/session",
                    method: "POST",
                    body: payload
                )
                let resolvedId = res.sessionId ?? session.sessionId
                selectedSessionId = resolvedId
                activeSessionTitle = res.title ?? session.displayTitle
                if let cwd = res.cwd ?? session.cwd, !cwd.isEmpty {
                    selectedCwd = cwd
                    currentCwd = cwd
                }
                if let provider = session.provider, !provider.isEmpty {
                    selectedAgent = provider
                }
                showBanner("已绑定会话：\(activeSessionTitle)")
                await loadConversation(sessionId: resolvedId)
            } catch {
                lastError = error.localizedDescription
            }
        } else {
            // New session
            do {
                let _: SessionSwitchResponse = try await performRequest(
                    path: "/api/mobile/session",
                    method: "POST",
                    body: [
                        "sessionId": "new",
                        "targetAgent": selectedAgent,
                    ]
                )
            } catch {
                // Even if backend fails or is offline, reset local session selection
            }
            selectedSessionId = ""
            activeSessionTitle = ""
            activeSessionStatus = "idle"
            messages = []
            showBanner("已切换为新建会话")
        }
    }

    func selectAgent(_ agentId: String) async {
        let next = agentId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !next.isEmpty else { return }
        if selectedAgent != next {
            selectedAgent = next
            // Reset bound session if it belongs to a different provider
            if !selectedSessionId.isEmpty,
               let currentSession = sessions.first(where: { $0.sessionId == selectedSessionId }),
               let prov = currentSession.provider?.lowercased(),
               prov != next {
                selectedSessionId = ""
                activeSessionTitle = ""
                messages = []
            }
        }
        showBanner("对话目标已设为 \(AgentVisualMeta.meta(for: next).label)")
        await refreshState()
    }

    func loadConversation(sessionId: String) async {
        guard isPaired, !sessionId.isEmpty else { return }
        isLoadingConversation = true
        defer { isLoadingConversation = false }

        do {
            let res: ConversationResponse = try await performRequest(
                path: "/api/mobile/conversation",
                queryItems: [URLQueryItem(name: "sessionId", value: sessionId)]
            )
            if let list = res.messages {
                self.messages = list
            }
            if let title = res.title, !title.isEmpty {
                self.activeSessionTitle = title
            }
            if let status = res.status, !status.isEmpty {
                self.activeSessionStatus = status.lowercased()
            }
            if let cwd = res.cwd, !cwd.isEmpty {
                self.selectedCwd = cwd
            }
        } catch {
            lastError = error.localizedDescription
        }
    }

    func sendChat(text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        // Slash commands shortcut
        if trimmed.hasPrefix("/") {
            await sendCommand(trimmed)
            return
        }

        guard isPaired else {
            lastError = AgentPetAPIError.unauthenticated.localizedDescription
            return
        }

        lastError = nil
        isSending = true
        defer { isSending = false }

        let optimisticUserMsg = ChatMessageItem(
            role: "user",
            text: trimmed,
            createdAt: Date().timeIntervalSince1970 * 1000
        )
        messages.append(optimisticUserMsg)
        activeSessionStatus = "running"

        var body: [String: Any] = [
            "targetAgent": selectedAgent,
            "text": trimmed,
        ]
        if !effectiveCwd.isEmpty {
            body["cwd"] = effectiveCwd
        }
        if !selectedSessionId.isEmpty {
            body["sessionId"] = selectedSessionId
        }

        do {
            let res: ChatDispatchResponse = try await performRequest(
                path: "/api/mobile/chat",
                method: "POST",
                body: body
            )

            if res.ok == false, let err = res.error {
                throw AgentPetAPIError.serverMessage(err)
            }

            if let nextSessionId = res.sessionId, !nextSessionId.isEmpty {
                selectedSessionId = nextSessionId
            }

            if res.launched == true {
                let label = res.providerLabel ?? selectedAgentMeta.label
                let launchText = res.resolvedReply ?? "已复制指令并在 Mac 上打开 \(label)（可直接 ⌘V 粘贴）"
                messages.append(ChatMessageItem(
                    role: "assistant",
                    text: launchText,
                    createdAt: Date().timeIntervalSince1970 * 1000
                ))
                activeSessionStatus = "ready"
                showBanner("已唤起 \(label)")
            } else if let reply = res.resolvedReply {
                // Reload full conversation if sessionId available, else append reply
                if !selectedSessionId.isEmpty {
                    await loadConversation(sessionId: selectedSessionId)
                }
                if !messages.contains(where: { !$0.isUser && $0.text == reply }) {
                    messages.append(ChatMessageItem(
                        role: "assistant",
                        text: reply,
                        createdAt: Date().timeIntervalSince1970 * 1000
                    ))
                }
                activeSessionStatus = "ready"
            } else if !selectedSessionId.isEmpty {
                await loadConversation(sessionId: selectedSessionId)
            }

            await refreshState()
        } catch {
            activeSessionStatus = "blocked"
            lastError = error.localizedDescription
            messages.append(ChatMessageItem(
                role: "assistant",
                text: "发送失败：\(error.localizedDescription)",
                createdAt: Date().timeIntervalSince1970 * 1000
            ))
        }
    }

    @discardableResult
    func sendCommand(_ commandText: String) async -> String? {
        let trimmed = commandText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard isPaired else {
            lastError = AgentPetAPIError.unauthenticated.localizedDescription
            return nil
        }

        lastError = nil
        do {
            let res: CommandResponse = try await performRequest(
                path: "/api/mobile/command",
                method: "POST",
                body: ["text": trimmed]
            )
            if res.ok == false, let err = res.error {
                throw AgentPetAPIError.serverMessage(err)
            }
            let output = res.text ?? "命令已执行：\(trimmed)"
            lastCommandOutput = output
            showBanner("已执行 \(trimmed)")
            await refreshState()
            return output
        } catch {
            lastError = error.localizedDescription
            return nil
        }
    }

    func openActivityConversation(_ activity: ActivityCardItem) async {
        if let prov = activity.provider, !prov.isEmpty {
            selectedAgent = prov.lowercased()
        }
        if let cwd = activity.cwd, !cwd.isEmpty {
            selectedCwd = cwd
        }
        selectedSessionId = activity.sessionId
        activeSessionTitle = activity.displayTitle
        activeSessionStatus = activity.normalizedStatus
        selectedTab = .chat
        await loadConversation(sessionId: activity.sessionId)
    }

    // MARK: - WebSocket & Polling

    func connectWebSocket() {
        webSocketLoopTask?.cancel()
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        isWebSocketConnected = false

        guard isPaired else { return }

        webSocketLoopTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                await self.runSingleWebSocketSession()
                if Task.isCancelled { break }
                self.reconnectAttempt = min(self.reconnectAttempt + 1, 5)
                let delaySeconds = min(pow(1.6, Double(self.reconnectAttempt)), 12.0)
                try? await Task.sleep(nanoseconds: UInt64(delaySeconds * 1_000_000_000))
            }
        }
    }

    private func runSingleWebSocketSession() async {
        guard isPaired else { return }
        let wsURL: URL
        do {
            wsURL = try makeWebSocketURL()
        } catch {
            return
        }

        let task = urlSession.webSocketTask(with: wsURL)
        self.webSocketTask = task
        task.resume()

        isWebSocketConnected = true
        connectionStatus = .connected
        reconnectAttempt = 0

        while !Task.isCancelled {
            do {
                let message = try await task.receive()
                switch message {
                case .string(let text):
                    handleWebSocketText(text)
                case .data(let data):
                    handleWebSocketData(data)
                @unknown default:
                    break
                }
            } catch {
                break
            }
        }

        task.cancel(with: .goingAway, reason: nil)
        if self.webSocketTask === task {
            self.webSocketTask = nil
        }
        isWebSocketConnected = false
    }

    private func handleWebSocketText(_ text: String) {
        guard let data = text.data(using: .utf8) else { return }
        handleWebSocketData(data)
    }

    private func handleWebSocketData(_ data: Data) {
        if let frame = try? decoder.decode(MobileWSFrame.self, from: data),
           let state = frame.extractedState {
            applyState(state)
            if !selectedSessionId.isEmpty, activeSessionStatus == "running" {
                Task { await loadConversation(sessionId: selectedSessionId) }
            }
            return
        }
        if let state = try? decoder.decode(MobileStateResponse.self, from: data),
           state.activities != nil || state.sources != nil || state.sessions != nil || state.currentCwd != nil {
            applyState(state)
        }
    }

    private func startPollingFallback() {
        pollingTask?.cancel()
        pollingTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                if Task.isCancelled { break }
                guard self.isPaired else { continue }
                // Always poll if WebSocket is offline, or periodically when running
                if !self.isWebSocketConnected || self.isSending || self.activeSessionStatus == "running" {
                    await self.refreshState()
                    if !self.selectedSessionId.isEmpty && (self.isSending || self.activeSessionStatus == "running") {
                        await self.loadConversation(sessionId: self.selectedSessionId)
                    }
                }
            }
        }
    }

    // MARK: - Banner Toast

    func showBanner(_ text: String) {
        statusBanner = text
        bannerDismissTask?.cancel()
        bannerDismissTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            guard !Task.isCancelled else { return }
            self?.statusBanner = nil
        }
    }
}
