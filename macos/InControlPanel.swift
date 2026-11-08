// InControl native macOS side panel.
// A borderless, always-on-top panel docked to the right edge of the screen that hosts the
// InControl web UI, plus a menu bar item showing how many agents need you.
//
// Build: swiftc -O macos/InControlPanel.swift -o macos/incontrol-panel -framework Cocoa -framework WebKit
// Run:   ./macos/incontrol-panel http://localhost:4747

import Cocoa
import WebKit

final class SidePanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    var panel: SidePanel!
    var webView: WKWebView!
    var statusItem: NSStatusItem!
    let hubURL: URL
    var panelWidth: CGFloat = 380

    init(hubURL: URL) {
        self.hubURL = hubURL
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        setupPanel()
        setupStatusItem()
        dock()
        NotificationCenter.default.addObserver(
            self, selector: #selector(dock),
            name: NSApplication.didChangeScreenParametersNotification, object: nil)
    }

    // MARK: Panel

    func setupPanel() {
        panel = SidePanel(
            contentRect: NSRect(x: 0, y: 0, width: panelWidth, height: 800),
            styleMask: [.titled, .closable, .resizable, .fullSizeContentView, .nonactivatingPanel],
            backing: .buffered, defer: false)
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.hidesOnDeactivate = false
        panel.backgroundColor = NSColor(red: 0.035, green: 0.043, blue: 0.063, alpha: 1)
        panel.minSize = NSSize(width: 300, height: 400)
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
        panel.standardWindowButton(.zoomButton)?.isHidden = true

        let config = WKWebViewConfiguration()
        let controller = WKUserContentController()
        // Bridge: web UI title "(3) InControl" → menu bar badge
        let script = WKUserScript(source: """
            new MutationObserver(() => window.webkit.messageHandlers.badge.postMessage(document.title))
              .observe(document.querySelector('title'), { childList: true });
            window.webkit.messageHandlers.badge.postMessage(document.title);
            """, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
        controller.addUserScript(script)
        controller.add(self, name: "badge")
        config.userContentController = controller

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.customUserAgent = "Mozilla/5.0 (Macintosh) AppleWebKit Safari InControlPanel/0.1"
        webView.setValue(false, forKey: "drawsBackground")
        panel.contentView = webView
        load()
    }

    func load() {
        webView.load(URLRequest(url: hubURL))
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let html = """
        <body style="background:#090b10;color:#94a3b8;font:13px -apple-system;display:grid;place-items:center;height:100vh;margin:0;text-align:center">
        <div><div style="font-size:30px">🛰️</div><h3 style="color:#e2e8f0">Hub not reachable</h3>
        <p>Start it with <code>incontrol start</code><br>Retrying…</p></div></body>
        """
        webView.loadHTMLString(html, baseURL: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.load() }
    }

    @objc func dock() {
        guard let screen = NSScreen.main else { return }
        let f = screen.visibleFrame
        let frame = NSRect(x: f.maxX - panelWidth, y: f.minY, width: panelWidth, height: f.height)
        panel.setFrame(frame, display: true, animate: true)
        panel.orderFrontRegardless()
    }

    // MARK: Menu bar

    func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "◉ InControl"
        let menu = NSMenu()
        menu.addItem(withTitle: "Show / Hide Panel", action: #selector(togglePanel), keyEquivalent: "i")
        menu.addItem(withTitle: "Dock Right", action: #selector(dock), keyEquivalent: "d")
        let pin = NSMenuItem(title: "Always on Top", action: #selector(togglePin(_:)), keyEquivalent: "t")
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
        if panel.isVisible { panel.orderOut(nil) } else { panel.orderFrontRegardless() }
    }

    @objc func togglePin(_ sender: NSMenuItem) {
        let pinned = sender.state == .on
        panel.level = pinned ? .normal : .floating
        sender.state = pinned ? .off : .on
    }

    @objc func reload() { load() }
    @objc func openBrowser() { NSWorkspace.shared.open(hubURL) }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let title = message.body as? String else { return }
        if let open = title.firstIndex(of: "("), let close = title.firstIndex(of: ")"), open < close {
            let count = title[title.index(after: open)..<close]
            statusItem.button?.title = "🔴 \(count) InControl"
        } else {
            statusItem.button?.title = "◉ InControl"
        }
    }
}

let urlArg = CommandLine.arguments.dropFirst().first ?? "http://localhost:4747"
let app = NSApplication.shared
let delegate = AppDelegate(hubURL: URL(string: urlArg)!)
app.delegate = delegate
app.run()
