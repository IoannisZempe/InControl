// InControl native macOS side panel.
// A frosted Apple-style floating HUD panel docked to the right edge of the screen that hosts the
// InControl web UI, plus a menu bar item showing how many agents need your input.
//
// Build: swiftc -O macos/InControlPanel.swift -o macos/incontrol-panel -framework Cocoa -framework WebKit
// Run:   ./macos/incontrol-panel http://localhost:4747

import Cocoa
import WebKit
import Carbon

final class SidePanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

final class EdgeHandleView: NSView {
    var urgentCount: Int = 0 { didSet { needsDisplay = true } }
    var stayHidden: Bool = false { didSet { needsDisplay = true } }
    var onOpen: (() -> Void)?
    var onMovedY: ((CGFloat) -> Void)?
    private var mouseDownPoint: NSPoint?
    private var didDrag = false

    override func draw(_ dirtyRect: NSRect) {
        let rect = bounds.insetBy(dx: 1, dy: 1)
        let bgPath = NSBezierPath(roundedRect: rect, xRadius: 12, yRadius: 12)
        NSColor(calibratedRed: 0.055, green: 0.055, blue: 0.075, alpha: 0.92).setFill()
        bgPath.fill()

        let borderColor = urgentCount > 0
            ? NSColor(calibratedRed: 0.94, green: 0.28, blue: 0.25, alpha: 0.85)
            : NSColor(calibratedRed: 0.91, green: 0.77, blue: 0.41, alpha: 0.55)
        borderColor.setStroke()
        bgPath.lineWidth = 1.2
        bgPath.stroke()

        // Draw Forged Gold One Ring & Eye Emblem
        let cx = bounds.midX
        let cy = urgentCount > 0 ? bounds.height - 19 : bounds.midY
        let ringColor = urgentCount > 0
            ? NSColor(calibratedRed: 1.0, green: 0.42, blue: 0.28, alpha: 1.0)
            : NSColor(calibratedRed: 0.91, green: 0.77, blue: 0.41, alpha: 0.98)

        let ring = NSBezierPath()
        ring.appendArc(withCenter: NSPoint(x: cx, y: cy), radius: 7.5, startAngle: 0, endAngle: 360)
        ring.lineWidth = 2.0
        ringColor.setStroke()
        ring.stroke()

        let iris = NSBezierPath(ovalIn: NSRect(x: cx - 1.5, y: cy - 4.4, width: 3.0, height: 8.8))
        ringColor.setFill()
        iris.fill()

        let pupil = NSBezierPath(ovalIn: NSRect(x: cx - 0.55, y: cy - 3.0, width: 1.1, height: 6.0))
        NSColor(calibratedWhite: 0.04, alpha: 1.0).setFill()
        pupil.fill()

        if urgentCount > 0 {
            let badgeText = urgentCount > 9 ? "9+" : "\(urgentCount)"
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .bold),
                .foregroundColor: NSColor(calibratedRed: 1.0, green: 0.72, blue: 0.70, alpha: 1.0)
            ]
            let sz = (badgeText as NSString).size(withAttributes: attrs)
            (badgeText as NSString).draw(at: NSPoint(x: cx - sz.width / 2, y: 7), withAttributes: attrs)
        } else if stayHidden {
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 8.5, weight: .semibold),
                .foregroundColor: NSColor(calibratedRed: 0.91, green: 0.77, blue: 0.41, alpha: 0.75)
            ]
            let s = "☾" as NSString
            let sz = s.size(withAttributes: attrs)
            s.draw(at: NSPoint(x: cx - sz.width / 2, y: 5), withAttributes: attrs)
        }
    }

    override func mouseDown(with event: NSEvent) {
        mouseDownPoint = event.locationInWindow
        didDrag = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard let win = window, let start = mouseDownPoint else { return }
        let dy = event.locationInWindow.y - start.y
        if abs(dy) > 3 { didDrag = true }
        var f = win.frame
        f.origin.y += dy
        win.setFrame(f, display: true)
        onMovedY?(f.origin.y)
    }

    override func mouseUp(with event: NSEvent) {
        if !didDrag {
            onOpen?()
        }
    }
}

/// MacBook Pro Dynamic Notch Extension — hugs both sides of the hardware notch in compact state
/// and expands smoothly downward on hover with live agent status + 1-click Approve / Deny buttons.
final class NotchHandleView: NSView {
    var urgentCount: Int = 0 { didSet { needsDisplay = true } }
    var workingCount: Int = 0 { didSet { needsDisplay = true } }
    var stayHidden: Bool = false { didSet { needsDisplay = true } }
    var expanded: Bool = false { didSet { needsDisplay = true } }
    var topAgentId: String? = nil
    var topAgentRequestId: String? = nil
    var topAgentTitle: String = "TheOne" { didSet { needsDisplay = true } }
    var topAgentSubtitle: String = "All clear · Click or press ⌥⇧T" { didSet { needsDisplay = true } }
    var topAgentNeedsInput: Bool = false { didSet { needsDisplay = true } }

    var onOpen: (() -> Void)?
    var onHoverChange: ((Bool) -> Void)?
    var onQuickDecision: ((_ agentId: String, _ requestId: String?, _ action: String) -> Void)?

    private var trackingArea: NSTrackingArea?
    private var approveRect: NSRect = .zero
    private var denyRect: NSRect = .zero

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let existing = trackingArea {
            removeTrackingArea(existing)
        }
        let area = NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(area)
        trackingArea = area
    }

    override func mouseEntered(with event: NSEvent) {
        onHoverChange?(true)
    }

    override func mouseExited(with event: NSEvent) {
        onHoverChange?(false)
    }

    override func draw(_ dirtyRect: NSRect) {
        let w = bounds.width
        let h = bounds.height
        let r: CGFloat = expanded ? 18 : 14

        // Top-flat, bottom-rounded black capsule merging seamlessly into the MacBook Pro notch
        let path = NSBezierPath()
        path.move(to: NSPoint(x: 0, y: h))
        path.line(to: NSPoint(x: w, y: h))
        path.line(to: NSPoint(x: w, y: r))
        path.appendArc(withCenter: NSPoint(x: w - r, y: r), radius: r, startAngle: 0, endAngle: 270, clockwise: true)
        path.line(to: NSPoint(x: r, y: 0))
        path.appendArc(withCenter: NSPoint(x: r, y: r), radius: r, startAngle: 270, endAngle: 180, clockwise: true)
        path.close()

        NSColor(calibratedRed: 0.02, green: 0.02, blue: 0.03, alpha: 0.98).setFill()
        path.fill()

        let rimColor = urgentCount > 0
            ? NSColor(calibratedRed: 0.94, green: 0.28, blue: 0.25, alpha: 0.85)
            : NSColor(calibratedRed: 0.91, green: 0.77, blue: 0.41, alpha: expanded ? 0.65 : 0.42)
        rimColor.setStroke()
        path.lineWidth = 1.2
        path.stroke()

        // Top bar wings (y near top of capsule, flanking the ~185px camera notch)
        let wingCy = h - 19

        // Left Wing: Forged Gold One Ring & Eye Emblem
        let lx: CGFloat = 22
        let ringColor = urgentCount > 0
            ? NSColor(calibratedRed: 1.0, green: 0.42, blue: 0.28, alpha: 1.0)
            : NSColor(calibratedRed: 0.91, green: 0.77, blue: 0.41, alpha: 0.98)
        let ring = NSBezierPath()
        ring.appendArc(withCenter: NSPoint(x: lx, y: wingCy), radius: 7.2, startAngle: 0, endAngle: 360)
        ring.lineWidth = 1.9
        ringColor.setStroke()
        ring.stroke()

        let iris = NSBezierPath(ovalIn: NSRect(x: lx - 1.4, y: wingCy - 4.2, width: 2.8, height: 8.4))
        ringColor.setFill()
        iris.fill()

        let pupil = NSBezierPath(ovalIn: NSRect(x: lx - 0.5, y: wingCy - 2.8, width: 1.0, height: 5.6))
        NSColor(calibratedWhite: 0.04, alpha: 1.0).setFill()
        pupil.fill()

        // Right Wing: Compact status dot + count or muted moon
        let rx: CGFloat = w - 22
        if urgentCount > 0 {
            let dot = NSBezierPath(ovalIn: NSRect(x: rx - 14, y: wingCy - 3.5, width: 7, height: 7))
            NSColor(calibratedRed: 0.96, green: 0.28, blue: 0.26, alpha: 1.0).setFill()
            dot.fill()
            let txt = (urgentCount > 9 ? "9+" : "\(urgentCount)") as NSString
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .bold),
                .foregroundColor: NSColor(calibratedRed: 1.0, green: 0.78, blue: 0.75, alpha: 1.0)
            ]
            let sz = txt.size(withAttributes: attrs)
            txt.draw(at: NSPoint(x: rx - 3, y: wingCy - sz.height / 2), withAttributes: attrs)
        } else if stayHidden {
            let txt = "☾" as NSString
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
                .foregroundColor: NSColor(calibratedRed: 0.91, green: 0.77, blue: 0.41, alpha: 0.85)
            ]
            let sz = txt.size(withAttributes: attrs)
            txt.draw(at: NSPoint(x: rx - sz.width / 2, y: wingCy - sz.height / 2), withAttributes: attrs)
        } else {
            let dot = NSBezierPath(ovalIn: NSRect(x: rx - 10, y: wingCy - 3.2, width: 6.4, height: 6.4))
            NSColor(calibratedRed: 0.19, green: 0.82, blue: 0.35, alpha: 0.95).setFill()
            dot.fill()
            if workingCount > 0 {
                let txt = "\(workingCount)" as NSString
                let attrs: [NSAttributedString.Key: Any] = [
                    .font: NSFont.monospacedDigitSystemFont(ofSize: 10.5, weight: .semibold),
                    .foregroundColor: NSColor(calibratedWhite: 0.85, alpha: 0.9)
                ]
                let sz = txt.size(withAttributes: attrs)
                txt.draw(at: NSPoint(x: rx, y: wingCy - sz.height / 2), withAttributes: attrs)
            }
        }

        // Expanded Shelf Below the Hardware Notch
        approveRect = .zero
        denyRect = .zero
        guard expanded else { return }

        let padX: CGFloat = 16
        let titleY = h - 56
        let titleAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12, weight: .bold),
            .foregroundColor: NSColor.white
        ]
        (topAgentTitle as NSString).draw(
            in: NSRect(x: padX, y: titleY, width: w - padX * 2 - 70, height: 16),
            withAttributes: titleAttrs
        )

        let shortcutHint = "⌥⇧T" as NSString
        let hintAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: 10, weight: .semibold),
            .foregroundColor: NSColor(calibratedRed: 0.91, green: 0.77, blue: 0.41, alpha: 0.85)
        ]
        let hintSz = shortcutHint.size(withAttributes: hintAttrs)
        shortcutHint.draw(at: NSPoint(x: w - padX - hintSz.width, y: titleY + 1), withAttributes: hintAttrs)

        let subY = h - 74
        let subAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: 10.5, weight: .regular),
            .foregroundColor: topAgentNeedsInput
                ? NSColor(calibratedRed: 1.0, green: 0.94, blue: 0.78, alpha: 0.95)
                : NSColor(calibratedWhite: 0.65, alpha: 1.0)
        ]
        (topAgentSubtitle as NSString).draw(
            in: NSRect(x: padX, y: subY, width: w - padX * 2, height: 15),
            withAttributes: subAttrs
        )

        if topAgentNeedsInput, topAgentId != nil {
            let btnY: CGFloat = 10
            let btnH: CGFloat = 24
            let btnW: CGFloat = (w - padX * 2 - 8) / 2
            approveRect = NSRect(x: padX, y: btnY, width: btnW, height: btnH)
            denyRect = NSRect(x: padX + btnW + 8, y: btnY, width: btnW, height: btnH)

            let appPath = NSBezierPath(roundedRect: approveRect, xRadius: 7, yRadius: 7)
            NSColor(calibratedRed: 0.91, green: 0.77, blue: 0.41, alpha: 0.95).setFill()
            appPath.fill()
            let appLabel = "✓ Approve" as NSString
            let appAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 11, weight: .bold),
                .foregroundColor: NSColor(calibratedWhite: 0.05, alpha: 1.0)
            ]
            let appSz = appLabel.size(withAttributes: appAttrs)
            appLabel.draw(
                at: NSPoint(x: approveRect.midX - appSz.width / 2, y: approveRect.midY - appSz.height / 2),
                withAttributes: appAttrs
            )

            let denyPath = NSBezierPath(roundedRect: denyRect, xRadius: 7, yRadius: 7)
            NSColor(calibratedRed: 0.35, green: 0.11, blue: 0.12, alpha: 0.95).setFill()
            denyPath.fill()
            NSColor(calibratedRed: 0.94, green: 0.28, blue: 0.26, alpha: 0.55).setStroke()
            denyPath.lineWidth = 1.0
            denyPath.stroke()
            let denyLabel = "✕ Deny" as NSString
            let denyAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
                .foregroundColor: NSColor(calibratedRed: 1.0, green: 0.76, blue: 0.76, alpha: 1.0)
            ]
            let denySz = denyLabel.size(withAttributes: denyAttrs)
            denyLabel.draw(
                at: NSPoint(x: denyRect.midX - denySz.width / 2, y: denyRect.midY - denySz.height / 2),
                withAttributes: denyAttrs
            )
        }
    }

    override func mouseUp(with event: NSEvent) {
        let loc = convert(event.locationInWindow, from: nil)
        if expanded, topAgentNeedsInput, let id = topAgentId {
            if approveRect.contains(loc) {
                onQuickDecision?(id, topAgentRequestId, "approve")
                return
            }
            if denyRect.contains(loc) {
                onQuickDecision?(id, topAgentRequestId, "deny")
                return
            }
        }
        onOpen?()
    }
}

private var globalHotKeyHandlerRef: EventHandlerRef?
private weak var globalHotKeyDelegate: AppDelegate?

final class PanelWebView: WKWebView {
    var lastMouseDownEvent: NSEvent?
    var onDragFinished: (() -> Void)?

    override func mouseDown(with event: NSEvent) {
        lastMouseDownEvent = event
        // Top 18pt grabber strip always drags immediately at the native Cocoa layer
        let loc = convert(event.locationInWindow, from: nil)
        let distFromTop = isFlipped ? loc.y : (bounds.height - loc.y)
        if distFromTop <= 18 {
            window?.performDrag(with: event)
            onDragFinished?()
            return
        }
        super.mouseDown(with: event)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    var panel: SidePanel!
    var edgePanel: NSPanel!
    var edgeHandleView: EdgeHandleView!
    var notchPanel: NSPanel!
    var notchHandleView: NotchHandleView!
    var notchExpanded: Bool = false
    var edgeHandleY: CGFloat? = nil
    var webView: PanelWebView!
    var statusItem: NSStatusItem!
    var autoMenuItem: NSMenuItem?
    var stayHiddenMenuItem: NSMenuItem?
    var notchMenuItem: NSMenuItem?
    var tileMenuItem: NSMenuItem?
    var hotKeyRef: EventHotKeyRef?
    let hubURL: URL
    let explicitCliPath: String?
    var panelWidth: CGFloat = 386
    var dockSide: String = "right"
    var handleStyle: String = "notch" // "notch" | "edge"
    var popupMode: String = "needs_input"
    var autoPopupOnly: Bool = true
    var stayHidden: Bool = false
    var autoTileBesidePanel: Bool = true
    var demoMode: Bool = false
    var manuallyShown: Bool = true
    var hadUrgentAction: Bool = false
    var currentActionCount: Int = 0
    var currentWorkingCount: Int = 0
    var lastUrgentSignature: String = ""
    var dismissedSignature: String = ""
    var statePollTimer: Timer?
    var lastHubSpawnAttempt: Date = .distantPast

    init(hubURL: URL, cliPath: String? = nil) {
        self.hubURL = hubURL
        self.explicitCliPath = cliPath
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        setupPanel()
        setupEdgeHandle()
        setupNotchHandle()
        setupStatusItem()
        registerGlobalHotkey()
        positionDockFrame(animate: false)
        showMainPanel(focusForKeyboard: false)
        startStatePoller()
        NotificationCenter.default.addObserver(
            self, selector: #selector(handleScreenChange),
            name: NSApplication.didChangeScreenParametersNotification, object: nil)
    }

    func showMainPanel(focusForKeyboard: Bool = false) {
        edgePanel?.orderOut(nil)
        notchPanel?.orderOut(nil)
        notchExpanded = false
        notchHandleView?.expanded = false
        if focusForKeyboard {
            NSApp.activate(ignoringOtherApps: true)
            panel.makeKeyAndOrderFront(nil)
            panel.makeFirstResponder(webView)
        } else {
            panel.orderFrontRegardless()
        }
    }

    func hideMainPanel() {
        panel.orderOut(nil)
        if handleStyle == "notch" {
            edgePanel?.orderOut(nil)
            positionNotchHandle(expanded: false, animate: false)
            notchHandleView?.urgentCount = currentActionCount
            notchHandleView?.workingCount = currentWorkingCount
            notchHandleView?.stayHidden = stayHidden
            notchPanel?.orderFrontRegardless()
        } else {
            notchPanel?.orderOut(nil)
            positionEdgeHandle()
            edgeHandleView?.urgentCount = currentActionCount
            edgeHandleView?.stayHidden = stayHidden
            edgePanel?.orderFrontRegardless()
        }
    }

    func setupNotchHandle() {
        notchPanel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 286, height: 38),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        notchPanel.isOpaque = false
        notchPanel.backgroundColor = .clear
        notchPanel.hasShadow = true
        notchPanel.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.statusWindow)) + 1)
        notchPanel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        notchPanel.hidesOnDeactivate = false

        let view = NotchHandleView(frame: NSRect(x: 0, y: 0, width: 286, height: 38))
        view.toolTip = "TheOne Dynamic Notch · Hover for quick actions, click or press ⌥⇧T to open"
        view.onOpen = { [weak self] in
            guard let self = self else { return }
            self.stayHidden = false
            self.stayHiddenMenuItem?.state = .off
            self.manuallyShown = true
            self.updateMenuBarBadge(count: self.currentActionCount)
            self.showMainPanel(focusForKeyboard: true)
            self.pollHubState()
        }
        view.onHoverChange = { [weak self] isHovering in
            guard let self = self, !self.panel.isVisible else { return }
            self.positionNotchHandle(expanded: isHovering, animate: true)
        }
        view.onQuickDecision = { [weak self] agentId, reqId, action in
            self?.sendQuickDecision(agentId: agentId, requestId: reqId, action: action)
        }
        notchPanel.contentView = view
        self.notchHandleView = view
        positionNotchHandle(expanded: false, animate: false)
    }

    func positionNotchHandle(expanded: Bool, animate: Bool) {
        guard let notchPanel = notchPanel, let screen = panel.screen ?? NSScreen.main else { return }
        notchExpanded = expanded
        notchHandleView?.expanded = expanded
        let f = screen.frame
        let w: CGFloat = expanded ? 360 : 286
        let h: CGFloat = expanded ? (notchHandleView?.topAgentNeedsInput == true ? 114 : 84) : 38
        let x = f.midX - w / 2
        let y = f.maxY - h
        let target = NSRect(x: x, y: y, width: w, height: h)
        if animate {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.16
                ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
                notchPanel.animator().setFrame(target, display: true)
            }
        } else {
            notchPanel.setFrame(target, display: true)
        }
    }

    func sendQuickDecision(agentId: String, requestId: String?, action: String) {
        let encoded = agentId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? agentId
        guard let url = URL(string: "/api/agents/\(encoded)/respond", relativeTo: hubURL) else { return }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 4)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = ["action": action, "sourceDevice": "Mac Notch"]
        if let reqId = requestId, !reqId.isEmpty { body["requestId"] = reqId }
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: req) { [weak self] _, _, _ in
            DispatchQueue.main.async {
                self?.pollHubState()
            }
        }.resume()
    }

    func setupEdgeHandle() {
        edgePanel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 32, height: 56),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        edgePanel.isOpaque = false
        edgePanel.backgroundColor = .clear
        edgePanel.hasShadow = true
        edgePanel.level = .floating
        edgePanel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        edgePanel.hidesOnDeactivate = false

        let view = EdgeHandleView(frame: NSRect(x: 0, y: 0, width: 32, height: 56))
        view.toolTip = "Click to open TheOne (⌥⇧T) · Drag up/down to move"
        view.onOpen = { [weak self] in
            guard let self = self else { return }
            self.stayHidden = false
            self.stayHiddenMenuItem?.state = .off
            self.manuallyShown = true
            self.updateMenuBarBadge(count: self.currentActionCount)
            self.showMainPanel(focusForKeyboard: true)
            self.pollHubState()
        }
        view.onMovedY = { [weak self] newY in
            self?.edgeHandleY = newY
        }
        edgePanel.contentView = view
        self.edgeHandleView = view
        positionEdgeHandle()
    }

    func positionEdgeHandle() {
        guard let edgePanel = edgePanel, let screen = panel.screen ?? NSScreen.main else { return }
        let f = screen.visibleFrame
        let w: CGFloat = 32
        let h: CGFloat = 56
        let x = dockSide == "left" ? (f.minX + 4) : (f.maxX - w - 4)
        let defaultY = f.minY + (f.height - h) * 0.55
        let clampedY = min(max(edgeHandleY ?? defaultY, f.minY + 12), f.maxY - h - 12)
        edgePanel.setFrame(NSRect(x: x, y: clampedY, width: w, height: h), display: true)
    }

    func registerGlobalHotkey() {
        // Option + Shift + T toggles TheOne from anywhere (works with zero Accessibility permissions)
        globalHotKeyDelegate = self
        var eventSpec = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )
        let status = InstallEventHandler(
            GetApplicationEventTarget(),
            { _, _, _ in
                DispatchQueue.main.async {
                    globalHotKeyDelegate?.togglePanel()
                }
                return noErr
            },
            1,
            &eventSpec,
            nil,
            &globalHotKeyHandlerRef
        )
        if status == noErr {
            let hotKeyID = EventHotKeyID(signature: OSType(0x54484F4E), id: 1) // 'THON'
            // kVK_ANSI_T = 17
            RegisterEventHotKey(UInt32(kVK_ANSI_T), UInt32(optionKey | shiftKey), hotKeyID, GetApplicationEventTarget(), 0, &hotKeyRef)
        }
    }

    /// Native loopback poller so auto-popup works instantaneously even while WKWebView is hidden (ordered out).
    func startStatePoller() {
        statePollTimer?.invalidate()
        pollHubState()
        statePollTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            self?.pollHubState()
        }
    }

    func pollHubState() {
        if demoMode { return }
        guard let stateURL = URL(string: "/api/state", relativeTo: hubURL) else { return }
        var req = URLRequest(url: stateURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 1.5)
        req.httpMethod = "GET"
        URLSession.shared.dataTask(with: req) { [weak self] data, response, _ in
            guard let self = self,
                  let http = response as? HTTPURLResponse, http.statusCode == 200,
                  let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return
            }
            let counts = json["counts"] as? [String: Any] ?? [:]
            let settings = json["settings"] as? [String: Any] ?? [:]
            let agents = json["agents"] as? [[String: Any]] ?? []
            let mode = (settings["popupMode"] as? String) ?? self.popupMode
            let hStyle = (settings["handleStyle"] as? String) ?? self.handleStyle
            let needsInput = (counts["needs_input"] as? Int) ?? 0
            let needsAttention = (counts["needs_attention"] as? Int) ?? 0
            let workingCount = (counts["working"] as? Int) ?? 0
            let actionCount = (mode == "urgent_and_review") ? (needsInput + needsAttention) : needsInput

            let topAgent = agents.first
            let topId = topAgent?["id"] as? String
            let topStatus = topAgent?["status"] as? String ?? ""
            let topProj = (topAgent?["projectName"] as? String) ?? (topAgent?["name"] as? String) ?? "TheOne"
            let topName = (topAgent?["name"] as? String) ?? ""
            let topPrompt = topAgent?["pendingPrompt"] as? [String: Any]
            let topReqId = topPrompt?["requestId"] as? String
            let topCmd = topPrompt?["command"] as? String
            let topQ = topPrompt?["question"] as? String
            let topStep = topAgent?["currentStep"] as? String

            let urgentKeys: [String] = agents.compactMap { a in
                let st = a["status"] as? String ?? ""
                let isUrgent = (mode == "urgent_and_review")
                    ? (st == "needs_input" || st == "needs_attention")
                    : (st == "needs_input")
                guard isUrgent else { return nil }
                let id = a["id"] as? String ?? ""
                let prompt = a["pendingPrompt"] as? [String: Any]
                let reqId = prompt?["requestId"] as? String ?? st
                return "\(id):\(reqId)"
            }
            let signature = urgentKeys.sorted().joined(separator: "|")

            DispatchQueue.main.async {
                self.popupMode = mode
                self.currentWorkingCount = workingCount
                if hStyle != self.handleStyle {
                    self.handleStyle = hStyle
                    self.notchMenuItem?.state = (hStyle == "notch") ? .on : .off
                    if !self.panel.isVisible {
                        self.hideMainPanel()
                    }
                }
                if let nv = self.notchHandleView {
                    nv.workingCount = workingCount
                    nv.topAgentId = topId
                    nv.topAgentRequestId = topReqId
                    nv.topAgentNeedsInput = (topStatus == "needs_input")
                    if let _ = topAgent {
                        nv.topAgentTitle = topName.isEmpty ? topProj : "\(topProj) · \(topName)"
                        if let cmd = topCmd, !cmd.isEmpty {
                            nv.topAgentSubtitle = "$ \(cmd)"
                        } else if let q = topQ, !q.isEmpty {
                            nv.topAgentSubtitle = q
                        } else if let step = topStep, !step.isEmpty {
                            nv.topAgentSubtitle = step
                        } else {
                            nv.topAgentSubtitle = "\(workingCount) active · Click or press ⌥⇧T"
                        }
                    } else {
                        nv.topAgentTitle = "TheOne"
                        nv.topAgentSubtitle = "All clear · Click or press ⌥⇧T"
                    }
                    if self.notchExpanded && !self.panel.isVisible {
                        self.positionNotchHandle(expanded: true, animate: false)
                    }
                }
                let shouldAutoOnly = (mode != "always")
                if shouldAutoOnly != self.autoPopupOnly {
                    self.autoPopupOnly = shouldAutoOnly
                    self.autoMenuItem?.state = shouldAutoOnly ? .on : .off
                }
                if !shouldAutoOnly && !self.panel.isVisible && !self.stayHidden {
                    self.showMainPanel(focusForKeyboard: false)
                }
                self.applyUrgentState(count: actionCount, signature: signature)
            }
        }.resume()
    }

    func updateMenuBarBadge(count: Int) {
        currentActionCount = count
        statusItem.button?.image = makeMenuBarIcon(urgent: count > 0)
        if count > 0 {
            statusItem.button?.title = stayHidden ? " \(count)☾" : " \(count)"
        } else {
            statusItem.button?.title = stayHidden ? " ☾" : ""
        }
        statusItem.button?.toolTip = stayHidden
            ? "TheOne (Stay Hidden — click to reopen)"
            : (count > 0 ? "TheOne — \(count) agent\(count == 1 ? "" : "s") need attention" : "TheOne — AI Agent Mission Control")
        edgeHandleView?.urgentCount = count
        edgeHandleView?.stayHidden = stayHidden
        notchHandleView?.urgentCount = count
        notchHandleView?.stayHidden = stayHidden
    }

    func applyUrgentState(count: Int, signature: String) {
        if count > 0 {
            let isNewRequest = !hadUrgentAction || (!signature.isEmpty && signature != lastUrgentSignature)
            let isDismissed = !signature.isEmpty && signature == dismissedSignature
            updateMenuBarBadge(count: count)
            hadUrgentAction = true
            if !signature.isEmpty {
                lastUrgentSignature = signature
            }
            if !stayHidden && isNewRequest && !isDismissed {
                showMainPanel()
            }
        } else {
            updateMenuBarBadge(count: 0)
            if hadUrgentAction {
                hadUrgentAction = false
                lastUrgentSignature = ""
                dismissedSignature = ""
                manuallyShown = false
            }
            if autoPopupOnly && !manuallyShown && panel.isVisible {
                hideMainPanel()
            }
        }
    }

    // MARK: Panel

    func setupPanel() {
        panel = SidePanel(
            contentRect: NSRect(x: 0, y: 0, width: panelWidth, height: 820),
            styleMask: [.titled, .closable, .resizable, .fullSizeContentView, .nonactivatingPanel],
            backing: .buffered, defer: false)
        panel.appearance = NSAppearance(named: .darkAqua)
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.minSize = NSSize(width: 320, height: 420)
        panel.standardWindowButton(.closeButton)?.isHidden = true
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
        panel.standardWindowButton(.zoomButton)?.isHidden = true

        // Native Apple vibrancy container (popover/HUD glass material, stays active when unfocused)
        let visualEffect = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: panelWidth, height: 820))
        visualEffect.material = .popover
        visualEffect.blendingMode = .behindWindow
        visualEffect.state = .active
        visualEffect.wantsLayer = true
        visualEffect.layer?.cornerRadius = 18
        visualEffect.layer?.masksToBounds = true
        visualEffect.layer?.borderWidth = 0.8
        visualEffect.layer?.borderColor = NSColor(white: 1.0, alpha: 0.22).cgColor
        visualEffect.autoresizingMask = [.width, .height]

        let config = WKWebViewConfiguration()
        let controller = WKUserContentController()
        // Bridge:
        // 1) web UI title "(3) InControl" → menu bar badge
        // 2) native window drag from any non-interactive region in .topbar / .drag-handle
        let script = WKUserScript(source: """
            document.documentElement.classList.add('macos-panel');
            new MutationObserver(() => window.webkit.messageHandlers.badge.postMessage(document.title))
              .observe(document.querySelector('title'), { childList: true });
            window.webkit.messageHandlers.badge.postMessage(document.title);

            document.addEventListener('mousedown', (e) => {
              if (e.button !== 0) return;
              const interactive = e.target.closest('button, input, textarea, select, a, code, pre, .filter-pill, .agent-card, .modal-card');
              if (interactive) return;
              const dragZone = e.target.closest('.topbar, .drag-bar, .section-header, .empty-state');
              if (dragZone && window.webkit?.messageHandlers?.windowDrag) {
                window.webkit.messageHandlers.windowDrag.postMessage('drag');
              }
            }, true);

            document.addEventListener('dblclick', (e) => {
              if (e.target.closest('.drag-bar') && window.webkit?.messageHandlers?.windowDrag) {
                window.webkit.messageHandlers.windowDrag.postMessage('dock');
              }
            }, true);
            """, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
        controller.addUserScript(script)
        controller.add(self, name: "badge")
        controller.add(self, name: "windowDrag")
        controller.add(self, name: "panelConfig")
        config.userContentController = controller

        webView = PanelWebView(frame: visualEffect.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.customUserAgent = "Mozilla/5.0 (Macintosh) AppleWebKit Safari InControlPanel/0.2"
        webView.setValue(false, forKey: "drawsBackground")
        webView.onDragFinished = { [weak self] in
            self?.snapIfNearScreenEdge()
        }

        panel.delegate = self
        visualEffect.addSubview(webView)
        panel.contentView = visualEffect
        load()
    }

    func load() {
        WKWebsiteDataStore.default().removeData(
            ofTypes: [WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache],
            modifiedSince: Date(timeIntervalSince1970: 0)
        ) { [weak self] in
            guard let self = self else { return }
            let req = URLRequest(url: self.hubURL, cachePolicy: .reloadIgnoringLocalCacheData)
            self.webView.load(req)
        }
    }

    func resolveHubLaunchTarget() -> (executable: String, arguments: [String], cwd: URL)? {
        let fm = FileManager.default
        let env = ProcessInfo.processInfo.environment
        let incontrolHome = env["INCONTROL_HOME"] ?? fm.homeDirectoryForCurrentUser.appendingPathComponent(".incontrol").path
        let recordedCliPath = try? String(
            contentsOfFile: URL(fileURLWithPath: incontrolHome).appendingPathComponent("bin/cli-path").path,
            encoding: .utf8
        ).trimmingCharacters(in: .whitespacesAndNewlines)

        let execURL = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
        let repoRoot = execURL.deletingLastPathComponent().deletingLastPathComponent()
        let repoCliPath = repoRoot.appendingPathComponent("bin/incontrol.js").path

        let scriptCandidates = [
            explicitCliPath,
            env["INCONTROL_CLI_PATH"],
            recordedCliPath,
            repoCliPath,
        ].compactMap { $0 }.filter { !$0.isEmpty }

        if let cliPath = scriptCandidates.first(where: { fm.fileExists(atPath: $0) }) {
            let cliURL = URL(fileURLWithPath: cliPath).standardizedFileURL
            let pkgRoot = cliURL.deletingLastPathComponent().deletingLastPathComponent()
            if fm.isExecutableFile(atPath: cliPath) && !cliPath.hasSuffix(".js") {
                return (cliPath, ["start"], pkgRoot)
            }
            let pathDirs = (env["PATH"] ?? "").split(separator: ":").map { String($0) }
            var nodeCandidates = pathDirs.map { URL(fileURLWithPath: $0).appendingPathComponent("node").path }
            nodeCandidates.append(contentsOf: ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"])
            if let nodeBin = nodeCandidates.first(where: { fm.isExecutableFile(atPath: $0) }) {
                return (nodeBin, [cliPath, "start"], pkgRoot)
            }
        }

        let binCandidates = [
            "/opt/homebrew/bin/incontrol",
            "/usr/local/bin/incontrol",
            fm.homeDirectoryForCurrentUser.appendingPathComponent(".npm-global/bin/incontrol").path,
        ]
        if let globalBin = binCandidates.first(where: { fm.isExecutableFile(atPath: $0) }) {
            return (globalBin, ["start"], fm.homeDirectoryForCurrentUser)
        }
        return nil
    }

    func ensureHubRunning() {
        guard Date().timeIntervalSince(lastHubSpawnAttempt) > 8 else { return }
        lastHubSpawnAttempt = Date()

        guard let target = resolveHubLaunchTarget() else { return }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: target.executable)
        proc.arguments = target.arguments
        proc.currentDirectoryURL = target.cwd
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        try? proc.run()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        ensureHubRunning()
        let html = """
        <body style="background:transparent;color:#98989d;font:13px -apple-system;display:grid;place-items:center;height:100vh;margin:0;text-align:center">
        <div><h3 style="color:#f5f5f7;font-weight:600;margin-bottom:6px">Starting TheOne Hub…</h3>
        <p style="margin:0">Connecting to local agent watcher…</p></div></body>
        """
        webView.loadHTMLString(html, baseURL: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) { [weak self] in self?.load() }
    }

    func positionDockFrame(animate: Bool = true) {
        guard let screen = panel.screen ?? NSScreen.main else { return }
        let f = screen.visibleFrame
        let margin: CGFloat = 6
        let xPos = dockSide == "left" ? (f.minX + margin) : (f.maxX - panelWidth - margin)
        let frame = NSRect(
            x: xPos,
            y: f.minY + margin,
            width: panelWidth,
            height: f.height - (margin * 2)
        )
        panel.setFrame(frame, display: panel.isVisible, animate: animate && panel.isVisible)
    }

    /// When the user drags the panel near the left or right edge of any display, automatically
    /// snap flush to that edge, stretch to 100% of the screen's vertical height, and optionally
    /// fit the active foreground window/page alongside the panel.
    func snapIfNearScreenEdge() {
        guard let screen = panel.screen ?? NSScreen.main else { return }
        let f = screen.visibleFrame
        let snapThreshold: CGFloat = 68
        let pf = panel.frame

        if pf.minX <= f.minX + snapThreshold {
            dockSide = "left"
            panelWidth = pf.width
            positionDockFrame(animate: true)
            if autoTileBesidePanel {
                fitActiveWindowBesidePanel()
            }
        } else if pf.maxX >= f.maxX - snapThreshold {
            dockSide = "right"
            panelWidth = pf.width
            positionDockFrame(animate: true)
            if autoTileBesidePanel {
                fitActiveWindowBesidePanel()
            }
        } else if pf.maxY >= f.maxY - 36 {
            // Dragged to top edge: stretch full vertical height at current X position
            let margin: CGFloat = 6
            let frame = NSRect(
                x: pf.minX,
                y: f.minY + margin,
                width: pf.width,
                height: f.height - (margin * 2)
            )
            panel.setFrame(frame, display: true, animate: true)
        }
    }

    func windowDidEndLiveResize(_ notification: Notification) {
        guard let screen = panel.screen ?? NSScreen.main else { return }
        let f = screen.visibleFrame
        panelWidth = panel.frame.width
        if panel.frame.minX <= f.minX + 24 || panel.frame.maxX >= f.maxX - 24 {
            positionDockFrame(animate: true)
            if autoTileBesidePanel {
                fitActiveWindowBesidePanel()
            }
        }
    }

    @objc func fitActiveWindowBesidePanel() {
        guard let screen = panel.screen ?? NSScreen.main,
              let frontApp = NSWorkspace.shared.frontmostApplication,
              let appName = frontApp.localizedName,
              frontApp.processIdentifier != ProcessInfo.processInfo.processIdentifier else {
            return
        }

        let f = screen.visibleFrame
        let primaryHeight = NSScreen.screens.first?.frame.height ?? screen.frame.height
        let topY = Int(primaryHeight - f.maxY)
        let winHeight = Int(f.height)
        let gap: CGFloat = 14
        let winWidth = max(480, Int(f.width - panelWidth - gap))
        let leftX = dockSide == "left"
            ? Int(f.minX + panelWidth + gap)
            : Int(f.minX)
        let rightX = leftX + winWidth
        let bottomY = topY + winHeight

        // Parameterized AppleScript via argv (First tries standard bounds, then System Events position/size)
        let script = """
        on run argv
            set targetApp to item 1 of argv
            set x1 to (item 2 of argv) as integer
            set y1 to (item 3 of argv) as integer
            set x2 to (item 4 of argv) as integer
            set y2 to (item 5 of argv) as integer
            set w to (item 6 of argv) as integer
            set h to (item 7 of argv) as integer
            tell application "System Events"
                if exists process targetApp then
                    tell process targetApp
                        if (count of windows) > 0 then
                            set position of front window to {x1, y1}
                            set size of front window to {w, h}
                        end if
                    end tell
                end if
            end tell
        end run
        """

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        proc.arguments = [
            "-e", script,
            appName,
            String(leftX), String(topY), String(rightX), String(bottomY),
            String(winWidth), String(winHeight)
        ]
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        try? proc.run()
    }

    @objc func toggleAutoTile(_ sender: NSMenuItem) {
        autoTileBesidePanel.toggle()
        sender.state = autoTileBesidePanel ? .on : .off
        if autoTileBesidePanel {
            fitActiveWindowBesidePanel()
        }
    }

    @objc func handleScreenChange() {
        positionDockFrame(animate: false)
        positionEdgeHandle()
        positionNotchHandle(expanded: notchExpanded, animate: false)
    }

    @objc func dock() {
        positionDockFrame(animate: true)
        manuallyShown = true
        stayHidden = false
        stayHiddenMenuItem?.state = .off
        showMainPanel()
        if autoTileBesidePanel {
            fitActiveWindowBesidePanel()
        }
    }

    // MARK: Menu bar & Custom Vector Logo Icon (The One Ring & Eye)

    func makeMenuBarIcon(urgent: Bool) -> NSImage {
        let size = NSSize(width: 16, height: 16)
        let img = NSImage(size: size, flipped: false) { _ in
            let center = NSPoint(x: 8, y: 8)
            // Forged gold by default; fiery ember-red when an agent urgently needs input
            let ringColor = urgent
                ? NSColor(calibratedRed: 1.0, green: 0.36, blue: 0.25, alpha: 1.0)
                : NSColor(calibratedRed: 0.91, green: 0.77, blue: 0.41, alpha: 0.96)
            let glowColor = urgent
                ? NSColor(calibratedRed: 1.0, green: 0.45, blue: 0.20, alpha: 0.28)
                : NSColor(calibratedRed: 0.91, green: 0.77, blue: 0.41, alpha: 0.24)

            // Outer Forged One Ring band
            let ring = NSBezierPath()
            ring.appendArc(withCenter: center, radius: 6.1, startAngle: 0, endAngle: 360)
            ring.lineWidth = 1.65
            ringColor.setStroke()
            ring.stroke()

            // Inner vertical flame / eye contour
            let flame = NSBezierPath(ovalIn: NSRect(x: 6.1, y: 3.4, width: 3.8, height: 9.2))
            glowColor.setFill()
            flame.fill()

            // Vertical Eye Iris
            let iris = NSBezierPath(ovalIn: NSRect(x: 6.85, y: 4.3, width: 2.3, height: 7.4))
            ringColor.setFill()
            iris.fill()

            // Vertical Slit Pupil
            let pupil = NSBezierPath(ovalIn: NSRect(x: 7.55, y: 5.4, width: 0.9, height: 5.2))
            NSColor(calibratedWhite: 0.04, alpha: 1.0).setFill()
            pupil.fill()
            return true
        }
        img.isTemplate = false
        return img
    }

    func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.autosaveName = "TheOneStatusItem"
        statusItem.button?.image = makeMenuBarIcon(urgent: false)
        statusItem.button?.imagePosition = .imageLeading
        statusItem.button?.title = ""
        statusItem.button?.toolTip = "TheOne — AI Agent Mission Control"
        let menu = NSMenu()
        let titleHeader = NSMenuItem(title: "TheOne", action: nil, keyEquivalent: "")
        titleHeader.isEnabled = false
        menu.addItem(titleHeader)
        menu.addItem(.separator())
        menu.addItem(withTitle: "Show / Hide Panel", action: #selector(togglePanel), keyEquivalent: "i")
        let autoItem = NSMenuItem(
            title: "Only Pop Up When Action Needed",
            action: #selector(toggleAutoPopup(_:)),
            keyEquivalent: "a"
        )
        autoItem.state = autoPopupOnly ? .on : .off
        self.autoMenuItem = autoItem
        menu.addItem(autoItem)
        let stayItem = NSMenuItem(
            title: "Stay Hidden (Mute Auto-Popup)",
            action: #selector(toggleStayHidden(_:)),
            keyEquivalent: "m"
        )
        stayItem.state = stayHidden ? .on : .off
        self.stayHiddenMenuItem = stayItem
        menu.addItem(stayItem)
        let notchItem = NSMenuItem(
            title: "Use Dynamic Notch Handle",
            action: #selector(toggleNotchHandle(_:)),
            keyEquivalent: "n"
        )
        notchItem.state = (handleStyle == "notch") ? .on : .off
        self.notchMenuItem = notchItem
        menu.addItem(notchItem)
        menu.addItem(withTitle: "Snap to Screen Edge", action: #selector(dock), keyEquivalent: "d")
        menu.addItem(withTitle: "Fit Active Window Beside Panel", action: #selector(fitActiveWindowBesidePanel), keyEquivalent: "f")
        let tileItem = NSMenuItem(
            title: "Auto-Fit Page When Dragged to Side",
            action: #selector(toggleAutoTile(_:)),
            keyEquivalent: "w"
        )
        tileItem.state = autoTileBesidePanel ? .on : .off
        self.tileMenuItem = tileItem
        menu.addItem(tileItem)
        let pin = NSMenuItem(title: "Float Above Windows", action: #selector(togglePin(_:)), keyEquivalent: "t")
        pin.state = .on
        menu.addItem(pin)
        menu.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        menu.addItem(withTitle: "Open in Browser", action: #selector(openBrowser), keyEquivalent: "b")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        for item in menu.items { item.target = item.action == #selector(NSApplication.terminate(_:)) ? NSApp : self }
        statusItem.menu = menu
    }

    @objc func togglePanel() {
        if panel.isVisible {
            manuallyShown = false
            dismissedSignature = lastUrgentSignature
            hideMainPanel()
        } else {
            stayHidden = false
            stayHiddenMenuItem?.state = .off
            manuallyShown = true
            updateMenuBarBadge(count: currentActionCount)
            showMainPanel(focusForKeyboard: true)
            pollHubState()
        }
    }

    @objc func toggleNotchHandle(_ sender: NSMenuItem) {
        handleStyle = (handleStyle == "notch") ? "edge" : "notch"
        sender.state = (handleStyle == "notch") ? .on : .off
        if !panel.isVisible {
            hideMainPanel()
        }
        // Persist handleStyle to hub settings
        if let url = URL(string: "/api/settings", relativeTo: hubURL) {
            var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 3)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: ["handleStyle": handleStyle])
            URLSession.shared.dataTask(with: req).resume()
        }
    }

    @objc func toggleStayHidden(_ sender: NSMenuItem) {
        stayHidden.toggle()
        sender.state = stayHidden ? .on : .off
        if stayHidden {
            manuallyShown = false
            dismissedSignature = lastUrgentSignature
            hideMainPanel()
        } else {
            manuallyShown = true
            showMainPanel()
        }
        pollHubState()
    }

    @objc func toggleAutoPopup(_ sender: NSMenuItem) {
        autoPopupOnly.toggle()
        sender.state = autoPopupOnly ? .on : .off
        if autoPopupOnly && !hadUrgentAction {
            manuallyShown = false
            hideMainPanel()
        } else if !autoPopupOnly && !panel.isVisible && !stayHidden {
            showMainPanel()
        }
    }

    @objc func togglePin(_ sender: NSMenuItem) {
        let pinned = sender.state == .on
        panel.level = pinned ? .normal : .floating
        sender.state = pinned ? .off : .on
    }

    @objc func reload() { load() }
    @objc func openBrowser() { NSWorkspace.shared.open(hubURL) }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "panelConfig", let dict = message.body as? [String: Any] {
            var geometryChanged = false
            if let side = dict["dockSide"] as? String, side != dockSide {
                dockSide = side
                geometryChanged = true
            }
            if let hStyle = dict["handleStyle"] as? String, hStyle != handleStyle {
                handleStyle = hStyle
                notchMenuItem?.state = (hStyle == "notch") ? .on : .off
                if !panel.isVisible {
                    hideMainPanel()
                }
            }
            if let w = dict["panelWidth"] as? CGFloat, abs(w - panelWidth) > 1 {
                panelWidth = w
                geometryChanged = true
            }
            if let demo = dict["demoMode"] as? Bool {
                demoMode = demo
            }
            if let mode = dict["popupMode"] as? String {
                popupMode = mode
                let shouldAutoOnly = (mode != "always")
                if shouldAutoOnly != autoPopupOnly {
                    autoPopupOnly = shouldAutoOnly
                    autoMenuItem?.state = autoPopupOnly ? .on : .off
                    if !autoPopupOnly && !panel.isVisible && !stayHidden {
                        showMainPanel()
                    } else if autoPopupOnly && !hadUrgentAction && !manuallyShown && panel.isVisible {
                        hideMainPanel()
                    }
                }
            }
            if geometryChanged {
                positionDockFrame(animate: true)
                positionEdgeHandle()
            }
            return
        }

        if message.name == "windowDrag" {
            let cmd = (message.body as? String) ?? "drag"
            if cmd == "dock" {
                positionDockFrame(animate: true)
                if autoTileBesidePanel {
                    fitActiveWindowBesidePanel()
                }
            } else if cmd == "tile" {
                positionDockFrame(animate: true)
                fitActiveWindowBesidePanel()
            } else if cmd == "hide" {
                manuallyShown = false
                dismissedSignature = lastUrgentSignature
                hideMainPanel()
            } else if cmd == "stay_hidden" {
                stayHidden = true
                stayHiddenMenuItem?.state = .on
                manuallyShown = false
                dismissedSignature = lastUrgentSignature
                hideMainPanel()
                pollHubState()
            } else if let event = webView.lastMouseDownEvent ?? NSApp.currentEvent {
                panel.performDrag(with: event)
                snapIfNearScreenEdge()
            }
            return
        }

        guard let title = message.body as? String else { return }
        if let open = title.firstIndex(of: "("), let close = title.firstIndex(of: ")"), open < close,
           let count = Int(title[title.index(after: open)..<close]), count > 0 {
            applyUrgentState(count: count, signature: lastUrgentSignature)
        } else if demoMode {
            applyUrgentState(count: 0, signature: "")
        } else if !hadUrgentAction {
            updateMenuBarBadge(count: 0)
        }
    }
}

var urlArg = "http://localhost:4747"
var cliPathArg: String? = nil
let rawArgs = Array(CommandLine.arguments.dropFirst())
var argIdx = 0
var sawPositionalUrl = false
while argIdx < rawArgs.count {
    let arg = rawArgs[argIdx]
    if arg == "--cli-path", argIdx + 1 < rawArgs.count {
        cliPathArg = rawArgs[argIdx + 1]
        argIdx += 2
    } else if arg.hasPrefix("--cli-path=") {
        cliPathArg = String(arg.dropFirst("--cli-path=".count))
        argIdx += 1
    } else if !arg.hasPrefix("-"), !sawPositionalUrl {
        urlArg = arg
        sawPositionalUrl = true
        argIdx += 1
    } else {
        argIdx += 1
    }
}

let app = NSApplication.shared
let delegate = AppDelegate(hubURL: URL(string: urlArg) ?? URL(string: "http://localhost:4747")!, cliPath: cliPathArg)
app.delegate = delegate
app.run()
