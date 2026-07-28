/** Shared OTLP resource config for logs + metrics. */

export type OtelRuntimeConfig = {
  enabled: boolean;
  endpoint: string;
  serviceName: string;
  environment: string;
  serviceVersion: string;
};

const defaultConfig = (): OtelRuntimeConfig => ({
  enabled: false,
  endpoint: "",
  serviceName: "family-os-health-api",
  environment: "development",
  serviceVersion: "0.1.0"
});

let config: OtelRuntimeConfig = defaultConfig();

export function getOtelConfig(): OtelRuntimeConfig {
  return config;
}

export function setOtelConfig(input: {
  endpoint?: string;
  serviceName?: string;
  environment?: string;
  serviceVersion?: string;
  enabled?: boolean;
}): OtelRuntimeConfig {
  const endpoint = (input.endpoint ?? "").trim().replace(/\/$/, "");
  const enabled = input.enabled ?? Boolean(endpoint);
  config = {
    enabled,
    endpoint,
    serviceName: input.serviceName?.trim() || "family-os-health-api",
    environment: input.environment?.trim() || "development",
    serviceVersion: input.serviceVersion?.trim() || "0.1.0"
  };
  return config;
}

export function resetOtelConfigForTests(): void {
  config = defaultConfig();
}

export function isOtelEnabled(): boolean {
  return config.enabled && config.endpoint.length > 0;
}

export function otelAttrValue(
  value: string | number | boolean
): { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean } {
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

export function otelResourceAttributes() {
  const c = getOtelConfig();
  return [
    { key: "service.name", value: otelAttrValue(c.serviceName) },
    { key: "service.namespace", value: otelAttrValue("homelab") },
    { key: "deployment.environment", value: otelAttrValue(c.environment) },
    { key: "service.version", value: otelAttrValue(c.serviceVersion) }
  ];
}

/** Collapse high-cardinality path segments for metrics labels. */
export function normalizeHttpRoute(path: string): string {
  const withoutQuery = path.split("?")[0] ?? path;
  return withoutQuery
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, ":uuid")
    .replace(/\/\d+(?=\/|$)/g, "/:id");
}

export function httpStatusClass(status: number): string {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  if (status >= 200) return "2xx";
  if (status >= 100) return "1xx";
  return "unknown";
}
