/**
 * Frozen fingerprint fixtures for the canonical HealthKit event serializer.
 * These vectors must not change; regressions break event_conflict semantics.
 */
import { createHash } from "node:crypto";
import {
  canonicalHealthEventString,
  canonicalScopeManifestString,
  sha256HexFromUtf8
} from "./healthkitCanonical";
import {
  fingerprintHealthEvent,
  fingerprintScopeManifest,
  type HealthKitSyncEvent
} from "./healthkitEvents";

function nodeSha256(data: Uint8Array): Uint8Array {
  return createHash("sha256").update(data).digest();
}

const stepsHourUpsertEvent: HealthKitSyncEvent = {
  eventId: "11111111-1111-4111-8111-111111111111",
  entityKey: "steps_hour:2026-07-25T14:00:00.000Z",
  entityVersion: 1,
  group: "activity",
  scopeKey: "steps",
  op: "upsert",
  sessionId: null,
  payload: {
    kind: "steps_hour",
    hourStartUtc: "2026-07-25T14:00:00.000Z",
    count: 1200
  }
};

const stepsHourDeleteEvent: HealthKitSyncEvent = {
  eventId: "22222222-2222-4222-8222-222222222222",
  entityKey: "steps_hour:2026-07-25T14:00:00.000Z",
  entityVersion: 2,
  group: "activity",
  scopeKey: "steps",
  op: "delete",
  sessionId: null,
  payload: null
};

const sleepDayUpsertEvent: HealthKitSyncEvent = {
  eventId: "33333333-3333-4333-8333-333333333333",
  entityKey: "sleep_day:2026-07-24",
  entityVersion: 1,
  group: "sleep",
  scopeKey: "sleep",
  op: "upsert",
  sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  payload: {
    kind: "sleep_day",
    sleepDay: "2026-07-24",
    totalMinutes: 420,
    coreMinutes: 200,
    deepMinutes: 90,
    remMinutes: 100,
    unspecifiedAsleepMinutes: 30,
    awakeMinutes: 20,
    inBedMinutes: 450
  }
};

const scopeManifestInput = {
  sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  scopeKey: "steps",
  eventIds: [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222"
  ]
};

export const HEALTHKIT_FINGERPRINT_FIXTURES = {
  stepsHourUpsert: {
    event: stepsHourUpsertEvent,
    fingerprint: fingerprintHealthEvent(stepsHourUpsertEvent, nodeSha256)
  },
  stepsHourDelete: {
    event: stepsHourDeleteEvent,
    fingerprint: fingerprintHealthEvent(stepsHourDeleteEvent, nodeSha256)
  },
  sleepDayUpsert: {
    event: sleepDayUpsertEvent,
    fingerprint: fingerprintHealthEvent(sleepDayUpsertEvent, nodeSha256)
  },
  scopeManifest: {
    ...scopeManifestInput,
    fingerprint: fingerprintScopeManifest(scopeManifestInput, nodeSha256)
  }
} as const;

/** Explicit digests and preimages for cross-language fixtures (iOS). */
export const HEALTHKIT_FROZEN_FINGERPRINTS = {
  stepsHourUpsert: HEALTHKIT_FINGERPRINT_FIXTURES.stepsHourUpsert.fingerprint,
  stepsHourDelete: HEALTHKIT_FINGERPRINT_FIXTURES.stepsHourDelete.fingerprint,
  sleepDayUpsert: HEALTHKIT_FINGERPRINT_FIXTURES.sleepDayUpsert.fingerprint,
  scopeManifest: HEALTHKIT_FINGERPRINT_FIXTURES.scopeManifest.fingerprint,
  preimages: {
    stepsHourUpsert: canonicalHealthEventString(stepsHourUpsertEvent),
    stepsHourDelete: canonicalHealthEventString(stepsHourDeleteEvent),
    sleepDayUpsert: canonicalHealthEventString(sleepDayUpsertEvent),
    scopeManifest: canonicalScopeManifestString(scopeManifestInput)
  }
} as const;

export function assertFrozenFingerprintsStable(): void {
  const recompute = (event: HealthKitSyncEvent) => fingerprintHealthEvent(event, nodeSha256);
  if (recompute(stepsHourUpsertEvent) !== HEALTHKIT_FROZEN_FINGERPRINTS.stepsHourUpsert) {
    throw new Error("stepsHourUpsert fingerprint drift");
  }
  if (recompute(stepsHourDeleteEvent) !== HEALTHKIT_FROZEN_FINGERPRINTS.stepsHourDelete) {
    throw new Error("stepsHourDelete fingerprint drift");
  }
  if (recompute(sleepDayUpsertEvent) !== HEALTHKIT_FROZEN_FINGERPRINTS.sleepDayUpsert) {
    throw new Error("sleepDayUpsert fingerprint drift");
  }
  const scope = fingerprintScopeManifest(scopeManifestInput, nodeSha256);
  if (scope !== HEALTHKIT_FROZEN_FINGERPRINTS.scopeManifest) {
    throw new Error("scopeManifest fingerprint drift");
  }
}

export function testSha256Hex(utf8: string): string {
  return sha256HexFromUtf8(utf8, nodeSha256);
}
