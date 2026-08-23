import SwiftUI

struct ReadingRow<Extra: View>: View {
    let title: String
    let subtitle: String?
    let metrics: [HistoryMetricCell]
    var onInfo: (() -> Void)? = nil
    var showsExtra: Bool = true
    @ViewBuilder var extra: Extra

    init(
        presentation: HistoryItemPresentation,
        onInfo: (() -> Void)? = nil,
        @ViewBuilder extra: () -> Extra
    ) {
        self.title = presentation.title
        self.subtitle = presentation.subtitle
        self.metrics = presentation.metrics
        self.onInfo = onInfo
        self.showsExtra = true
        self.extra = extra()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(title)
                    .font(.headline)
                Spacer(minLength: 8)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
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
            if !metrics.isEmpty {
                HistoryMetricGrid(metrics: metrics)
            }
        }
        .padding(.vertical, 2)
    }
}

extension ReadingRow where Extra == EmptyView {
    init(presentation: HistoryItemPresentation, onInfo: (() -> Void)? = nil) {
        self.title = presentation.title
        self.subtitle = presentation.subtitle
        self.metrics = presentation.metrics
        self.onInfo = onInfo
        self.showsExtra = false
        self.extra = EmptyView()
    }
}

private struct HistoryMetricGrid: View {
    let metrics: [HistoryMetricCell]
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 8, alignment: .topLeading), count: 3)

    var body: some View {
        LazyVGrid(columns: columns, alignment: .leading, spacing: 8) {
            ForEach(metrics) { metric in
                VStack(alignment: .leading, spacing: 1) {
                    Text(metric.label.uppercased())
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.tertiary)
                        .tracking(0.3)
                    Text(metric.value)
                        .font(.subheadline.weight(.semibold))
                        .monospacedDigit()
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    if let detail = metric.detail, !detail.isEmpty {
                        Text(detail)
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}
