import AppKit
import CoreGraphics

// Allow this window inside the menu-bar band; Electron clamps it below it.
final class NotchPanel: NSPanel {
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
    var onEscape: (() -> Void)?
    override func cancelOperation(_ sender: Any?) { onEscape?() }
}
final class IslandBackground: NSView {
    override var isOpaque: Bool { false }
    override func draw(_ dirtyRect: NSRect) {
        let shape = NSBezierPath(roundedRect: bounds, xRadius: 24, yRadius: 24)
        shape.appendRect(NSRect(x: 0, y: bounds.height - 24, width: bounds.width, height: 24))
        NSColor.black.setFill(); shape.fill()
    }
}
final class PetRow {
    static let labels = ["dsh": "DSH", "workbuddy": "WorkBuddy", "antigravity": "Antigravity", "codex": "Codex"]
    private static let iconsDir: URL = {
        if let custom = ProcessInfo.processInfo.environment["AGENT_PET_ICONS"], !custom.isEmpty {
            return URL(fileURLWithPath: custom)
        }
        return URL(fileURLWithPath: CommandLine.arguments[0])
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("assets/icons")
    }()
    let id: String
    let status: NSTextField
    let button: NSButton
    init(id: String, label: String, y: CGFloat, in view: NSView, target: AnyObject, action: Selector) {
        self.id = id
        let icon = NSImageView(frame: NSRect(x: 20, y: y + 12, width: 28, height: 28))
        icon.image = NSImage(contentsOf: PetRow.iconsDir.appendingPathComponent("\(id).png"))
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.wantsLayer = true
        icon.layer?.cornerRadius = 6
        icon.layer?.masksToBounds = true
        let title = NSTextField(labelWithString: label)
        title.frame = NSRect(x: 62, y: y + 25, width: 180, height: 18)
        title.font = .systemFont(ofSize: 13, weight: .medium); title.textColor = .white
        status = NSTextField(labelWithString: "")
        status.frame = NSRect(x: 62, y: y + 8, width: 190, height: 16)
        status.font = .systemFont(ofSize: 11); status.lineBreakMode = .byTruncatingTail
        button = NSButton(title: "放出", target: target, action: action)
        button.frame = NSRect(x: 280, y: y + 11, width: 60, height: 30)
        button.bezelStyle = .rounded; button.font = .systemFont(ofSize: 12)
        button.identifier = NSUserInterfaceItemIdentifier(id)
        [icon, title, status, button].forEach(view.addSubview)
    }
}
final class NotchController: NSObject, NSApplicationDelegate {
    private var panel: NotchPanel!
    private var state: [String: Any] = [:]
    private var rows: [PetRow] = []
    private var automatic: NSButton!
    private var location: NSTextField!
    private var message: NSTextField!
    private var expanded = false
    private var physicalNotch: NSRect?
    private var targetScreen: NSScreen?
    private var safeHeight: CGFloat = 32
    private var enterTime: TimeInterval?
    private var leaveTime: TimeInterval?
    private var timer: Timer?
    private var globalClick: Any?
    private var localClick: Any?
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        panel = NotchPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "Agent Pet 原生刘海"; panel.isOpaque = false; panel.backgroundColor = .clear; panel.hasShadow = false
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.hidesOnDeactivate = false; panel.isReleasedWhenClosed = false
        panel.appearance = NSAppearance(named: .darkAqua)
        panel.onEscape = { [weak self] in self?.setExpanded(false) }
        updateGeometry()
        NotificationCenter.default.addObserver(self, selector: #selector(screensChanged), name: NSApplication.didChangeScreenParametersNotification, object: nil)
        timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in self?.trackPointer() }
        globalClick = NSEvent.addGlobalMonitorForEvents(matching: .leftMouseDown) { [weak self] _ in self?.clickNotch() }
        localClick = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] event in self?.clickNotch(); return event }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            while let line = readLine() {
                guard let data = line.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                DispatchQueue.main.async { self?.receive(value) }
            }
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
        publishStatus()
    }
    @objc private func screensChanged() { updateGeometry(); publishStatus() }
    private func updateGeometry() {
        let notched = NSScreen.screens.first { $0.safeAreaInsets.top > 0 && $0.auxiliaryTopLeftArea != nil && $0.auxiliaryTopRightArea != nil }
        targetScreen = notched ?? NSScreen.main ?? NSScreen.screens.first
        guard let screen = targetScreen else { return }
        if let left = notched?.auxiliaryTopLeftArea, let right = notched?.auxiliaryTopRightArea {
            safeHeight = screen.safeAreaInsets.top
            physicalNotch = NSRect(x: left.maxX, y: screen.frame.maxY - safeHeight, width: right.minX - left.maxX, height: safeHeight)
        } else { physicalNotch = nil; safeHeight = 0 } // Notchless screens use the tray only.
        let width: CGFloat = 360; let height = safeHeight + 312
        let center = physicalNotch?.midX ?? screen.frame.midX
        panel.setFrame(NSRect(x: center - width / 2, y: screen.frame.maxY - height, width: width, height: height), display: true)
        buildControls()
        if expanded { panel.orderFrontRegardless() } else { panel.orderOut(nil) }
    }
    private func buildControls() {
        let background = IslandBackground(frame: NSRect(origin: .zero, size: panel.frame.size)); panel.contentView = background
        let title = NSTextField(labelWithString: "宠物")
        title.frame = NSRect(x: 20, y: 276, width: 200, height: 20); title.font = .systemFont(ofSize: 14, weight: .semibold); title.textColor = .white
        background.addSubview(title)
        let close = NSButton(image: NSImage(systemSymbolName: "chevron.up", accessibilityDescription: "收起面板")!, target: self, action: #selector(collapse))
        close.frame = NSRect(x: 312, y: 274, width: 28, height: 26); close.isBordered = false; close.contentTintColor = .secondaryLabelColor
        background.addSubview(close)
        rows = [PetRow(id: "dsh", label: "DSH", y: 214, in: background, target: self, action: #selector(togglePet)),
                PetRow(id: "workbuddy", label: "WorkBuddy", y: 158, in: background, target: self, action: #selector(togglePet)),
                PetRow(id: "antigravity", label: "Antigravity", y: 102, in: background, target: self, action: #selector(togglePet)),
                PetRow(id: "codex", label: "Codex", y: 46, in: background, target: self, action: #selector(togglePet))]
        automatic = NSButton(title: "自动跟随", target: self, action: #selector(followAutomatically))
        automatic.frame = NSRect(x: 16, y: 16, width: 106, height: 24); automatic.isBordered = false; automatic.alignment = .left; automatic.font = .systemFont(ofSize: 11)
        background.addSubview(automatic)
        location = NSTextField(labelWithString: "")
        location.frame = NSRect(x: 190, y: 19, width: 150, height: 18); location.alignment = .right; location.textColor = .secondaryLabelColor; location.font = .systemFont(ofSize: 11)
        background.addSubview(location)
        message = NSTextField(labelWithString: "")
        message.frame = NSRect(x: 20, y: 2, width: 320, height: 14); message.font = .systemFont(ofSize: 10); message.textColor = .systemOrange
        background.addSubview(message); render()
    }
    private func render() {
        let source = state["source"] as? String ?? "auto", visible = state["visible"] as? Bool ?? false
        let sources = state["sources"] as? [[String: Any]] ?? []
        for row in rows {
            let info = sources.first { ($0["id"] as? String) == row.id }
            row.status.stringValue = info?["detail"] as? String ?? "未连接"
            let status = info?["status"] as? String ?? "idle"
            row.status.textColor = ["waiting", "blocked"].contains(status) ? .systemOrange : status == "running" ? .systemGreen : .secondaryLabelColor
            let showing = source == row.id && visible, label = PetRow.labels[row.id] ?? row.id
            row.button.title = showing ? "收起" : "放出"
            row.button.setAccessibilityLabel(showing ? "将 \(label) 宠物收回刘海" : "放出宠物并跟随 \(label)")
        }
        automatic?.title = source == "auto" ? "✓ 自动跟随" : "自动跟随"
        location?.stringValue = visible ? "桌面显示中" : "已收回刘海"
    }
    private func receive(_ value: [String: Any]) {
        switch value["type"] as? String {
        case "state": state = value["state"] as? [String: Any] ?? [:]; render()
        case "expand": setExpanded(value["value"] as? Bool ?? false)
        case "error": message.stringValue = "操作未完成，请稍后重试"
        default: break
        }
    }
    private func trackPointer() {
        let point = NSEvent.mouseLocation, now = ProcessInfo.processInfo.systemUptime
        if expanded {
            if panel.frame.contains(point) { leaveTime = nil }
            else { leaveTime = leaveTime ?? now; if now - leaveTime! > 0.65 { setExpanded(false) } }
        } else if physicalNotch?.contains(point) == true {
            enterTime = enterTime ?? now; if now - enterTime! >= 0.2 { setExpanded(true) }
        } else { enterTime = nil }
    }
    private func clickNotch() { if physicalNotch?.contains(NSEvent.mouseLocation) == true { setExpanded(true) } }
    private func setExpanded(_ value: Bool) {
        guard value != expanded else { return }
        expanded = value; enterTime = nil; leaveTime = nil
        if value { panel.orderFrontRegardless() } else { panel.orderOut(nil) }
        publishStatus()
    }
    private func emit(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value), let line = String(data: data, encoding: .utf8) else { return }
        print(line); fflush(stdout)
    }
    private func publishStatus() {
        emit(["type": "status", "expanded": expanded, "nativeNotch": physicalNotch != nil,
              "frame": ["x": panel.frame.minX, "y": panel.frame.minY, "width": panel.frame.width, "height": panel.frame.height], "screenTop": targetScreen?.frame.maxY ?? 0])
    }
    @objc private func collapse() { setExpanded(false) }
    @objc private func followAutomatically() { emit(["type": "action", "action": "source", "value": "auto"]) }
    @objc private func togglePet(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue else { return }
        let showing = (state["visible"] as? Bool ?? false) && state["source"] as? String == id
        message.stringValue = ""; emit(["type": "action", "action": showing ? "hide" : "show", "value": id])
    }
    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        if let monitor = globalClick { NSEvent.removeMonitor(monitor) }
        if let monitor = localClick { NSEvent.removeMonitor(monitor) }
    }
}
let delegate = NotchController()
NSApplication.shared.delegate = delegate
NSApplication.shared.run()
