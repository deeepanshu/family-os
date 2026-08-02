import Foundation

/// Drains `pending_ops` only. Not MainActor — UI observes results separately.
actor HealthKitSyncWorker {
    private let store: HealthKitSyncStore
    private let postBatch: @Sendable (HealthKitOpsBatchRequest) async throws -> HealthKitOpsBatchResult
    private var isDraining = false

    init(
        store: HealthKitSyncStore,
        postBatch: @escaping @Sendable (HealthKitOpsBatchRequest) async throws -> HealthKitOpsBatchResult
    ) {
        self.store = store
        self.postBatch = postBatch
    }

    @discardableResult
    func drain() async throws -> Int {
        guard !isDraining else { return 0 }
        isDraining = true
        defer { isDraining = false }

        var appliedTotal = 0
        while true {
            let batch = try store.claimBatch(limit: 50)
            guard !batch.isEmpty else { break }
            guard let config = try store.configuration() else {
                try store.markBackoff(opIds: batch.map(\.opId), delaySeconds: 5)
                break
            }

            let ops: [HealthKitSyncOpWire] = try batch.map { row in
                var payload: HealthKitOpPayloadWire?
                if let json = row.payloadJSON, let data = json.data(using: .utf8) {
                    payload = try JSONDecoder().decode(HealthKitOpPayloadWire.self, from: data)
                }
                return HealthKitSyncOpWire(
                    opId: row.opId,
                    naturalKey: row.naturalKey,
                    group: row.groupKey,
                    scopeKey: row.scopeKey,
                    op: row.op,
                    payload: payload
                )
            }

            let request = HealthKitOpsBatchRequest(
                installationId: config.installationId,
                personId: config.personId,
                timezoneVersion: config.timezoneVersion,
                ops: ops
            )

            do {
                let result = try await postBatch(request)
                var appliedIds: [String] = []
                for item in result.results {
                    switch item.result {
                    case "applied", "duplicate":
                        appliedIds.append(item.opId)
                    case "rejected":
                        try store.markRejected(opId: item.opId, errorCode: item.errorCode ?? "payload_invalid")
                    default:
                        try store.markBackoff(opIds: [item.opId], delaySeconds: 30)
                    }
                }
                try store.markApplied(opIds: appliedIds)
                appliedTotal += appliedIds.count
            } catch {
                // Network / 5xx — keep ops, backoff.
                try store.markBackoff(opIds: batch.map(\.opId), delaySeconds: 15)
                throw error
            }
        }
        return appliedTotal
    }
}
