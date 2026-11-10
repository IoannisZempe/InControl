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

    override func mouseDown(with event: NSEvent) {
        lastMouseDownEvent = event
        // Top 18pt grabber strip always drags immediately at the native Cocoa layer
        let loc = convert(event.locationInWindow, from: nil)
        let distFromTop = isFlipped ? loc.y : (bounds.height - loc.y)
        if distFromTop <= 18 {
            window?.performDrag(with: event)
            return
        }
        super.mouseDown(with: event)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    var panel: SidePanel!
    var webView: PanelWebView!
    var statusItem: NSStatusItem!
    let hubURL: URL
    var panelWidth: CGFloat = 376
    var autoPopupOnly: Bool = true
    var manuallyShown: Bool = false
    var hadUrgentAction: Bool = false

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
        NotificationCenter.default.addObserver(
            self, selector: #selector(handleScreenChange),
            name: NSApplication.didChangeScreenParametersNotification, object: nil)
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
        config.userContentController = controller

        webView = PanelWebView(frame: visualEffect.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.customUserAgent = "Mozilla/5.0 (Macintosh) AppleWebKit Safari InControlPanel/0.2"
        webView.setValue(false, forKey: "drawsBackground")

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

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let html = """
        <body style="background:transparent;color:#98989d;font:13px -apple-system;display:grid;place-items:center;height:100vh;margin:0;text-align:center">
        <div><h3 style="color:#f5f5f7;font-weight:600;margin-bottom:6px">InControl Hub Offline</h3>
        <p style="margin:0">Run <code>incontrol start</code><br>Reconnecting…</p></div></body>
        """
        webView.loadHTMLString(html, baseURL: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in self?.load() }
    }

    func positionDockFrame(animate: Bool = true) {
        guard let screen = NSScreen.main else { return }
        let f = screen.visibleFrame
        let margin: CGFloat = 8
        let frame = NSRect(
            x: f.maxX - panelWidth - margin,
            y: f.minY + margin,
            width: panelWidth,
            height: f.height - (margin * 2)
        )
        panel.setFrame(frame, display: panel.isVisible, animate: animate && panel.isVisible)
    }

    @objc func handleScreenChange() {
        positionDockFrame(animate: false)
    }

    @objc func dock() {
        positionDockFrame(animate: true)
        manuallyShown = true
        panel.orderFrontRegardless()
    }

    // MARK: Menu bar

    func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "◉ InControl"
        let menu = NSMenu()
        menu.addItem(withTitle: "Show / Hide Panel", action: #selector(togglePanel), keyEquivalent: "i")
        let autoItem = NSMenuItem(
            title: "Only Pop Up When Action Needed",
            action: #selector(toggleAutoPopup(_:)),
            keyEquivalent: "a"
        )
        autoItem.state = autoPopupOnly ? .on : .off
        menu.addItem(autoItem)
        menu.addItem(withTitle: "Snap to Right Edge", action: #selector(dock), keyEquivalent: "d")
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
        if message.name == "windowDrag" {
            let cmd = (message.body as? String) ?? "drag"
            if cmd == "dock" {
                positionDockFrame(animate: true)
            } else if cmd == "hide" {
                manuallyShown = false
                panel.orderOut(nil)
            } else if let event = webView.lastMouseDownEvent ?? NSApp.currentEvent {
                panel.performDrag(with: event)
            }
            return
        }

        guard let title = message.body as? String else { return }
        if let open = title.firstIndex(of: "("), let close = title.firstIndex(of: ")"), open < close {
            let count = title[title.index(after: open)..<close]
            statusItem.button?.title = "🔴 \(count) InControl"
            hadUrgentAction = true
            if !panel.isVisible {
                panel.orderFrontRegardless()
            }
        } else {
            statusItem.button?.title = "◉ InControl"
            if hadUrgentAction {
                hadUrgentAction = false
                manuallyShown = false
            }
            if autoPopupOnly && !manuallyShown && panel.isVisible {
                panel.orderOut(nil)
            }
        }
    }
}

let urlArg = CommandLine.arguments.dropFirst().first ?? "http://localhost:4747"
let app = NSApplication.shared
let delegate = AppDelegate(hubURL: URL(string: urlArg)!)
app.delegate = delegate
app.run()
