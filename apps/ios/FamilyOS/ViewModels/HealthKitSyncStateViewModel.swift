import Foundation

@MainActor
final class HealthKitSyncStateViewModel: ObservableObject {
    @Published var status: HealthKitSyncStatus?
    @Published var dailySummaries: [HealthMetricDailySummary] = []
    @Published var isAvailable = false
    @Published var isSyncing = false
    @Published var linkedProfileId: String?

    var enabledMetrics: [HealthKitMetricType] {
        status?.enabledMetrics ?? []
    }

    func clear() {
        status = nil
        dailySummaries = []
        isAvailable = false
        isSyncing = false
        linkedProfileId = nil
    }
}
