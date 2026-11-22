import SwiftUI

struct ContentView: View {
    @StateObject private var hub = HubClient()
    @State private var selectedFilter: AgentFilter = .all
    @State private var showPairSheet = false
    @State private var replyDrafts: [String: String] = [:]
    @State private var expandedLogs: Set<String> = []

    private var filteredAgents: [AgentRecord] {
        switch selectedFilter {
        case .all: return hub.agents
        case .needs_input: return hub.agents.filter { $0.status == "needs_input" }
        case .needs_attention: return hub.agents.filter { $0.status == "needs_attention" }
        case .working: return hub.agents.filter { $0.status == "working" }
        }
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            TheOneTheme.obsidianBg.ignoresSafeArea()

            VStack(spacing: 0) {
                headerBar
                filterBar
                Divider().overlay(TheOneTheme.borderSubtle)

                if let err = hub.lastError, !hub.isConnected && !hub.demoMode {
                    connectionBanner(err)
                }

                ScrollView {
                    LazyVStack(spacing: 12) {
                        if filteredAgents.isEmpty {
                            emptyState
                        } else {
                            ForEach(filteredAgents) { agent in
                                AgentCardView(
                                    agent: agent,
                                    functions: hub.customFunctions,
                                    draft: Binding(
                                        get: { replyDrafts[agent.id] ?? "" },
                                        set: { replyDrafts[agent.id] = $0 }
                                    ),
                                    logsExpanded: expandedLogs.contains(agent.id),
                                    onToggleLogs: {
                                        if expandedLogs.contains(agent.id) {
                                            expandedLogs.remove(agent.id)
                                        } else {
                                            expandedLogs.insert(agent.id)
                                        }
                                    },
                                    onRespond: { action, text in
                                        let reqId = agent.pendingPrompt?.requestId
                                        replyDrafts[agent.id] = ""
                                        Task { await hub.respond(agentId: agent.id, action: action, text: text, requestId: reqId) }
                                    },
                                    onRunFunction: { fn in
                                        Task { await hub.runFunction(agentId: agent.id, fn: fn) }
                                    },
                                    onFocusMac: {
                                        Task { await hub.focusOnMac(agentId: agent.id) }
                                    }
                                )
                            }
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .padding(.bottom, 54)
                }
                .refreshable {
                    await hub.fetchState()
                }
            }

            if let toast = hub.toastMessage {
                Text(toast)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.black)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(TheOneTheme.goldGradient)
                    .clipShape(Capsule())
                    .shadow(color: .black.opacity(0.45), radius: 10, y: 4)
                    .padding(.bottom, 18)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: hub.toastMessage)
        .sheet(isPresented: $showPairSheet) {
            PairHubSheet(hub: hub)
        }
        .onAppear {
            hub.start()
        }
        .onDisappear {
            hub.stop()
        }
    }

    private var headerBar: some View {
        HStack(spacing: 10) {
            ZStack(alignment: .bottomTrailing) {
                TheOneLogoView(size: 30, urgent: hub.counts.needs_input > 0)
                Circle()
                    .fill(hub.isConnected ? TheOneTheme.activeGreen : TheOneTheme.urgentRed)
                    .frame(width: 8, height: 8)
                    .overlay(Circle().stroke(TheOneTheme.obsidianBg, lineWidth: 1.5))
            }

            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text("TheOne")
                        .font(.system(size: 18, weight: .bold))
                        .foregroundStyle(.white)
                    if hub.counts.needs_input > 0 {
                        Text("\(hub.counts.needs_input) waiting")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(Color(red: 1.0, green: 0.72, blue: 0.72))
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2)
                            .background(TheOneTheme.urgentRed.opacity(0.22))
                            .clipShape(Capsule())
                            .overlay(Capsule().stroke(TheOneTheme.urgentRed.opacity(0.55), lineWidth: 1))
                    } else if hub.demoMode {
                        Text("DEMO")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(TheOneTheme.goldBright)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2)
                            .background(TheOneTheme.goldMain.opacity(0.2))
                            .clipShape(Capsule())
                    }
                }
                Text(hub.demoMode ? "Simulated Local Hub" : hub.pairing.baseURL.replacingOccurrences(of: "http://", with: ""))
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(TheOneTheme.mutedText)
            }

            Spacer()

            Button {
                Task { await hub.saveDailyContext() }
            } label: {
                Image(systemName: "tray.and.arrow.down")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(TheOneTheme.goldMain)
                    .frame(width: 34, height: 34)
                    .background(TheOneTheme.surfaceElevated)
                    .clipShape(RoundedRectangle(cornerRadius: 9))
            }
            .accessibilityLabel("Save Daily Context")

            Button {
                hub.toggleDemoMode()
            } label: {
                Image(systemName: hub.demoMode ? "sparkles.rectangle.stack.fill" : "sparkles.rectangle.stack")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(hub.demoMode ? .black : .white)
                    .frame(width: 34, height: 34)
                    .background(hub.demoMode ? AnyShapeStyle(TheOneTheme.goldGradient) : AnyShapeStyle(TheOneTheme.surfaceElevated))
                    .clipShape(RoundedRectangle(cornerRadius: 9))
            }
            .accessibilityLabel("Toggle Demo Mode")

            Button {
                showPairSheet = true
            } label: {
                Image(systemName: "qrcode.viewfinder")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.black)
                    .frame(width: 34, height: 34)
                    .background(TheOneTheme.goldGradient)
                    .clipShape(RoundedRectangle(cornerRadius: 9))
            }
            .accessibilityLabel("Pair with Mac QR")
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 8)
    }

    private var filterBar: some View {
        HStack(spacing: 6) {
            ForEach(AgentFilter.allCases) { filter in
                let isSelected = selectedFilter == filter
                let count = countFor(filter)
                Button {
                    selectedFilter = filter
                } label: {
                    HStack(spacing: 5) {
                        if let dot = dotColor(for: filter) {
                            Circle().fill(dot).frame(width: 6, height: 6)
                        }
                        Text(filter.rawValue)
                            .font(.caption.weight(isSelected ? .bold : .medium))
                        Text("\(count)")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(isSelected ? .white : TheOneTheme.mutedText)
                    }
                    .foregroundStyle(isSelected ? .white : TheOneTheme.mutedText)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 7)
                    .background(isSelected ? TheOneTheme.surfaceElevated : Color.clear)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }
        }
        .padding(4)
        .background(TheOneTheme.surfaceCard)
        .clipShape(RoundedRectangle(cornerRadius: 11))
        .overlay(RoundedRectangle(cornerRadius: 11).stroke(TheOneTheme.borderSubtle))
        .padding(.horizontal, 14)
        .padding(.bottom, 10)
    }

    private func connectionBanner(_ err: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "wifi.exclamationmark")
                .foregroundStyle(TheOneTheme.goldMain)
            Text(err)
                .font(.caption)
                .foregroundStyle(.white)
                .lineLimit(2)
            Spacer()
            Button("Pair QR") { showPairSheet = true }
                .font(.caption.weight(.bold))
                .foregroundStyle(.black)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(TheOneTheme.goldGradient)
                .clipShape(Capsule())
            Button("Demo") { hub.toggleDemoMode() }
                .font(.caption.weight(.semibold))
                .foregroundStyle(TheOneTheme.goldMain)
        }
        .padding(10)
        .background(TheOneTheme.surfaceCard)
        .overlay(Rectangle().frame(height: 1).foregroundStyle(TheOneTheme.goldMain.opacity(0.35)), alignment: .bottom)
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            TheOneLogoView(size: 48)
            Text("No agents in \(selectedFilter.rawValue)")
                .font(.headline)
                .foregroundStyle(.white)
            Text("Start TheOne on your Mac (`npx incontrol-agents start`) or tap Demo to preview live Bash approval.")
                .font(.caption)
                .foregroundStyle(TheOneTheme.mutedText)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
            HStack(spacing: 10) {
                Button("Scan Mac QR") { showPairSheet = true }
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.black)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(TheOneTheme.goldGradient)
                    .clipShape(Capsule())
                Button("Try Demo Mode") { hub.toggleDemoMode() }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(TheOneTheme.surfaceElevated)
                    .clipShape(Capsule())
            }
        }
        .padding(.top, 56)
    }

    private func countFor(_ filter: AgentFilter) -> Int {
        switch filter {
        case .all: return hub.counts.total
        case .needs_input: return hub.counts.needs_input
        case .needs_attention: return hub.counts.needs_attention
        case .working: return hub.counts.working
        }
    }

    private func dotColor(for filter: AgentFilter) -> Color? {
        switch filter {
        case .all: return nil
        case .needs_input: return TheOneTheme.urgentRed
        case .needs_attention: return TheOneTheme.reviewAmber
        case .working: return TheOneTheme.activeGreen
        }
    }
}

struct AgentCardView: View {
    let agent: AgentRecord
    let functions: [CustomFunction]
    @Binding var draft: String
    let logsExpanded: Bool
    let onToggleLogs: () -> Void
    let onRespond: (_ action: String, _ text: String?) -> Void
    let onRunFunction: (_ fn: CustomFunction) -> Void
    let onFocusMac: () -> Void
    @State private var showIdleComposer: Bool = false

    private var statusColor: Color {
        switch agent.status {
        case "needs_input": return TheOneTheme.urgentRed
        case "needs_attention": return TheOneTheme.reviewAmber
        case "working": return TheOneTheme.activeGreen
        default: return TheOneTheme.mutedText
        }
    }

    private var statusLabel: String {
        switch agent.status {
        case "needs_input": return "NEEDS INPUT"
        case "needs_attention": return "NEEDS REVIEW"
        case "working": return "ACTIVE"
        default: return "IDLE"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Card Header
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Circle().fill(statusColor).frame(width: 7, height: 7)
                        Text(statusLabel)
                            .font(.system(size: 10, weight: .bold, design: .monospaced))
                            .foregroundStyle(statusColor)
                        if let branch = agent.branch, !branch.isEmpty {
                            Text("⎇ \(branch)")
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundStyle(TheOneTheme.mutedText)
                        }
                    }
                    HStack(spacing: 6) {
                        Text(agent.displayTitle)
                            .font(.system(size: 16, weight: .bold))
                            .foregroundStyle(.white)
                        Text(agent.providerLabel)
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(TheOneTheme.mutedText)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(TheOneTheme.surfaceElevated)
                            .clipShape(RoundedRectangle(cornerRadius: 5))
                    }
                }
                Spacer()
                HStack(spacing: 8) {
                    Button(action: onToggleLogs) {
                        Text(logsExpanded ? "Hide Log" : "Log")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(TheOneTheme.mutedText)
                    }
                    Button(action: onFocusMac) {
                        Text("↗ Mac")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(TheOneTheme.goldMain)
                    }
                }
            }

            if let task = agent.currentTask, !task.isEmpty {
                Text(task)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Color.white.opacity(0.92))
                    .lineLimit(2)
            }

            // Approval Gate Block when status == needs_input
            if agent.status == "needs_input", let prompt = agent.pendingPrompt {
                VStack(alignment: .leading, spacing: 8) {
                    if let q = prompt.question, !q.isEmpty {
                        Text(q)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Color(red: 1.0, green: 0.78, blue: 0.78))
                    }
                    if let cmd = prompt.command, !cmd.isEmpty {
                        Text("$ \(cmd)")
                            .font(.system(size: 12, weight: .semibold, design: .monospaced))
                            .foregroundStyle(TheOneTheme.goldBright)
                            .padding(10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color.black.opacity(0.55))
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(TheOneTheme.urgentRed.opacity(0.35)))
                    }

                    let opts = prompt.options ?? ["Approve", "Deny"]
                    if opts.count == 2 && opts[0].lowercased().contains("approve") {
                        HStack(spacing: 8) {
                            Button {
                                onRespond("approve", nil)
                            } label: {
                                Text("✓ Approve")
                                    .font(.subheadline.weight(.bold))
                                    .foregroundStyle(.black)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 10)
                                    .background(TheOneTheme.goldGradient)
                                    .clipShape(RoundedRectangle(cornerRadius: 9))
                            }
                            Button {
                                onRespond("deny", draft.isEmpty ? nil : draft)
                            } label: {
                                Text("✕ Deny")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(Color(red: 1.0, green: 0.72, blue: 0.72))
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 10)
                                    .background(TheOneTheme.urgentRed.opacity(0.18))
                                    .clipShape(RoundedRectangle(cornerRadius: 9))
                                    .overlay(RoundedRectangle(cornerRadius: 9).stroke(TheOneTheme.urgentRed.opacity(0.45)))
                            }
                        }
                    } else {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(opts, id: \.self) { opt in
                                    Button {
                                        onRespond(opt.lowercased() == "deny" ? "deny" : "reply", opt)
                                    } label: {
                                        Text(opt)
                                            .font(.caption.weight(.bold))
                                            .foregroundStyle(.black)
                                            .padding(.horizontal, 12)
                                            .padding(.vertical, 8)
                                            .background(TheOneTheme.goldGradient)
                                            .clipShape(RoundedRectangle(cornerRadius: 8))
                                    }
                                }
                            }
                        }
                    }
                }
                .padding(10)
                .background(TheOneTheme.urgentRed.opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: 10))
            } else if let step = agent.currentStep, !step.isEmpty {
                Text(step)
                    .font(.caption)
                    .foregroundStyle(agent.status == "working" ? TheOneTheme.activeGreen : TheOneTheme.mutedText)
                    .lineLimit(2)
            }

            // Idle "Send a message" button -> expandable multi-line composer; active cards keep inline steering bar
            if agent.status == "idle" {
                if showIdleComposer || !draft.isEmpty {
                    VStack(alignment: .trailing, spacing: 8) {
                        TextField("Write a message to \(agent.displayTitle)…", text: $draft, axis: .vertical)
                            .lineLimit(3...6)
                            .font(.caption)
                            .padding(10)
                            .background(Color.black.opacity(0.45))
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(TheOneTheme.goldMain.opacity(0.55)))

                        HStack(spacing: 8) {
                            Button("Cancel") {
                                draft = ""
                                showIdleComposer = false
                            }
                            .font(.caption.weight(.medium))
                            .foregroundStyle(TheOneTheme.mutedText)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)

                            Button {
                                let msg = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                                guard !msg.isEmpty else { return }
                                showIdleComposer = false
                                onRespond("reply", msg)
                            } label: {
                                Text("Send Message")
                                    .font(.caption.weight(.bold))
                                    .foregroundStyle(.black)
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 7)
                                    .background(TheOneTheme.goldGradient)
                                    .clipShape(RoundedRectangle(cornerRadius: 8))
                            }
                            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                    }
                } else {
                    Button {
                        showIdleComposer = true
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "arrowshape.turn.up.left")
                                .font(.caption2.weight(.semibold))
                            Text("Send a message")
                                .font(.caption.weight(.semibold))
                        }
                        .foregroundStyle(TheOneTheme.goldBright)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background(TheOneTheme.goldMain.opacity(0.14))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(TheOneTheme.goldMain.opacity(0.4)))
                    }
                }
            } else {
                HStack(spacing: 8) {
                    TextField("Steer agent or add note…", text: $draft)
                        .font(.caption)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .background(Color.black.opacity(0.35))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(TheOneTheme.borderSubtle))

                    Button {
                        let msg = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !msg.isEmpty else { return }
                        onRespond("reply", msg)
                    } label: {
                        Text("Send")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(TheOneTheme.surfaceElevated)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(TheOneTheme.borderSubtle))
                    }
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }

            // 1-Click Custom Macros Strip
            if !functions.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(functions) { fn in
                            Button {
                                onRunFunction(fn)
                            } label: {
                                Text(fn.label)
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(Color.white.opacity(0.88))
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 5)
                                    .background(TheOneTheme.surfaceElevated)
                                    .clipShape(Capsule())
                                    .overlay(Capsule().stroke(TheOneTheme.borderSubtle))
                            }
                        }
                    }
                }
            }

            // Expandable Activity Logs
            if logsExpanded, let logs = agent.logs, !logs.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Divider().overlay(TheOneTheme.borderSubtle)
                    ForEach(logs.prefix(6)) { log in
                        Text("› \(log.message ?? "")")
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(TheOneTheme.mutedText)
                            .lineLimit(2)
                    }
                }
                .padding(.top, 4)
            }
        }
        .padding(14)
        .background(TheOneTheme.surfaceCard)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(
                    agent.status == "needs_input" ? TheOneTheme.urgentRed.opacity(0.65) : TheOneTheme.borderSubtle,
                    lineWidth: agent.status == "needs_input" ? 1.5 : 1
                )
        )
    }
}
