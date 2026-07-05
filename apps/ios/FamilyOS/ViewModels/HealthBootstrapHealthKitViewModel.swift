import Foundation

extension HealthBootstrapViewModel {
    func loadHealthKitStatus() async {
        healthKit.isAvailable = healthKitClient.isAvailable
        await request {
            healthKit.status = try await client.healthKitSyncStatus(baseURL: connection.baseURL, accessToken: auth.accessToken)
            healthKit.linkedProfileId = healthKit.status?.linkedProfileId
            if let linkedProfileId = healthKit.linkedProfileId {
                healthKit.dailySummaries = try await client.listHealthKitDailySummaries(
                    baseURL: connection.baseURL,
                    accessToken: auth.accessToken,
                    personId: linkedProfileId
                )
            }
            return "Loaded HealthKit sync status."
        }
    }

    func linkSelectedProfileForHealthKit() async {
        guard let profile = selectedProfile else {
            isError = true
            statusMessage = "Choose your own profile before linking HealthKit."
            return
        }
        await request {
            healthKit.status = try await client.linkHealthKitProfile(
                baseURL: connection.baseURL,
                accessToken: auth.accessToken,
                personId: profile.id
            )
            return "Linked \(profile.displayName) to HealthKit sync."
        }
    }

    func enableDefaultHealthKitMetrics() async {
        await request {
            healthKit.status = try await client.updateHealthKitSettings(
                baseURL: connection.baseURL,
                accessToken: auth.accessToken,
                enabledMetrics: HealthKitMetricType.allCases
            )
            return "Enabled HealthKit categories."
        }
    }

    func syncHealthKitNow() async {
        guard healthKitClient.isAvailable else {
            isError = true
            statusMessage = "HealthKit is not available on this device."
            return
        }
        guard let linkedProfileId = healthKit.linkedProfileId else {
            isError = true
            statusMessage = "Link your profile before syncing HealthKit."
            return
        }
        guard linkedProfileId == selfProfile?.id else {
            isError = true
            statusMessage = "HealthKit sync must target your own profile."
            return
        }
        healthKit.isSyncing = true
        defer { healthKit.isSyncing = false }
        await request {
            try await healthKitClient.requestAuthorization()
            let startDate = Calendar.current.date(byAdding: .day, value: -90, to: Date()) ?? Date()
            let enabled = Set(healthKit.enabledMetrics)
            let samples = try await healthKitClient.readSamples(since: startDate)
                .filter { enabled.contains($0.metricType) }
            let result = try await importHealthKitSamplesInBatches(samples)
            healthKit.status = try await client.healthKitSyncStatus(baseURL: connection.baseURL, accessToken: auth.accessToken)
            healthKit.dailySummaries = try await client.listHealthKitDailySummaries(
                baseURL: connection.baseURL,
                accessToken: auth.accessToken,
                personId: linkedProfileId
            )
            readings.bloodPressureReadings = try await client.listBloodPressure(
                baseURL: connection.baseURL,
                accessToken: auth.accessToken,
                personId: linkedProfileId
            )
            readings.bloodGlucoseReadings = try await client.listBloodGlucose(
                baseURL: connection.baseURL,
                accessToken: auth.accessToken,
                personId: linkedProfileId
            )
            return "HealthKit sync imported \(result.importedCount), skipped \(result.skippedCount), failed \(result.failedCount)."
        }
    }

    private func importHealthKitSamplesInBatches(_ samples: [HealthKitSampleInput]) async throws -> HealthKitImportResult {
        let batchSize = 500
        var syncRunId = ""
        var importedCount = 0
        var skippedCount = 0
        var failedCount = 0

        for startIndex in stride(from: 0, to: samples.count, by: batchSize) {
            let endIndex = min(startIndex + batchSize, samples.count)
            let batch = Array(samples[startIndex..<endIndex])
            let result = try await client.importHealthKitSamples(
                baseURL: connection.baseURL,
                accessToken: auth.accessToken,
                samples: batch
            )
            if syncRunId.isEmpty {
                syncRunId = result.syncRunId
            }
            importedCount += result.importedCount
            skippedCount += result.skippedCount
            failedCount += result.failedCount
        }

        return HealthKitImportResult(
            syncRunId: syncRunId,
            importedCount: importedCount,
            skippedCount: skippedCount,
            failedCount: failedCount
        )
    }
}
