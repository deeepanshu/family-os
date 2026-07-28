/**
 * Lightweight OTLP/HTTP JSON metrics exporter (counters + histograms + gauges).
 * Collector scrapes :8889 → Prometheus as app_* series.
 */

import {
  getOtelConfig,
  isOtelEnabled,
  otelAttrValue,
  otelResourceAttributes
} from "./otelConfig";

type Labels = Record<string, string>;

const DURATION_BOUNDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

type CounterKey = string;
type HistogramState = {
  labels: Labels;
  count: number;
  sum: number;
  buckets: number[]; // counts per bound + Inf
};

const requestTotals = new Map<CounterKey, { labels: Labels; value: number }>();
const errorTotals = new Map<CounterKey, { labels: Labels; value: number }>();
const durationHist = new Map<CounterKey, HistogramState>();
let inFlight = 0;

let flushTimer: ReturnType<typeof setInterval> | undefined;
let flushing = false;

function labelsKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(",");
}

function labelAttrs(labels: Labels) {
  return Object.entries(labels).map(([key, value]) => ({
    key,
    value: otelAttrValue(value)
  }));
}

export function configureOtelMetrics(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = undefined;
  }
  if (isOtelEnabled()) {
    flushTimer = setInterval(() => {
      void flushOtelMetrics();
    }, 5000);
    if (typeof flushTimer === "object" && flushTimer && "unref" in flushTimer) {
      (flushTimer as NodeJS.Timeout).unref?.();
    }
  }
}

export function recordHttpRequest(input: {
  method: string;
  route: string;
  status: number;
  durationMs: number;
}): void {
  if (!isOtelEnabled()) {
    return;
  }
  const method = input.method.toUpperCase();
  const route = input.route || "unknown";
  const status = String(input.status);
  const statusClass =
    input.status >= 500 ? "5xx" : input.status >= 400 ? "4xx" : input.status >= 300 ? "3xx" : input.status >= 200 ? "2xx" : "other";

  const reqLabels: Labels = { method, route, status, status_class: statusClass };
  const reqKey = labelsKey(reqLabels);
  const counter = requestTotals.get(reqKey) ?? { labels: reqLabels, value: 0 };
  counter.value += 1;
  requestTotals.set(reqKey, counter);

  if (input.status >= 500) {
    const errLabels: Labels = { method, route, status };
    const errKey = labelsKey(errLabels);
    const err = errorTotals.get(errKey) ?? { labels: errLabels, value: 0 };
    err.value += 1;
    errorTotals.set(errKey, err);
  }

  const histLabels: Labels = { method, route, status_class: statusClass };
  const histKey = labelsKey(histLabels);
  let hist = durationHist.get(histKey);
  if (!hist) {
    hist = {
      labels: histLabels,
      count: 0,
      sum: 0,
      buckets: new Array(DURATION_BOUNDS.length + 1).fill(0)
    };
    durationHist.set(histKey, hist);
  }
  const seconds = Math.max(0, input.durationMs) / 1000;
  hist.count += 1;
  hist.sum += seconds;
  // Non-cumulative per-bucket counts (collector converts to Prometheus cumulative le=).
  let placed = false;
  for (let i = 0; i < DURATION_BOUNDS.length; i++) {
    if (seconds <= DURATION_BOUNDS[i]!) {
      hist.buckets[i]! += 1;
      placed = true;
      break;
    }
  }
  if (!placed) {
    hist.buckets[DURATION_BOUNDS.length]! += 1;
  }
}

export function httpRequestStarted(): void {
  inFlight += 1;
}

export function httpRequestFinished(): void {
  inFlight = Math.max(0, inFlight - 1);
}

export async function flushOtelMetrics(): Promise<void> {
  if (!isOtelEnabled() || flushing) {
    return;
  }
  if (requestTotals.size === 0 && errorTotals.size === 0 && durationHist.size === 0 && inFlight === 0) {
    // still export up gauge
  }
  flushing = true;
  const now = String(BigInt(Date.now()) * 1_000_000n);
  const cfg = getOtelConfig();

  try {
    const metrics: unknown[] = [];

    const reqPoints = [...requestTotals.values()].map((c) => ({
      attributes: labelAttrs(c.labels),
      startTimeUnixNano: now,
      timeUnixNano: now,
      asInt: String(c.value)
    }));
    if (reqPoints.length > 0) {
      metrics.push({
        name: "http_server_requests_total",
        description: "Total HTTP requests handled by family-os",
        unit: "1",
        sum: {
          dataPoints: reqPoints,
          aggregationTemporality: 2,
          isMonotonic: true
        }
      });
    }

    const errPoints = [...errorTotals.values()].map((c) => ({
      attributes: labelAttrs(c.labels),
      startTimeUnixNano: now,
      timeUnixNano: now,
      asInt: String(c.value)
    }));
    if (errPoints.length > 0) {
      metrics.push({
        name: "http_server_errors_total",
        description: "Total HTTP 5xx responses",
        unit: "1",
        sum: {
          dataPoints: errPoints,
          aggregationTemporality: 2,
          isMonotonic: true
        }
      });
    }

    const histPoints = [...durationHist.values()].map((h) => ({
      attributes: labelAttrs(h.labels),
      startTimeUnixNano: now,
      timeUnixNano: now,
      count: String(h.count),
      sum: h.sum,
      bucketCounts: h.buckets.map(String),
      explicitBounds: DURATION_BOUNDS
    }));
    if (histPoints.length > 0) {
      metrics.push({
        name: "http_server_request_duration_seconds",
        description: "HTTP request duration in seconds",
        unit: "s",
        histogram: {
          dataPoints: histPoints,
          aggregationTemporality: 2
        }
      });
    }

    metrics.push({
      name: "http_server_inflight_requests",
      description: "In-flight HTTP requests",
      unit: "1",
      gauge: {
        dataPoints: [
          {
            timeUnixNano: now,
            asInt: String(inFlight)
          }
        ]
      }
    });

    metrics.push({
      name: "app_up",
      description: "1 if the process is exporting metrics",
      unit: "1",
      gauge: {
        dataPoints: [
          {
            timeUnixNano: now,
            asInt: "1"
          }
        ]
      }
    });

    const payload = {
      resourceMetrics: [
        {
          resource: { attributes: otelResourceAttributes() },
          scopeMetrics: [
            {
              scope: { name: cfg.serviceName, version: cfg.serviceVersion },
              metrics
            }
          ]
        }
      ]
    };

    const response = await fetch(`${cfg.endpoint}/v1/metrics`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "family-os-health-api-otel/1.0"
      },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      console.warn(
        JSON.stringify({
          msg: "otel metrics export failed",
          status: response.status,
          endpoint: cfg.endpoint
        })
      );
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        msg: "otel metrics export error",
        error: error instanceof Error ? error.message : String(error)
      })
    );
  } finally {
    flushing = false;
  }
}

export function _resetOtelMetricsForTests(): void {
  requestTotals.clear();
  errorTotals.clear();
  durationHist.clear();
  inFlight = 0;
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = undefined;
  }
}
