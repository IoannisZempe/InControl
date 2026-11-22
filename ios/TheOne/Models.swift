import Foundation

struct HubStatePayload: Codable {
    let agents: [AgentRecord]
    let counts: SummaryCounts
    let settings: HubSettings?
    let serverTime: Double?
}

struct WebSocketEnvelope: Codable {
    let type: String?
    let state: HubStatePayload?
}

struct SummaryCounts: Codable {
    let total: Int
    let needs_input: Int
    let needs_attention: Int
    let working: Int
    let idle: Int

    static let empty = SummaryCounts(total: 0, needs_input: 0, needs_attention: 0, working: 0, idle: 0)
}

struct HubSettings: Codable {
    let customFunctions: [CustomFunction]?
    let showFunctionBar: Bool?
}

struct CustomFunction: Codable, Identifiable, Equatable {
    let id: String
    let label: String
    let icon: String?
    let type: String?
    let payload: String?
    let pinned: Bool?
}

struct PendingPrompt: Codable, Equatable {
    let requestId: String?
    let question: String?
    let toolName: String?
    let command: String?
    let details: String?
    let options: [String]?
    let allowFreeText: Bool?
}

struct AgentLog: Codable, Identifiable, Equatable {
    var id: String { "\(timestamp ?? 0)-\(message ?? "")" }
    let type: String?
    let message: String?
    let timestamp: Double?
}

struct AgentRecord: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    let provider: String?
    let ide: String?
    let workspace: String?
    let projectName: String?
    let branch: String?
    let status: String
    let currentTask: String?
    let currentStep: String?
    let attentionReason: String?
    let pendingPrompt: PendingPrompt?
    let logs: [AgentLog]?
    let updatedAt: Double?

    var displayTitle: String {
        if let p = projectName, !p.isEmpty { return p }
        if let w = workspace, !w.isEmpty { return URL(fileURLWithPath: w).lastPathComponent }
        return name
    }

    var providerLabel: String {
        if let ide = ide, !ide.isEmpty { return ide }
        switch (provider ?? "").lowercased() {
        case "claude-code", "claude": return "Claude Code"
        case "antigravity": return "Antigravity"
        case "codex": return "Codex"
        case "cursor": return "Cursor"
        default: return name
        }
    }
}

enum AgentFilter: String, CaseIterable, Identifiable {
    case all = "All"
    case needs_input = "Input"
    case needs_attention = "Review"
    case working = "Active"

    var id: String { rawValue }
}

struct PairingConfig: Codable, Equatable {
    var baseURL: String
    var token: String

    static func parse(_ raw: String) -> PairingConfig? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let normalized = trimmed.contains("://") ? trimmed : "http://\(trimmed)"
        guard var comps = URLComponents(string: normalized), let host = comps.host, !host.isEmpty else {
            return nil
        }
        let token = comps.queryItems?.first(where: { $0.name == "token" })?.value ?? ""
        comps.queryItems = nil
        comps.path = ""
        comps.fragment = nil
        guard let cleanBase = comps.string?.trimmingCharacters(in: CharacterSet(charactersIn: "/")) else {
            return nil
        }
        return PairingConfig(baseURL: cleanBase, token: token)
    }

    static var defaultLocal: PairingConfig {
        PairingConfig(baseURL: "http://127.0.0.1:4747", token: "")
    }
}

extension AgentRecord {
    static let demoAgents: [AgentRecord] = [
        AgentRecord(
            id: "demo-claude-payments",
            name: "Claude Code",
            provider: "claude-code",
            ide: "Claude Code",
            workspace: "/Users/dev/payments-api",
            projectName: "payments-api",
            branch: "main",
            status: "needs_input",
            currentTask: "Add ledger table & run migration",
            currentStep: "Waiting for Bash approval (--gate-bash)",
            attentionReason: "Risky Bash command paused by TheOne",
            pendingPrompt: PendingPrompt(
                requestId: "req-demo-1",
                question: "Allow Bash command in payments-api?",
                toolName: "Bash",
                command: "npx prisma migrate dev --name add_ledger",
                details: "PreToolUse --gate-bash",
                options: ["Approve", "Deny"],
                allowFreeText: true
            ),
            logs: [
                AgentLog(type: "tool", message: "Write(prisma/schema.prisma) +28 lines", timestamp: Date().timeIntervalSince1970 * 1000 - 14000),
                AgentLog(type: "tool", message: "Bash(npx prisma migrate dev --name add_ledger) — gated", timestamp: Date().timeIntervalSince1970 * 1000 - 2000)
            ],
            updatedAt: Date().timeIntervalSince1970 * 1000
        ),
        AgentRecord(
            id: "demo-codex-infra",
            name: "Codex",
            provider: "codex",
            ide: "ChatGPT App",
            workspace: "/Users/dev/cloud-infra",
            projectName: "cloud-infra",
            branch: "feat/iam",
            status: "needs_attention",
            currentTask: "Harden IAM policies & run terraform plan",
            currentStep: "All 14 Terraform checks passed — ready for review",
            attentionReason: "Turn complete — ready for review",
            pendingPrompt: nil,
            logs: [
                AgentLog(type: "success", message: "terraform validate & plan: 14/14 checks passed", timestamp: Date().timeIntervalSince1970 * 1000 - 45000)
            ],
            updatedAt: Date().timeIntervalSince1970 * 1000 - 45000
        ),
        AgentRecord(
            id: "demo-agy-theone",
            name: "Antigravity",
            provider: "antigravity",
            ide: "Antigravity",
            workspace: "/Users/dev/InControl",
            projectName: "TheOne",
            branch: "main",
            status: "working",
            currentTask: "Build native SwiftUI iOS companion app",
            currentStep: "Running 38/38 integration tests & compiling iOS target…",
            attentionReason: nil,
            pendingPrompt: nil,
            logs: [
                AgentLog(type: "tool", message: "npm test — 38/38 passing", timestamp: Date().timeIntervalSince1970 * 1000 - 8000)
            ],
            updatedAt: Date().timeIntervalSince1970 * 1000 - 8000
        )
    ]

    static let demoFunctions: [CustomFunction] = [
        CustomFunction(id: "fn_tests", label: "Run Tests", icon: "agent", type: "prompt", payload: "Run tests", pinned: true),
        CustomFunction(id: "fn_security", label: "Security Check", icon: "agent", type: "prompt", payload: "Audit security", pinned: true),
        CustomFunction(id: "fn_git_status", label: "Git Status", icon: "project", type: "shell", payload: "git status -sb", pinned: true)
    ]
}
