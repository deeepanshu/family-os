import { describe, expect, it } from "vitest";
import {
  allocateValueAcrossLocalHours,
  aggregateDailySleepHours,
  aggregateHourlySteps
} from "../src/mcp/sampleAggregation";
import type { HealthKitSampleRecord } from "../src/repositories/contracts";

function sample(partial: Partial<HealthKitSampleRecord> & Pick<HealthKitSampleRecord, "startDate" | "metricType">): HealthKitSampleRecord {
  return {
    id: "s1",
    familyId: "f1",
    personId: "p1",
    userId: "u1",
    syncRunId: "r1",
    sourceSampleKey: "k1",
    value: 1000,
    ...partial
  };
}

describe("sampleAggregation", () => {
  it("splits a multi-hour steps sample proportionally across local hours", () => {
    const amounts = allocateValueAcrossLocalHours(
      "2026-07-15T08:30:00.000Z",
      "2026-07-15T09:30:00.000Z",
      1000,
      "UTC"
    );
    expect(amounts.get("2026-07-15T08:00")).toBeCloseTo(500, 5);
    expect(amounts.get("2026-07-15T09:00")).toBeCloseTo(500, 5);
  });

  it("attributes sleep duration to the local day the session ends", () => {
    const points = aggregateDailySleepHours(
      [
        sample({
          metricType: "sleep",
          startDate: "2026-07-15T23:00:00.000Z",
          endDate: "2026-07-16T07:00:00.000Z",
          value: 480
        })
      ],
      "2026-07-15",
      "2026-07-16",
      "UTC"
    );
    expect(points).toEqual([{ bucket: "2026-07-16", value: 8 }]);
  });

  it("aggregates hourly steps with proportional allocation", () => {
    const points = aggregateHourlySteps(
      [
        sample({
          metricType: "steps",
          startDate: "2026-07-15T08:30:00.000Z",
          endDate: "2026-07-15T09:30:00.000Z",
          value: 1000
        })
      ],
      "2026-07-15",
      "2026-07-15",
      "UTC"
    );
    expect(points.find((p) => p.bucket === "2026-07-15T08:00")?.value).toBeCloseTo(500, 5);
    expect(points.find((p) => p.bucket === "2026-07-15T09:00")?.value).toBeCloseTo(500, 5);
  });
});
