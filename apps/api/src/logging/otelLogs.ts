/**
 * Lightweight OTLP/HTTP JSON log exporter for the homelab collector.
 * Mirrors the contract used by yt-learner / expense-tracker / rpi-manager:
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
 * Logs always go to console; OTLP is best-effort and never throws into request path.
 */

export type LogSeverity = "DEBUG" | "INFO" | "WARN" | "ERROR";

type LogAttributes = Record<string, string | number | boolean | undefined | null>;

type PendingLog = {
  body: string;
  severity: LogSeverity;
  attributes: LogAttributes;
  timeUnixNano: string;
};

type OtelConfig = {
  enabled: boolean;
  endpoint: string;
  serviceName: string;
  environment: string;
  serviceVersion: string;
};

const SEVERITY_NUMBER: Record<LogSeverity, number> = {
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17
};

let config: OtelConfig = {
  enabled: false,
  endpoint: "",
  serviceName: "family-os-health-api",
  environment: "development",
  serviceVersion: "0.1.0"
};

const pending: PendingLog[] = [];
let flushTimer: ReturnType<typeof setInterval> | undefined;
let flushing = false;

function attrValue(value: string | number | boolean): { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean } {
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      return { intValue: String(value) };
    }
    return { doubleValue: value };
  }
  return { stringValue: value };
}

function resourceAttributes() {
  return [
    { key: "service.name", value: attrValue(config.serviceName) },
    { key: "service.namespace", value: attrValue("homelab") },
    { key: "deployment.environment", value: attrValue(config.environment) },
    { key: "service.version", value: attrValue(config.serviceVersion) }
  ];
}

export function configureOtelLogs(input: {
  endpoint?: string;
  serviceName?: string;
  environment?: string;
  serviceVersion?: string;
  enabled?: boolean;
}): void {
  const endpoint = (input.endpoint ?? "").trim().replace(/\/$/, "");
  const enabled = input.enabled ?? Boolean(endpoint);
  config = {
    enabled,
    endpoint,
    serviceName: input.serviceName?.trim() || "family-os-health-api",
    environment: input.environment?.trim() || "development",
    serviceVersion: input.serviceVersion?.trim() || "0.1.0"
  };

  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = undefined;
  }
  if (config.enabled) {
    flushTimer = setInterval(() => {
      void flushOtelLogs();
    }, 2000);
    // Don't keep the process alive solely for the timer (Node); Bun ignores unref sometimes
    if (typeof flushTimer === "object" && flushTimer && "unref" in flushTimer) {
      (flushTimer as NodeJS.Timeout).unref?.();
    }
  }
}

export function isOtelLogsEnabled(): boolean {
  return config.enabled && config.endpoint.length > 0;
}

export function logWithSeverity(severity: LogSeverity, message: string, attributes: LogAttributes = {}): void {
  const line =
    Object.keys(attributes).length > 0
      ? JSON.stringify({ msg: message, ...sanitizeAttrs(attributes), severity })
      : message;

  if (severity === "ERROR") {
    console.error(line);
  } else if (severity === "WARN") {
    console.warn(line);
  } else {
    console.info(line);
  }

  if (!isOtelLogsEnabled()) {
    return;
  }

  pending.push({
    body: message,
    severity,
    attributes: sanitizeAttrs(attributes),
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
    // Never ship secrets-ish values
    const lower = key.toLowerCase();
    if (lower.includes("password") || lower.includes("secret") || lower.includes("authorization") || lower.includes("token")) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

export async function flushOtelLogs(): Promise<void> {
  if (!isOtelLogsEnabled() || flushing || pending.length === 0) {
    return;
  }
  flushing = true;
  const batch = pending.splice(0, pending.length);
  try {
    const logRecords = batch.map((item) => ({
      timeUnixNano: item.timeUnixNano,
      severityNumber: SEVERITY_NUMBER[item.severity],
      severityText: item.severity,
      body: { stringValue: item.body },
      attributes: Object.entries(item.attributes).map(([key, value]) => ({
        key,
        value: attrValue(value as string | number | boolean)
      }))
    }));

    const payload = {
      resourceLogs: [
        {
          resource: { attributes: resourceAttributes() },
          scopeLogs: [
            {
              scope: { name: "family-os-health-api", version: config.serviceVersion },
              logRecords
            }
          ]
        }
      ]
    };

    const url = `${config.endpoint}/v1/logs`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "family-os-health-api-otel/1.0"
      },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      // Drop on failure; do not re-queue forever
      console.warn(
        JSON.stringify({
          msg: "otel log export failed",
          status: response.status,
          endpoint: config.endpoint
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

/** Test helper — drain without network if disabled. */
export function _resetOtelLogsForTests(): void {
  pending.length = 0;
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = undefined;
  }
  config = {
    enabled: false,
    endpoint: "",
    serviceName: "family-os-health-api",
    environment: "test",
    serviceVersion: "0.1.0"
  };
}
