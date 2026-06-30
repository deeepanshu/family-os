import Foundation

@MainActor
final class HealthKitSyncStateViewModel: ObservableObject {
    @Published var status: HealthKitSyncStatus?
    @Published var dailySummaries: [HealthMetricDailySummary] = []
    @Published var isAvailable = false
    @Published var isSyncing = false

    var enabledMetrics: [HealthKitMetricType] {
        status?.enabledMetrics ?? []
    }

    var linkedProfileId: String? {
        status?.linkedProfileId
    }

    func clear() {
        status = nil
        dailySummaries = []
        isAvailable = false
        isSyncing = false
    }
}
