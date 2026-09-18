import { afterEach, describe, expect, it, vi } from "vitest";
import { setOtelConfig, resetOtelConfigForTests } from "../src/logging/otelConfig";
import {
  _resetOtelMetricsForTests,
  flushOtelMetrics,
  healthKitAbandonmentKind,
  recordHealthKitRunFailure,
  recordHttpRequest
} from "../src/logging/otelMetrics";

describe("otelMetrics", () => {
  afterEach(() => {
    _resetOtelMetricsForTests();
    resetOtelConfigForTests();
    vi.unstubAllGlobals();
  });

  it("posts cumulative request counters and duration histogram", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    setOtelConfig({
      endpoint: "http://otel-collector:4318",
      serviceName: "family-os-health-api",
      environment: "prod",
      enabled: true
    });

    recordHttpRequest({
      method: "GET",
      route: "/health/api/v1/healthcheck",
      status: 200,
      durationMs: 12
    });
    recordHttpRequest({
      method: "GET",
      route: "/health/api/v1/healthcheck",
      status: 200,
      durationMs: 30
    });
    recordHttpRequest({
      method: "POST",
      route: "/health/api/v1/families",
      status: 500,
      durationMs: 80
    });

    await flushOtelMetrics();

    expect(fetchMock).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://otel-collector:4318/v1/metrics");
    const body = JSON.parse(String(init.body));
    const metrics = body.resourceMetrics[0].scopeMetrics[0].metrics as Array<{ name: string }>;
    const names = metrics.map((m) => m.name);
    expect(names).toContain("http_server_requests_total");
    expect(names).toContain("http_server_request_duration_seconds");
    expect(names).toContain("http_server_errors_total");
    expect(names).toContain("app_up");
  });

  it("maps health kit error codes to abandonment kind", () => {
    expect(healthKitAbandonmentKind("sync_abandoned")).toBe("abandoned");
    expect(healthKitAbandonmentKind("sync_timeout")).toBe("failed");
    expect(healthKitAbandonmentKind("sync_cancelled")).toBe("failed");
    expect(healthKitAbandonmentKind("sync_failed")).toBe("failed");
    expect(healthKitAbandonmentKind("sync_incomplete")).toBe("failed");
    expect(healthKitAbandonmentKind("something_else")).toBe("other");
  });

  it("emits a cumulative healthkit_run_failures_total counter with labels", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    setOtelConfig({
      endpoint: "http://otel-collector:4318",
      serviceName: "family-os-health-api",
      environment: "prod",
      enabled: true
    });

    recordHealthKitRunFailure({ group: "family-a", errorCode: "sync_abandoned" });
    recordHealthKitRunFailure({ group: "family-a", errorCode: "sync_abandoned" });
    recordHealthKitRunFailure({ group: "family-b", errorCode: "sync_timeout" });

    await flushOtelMetrics();

    expect(fetchMock).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://otel-collector:4318/v1/metrics");
    const body = JSON.parse(String(init.body));
    const metrics = body.resourceMetrics[0].scopeMetrics[0].metrics as Array<{
      name: string;
      sum?: {
        dataPoints: Array<{
          attributes: Array<{ key: string; value: Record<string, string> }>;
          asInt: string;
        }>;
        aggregationTemporality: number;
        isMonotonic: boolean;
      };
    }>;

    const hkMetric = metrics.find((m) => m.name === "healthkit_run_failures_total");
    expect(hkMetric).toBeDefined();

    const { sum } = hkMetric as {
      sum: {
        dataPoints: Array<{
          attributes: Array<{ key: string; value: Record<string, string> }>;
          asInt: string;
        }>;
        aggregationTemporality: number;
        isMonotonic: boolean;
      };
    };
    expect(sum.aggregationTemporality).toBe(2);
    expect(sum.isMonotonic).toBe(true);
    expect(sum.dataPoints).toHaveLength(2);

    const labelOf = (dp: (typeof sum.dataPoints)[number], key: string): string => {
      const attr = dp.attributes.find((a) => a.key === key);
      return attr ? Object.values(attr.value)[0] ?? "" : "";
    };

    const abandoned = sum.dataPoints.find(
      (dp) => labelOf(dp, "group") === "family-a"
    );
    expect(abandoned).toBeDefined();
    expect(labelOf(abandoned as (typeof sum.dataPoints)[number], "error_code")).toBe(
      "sync_abandoned"
    );
    expect(labelOf(abandoned as (typeof sum.dataPoints)[number], "abandonment_kind")).toBe(
      "abandoned"
    );
    expect((abandoned as (typeof sum.dataPoints)[number]).asInt).toBe("2");

    const failed = sum.dataPoints.find((dp) => labelOf(dp, "group") === "family-b");
    expect(failed).toBeDefined();
    expect(labelOf(failed as (typeof sum.dataPoints)[number], "error_code")).toBe("sync_timeout");
    expect(labelOf(failed as (typeof sum.dataPoints)[number], "abandonment_kind")).toBe("failed");
    expect((failed as (typeof sum.dataPoints)[number]).asInt).toBe("1");
  });
});
