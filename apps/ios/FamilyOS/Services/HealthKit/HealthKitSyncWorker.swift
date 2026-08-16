import Foundation

/// Drains `pending_ops` only. Not MainActor — UI observes results separately.
actor HealthKitSyncWorker {
    private let store: HealthKitSyncStore
    private let postBatch: @Sendable (HealthKitOpsBatchRequest) async throws -> HealthKitOpsBatchResult
    private let batchSize: Int
    private var isDraining = false

    init(
        store: HealthKitSyncStore,
        postBatch: @escaping @Sendable (HealthKitOpsBatchRequest) async throws -> HealthKitOpsBatchResult,
        batchSize: Int = 50
    ) {
        precondition(batchSize > 0)
        self.store = store
        self.postBatch = postBatch
        self.batchSize = batchSize
    }

    @discardableResult
    /// Drains one metric when `group` is supplied; background recovery drains
    /// every group by leaving it nil.
    func drain(group: String? = nil) async throws -> Int {
        guard !isDraining else { return 0 }
        isDraining = true
        defer { isDraining = false }

        var appliedTotal = 0
        var batchIndex = 0
        while true {
            let batch = try store.claimBatch(group: group, limit: batchSize)
            guard !batch.isEmpty else { break }
            guard let config = try store.configuration() else {
                CrashReporting.healthKit(
                    .drainBatch,
                    extra: ["reason": "missing_config", "batch_size": String(batch.count)]
                )
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

            batchIndex += 1
            CrashReporting.healthKit(
                .drainBatch,
                count: ops.count,
                extra: [
                    "batch_index": String(batchIndex),
                    "tz_version": String(config.timezoneVersion)
                ]
            )

            do {
                let result = try await postBatch(request)
                var appliedIds: [String] = []
                var rejected = 0
                for item in result.results {
                    switch item.result {
                    case "applied", "duplicate":
                        appliedIds.append(item.opId)
                    case "rejected":
                        rejected += 1
                        let code = item.errorCode ?? "payload_invalid"
                        try store.markRejected(opId: item.opId, errorCode: code)
                        CrashReporting.healthKitNonFatal(
                            .opRejected,
                            stage: .opRejected,
                            message: "op_rejected",
                            group: ops.first?.group,
                            metric: ops.first?.scopeKey
                        )
                    default:
                        try store.markBackoff(opIds: [item.opId], delaySeconds: 30)
                    }
                }
                try store.markApplied(opIds: appliedIds)
                appliedTotal += appliedIds.count
                if rejected > 0 {
                    CrashReporting.healthKit(
                        .drainBatch,
                        count: appliedIds.count,
                        extra: [
                            "rejected": String(rejected),
                            "batch_index": String(batchIndex)
                        ]
                    )
                }
            } catch {
                // Network / 5xx — keep ops, backoff.
                CrashReporting.healthKitNonFatal(
                    .batchFailed,
                    stage: .drainBatch,
                    message: "ops_batch_transport_failed",
                    underlying: error
                )
                try store.markBackoff(opIds: batch.map(\.opId), delaySeconds: 15)
                throw error
            }
        }
        return appliedTotal
    }
}
