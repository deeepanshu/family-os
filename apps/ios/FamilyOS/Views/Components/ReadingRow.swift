import SwiftUI

struct ReadingRow<Extra: View>: View {
    let kicker: String
    let title: String
    let detail: String?
    var onInfo: (() -> Void)? = nil
    var showsExtra: Bool = true
    @ViewBuilder var extra: Extra

    init(
        kicker: String,
        title: String,
        detail: String? = nil,
        onInfo: (() -> Void)? = nil,
        @ViewBuilder extra: () -> Extra
    ) {
        self.kicker = kicker
        self.title = title
        self.detail = detail
        self.onInfo = onInfo
        self.showsExtra = true
        self.extra = extra()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(kicker)
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack(spacing: 8) {
                Text(title)
                    .font(.headline)
                Spacer(minLength: 8)
                if let onInfo {
                    Button(action: onInfo) {
                        Image(systemName: "info.circle")
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Sleep stages")
                }
            }
            if showsExtra {
                extra
            }
            if let detail, !detail.isEmpty {
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

extension ReadingRow where Extra == EmptyView {
    init(
        kicker: String,
        title: String,
        detail: String? = nil,
        onInfo: (() -> Void)? = nil
    ) {
        self.kicker = kicker
        self.title = title
        self.detail = detail
        self.onInfo = onInfo
        self.showsExtra = false
        self.extra = EmptyView()
    }
}
