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
        NSColor.black.setFill()
        shape.fill()
    }
}

final class FlippedContentView: NSView {
    override var isFlipped: Bool { true }
}

private func stylePillButton(
    _ button: NSButton,
    title: String,
    fontSize: CGFloat = 11,
    weight: NSFont.Weight = .medium,
    textColor: NSColor = .white,
    backgroundColor: NSColor? = nil,
    borderColor: NSColor? = nil,
    cornerRadius: CGFloat = 7
) {
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = .center
    button.attributedTitle = NSAttributedString(
        string: title,
        attributes: [
            .font: NSFont.systemFont(ofSize: fontSize, weight: weight),
            .foregroundColor: textColor,
            .paragraphStyle: paragraph,
        ]
    )
    if let bg = backgroundColor {
        button.wantsLayer = true
        button.layer?.cornerRadius = cornerRadius
        button.layer?.backgroundColor = bg.cgColor
    }
    if let border = borderColor {
        button.wantsLayer = true
        button.layer?.borderWidth = 1
        button.layer?.borderColor = border.cgColor
    } else if backgroundColor != nil {
        button.layer?.borderWidth = 0
    }
}

final class PetRow {
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
    let label: String
    let cardView: FlippedContentView
    let titleLabel: NSTextField
    let sessionBadge: NSTextField
    let status: NSTextField
    let openButton: NSButton
    let followButton: NSButton

    init(
        id: String,
        label: String,
        y: CGFloat,
        in view: NSView,
        target: AnyObject,
        openAction: Selector,
        followAction: Selector
    ) {
        self.id = id
        self.label = label

        cardView = FlippedContentView(frame: NSRect(x: 14, y: y + 4, width: 352, height: 48))
        cardView.wantsLayer = true
        cardView.layer?.cornerRadius = 11
        cardView.layer?.backgroundColor = NSColor(white: 1.0, alpha: 0.055).cgColor
        cardView.layer?.borderWidth = 1
        cardView.layer?.borderColor = NSColor(white: 1.0, alpha: 0.06).cgColor

        let icon = NSImageView(frame: NSRect(x: 10, y: 10, width: 28, height: 28))
        let iconURL = PetRow.iconsDir.appendingPathComponent("\(id).png")
        let fallbackURL = PetRow.iconsDir.appendingPathComponent("dsh.png")
        icon.image = NSImage(contentsOf: iconURL) ?? NSImage(contentsOf: fallbackURL)
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.wantsLayer = true
        icon.layer?.cornerRadius = 6
        icon.layer?.masksToBounds = true

        titleLabel = NSTextField(labelWithString: label)
        titleLabel.frame = NSRect(x: 46, y: 7, width: 176, height: 17)
        titleLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        titleLabel.textColor = .white
        titleLabel.lineBreakMode = .byTruncatingTail

        sessionBadge = NSTextField(labelWithString: "")
        sessionBadge.frame = NSRect(x: 120, y: 8, width: 52, height: 15)
        sessionBadge.font = .systemFont(ofSize: 10, weight: .medium)
        sessionBadge.textColor = NSColor(white: 1.0, alpha: 0.72)
        sessionBadge.alignment = .center
        sessionBadge.wantsLayer = true
        sessionBadge.layer?.cornerRadius = 5
        sessionBadge.layer?.backgroundColor = NSColor(white: 1.0, alpha: 0.1).cgColor
        sessionBadge.isHidden = true

        status = NSTextField(labelWithString: "")
        status.frame = NSRect(x: 46, y: 25, width: 176, height: 15)
        status.font = .systemFont(ofSize: 11)
        status.lineBreakMode = .byTruncatingTail

        openButton = NSButton(title: "打开", target: target, action: openAction)
        openButton.frame = NSRect(x: 230, y: 12, width: 46, height: 24)
        openButton.isBordered = false
        openButton.identifier = NSUserInterfaceItemIdentifier(id)
        stylePillButton(
            openButton,
            title: "打开",
            fontSize: 11,
            weight: .medium,
            textColor: NSColor(white: 1.0, alpha: 0.85),
            backgroundColor: NSColor(white: 1.0, alpha: 0.08),
            cornerRadius: 7
        )

        followButton = NSButton(title: "跟随", target: target, action: followAction)
        followButton.frame = NSRect(x: 282, y: 12, width: 60, height: 24)
        followButton.isBordered = false
        followButton.identifier = NSUserInterfaceItemIdentifier(id)
        stylePillButton(
            followButton,
            title: "跟随",
            fontSize: 11,
            weight: .medium,
            textColor: .white,
            backgroundColor: NSColor(white: 1.0, alpha: 0.12),
            cornerRadius: 7
        )

        [icon, titleLabel, sessionBadge, status, openButton, followButton].forEach(cardView.addSubview)
        view.addSubview(cardView)
    }

    func updateLayout(sessionCount: Int) {
        let maxMiddleRight: CGFloat = 222
        let titleStartX: CGFloat = 46
        if sessionCount > 0 {
            let badgeText = "\(sessionCount) 会话"
            sessionBadge.stringValue = badgeText
            sessionBadge.sizeToFit()
            let badgeWidth = min(68, ceil(sessionBadge.frame.width) + 10)
            let maxTitleWidth = max(48, maxMiddleRight - titleStartX - badgeWidth - 6)
            titleLabel.stringValue = label
            titleLabel.sizeToFit()
            let titleWidth = min(maxTitleWidth, ceil(titleLabel.frame.width))
            titleLabel.frame = NSRect(x: titleStartX, y: 7, width: titleWidth, height: 17)
            sessionBadge.frame = NSRect(x: titleStartX + titleWidth + 6, y: 8, width: badgeWidth, height: 15)
            sessionBadge.isHidden = false
        } else {
            sessionBadge.isHidden = true
            titleLabel.stringValue = label
            titleLabel.frame = NSRect(x: titleStartX, y: 7, width: maxMiddleRight - titleStartX, height: 17)
        }
    }
}

final class NotchController: NSObject, NSApplicationDelegate {
    private let panelWidth: CGFloat = 380
    private let headerHeight: CGFloat = 44
    private let rowHeight: CGFloat = 56
    private let maxVisibleRows = 6
    private let footerHeight: CGFloat = 46

    private var panel: NotchPanel!
    private var state: [String: Any] = [:]
    private var renderedKey = ""
    private var rows: [PetRow] = []
    private var summaryPill: NSTextField!
    private var automatic: NSButton!
    private var resetButton: NSButton!
    private var visibilityButton: NSButton!
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
        panel.title = "小鑫 · 原生刘海"
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.appearance = NSAppearance(named: .darkAqua)
        panel.onEscape = { [weak self] in self?.setExpanded(false) }

        updateGeometry(forceRebuild: true)
        NotificationCenter.default.addObserver(self, selector: #selector(screensChanged), name: NSApplication.didChangeScreenParametersNotification, object: nil)
        timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in self?.trackPointer() }
        globalClick = NSEvent.addGlobalMonitorForEvents(matching: .leftMouseDown) { [weak self] _ in self?.clickNotch() }
        localClick = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] event in self?.clickNotch(); return event }

        DispatchQueue.global(qos: .utility).async { [weak self] in
            while let line = readLine() {
                guard let data = line.data(using: .utf8),
                      let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                DispatchQueue.main.async { self?.receive(value) }
            }
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
        publishStatus()
    }

    private func sourceSpecs() -> [(id: String, label: String)] {
        let sources = state["sources"] as? [[String: Any]] ?? []
        let parsed: [(id: String, label: String)] = sources.compactMap { row in
            guard let id = row["id"] as? String, !id.isEmpty else { return nil }
            let label = (row["label"] as? String) ?? id
            return (id, label)
        }
        return parsed.isEmpty ? [("dsh", "DSH")] : parsed
    }

    @objc private func screensChanged() {
        updateGeometry(forceRebuild: true)
        publishStatus()
    }

    private func updateGeometry(forceRebuild: Bool = false) {
        let notched = NSScreen.screens.first { $0.safeAreaInsets.top > 0 && $0.auxiliaryTopLeftArea != nil && $0.auxiliaryTopRightArea != nil }
        targetScreen = notched ?? NSScreen.main ?? NSScreen.screens.first
        guard let screen = targetScreen else { return }
        if let left = notched?.auxiliaryTopLeftArea, let right = notched?.auxiliaryTopRightArea {
            safeHeight = screen.safeAreaInsets.top
            physicalNotch = NSRect(x: left.maxX, y: screen.frame.maxY - safeHeight, width: right.minX - left.maxX, height: safeHeight)
        } else {
            physicalNotch = nil
            safeHeight = 0
        }

        let specs = sourceSpecs()
        let key = specs.map { "\($0.id):\($0.label)" }.joined(separator: "|")
        let visibleRows = min(max(1, specs.count), maxVisibleRows)
        let scrollHeight = CGFloat(visibleRows) * rowHeight
        let height = safeHeight + headerHeight + scrollHeight + footerHeight
        let center = physicalNotch?.midX ?? screen.frame.midX
        let nextFrame = NSRect(x: center - panelWidth / 2, y: screen.frame.maxY - height, width: panelWidth, height: height)

        let sizeChanged = abs(panel.frame.height - height) > 0.5 || abs(panel.frame.width - panelWidth) > 0.5
        panel.setFrame(nextFrame, display: true)

        if forceRebuild || sizeChanged || key != renderedKey {
            renderedKey = key
            buildControls(specs: specs, height: height, scrollHeight: scrollHeight)
        } else {
            render()
        }

        if expanded { panel.orderFrontRegardless() } else { panel.orderOut(nil) }
    }

    private func buildControls(specs: [(id: String, label: String)], height: CGFloat, scrollHeight: CGFloat) {
        let background = IslandBackground(frame: NSRect(origin: .zero, size: NSSize(width: panelWidth, height: height)))
        panel.contentView = background

        let headerBottom = height - safeHeight - headerHeight
        let title = NSTextField(labelWithString: "小鑫")
        title.frame = NSRect(x: 18, y: headerBottom + 11, width: 34, height: 20)
        title.font = .systemFont(ofSize: 14, weight: .semibold)
        title.textColor = .white
        background.addSubview(title)

        summaryPill = NSTextField(labelWithString: "")
        summaryPill.frame = NSRect(x: 56, y: headerBottom + 12, width: 140, height: 18)
        summaryPill.font = .systemFont(ofSize: 10.5, weight: .medium)
        summaryPill.alignment = .center
        summaryPill.lineBreakMode = .byTruncatingTail
        summaryPill.wantsLayer = true
        summaryPill.layer?.cornerRadius = 9
        background.addSubview(summaryPill)

        let manageButton = NSButton(title: "＋ 接入", target: self, action: #selector(openManager))
        manageButton.frame = NSRect(x: panelWidth - 14 - 26 - 6 - 62, y: headerBottom + 10, width: 62, height: 22)
        manageButton.isBordered = false
        manageButton.toolTip = "管理与接入本机 AI Agent"
        manageButton.setAccessibilityLabel("管理与接入本机 AI Agent")
        stylePillButton(
            manageButton,
            title: "＋ 接入",
            fontSize: 11,
            weight: .medium,
            textColor: NSColor(white: 1.0, alpha: 0.9),
            backgroundColor: NSColor(white: 1.0, alpha: 0.1),
            cornerRadius: 11
        )
        background.addSubview(manageButton)

        let close = NSButton(image: NSImage(systemSymbolName: "chevron.up", accessibilityDescription: "收起面板")!, target: self, action: #selector(collapse))
        close.frame = NSRect(x: panelWidth - 14 - 26, y: headerBottom + 9, width: 26, height: 24)
        close.isBordered = false
        close.contentTintColor = .secondaryLabelColor
        background.addSubview(close)

        let scrollY = footerHeight
        let scroll = NSScrollView(frame: NSRect(x: 0, y: scrollY, width: panelWidth, height: scrollHeight))
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = specs.count > maxVisibleRows
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay

        let docHeight = CGFloat(max(1, specs.count)) * rowHeight
        let docView = FlippedContentView(frame: NSRect(x: 0, y: 0, width: panelWidth, height: docHeight))
        rows = specs.enumerated().map { idx, spec in
            PetRow(
                id: spec.id,
                label: spec.label,
                y: CGFloat(idx) * rowHeight,
                in: docView,
                target: self,
                openAction: #selector(openApp(_:)),
                followAction: #selector(followPet(_:))
            )
        }
        scroll.documentView = docView
        background.addSubview(scroll)

        let divider = NSView(frame: NSRect(x: 16, y: footerHeight - 1, width: panelWidth - 32, height: 1))
        divider.wantsLayer = true
        divider.layer?.backgroundColor = NSColor(white: 1.0, alpha: 0.08).cgColor
        background.addSubview(divider)

        automatic = NSButton(title: "自动跟随", target: self, action: #selector(followAutomatically))
        automatic.frame = NSRect(x: 16, y: 13, width: 96, height: 24)
        automatic.isBordered = false
        background.addSubview(automatic)

        resetButton = NSButton(title: "归位", target: self, action: #selector(resetPet))
        resetButton.frame = NSRect(x: panelWidth - 16 - 76 - 8 - 50, y: 13, width: 50, height: 24)
        resetButton.isBordered = false
        stylePillButton(
            resetButton,
            title: "归位",
            fontSize: 11,
            weight: .medium,
            textColor: NSColor(white: 1.0, alpha: 0.82),
            backgroundColor: NSColor(white: 1.0, alpha: 0.08),
            cornerRadius: 7
        )
        background.addSubview(resetButton)

        visibilityButton = NSButton(title: "收回刘海", target: self, action: #selector(toggleVisibility))
        visibilityButton.frame = NSRect(x: panelWidth - 16 - 76, y: 13, width: 76, height: 24)
        visibilityButton.isBordered = false
        background.addSubview(visibilityButton)

        message = NSTextField(labelWithString: "")
        message.frame = NSRect(x: 16, y: 1, width: panelWidth - 32, height: 12)
        message.font = .systemFont(ofSize: 10)
        message.textColor = .systemOrange
        background.addSubview(message)

        render()
    }

    private func render() {
        let source = state["source"] as? String ?? "auto"
        let activeSource = state["activeSource"] as? String ?? "dsh"
        let visible = state["visible"] as? Bool ?? false
        let sources = state["sources"] as? [[String: Any]] ?? []

        let runningCount = sources.filter { ($0["status"] as? String) == "running" }.count
        let waitingCount = sources.filter { ["waiting", "blocked"].contains($0["status"] as? String ?? "") }.count
        if let pill = summaryPill {
            let pillText: String
            let pillColor: NSColor
            let pillBg: NSColor
            if waitingCount > 0 {
                pillText = "● \(waitingCount) 个待确认"
                pillColor = .systemOrange
                pillBg = NSColor.systemOrange.withAlphaComponent(0.18)
            } else if runningCount > 0 {
                pillText = "● \(runningCount) 个运行中"
                pillColor = .systemGreen
                pillBg = NSColor.systemGreen.withAlphaComponent(0.18)
            } else {
                pillText = "已接入 \(max(1, sources.count)) 个 · 空闲"
                pillColor = NSColor(white: 1.0, alpha: 0.68)
                pillBg = NSColor(white: 1.0, alpha: 0.08)
            }
            pill.stringValue = pillText
            pill.textColor = pillColor
            pill.layer?.backgroundColor = pillBg.cgColor
            pill.sizeToFit()
            let maxPillWidth = panelWidth - 14 - 26 - 6 - 62 - 8 - 56
            let pillWidth = min(maxPillWidth, max(76, ceil(pill.frame.width) + 14))
            pill.frame = NSRect(x: 56, y: pill.frame.origin.y, width: pillWidth, height: 18)
        }

        for row in rows {
            let info = sources.first { ($0["id"] as? String) == row.id }
            let status = info?["status"] as? String ?? "idle"
            let sessionCount = info?["sessionCount"] as? Int ?? 0
            row.updateLayout(sessionCount: sessionCount)
            row.status.stringValue = info?["detail"] as? String ?? "等待首个任务"
            row.status.textColor = ["waiting", "blocked"].contains(status)
                ? .systemOrange
                : status == "running" ? .systemGreen : .secondaryLabelColor

            let isLocked = source == row.id
            let isAutoFollowing = source == "auto" && activeSource == row.id && visible
            let isFollowed = (isLocked && visible) || isAutoFollowing

            if ["waiting", "blocked"].contains(status) {
                row.cardView.layer?.borderColor = NSColor.systemOrange.withAlphaComponent(0.5).cgColor
            } else if status == "running" {
                row.cardView.layer?.borderColor = NSColor.systemGreen.withAlphaComponent(0.45).cgColor
            } else if isFollowed {
                row.cardView.layer?.borderColor = NSColor(red: 0.45, green: 0.72, blue: 1.0, alpha: 0.28).cgColor
            } else {
                row.cardView.layer?.borderColor = NSColor(white: 1.0, alpha: 0.06).cgColor
            }

            if isLocked {
                stylePillButton(
                    row.followButton,
                    title: "✓ 锁定",
                    fontSize: 11,
                    weight: .semibold,
                    textColor: .white,
                    backgroundColor: NSColor.systemBlue.withAlphaComponent(0.55),
                    borderColor: NSColor.systemBlue.withAlphaComponent(0.8),
                    cornerRadius: 7
                )
                row.followButton.setAccessibilityLabel("取消锁定 \(row.label)，切回自动跟随")
            } else if isAutoFollowing {
                stylePillButton(
                    row.followButton,
                    title: "跟随中",
                    fontSize: 11,
                    weight: .medium,
                    textColor: NSColor(red: 0.62, green: 0.82, blue: 1.0, alpha: 1.0),
                    backgroundColor: NSColor.systemBlue.withAlphaComponent(0.22),
                    borderColor: NSColor.systemBlue.withAlphaComponent(0.45),
                    cornerRadius: 7
                )
                row.followButton.setAccessibilityLabel("锁定小鑫跟随 \(row.label)")
            } else {
                stylePillButton(
                    row.followButton,
                    title: "跟随",
                    fontSize: 11,
                    weight: .medium,
                    textColor: .white,
                    backgroundColor: NSColor(white: 1.0, alpha: 0.12),
                    cornerRadius: 7
                )
                row.followButton.setAccessibilityLabel("放出小鑫并跟随 \(row.label)")
            }
            row.openButton.setAccessibilityLabel("打开 \(row.label)")
        }

        if let automatic = automatic {
            let isAuto = source == "auto"
            stylePillButton(
                automatic,
                title: isAuto ? "✓ 自动跟随" : "自动跟随",
                fontSize: 11,
                weight: isAuto ? .semibold : .medium,
                textColor: isAuto ? .white : NSColor(white: 1.0, alpha: 0.72),
                backgroundColor: isAuto ? NSColor.systemBlue.withAlphaComponent(0.32) : NSColor(white: 1.0, alpha: 0.06),
                borderColor: isAuto ? NSColor.systemBlue.withAlphaComponent(0.55) : nil,
                cornerRadius: 7
            )
        }
        if let visibilityButton = visibilityButton {
            stylePillButton(
                visibilityButton,
                title: visible ? "收回刘海" : "放出小鑫",
                fontSize: 11,
                weight: .medium,
                textColor: .white,
                backgroundColor: visible ? NSColor(white: 1.0, alpha: 0.1) : NSColor.systemBlue.withAlphaComponent(0.55),
                cornerRadius: 7
            )
        }
    }

    private func receive(_ value: [String: Any]) {
        switch value["type"] as? String {
        case "state":
            state = value["state"] as? [String: Any] ?? [:]
            let specs = sourceSpecs()
            let key = specs.map { "\($0.id):\($0.label)" }.joined(separator: "|")
            if key != renderedKey {
                updateGeometry()
                publishStatus()
            } else {
                render()
            }
        case "expand":
            setExpanded(value["value"] as? Bool ?? false)
        case "error":
            message?.stringValue = "操作未完成，请稍后重试"
        default:
            break
        }
    }

    private func trackPointer() {
        let point = NSEvent.mouseLocation
        let now = ProcessInfo.processInfo.systemUptime
        if expanded {
            if panel.frame.contains(point) {
                leaveTime = nil
            } else {
                leaveTime = leaveTime ?? now
                if now - leaveTime! > 0.65 { setExpanded(false) }
            }
        } else if physicalNotch?.contains(point) == true {
            enterTime = enterTime ?? now
            if now - enterTime! >= 0.2 { setExpanded(true) }
        } else {
            enterTime = nil
        }
    }

    private func clickNotch() {
        if physicalNotch?.contains(NSEvent.mouseLocation) == true { setExpanded(true) }
    }

    private func setExpanded(_ value: Bool) {
        guard value != expanded else { return }
        expanded = value
        enterTime = nil
        leaveTime = nil
        if value { panel.orderFrontRegardless() } else { panel.orderOut(nil) }
        publishStatus()
    }

    private func emit(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value),
              let line = String(data: data, encoding: .utf8) else { return }
        print(line)
        fflush(stdout)
    }

    private func publishStatus() {
        emit([
            "type": "status",
            "expanded": expanded,
            "nativeNotch": physicalNotch != nil,
            "frame": ["x": panel.frame.minX, "y": panel.frame.minY, "width": panel.frame.width, "height": panel.frame.height],
            "screenTop": targetScreen?.frame.maxY ?? 0,
        ])
    }

    @objc private func collapse() { setExpanded(false) }
    @objc private func openManager() { setExpanded(false); emit(["type": "action", "action": "manage"]) }
    @objc private func followAutomatically() {
        message?.stringValue = ""
        emit(["type": "action", "action": "source", "value": "auto"])
    }
    @objc private func resetPet() {
        message?.stringValue = ""
        emit(["type": "action", "action": "reset"])
    }
    @objc private func toggleVisibility() {
        let visible = state["visible"] as? Bool ?? false
        message?.stringValue = ""
        emit(["type": "action", "action": visible ? "hide" : "show"])
    }
    @objc private func openApp(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue else { return }
        message?.stringValue = ""
        emit(["type": "action", "action": "open", "value": id])
    }
    @objc private func followPet(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue else { return }
        let source = state["source"] as? String ?? "auto"
        let visible = state["visible"] as? Bool ?? false
        message?.stringValue = ""
        if source == id {
            if visible {
                emit(["type": "action", "action": "source", "value": "auto"])
            } else {
                emit(["type": "action", "action": "show", "value": id])
            }
        } else {
            emit(["type": "action", "action": "show", "value": id])
        }
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
