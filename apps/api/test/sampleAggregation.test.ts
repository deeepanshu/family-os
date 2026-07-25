import { describe, expect, it } from "vitest";
import {
  allocateValueAcrossLocalHours,
  aggregateDailySleepHours,
  aggregateHourlySteps,
  nextLocalHourBoundaryMs
} from "../src/mcp/sampleAggregation";
import type { AggregateSample } from "../src/mcp/sampleAggregation";

function sample(partial: Partial<AggregateSample> & Pick<AggregateSample, "startDate" | "metricType">): AggregateSample {
  return {
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

  it("uses the true hour boundary when the sample starts with non-zero seconds", () => {
    // 08:30:30 → 09:00:30 should allocate 29.5 min to 08:00 and 30.5 min to 09:00,
    // not treat 09:00:30 as the boundary.
    const start = Date.parse("2026-07-15T08:30:30.000Z");
    const boundary = nextLocalHourBoundaryMs(start, "UTC");
    expect(boundary).toBe(Date.parse("2026-07-15T09:00:00.000Z"));

    const amounts = allocateValueAcrossLocalHours(
      "2026-07-15T08:30:30.000Z",
      "2026-07-15T09:00:30.000Z",
      1800,
      "UTC"
    );
    // 29.5 minutes in hour 08, 0.5 minutes in hour 09 out of 30 total minutes
    expect(amounts.get("2026-07-15T08:00")).toBeCloseTo(1800 * (29.5 / 30), 5);
    expect(amounts.get("2026-07-15T09:00")).toBeCloseTo(1800 * (0.5 / 30), 5);
  });

  it("handles millisecond precision on the hour boundary", () => {
    const start = Date.parse("2026-07-15T08:59:59.500Z");
    const boundary = nextLocalHourBoundaryMs(start, "UTC");
    expect(boundary).toBe(Date.parse("2026-07-15T09:00:00.000Z"));
  });

  it("finds the next local hour across a US Pacific DST spring-forward", () => {
    // 2026-03-08: clocks jump 02:00 → 03:00 in America/Los_Angeles.
    // 01:30 PST is 09:30 UTC; the next distinct local-hour bucket is 03:00 PDT = 10:00 UTC
    // (the 02:00 local hour does not exist). Real elapsed time 01:30→03:00 is 30 minutes.
    const from = Date.parse("2026-03-08T09:30:00.000Z");
    const boundary = nextLocalHourBoundaryMs(from, "America/Los_Angeles");
    expect(boundary).toBe(Date.parse("2026-03-08T10:00:00.000Z"));

    const amounts = allocateValueAcrossLocalHours(
      "2026-03-08T09:30:00.000Z",
      "2026-03-08T10:30:00.000Z",
      1000,
      "America/Los_Angeles"
    );
    // 30 real minutes in local hour 01, 30 real minutes in local hour 03
    expect(amounts.get("2026-03-08T01:00")).toBeCloseTo(500, 3);
    expect(amounts.get("2026-03-08T03:00")).toBeCloseTo(500, 3);
    expect(amounts.has("2026-03-08T02:00")).toBe(false);
  });

  it("finds the next local hour across a US Pacific DST fall-back", () => {
    // 2026-11-01: 02:00 PDT falls back to 01:00 PST. localHourBucket is hour-granular, so both
    // occurrences of 01:xx share the "T01:00" label until local 02:00 PST (10:00 UTC).
    const from = Date.parse("2026-11-01T08:30:00.000Z"); // 01:30 PDT (first occurrence)
    const boundary = nextLocalHourBoundaryMs(from, "America/Los_Angeles");
    expect(boundary).toBe(Date.parse("2026-11-01T10:00:00.000Z")); // 02:00 PST
    expect(boundary - from).toBe(90 * 60_000);
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
