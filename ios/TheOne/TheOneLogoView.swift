import SwiftUI

enum TheOneTheme {
    static let obsidianBg = Color(red: 0.028, green: 0.028, blue: 0.038)
    static let surfaceCard = Color(red: 0.067, green: 0.067, blue: 0.088)
    static let surfaceElevated = Color(red: 0.10, green: 0.10, blue: 0.13)
    static let borderSubtle = Color.white.opacity(0.10)

    static let goldBright = Color(red: 1.0, green: 0.965, blue: 0.84)
    static let goldMain = Color(red: 0.910, green: 0.769, blue: 0.408) // #E8C468
    static let goldDeep = Color(red: 0.722, green: 0.525, blue: 0.157)

    static let urgentRed = Color(red: 0.937, green: 0.267, blue: 0.267)
    static let reviewAmber = Color(red: 0.918, green: 0.702, blue: 0.031)
    static let activeGreen = Color(red: 0.188, green: 0.820, blue: 0.345)
    static let mutedText = Color(red: 0.56, green: 0.56, blue: 0.62)

    static var goldGradient: LinearGradient {
        LinearGradient(
            colors: [goldBright, goldMain, goldDeep],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }
}

/// Native SwiftUI Forged Gold One Ring & Eye Emblem
struct TheOneLogoView: View {
    var size: CGFloat = 28
    var urgent: Bool = false
    @State private var pulse = false

    var body: some View {
        ZStack {
            Circle()
                .fill((urgent ? TheOneTheme.urgentRed : TheOneTheme.goldMain).opacity(pulse ? 0.28 : 0.14))
                .frame(width: size * 1.24, height: size * 1.24)
                .blur(radius: size * 0.14)

            // Forged One Ring outer band
            Circle()
                .stroke(
                    urgent
                        ? LinearGradient(colors: [Color.orange, TheOneTheme.urgentRed], startPoint: .topLeading, endPoint: .bottomTrailing)
                        : TheOneTheme.goldGradient,
                    lineWidth: max(2.2, size * 0.14)
                )
                .frame(width: size * 0.84, height: size * 0.84)

            // Inner dashed rune ring
            Circle()
                .stroke(
                    TheOneTheme.goldBright.opacity(0.38),
                    style: StrokeStyle(lineWidth: max(0.7, size * 0.035), dash: [2, 3])
                )
                .frame(width: size * 0.62, height: size * 0.62)

            // Inner flame glow contour
            Ellipse()
                .fill((urgent ? TheOneTheme.urgentRed : TheOneTheme.goldMain).opacity(0.32))
                .frame(width: size * 0.22, height: size * 0.56)

            // Vertical eye iris
            Ellipse()
                .fill(urgent ? Color.orange : TheOneTheme.goldBright)
                .frame(width: size * 0.11, height: size * 0.46)
                .scaleEffect(y: pulse ? 1.04 : 0.96)

            // Vertical obsidian slit pupil
            Ellipse()
                .fill(TheOneTheme.obsidianBg)
                .frame(width: max(1.4, size * 0.048), height: size * 0.30)
        }
        .frame(width: size, height: size)
        .onAppear {
            withAnimation(.easeInOut(duration: 1.8).repeatForever(autoreverses: true)) {
                pulse = true
            }
        }
    }
}
