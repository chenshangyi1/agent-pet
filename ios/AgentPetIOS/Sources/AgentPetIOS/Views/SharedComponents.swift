import SwiftUI

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

enum PlatformColors {
    static var groupedBackground: Color {
        #if os(iOS)
        return Color(uiColor: .systemGroupedBackground)
        #else
        return Color(nsColor: .windowBackgroundColor)
        #endif
    }

    static var cardBackground: Color {
        #if os(iOS)
        return Color(uiColor: .secondarySystemGroupedBackground)
        #else
        return Color(nsColor: .controlBackgroundColor)
        #endif
    }

    static var subtleFill: Color {
        #if os(iOS)
        return Color(uiColor: .tertiarySystemFill)
        #else
        return Color.primary.opacity(0.06)
        #endif
    }
}

struct AgentAvatarBadge: View {
    let agentId: String
    var size: CGFloat = 34
    var cornerRadius: CGFloat = 10

    private var meta: AgentVisualMeta {
        AgentVisualMeta.meta(for: agentId)
    }

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(meta.color.gradient)
                .frame(width: size, height: size)

            Image(systemName: meta.symbolName)
                .font(.system(size: size * 0.46, weight: .semibold))
                .foregroundStyle(.white)
        }
        .accessibilityLabel(meta.label)
    }
}

struct ActivityStatusBadge: View {
    let status: String?
    var showLabel: Bool = false

    private var meta: ActivityStatusMeta {
        ActivityStatusMeta.from(status)
    }

    var body: some View {
        HStack(spacing: 5) {
            if meta.isSpinning {
                ProgressView()
                    .controlSize(.small)
                    .tint(meta.color)
            } else {
                Image(systemName: meta.symbolName)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(meta.color)
            }

            if showLabel {
                Text(meta.label)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(meta.color)
            }
        }
    }
}

struct ToastBannerView: View {
    let message: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
            Text(message)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.white)
                .lineLimit(2)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(
            Capsule(style: .continuous)
                .fill(Color.black.opacity(0.86))
                .shadow(color: .black.opacity(0.22), radius: 10, y: 4)
        )
        .padding(.horizontal, 16)
    }
}
