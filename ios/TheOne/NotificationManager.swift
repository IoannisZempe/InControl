import Foundation
import UserNotifications

final class NotificationManager: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationManager()

    static let categoryPrompt = "THEONE_AGENT_PROMPT"
    static let actionApprove = "THEONE_APPROVE"
    static let actionDeny = "THEONE_DENY"

    var onQuickDecision: ((_ agentId: String, _ requestId: String?, _ action: String) -> Void)?

    private var notifiedKeys = Set<String>()

    func configure() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self

        let approve = UNNotificationAction(
            identifier: Self.actionApprove,
            title: "✓ Approve",
            options: []
        )
        let deny = UNNotificationAction(
            identifier: Self.actionDeny,
            title: "✕ Deny",
            options: [.destructive]
        )
        let category = UNNotificationCategory(
            identifier: Self.categoryPrompt,
            actions: [approve, deny],
            intentIdentifiers: [],
            options: []
        )
        center.setNotificationCategories([category])
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    func notifyIfNewPrompt(agent: AgentRecord) {
        guard agent.status == "needs_input" else { return }
        let reqId = agent.pendingPrompt?.requestId ?? agent.currentStep ?? "prompt"
        let key = "\(agent.id):\(reqId)"
        guard !notifiedKeys.contains(key) else { return }
        notifiedKeys.insert(key)

        let content = UNMutableNotificationContent()
        content.title = "\(agent.displayTitle) · \(agent.providerLabel)"
        content.subtitle = "Needs Input — Hold to Approve or Deny"
        if let cmd = agent.pendingPrompt?.command, !cmd.isEmpty {
            content.body = "$ \(cmd)"
        } else {
            content.body = agent.pendingPrompt?.question ?? agent.attentionReason ?? "Agent is waiting for your approval."
        }
        content.sound = .default
        content.categoryIdentifier = Self.categoryPrompt
        content.userInfo = [
            "agentId": agent.id,
            "requestId": agent.pendingPrompt?.requestId ?? ""
        ]

        let req = UNNotificationRequest(identifier: key, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req)
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .badge])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let info = response.notification.request.content.userInfo
        let agentId = info["agentId"] as? String ?? ""
        let rawReqId = info["requestId"] as? String ?? ""
        let reqId = rawReqId.isEmpty ? nil : rawReqId

        if !agentId.isEmpty {
            if response.actionIdentifier == Self.actionApprove {
                onQuickDecision?(agentId, reqId, "approve")
            } else if response.actionIdentifier == Self.actionDeny {
                onQuickDecision?(agentId, reqId, "deny")
            }
        }
        completionHandler()
    }
}
