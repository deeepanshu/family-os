/**
 * Lightweight OTLP/HTTP JSON log exporter for the homelab collector.
 * Logs always go to console; OTLP is best-effort and never throws into request path.
 */

import {
  getOtelConfig,
  isOtelEnabled,
  otelAttrValue,
  otelResourceAttributes,
  resetOtelConfigForTests,
  setOtelConfig
} from "./otelConfig";
import { configureOtelMetrics, flushOtelMetrics } from "./otelMetrics";

export type LogSeverity = "DEBUG" | "INFO" | "WARN" | "ERROR";

type LogAttributes = Record<string, string | number | boolean | undefined | null>;

type PendingLog = {
  body: string;
  severity: LogSeverity;
  attributes: LogAttributes;
  timeUnixNano: string;
};

const SEVERITY_NUMBER: Record<LogSeverity, number> = {
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17
};

const pending: PendingLog[] = [];
let flushTimer: ReturnType<typeof setInterval> | undefined;
let flushing = false;

export function configureOtelLogs(input: {
  endpoint?: string;
  serviceName?: string;
  environment?: string;
  serviceVersion?: string;
  enabled?: boolean;
}): void {
  setOtelConfig(input);

  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = undefined;
  }
  if (isOtelEnabled()) {
    flushTimer = setInterval(() => {
      void flushOtelLogs();
      void flushOtelMetrics();
    }, 2000);
    if (typeof flushTimer === "object" && flushTimer && "unref" in flushTimer) {
      (flushTimer as NodeJS.Timeout).unref?.();
    }
  }
  configureOtelMetrics();
}

export function isOtelLogsEnabled(): boolean {
  return isOtelEnabled();
}

export function logWithSeverity(severity: LogSeverity, message: string, attributes: LogAttributes = {}): void {
  const clean = sanitizeAttrs(attributes);
  const line =
    Object.keys(clean).length > 0
      ? JSON.stringify({ msg: message, ...clean, severity })
      : message;

  if (severity === "ERROR") {
    console.error(line);
  } else if (severity === "WARN") {
    console.warn(line);
  } else {
    console.info(line);
  }

  if (!isOtelEnabled()) {
    return;
  }

  pending.push({
    body: message,
    severity,
    attributes: clean,
    timeUnixNano: String(BigInt(Date.now()) * 1_000_000n)
  });

  if (pending.length >= 40) {
    void flushOtelLogs();
  }
}

export function logInfo(message: string, attributes?: LogAttributes): void {
  logWithSeverity("INFO", message, attributes ?? {});
}

export function logWarn(message: string, attributes?: LogAttributes): void {
  logWithSeverity("WARN", message, attributes ?? {});
}

export function logError(message: string, attributes?: LogAttributes): void {
  logWithSeverity("ERROR", message, attributes ?? {});
}

function sanitizeAttrs(attributes: LogAttributes): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) {
      continue;
    }
    const lower = key.toLowerCase();
    if (
      lower.includes("password") ||
      lower.includes("secret") ||
      lower.includes("authorization") ||
      lower.includes("token") ||
      lower.includes("cookie")
    ) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

export async function flushOtelLogs(): Promise<void> {
  if (!isOtelEnabled() || flushing || pending.length === 0) {
    return;
  }
  flushing = true;
  const batch = pending.splice(0, pending.length);
  const cfg = getOtelConfig();
  try {
    const logRecords = batch.map((item) => ({
      timeUnixNano: item.timeUnixNano,
      severityNumber: SEVERITY_NUMBER[item.severity],
      severityText: item.severity,
      body: { stringValue: item.body },
      attributes: Object.entries(item.attributes).map(([key, value]) => ({
        key,
        value: otelAttrValue(value as string | number | boolean)
      }))
    }));

    const payload = {
      resourceLogs: [
        {
          resource: { attributes: otelResourceAttributes() },
          scopeLogs: [
            {
              scope: { name: cfg.serviceName, version: cfg.serviceVersion },
              logRecords
            }
          ]
        }
      ]
    };

    const response = await fetch(`${cfg.endpoint}/v1/logs`, {
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
          msg: "otel log export failed",
          status: response.status,
          endpoint: cfg.endpoint
        })
      );
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        msg: "otel log export error",
        error: error instanceof Error ? error.message : String(error)
      })
    );
  } finally {
    flushing = false;
  }
}

/** Test helper */
export function _resetOtelLogsForTests(): void {
  pending.length = 0;
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = undefined;
  }
  resetOtelConfigForTests();
}
