import SwiftUI

struct ReadingRow: View {
    let title: String
    let detail: String
    let source: String?

    init(title: String, detail: String, source: String? = nil) {
        self.title = title
        self.detail = detail
        self.source = source
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.headline)
            Text(detail)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            if let source {
                Text(source)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }
}
