import { afterEach, describe, expect, it, vi } from "vitest";
import { setOtelConfig, resetOtelConfigForTests } from "../src/logging/otelConfig";
import {
  _resetOtelMetricsForTests,
  flushOtelMetrics,
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
});
