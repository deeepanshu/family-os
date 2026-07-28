import { afterEach, describe, expect, it, vi } from "vitest";
import { _resetOtelMetricsForTests } from "../src/logging/otelMetrics";
import {
  _resetOtelLogsForTests,
  configureOtelLogs,
  flushOtelLogs,
  logInfo
} from "../src/logging/otelLogs";

describe("otelLogs", () => {
  afterEach(() => {
    _resetOtelLogsForTests();
    _resetOtelMetricsForTests();
    vi.unstubAllGlobals();
  });

  it("does not call fetch when endpoint is unset", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    configureOtelLogs({ endpoint: "", enabled: false });
    logInfo("hello", { a: 1 });
    await flushOtelLogs();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts OTLP JSON logs when enabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    configureOtelLogs({
      endpoint: "http://otel-collector:4318",
      serviceName: "family-os-health-api",
      environment: "prod",
      enabled: true
    });
    logInfo("http_request", { path: "/health", status: 200 });
    await flushOtelLogs();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://otel-collector:4318/v1/logs");
    const body = JSON.parse(String(init.body));
    expect(body.resourceLogs[0].scopeLogs[0].logRecords).toHaveLength(1);
    expect(body.resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue).toBe("http_request");
  });
});
