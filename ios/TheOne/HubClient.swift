import Foundation
import SwiftUI
import UIKit

@MainActor
final class HubClient: ObservableObject {
    @Published var agents: [AgentRecord] = []
    @Published var counts: SummaryCounts = .empty
    @Published var customFunctions: [CustomFunction] = []
    @Published var isConnected: Bool = false
    @Published var lastError: String? = nil
    @Published var toastMessage: String? = nil
    @Published var demoMode: Bool = false
    @Published var pairing: PairingConfig {
        didSet { persistPairing() }
    }

    private let pairingStorageKey = "theone_pairing_config_v1"
    private var webSocketTask: URLSessionWebSocketTask?
    private var pollTimer: Timer?
    private var toastTask: Task<Void, Never>?

    init() {
        if let data = UserDefaults.standard.data(forKey: "theone_pairing_config_v1"),
           let saved = try? JSONDecoder().decode(PairingConfig.self, from: data) {
            self.pairing = saved
        } else {
            self.pairing = .defaultLocal
        }

        NotificationManager.shared.configure()
        NotificationManager.shared.onQuickDecision = { [weak self] agentId, reqId, action in
            Task { @MainActor in
                await self?.respond(agentId: agentId, action: action, text: nil, requestId: reqId)
            }
        }
    }

    func start() {
        if demoMode {
            loadDemoState()
            return
        }
        connectWebSocket()
        Task { await fetchState() }
        pollTimer?.invalidate()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, !self.demoMode else { return }
                await self.fetchState()
            }
        }
    }

    func stop() {
        pollTimer?.invalidate()
        pollTimer = nil
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
    }

    func applyPairing(rawInput: String) -> Bool {
        guard let parsed = PairingConfig.parse(rawInput) else {
            showToast("Invalid Hub URL or QR code")
            return false
        }
        demoMode = false
        pairing = parsed
        lastError = nil
        hapticSuccess()
        showToast("Paired with \(parsed.baseURL)")
        connectWebSocket()
        Task { await fetchState() }
        return true
    }

    func toggleDemoMode() {
        demoMode.toggle()
        if demoMode {
            stop()
            loadDemoState()
            showToast("Demo Mode enabled")
        } else {
            lastError = nil
            start()
            showToast("Switched to Live Hub")
        }
    }

    private func loadDemoState() {
        isConnected = true
        lastError = nil
        agents = AgentRecord.demoAgents
        customFunctions = AgentRecord.demoFunctions
        recomputeDemoCounts()
    }

    private func recomputeDemoCounts() {
        counts = SummaryCounts(
            total: agents.count,
            needs_input: agents.filter { $0.status == "needs_input" }.count,
            needs_attention: agents.filter { $0.status == "needs_attention" }.count,
            working: agents.filter { $0.status == "working" }.count,
            idle: agents.filter { $0.status == "idle" }.count
        )
    }

    // MARK: - Networking

    private func makeRequest(path: String, method: String = "GET", body: [String: Any]? = nil) -> URLRequest? {
        guard let url = URL(string: "\(pairing.baseURL)\(path)") else { return nil }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 6)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !pairing.token.isEmpty {
            req.setValue("Bearer \(pairing.token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        return req
    }

    func fetchState() async {
        guard !demoMode, let req = makeRequest(path: "/api/state") else { return }
        do {
            let (data, response) = try await URLSession.shared.data(for: req)
            guard let http = response as? HTTPURLResponse else { return }
            if http.statusCode == 401 {
                isConnected = false
                lastError = "Pairing token required — tap QR to pair"
                return
            }
            guard http.statusCode == 200 else {
                isConnected = false
                lastError = "Hub returned HTTP \(http.statusCode)"
                return
            }
            let payload = try JSONDecoder().decode(HubStatePayload.self, from: data)
            applyState(payload)
        } catch {
            isConnected = false
            lastError = "Cannot reach \(pairing.baseURL)"
        }
    }

    private func connectWebSocket() {
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        var wsBase = pairing.baseURL
            .replacingOccurrences(of: "https://", with: "wss://")
            .replacingOccurrences(of: "http://", with: "ws://")
        wsBase += "/ws"
        if !pairing.token.isEmpty, let encoded = pairing.token.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
            wsBase += "?token=\(encoded)"
        }
        guard let url = URL(string: wsBase) else { return }
        let task = URLSession.shared.webSocketTask(with: url)
        self.webSocketTask = task
        task.resume()
        receiveNextWebSocketMessage(task: task)
    }

    private func receiveNextWebSocketMessage(task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.webSocketTask === task, !self.demoMode else { return }
                switch result {
                case .success(let message):
                    if case .string(let text) = message,
                       let data = text.data(using: .utf8),
                       let envelope = try? JSONDecoder().decode(WebSocketEnvelope.self, from: data),
                       let state = envelope.state {
                        self.applyState(state)
                    }
                    self.receiveNextWebSocketMessage(task: task)
                case .failure:
                    self.isConnected = false
                    try? await Task.sleep(nanoseconds: 2_500_000_000)
                    if !self.demoMode && self.webSocketTask === task {
                        self.connectWebSocket()
                    }
                }
            }
        }
    }

    private func applyState(_ payload: HubStatePayload) {
        isConnected = true
        lastError = nil
        agents = payload.agents
        counts = payload.counts
        if let fns = payload.settings?.customFunctions {
            customFunctions = fns.filter { $0.pinned != false }
        }
        for agent in payload.agents where agent.status == "needs_input" {
            NotificationManager.shared.notifyIfNewPrompt(agent: agent)
        }
    }

    // MARK: - Actions

    func respond(agentId: String, action: String, text: String?, requestId: String?) async {
        hapticImpact(action == "deny" ? .heavy : .medium)

        if demoMode {
            if let idx = agents.firstIndex(where: { $0.id == agentId }) {
                let old = agents[idx]
                let nextStatus = (action == "deny") ? "needs_attention" : "working"
                let nextStep = (action == "deny")
                    ? "Action denied from iPhone"
                    : (text?.isEmpty == false ? "Received reply: \"\(text!)\"" : "Approved via iPhone — applying migration & tests (38/38)…")
                agents[idx] = AgentRecord(
                    id: old.id, name: old.name, provider: old.provider, ide: old.ide,
                    workspace: old.workspace, projectName: old.projectName, branch: old.branch,
                    status: nextStatus, currentTask: old.currentTask, currentStep: nextStep,
                    attentionReason: action == "deny" ? "Denied from iPhone" : nil,
                    pendingPrompt: nil, logs: old.logs, updatedAt: Date().timeIntervalSince1970 * 1000
                )
                recomputeDemoCounts()
            }
            hapticSuccess()
            showToast(action == "deny" ? "Denied from iPhone" : "Approved — agent resuming")
            return
        }

        let encodedId = agentId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? agentId
        var payload: [String: Any] = [
            "action": action,
            "sourceDevice": "iPhone App"
        ]
        if let text, !text.isEmpty { payload["text"] = text }
        if let requestId, !requestId.isEmpty { payload["requestId"] = requestId }

        guard let req = makeRequest(path: "/api/agents/\(encodedId)/respond", method: "POST", body: payload) else { return }
        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            if let http = resp as? HTTPURLResponse, http.statusCode == 200 {
                hapticSuccess()
                showToast(action == "deny" ? "Sent Deny to agent" : "Sent to agent")
                await fetchState()
            } else {
                showToast("Failed to deliver response")
            }
        } catch {
            showToast("Network error sending response")
        }
    }

    func runFunction(agentId: String, fn: CustomFunction) async {
        hapticImpact(.light)
        if demoMode {
            showToast("Ran \"\(fn.label)\"")
            return
        }
        let encodedId = agentId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? agentId
        guard let req = makeRequest(
            path: "/api/agents/\(encodedId)/function",
            method: "POST",
            body: ["functionId": fn.id, "sourceDevice": "iPhone App"]
        ) else { return }

        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            if let http = resp as? HTTPURLResponse, http.statusCode == 200 {
                hapticSuccess()
                showToast("Triggered \(fn.label)")
                await fetchState()
            } else {
                showToast("Failed to run \(fn.label)")
            }
        } catch {
            showToast("Could not reach Hub")
        }
    }

    func focusOnMac(agentId: String) async {
        hapticImpact(.light)
        if demoMode {
            showToast("Focused window on Mac")
            return
        }
        let encodedId = agentId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? agentId
        guard let req = makeRequest(path: "/api/agents/\(encodedId)/focus", method: "POST") else { return }
        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            if let http = resp as? HTTPURLResponse, http.statusCode == 200 {
                showToast("Focused IDE on Mac")
            }
        } catch {
            showToast("Could not focus Mac window")
        }
    }

    func saveDailyContext() async {
        hapticImpact(.medium)
        if demoMode {
            showToast("Saved daily checkpoint")
            return
        }
        guard let req = makeRequest(path: "/api/context/capture", method: "POST", body: [:]) else { return }
        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            if let http = resp as? HTTPURLResponse, http.statusCode == 200 {
                hapticSuccess()
                showToast("Daily context checkpoint saved")
            } else {
                showToast("Save Day failed")
            }
        } catch {
            showToast("Could not reach Hub")
        }
    }

    // MARK: - Helpers

    private func persistPairing() {
        if let data = try? JSONEncoder().encode(pairing) {
            UserDefaults.standard.set(data, forKey: pairingStorageKey)
        }
    }

    func showToast(_ message: String) {
        toastTask?.cancel()
        toastMessage = message
        toastTask = Task {
            try? await Task.sleep(nanoseconds: 2_600_000_000)
            if !Task.isCancelled {
                toastMessage = nil
            }
        }
    }

    private func hapticImpact(_ style: UIImpactFeedbackGenerator.FeedbackStyle) {
        UIImpactFeedbackGenerator(style: style).impactOccurred()
    }

    private func hapticSuccess() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }
}
