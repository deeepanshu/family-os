import SwiftUI

struct ProfileRow: View {
    let profile: HealthProfile

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(profile.displayName)
                .font(.body.weight(.medium))
            Text(profile.relationshipLabel ?? "Family member")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}
