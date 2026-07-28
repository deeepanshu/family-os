import BackgroundTasks
import Foundation
import HealthKit
import UIKit

/// Owns observer registration, completion handlers, and background retry scheduling.
@MainActor
final class HealthKitBackgroundSyncCoordinator {
    static let shared = HealthKitBackgroundSyncCoordinator()
    static let bgTaskIdentifier = "com.deepanshujain.familyos.healthkit-sync"

    private let healthKit = HealthKitClient()
    private let engine = HealthKitSyncEngine()
    private let stateStore = HealthKitSyncStateStore()
    private let sessionProvider = HealthKitSessionProvider()
    private var observerQueries: [HKObserverQuery] = []
    private var observedMetrics: Set<HealthKitSyncMetric> = []
    private var isProcessing = false
    private var processingWaiters: [CheckedContinuation<Void, Never>] = []

    private init() {}

    func registerBackgroundTasks() {
        Task {
            await HealthKitSyncWorker.shared.start()
        }
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.bgTaskIdentifier, using: nil) { task in
            guard let processingTask = task as? BGProcessingTask else {
                task.setTaskCompleted(success: false)
                return
            }
            Task { @MainActor in
                await HealthKitBackgroundSyncCoordinator.shared.handleBackgroundProcessing(task: processingTask)
            }
        }
    }

    /// Call after validated consent/configuration is available. Registers only enabled metrics.
    func configureObservers(for metrics: [HealthKitSyncMetric]) {
        guard healthKit.isAvailable else { return }
        let enabled = Set(metrics)
        if enabled == observedMetrics, !observerQueries.isEmpty {
            return
        }
        stopObservers()
        guard !enabled.isEmpty else { return }

        var observedTypes: [String: (type: HKSampleType, dataMetric: HealthKitDataMetric?)] = [:]
        for dataMetric in HealthKitDataMetric.allCases where enabled.contains(dataMetric.group) {
            guard let type = dataMetric.sampleType, !(type is HKCorrelationType) else { continue }
            observedTypes[type.identifier] = (type, dataMetric)
        }
        if enabled.contains(.vitals), let systolic = HKQuantityType.quantityType(forIdentifier: .bloodPressureSystolic) {
            observedTypes[systolic.identifier] = (systolic, nil)
        }
        for (_, registration) in observedTypes {
            let type = registration.type
            let query = healthKit.observe(type: type) { completionHandler in
                Task { @MainActor in
                    defer { completionHandler() }
                    if let dataMetric = registration.dataMetric {
                        switch dataMetric.storage {
                        case .dailyNumeric, .bloodGlucose, .workout:
                            await HealthKitBackgroundSyncCoordinator.shared.handleObserverFire(dataMetric: dataMetric)
                        case .hourly, .sleepDay, .bloodPressure:
                            await HealthKitBackgroundSyncCoordinator.shared.handleObserverFire(metric: dataMetric.group)
                        }
                    } else {
                        await HealthKitBackgroundSyncCoordinator.shared.handleObserverFire(metric: .vitals)
                    }
                }
            }
            observerQueries.append(query)
        }
        observedMetrics = enabled
        Task {
            try? await healthKit.enableBackgroundDelivery(for: enabled)
        }
    }

    /// Restores local configuration and registers observers only when consent is active.
    func restoreObserversFromLocalConfiguration() async {
        guard let configuration = await stateStore.loadConfiguration(),
              configuration.consentVersion != nil,
              !configuration.enabledMetrics.isEmpty
        else {
            stopObservers()
            return
        }
        configureObservers(for: configuration.enabledMetrics)
    }

    func stopObservers() {
        for query in observerQueries {
            healthKit.stop(query)
        }
        observerQueries.removeAll()
        observedMetrics = []
    }

    func scheduleBackgroundRetry() {
        let request = BGProcessingTaskRequest(identifier: Self.bgTaskIdentifier)
        request.requiresNetworkConnectivity = true
        request.requiresExternalPower = false
        try? BGTaskScheduler.shared.submit(request)
    }

    func resumePendingWorkIfSignedIn(using viewModel: HealthBootstrapViewModel? = nil) async {
        viewModel?.healthKit.isAutomaticallySyncing = true
        defer { viewModel?.healthKit.isAutomaticallySyncing = false }
        await processSerialized {
            let context: HealthKitSyncEngine.SessionContext
            if let viewModel, let uiContext = await self.contextFromViewModel(viewModel) {
                context = uiContext
            } else {
                context = try await self.sessionProvider.makeContext(origin: .appLaunch)
            }
            try await self.engine.processPendingWork(context: context)
            self.configureObservers(for: context.enabledGroups)
            if let viewModel {
                await viewModel.loadHealthKitStatus()
            }
        }
    }

    /// Foreground sync shares the same engine and outbox serialisation as observer work.
    func runForegroundSync(context: HealthKitSyncEngine.SessionContext) async throws {
        while isProcessing {
            await withCheckedContinuation { continuation in
                processingWaiters.append(continuation)
            }
        }

        isProcessing = true
        defer { finishProcessing() }
        try await engine.enableAndRepair(context: context)
        configureObservers(for: context.enabledGroups)
    }

    private func handleObserverFire(metric: HealthKitSyncMetric) async {
        recordTrace(origin: .healthKitObserver, phase: .started)
        let success = await processSerialized {
            let context = try await self.sessionProvider.makeContext(origin: .healthKitObserver)
            guard context.enabledGroups.contains(metric) else { return }
            try await self.engine.processMetric(metric, context: context)
        }
        // Plan: do not schedule after successful observer work unless a future retry is owed.
        if !success || hasFutureOutboxRetry() {
            if !success {
                recordTrace(origin: .healthKitObserver, phase: .failed)
            }
            scheduleBackgroundRetry()
        }
    }

    private func handleObserverFire(dataMetric: HealthKitDataMetric) async {
        recordTrace(origin: .healthKitObserver, phase: .started)
        let success = await processSerialized {
            let context = try await self.sessionProvider.makeContext(origin: .healthKitObserver)
            try await self.engine.processDataMetric(dataMetric, context: context)
        }
        if !success || hasFutureOutboxRetry() {
            if !success {
                recordTrace(origin: .healthKitObserver, phase: .failed)
            }
            scheduleBackgroundRetry()
        }
    }

    private func hasFutureOutboxRetry() -> Bool {
        (try? HealthKitOutboxStore.shared.hasFutureRetries()) == true
    }

    private func handleBackgroundProcessing(task: BGProcessingTask) async {
        recordTrace(origin: .backgroundTask, phase: .started)
        task.expirationHandler = {
            Task { @MainActor in
                HealthKitBackgroundSyncCoordinator.shared.scheduleBackgroundRetry()
            }
        }

        let success = await processSerialized {
            let context = try await self.sessionProvider.makeContext(origin: .backgroundTask)
            try await self.engine.processPendingWork(context: context)
            self.configureObservers(for: context.enabledGroups)
        }

        task.setTaskCompleted(success: success)
        if !success {
            recordTrace(origin: .backgroundTask, phase: .failed)
            scheduleBackgroundRetry()
        }
    }

    private func recordTrace(origin: HealthKitSyncOrigin, phase: HealthKitSyncTracePhase) {
        try? HealthKitOutboxStore.shared.recordSyncTrace(origin: origin, phase: phase, eventCount: 0)
    }

    @discardableResult
    private func processSerialized(_ work: @escaping () async throws -> Void) async -> Bool {
        guard !isProcessing else {
            // Contended; schedule a later pass rather than dropping work.
            scheduleBackgroundRetry()
            return false
        }
        isProcessing = true
        defer { finishProcessing() }
        do {
            try await work()
            return true
        } catch {
            // Redacted: do not log health values, UUIDs, anchors, or tokens.
            return false
        }
    }

    private func finishProcessing() {
        isProcessing = false
        let waiters = processingWaiters
        processingWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }

    private func contextFromViewModel(_ viewModel: HealthBootstrapViewModel) async -> HealthKitSyncEngine.SessionContext? {
        guard !viewModel.auth.accessToken.isEmpty,
              let userId = viewModel.auth.signedInUserId,
              let personId = viewModel.selfProfile?.id ?? viewModel.healthKit.linkedProfileId,
              let status = viewModel.healthKit.status,
              status.consentActive
        else {
            return nil
        }
        let installationId: String
        do {
            installationId = try await stateStore.installationId()
        } catch {
            return nil
        }
        return HealthKitSyncEngine.SessionContext(
            baseURL: viewModel.connection.baseURL,
            accessToken: viewModel.auth.accessToken,
            userId: userId,
            personId: personId,
            timezone: status.healthTimezone,
            timezoneVersion: status.healthTimezoneVersion,
            installationId: installationId,
            enabledGroups: status.enabledGroups,
            origin: .appLaunch
        )
    }
}

extension Notification.Name {
    static let healthKitObserverFired = Notification.Name("FamilyOSHealthKitObserverFired")
}
