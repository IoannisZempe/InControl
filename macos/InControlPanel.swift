// InControl native macOS side panel.
// A frosted Apple-style floating HUD panel docked to the right edge of the screen that hosts the
// InControl web UI, plus a menu bar item showing how many agents need your input.
//
// Build: swiftc -O macos/InControlPanel.swift -o macos/incontrol-panel -framework Cocoa -framework WebKit
// Run:   ./macos/incontrol-panel http://localhost:4747

import Cocoa
import WebKit

final class SidePanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

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
    var webView: PanelWebView!
    var statusItem: NSStatusItem!
    var autoMenuItem: NSMenuItem?
    var tileMenuItem: NSMenuItem?
    let hubURL: URL
    var panelWidth: CGFloat = 386
    var dockSide: String = "right"
    var popupMode: String = "needs_input"
    var autoPopupOnly: Bool = true
    var autoTileBesidePanel: Bool = true
    var demoMode: Bool = false
    var manuallyShown: Bool = false
    var hadUrgentAction: Bool = false
    var lastUrgentSignature: String = ""
    var statePollTimer: Timer?
    var lastHubSpawnAttempt: Date = .distantPast

    init(hubURL: URL) {
        self.hubURL = hubURL
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        setupPanel()
        setupStatusItem()
        positionDockFrame(animate: false)
        // Stay hidden in menu bar by default; only pop up when an agent requires user action
        panel.orderOut(nil)
        startStatePoller()
        NotificationCenter.default.addObserver(
            self, selector: #selector(handleScreenChange),
            name: NSApplication.didChangeScreenParametersNotification, object: nil)
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
            let needsInput = (counts["needs_input"] as? Int) ?? 0
            let needsAttention = (counts["needs_attention"] as? Int) ?? 0
            let actionCount = (mode == "urgent_and_review") ? (needsInput + needsAttention) : needsInput

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
                let shouldAutoOnly = (mode != "always")
                if shouldAutoOnly != self.autoPopupOnly {
                    self.autoPopupOnly = shouldAutoOnly
                    self.autoMenuItem?.state = shouldAutoOnly ? .on : .off
                }
                if !shouldAutoOnly && !self.panel.isVisible {
                    self.panel.orderFrontRegardless()
                }
                self.applyUrgentState(count: actionCount, signature: signature)
            }
        }.resume()
    }

    func applyUrgentState(count: Int, signature: String) {
        if count > 0 {
            let isNewRequest = !hadUrgentAction || (!signature.isEmpty && signature != lastUrgentSignature)
            statusItem.button?.image = makeMenuBarIcon(urgent: true)
            statusItem.button?.title = " \(count) InControl"
            hadUrgentAction = true
            if !signature.isEmpty {
                lastUrgentSignature = signature
            }
            if !panel.isVisible || isNewRequest {
                panel.orderFrontRegardless()
            }
        } else {
            statusItem.button?.image = makeMenuBarIcon(urgent: false)
            statusItem.button?.title = " InControl"
            if hadUrgentAction {
                hadUrgentAction = false
                lastUrgentSignature = ""
                manuallyShown = false
            }
            if autoPopupOnly && !manuallyShown && panel.isVisible {
                panel.orderOut(nil)
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

    func ensureHubRunning() {
        guard Date().timeIntervalSince(lastHubSpawnAttempt) > 8 else { return }
        lastHubSpawnAttempt = Date()

        let execURL = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
        let repoRoot = execURL.deletingLastPathComponent().deletingLastPathComponent()
        let cliPath = repoRoot.appendingPathComponent("bin/incontrol.js").path
        guard FileManager.default.fileExists(atPath: cliPath) else { return }

        let nodeCandidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        guard let nodeBin = nodeCandidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            return
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: nodeBin)
        proc.arguments = [cliPath, "start"]
        proc.currentDirectoryURL = repoRoot
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        try? proc.run()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        ensureHubRunning()
        let html = """
        <body style="background:transparent;color:#98989d;font:13px -apple-system;display:grid;place-items:center;height:100vh;margin:0;text-align:center">
        <div><h3 style="color:#f5f5f7;font-weight:600;margin-bottom:6px">Starting InControl Hub…</h3>
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
    }

    @objc func dock() {
        positionDockFrame(animate: true)
        manuallyShown = true
        panel.orderFrontRegardless()
        if autoTileBesidePanel {
            fitActiveWindowBesidePanel()
        }
    }

    // MARK: Menu bar & Custom Vector Logo Icon

    func makeMenuBarIcon(urgent: Bool) -> NSImage {
        let size = NSSize(width: 16, height: 16)
        let img = NSImage(size: size, flipped: false) { _ in
            let center = NSPoint(x: 8, y: 8)
            let primaryColor = urgent
                ? NSColor(calibratedRed: 1.0, green: 0.35, blue: 0.30, alpha: 1.0)
                : NSColor(calibratedRed: 0.38, green: 0.82, blue: 1.0, alpha: 0.95)

            // Outer orbit ring
            let orbit = NSBezierPath()
            orbit.appendArc(withCenter: center, radius: 6.2, startAngle: 25, endAngle: 315)
            orbit.lineWidth = 1.4
            orbit.lineCapStyle = .round
            primaryColor.setStroke()
            orbit.stroke()

            // Central command core
            let coreRect = NSRect(x: 5.7, y: 5.7, width: 4.6, height: 4.6)
            let core = NSBezierPath(ovalIn: coreRect)
            primaryColor.setFill()
            core.fill()

            // Satellite node at orbit tip
            let satRect = NSRect(x: 11.4, y: 10.2, width: 3.0, height: 3.0)
            let sat = NSBezierPath(ovalIn: satRect)
            (urgent ? NSColor.systemOrange : NSColor.systemGreen).setFill()
            sat.fill()
            return true
        }
        img.isTemplate = false
        return img
    }

    func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = makeMenuBarIcon(urgent: false)
        statusItem.button?.imagePosition = .imageLeading
        statusItem.button?.title = " InControl"
        let menu = NSMenu()
        menu.addItem(withTitle: "Show / Hide Panel", action: #selector(togglePanel), keyEquivalent: "i")
        let autoItem = NSMenuItem(
            title: "Only Pop Up When Action Needed",
            action: #selector(toggleAutoPopup(_:)),
            keyEquivalent: "a"
        )
        autoItem.state = autoPopupOnly ? .on : .off
        self.autoMenuItem = autoItem
        menu.addItem(autoItem)
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
            panel.orderOut(nil)
        } else {
            manuallyShown = true
            panel.orderFrontRegardless()
        }
    }

    @objc func toggleAutoPopup(_ sender: NSMenuItem) {
        autoPopupOnly.toggle()
        sender.state = autoPopupOnly ? .on : .off
        if autoPopupOnly && !hadUrgentAction {
            manuallyShown = false
            panel.orderOut(nil)
        } else if !autoPopupOnly && !panel.isVisible {
            panel.orderFrontRegardless()
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
                    if !autoPopupOnly && !panel.isVisible {
                        panel.orderFrontRegardless()
                    } else if autoPopupOnly && !hadUrgentAction && !manuallyShown && panel.isVisible {
                        panel.orderOut(nil)
                    }
                }
            }
            if geometryChanged {
                positionDockFrame(animate: true)
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
                panel.orderOut(nil)
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
            statusItem.button?.image = makeMenuBarIcon(urgent: false)
            statusItem.button?.title = " InControl"
        }
    }
}

let urlArg = CommandLine.arguments.dropFirst().first ?? "http://localhost:4747"
let app = NSApplication.shared
let delegate = AppDelegate(hubURL: URL(string: urlArg)!)
app.delegate = delegate
app.run()
