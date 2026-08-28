import { HEALTH_API_PREFIX, type AuthSessionResponse, type HealthcheckResponse } from "@family-os/shared";
import { Hono } from "hono";
import { loadConfig } from "./config";
import { HttpError, jsonError } from "./errors";
import { requireAuth, type AppVariables } from "./auth";
import type { FamilyRepository } from "./repositories/families";
import { createFamilyRoutes } from "./routes/families";
import { createInviteRoutes } from "./routes/invites";
import { createInviteLandingRoutes } from "./routes/inviteLanding";
import { createLegalPageRoutes } from "./routes/legalPages";
import { createPeopleRoutes } from "./routes/people";
import { createBloodPressureRoutes } from "./routes/bloodPressure";
import { createBloodGlucoseRoutes, createHeartRateRoutes, createSleepRoutes, createStepsRoutes, createWorkoutRoutes } from "./routes/historyReadings";
import { createHealthKitRoutes } from "./routes/healthKit";
import { createReminderRoutes } from "./routes/reminders";
import { createDeviceRoutes } from "./routes/devices";
import { createAuditLogRoutes } from "./routes/auditLogs";
import { createBootstrapRoutes } from "./routes/bootstrap";
import { createMeRoutes } from "./routes/me";
import { createMcpConnectionRoutes } from "./routes/mcpConnections";
import { createOAuthConsentRoutes } from "./routes/oauthConsent";
import { corsMiddleware, requestLoggingMiddleware, writeRateLimitMiddleware } from "./middleware/hardening";
import { createDependencies, repositoriesFromFamilyRepository } from "./dependencies";
import type { AppRepositories } from "./repositories/contracts";
import { createMcpRoutes, createMcpWellKnownRoutes } from "./mcp/routes";
import { mcpOAuthPath, mcpPublicPath } from "./mcp/publicUrl";
import { configureOtelLogs, logError, logInfo } from "./logging/otelLogs";
import { startAuditLogRetention } from "./retention";
import { flushOtelMetrics } from "./logging/otelMetrics";

export type AppOptions = {
  /** Env-like values parsed by `loadConfig` (strings, not pre-parsed arrays). */
  config?: Record<string, unknown>;
  familyRepository?: FamilyRepository;
  repositories?: AppRepositories;
};

function deploymentEnvironmentFromResourceAttributes(raw: string | undefined, nodeEnv: string): string {
  if (raw) {
    for (const part of raw.split(",")) {
      const [key, ...rest] = part.trim().split("=");
      if (key === "deployment.environment" && rest.length > 0) {
        return rest.join("=").trim() || nodeEnv;
      }
    }
  }
  return nodeEnv === "production" ? "prod" : nodeEnv;
}

export function createApp(options: AppOptions = {}) {
  const config = options.config ? loadConfig(options.config) : loadConfig();
  if (config.NODE_ENV !== "test") {
    configureOtelLogs({
      endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
      serviceName: config.OTEL_SERVICE_NAME,
      environment: deploymentEnvironmentFromResourceAttributes(
        config.OTEL_RESOURCE_ATTRIBUTES,
        config.NODE_ENV
      ),
      serviceVersion: "0.1.0",
      enabled: Boolean(config.OTEL_EXPORTER_OTLP_ENDPOINT)
    });
    if (config.OTEL_EXPORTER_OTLP_ENDPOINT) {
      logInfo("otel telemetry configured", {
        endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
        service: config.OTEL_SERVICE_NAME,
        signals: "logs,metrics"
      });
      // Prime Prometheus with an initial metrics scrape sample
      void flushOtelMetrics();
    }
  }
  const dependencies = options.repositories
    ? { repositories: options.repositories }
    : options.familyRepository
      ? { repositories: repositoriesFromFamilyRepository(options.familyRepository) }
      : createDependencies(config);
  const repositories = dependencies.repositories;
  startAuditLogRetention(repositories.auditLogs, config.NODE_ENV);
  const app = new Hono<{ Variables: AppVariables }>();
  const health = new Hono<{ Variables: AppVariables }>();

  app.use("*", async (c, next) => {
    c.set("config", config);
    await next();
  });
  app.use("*", requestLoggingMiddleware());
  app.use(`${HEALTH_API_PREFIX}/*`, corsMiddleware(config));
  app.use(`${HEALTH_API_PREFIX}/*`, writeRateLimitMiddleware(config));

  health.get("/healthcheck", (c) => {
    const body: HealthcheckResponse = {
      service: "family-os-health-api",
      status: "ok"
    };
    return c.json({ data: body });
  });

  health.get("/me", requireAuth(), (c) => {
    const user = c.get("user");
    const body: AuthSessionResponse = { userId: user.id };
    return c.json({ data: body });
  });

  health.route("/bootstrap", createBootstrapRoutes(repositories.families, config));
  health.route("/me", createMeRoutes(repositories.profiles, config));
  health.route("/families", createFamilyRoutes(repositories.families, config));
  health.route("/invites", createInviteRoutes(repositories.invites, config));
  health.route("/people", createPeopleRoutes(repositories.profiles));
  health.route("/readings/blood-pressure", createBloodPressureRoutes(repositories.readings));
  health.route("/readings/blood-glucose", createBloodGlucoseRoutes(repositories.healthKit));
  health.route("/readings/sleep", createSleepRoutes(repositories.healthKit));
  health.route("/readings/steps", createStepsRoutes(repositories.healthKit));
  health.route("/readings/workouts", createWorkoutRoutes(repositories.healthKit));
  health.route("/readings/heart-rate", createHeartRateRoutes(repositories.healthKit));
  health.route("/healthkit", createHealthKitRoutes(repositories.healthKit));
  health.route("/reminders", createReminderRoutes(repositories.reminders));
  health.route("/devices", createDeviceRoutes(repositories.devices));
  health.route("/audit-logs", createAuditLogRoutes(repositories.auditLogs));
  health.route("/mcp/connections", createMcpConnectionRoutes(repositories.mcpConnections));

  // Canonical MCP resource and RFC 9728 metadata under the Family OS origin.
  app.route("/", createMcpWellKnownRoutes(config));
  app.route(mcpPublicPath(config), createMcpRoutes({ config, repositories }));
  app.route(mcpOAuthPath(config), createOAuthConsentRoutes({ config, mcpConnections: repositories.mcpConnections }));
  app.route("/invite", createInviteLandingRoutes(repositories.invites));
  app.route("/", createLegalPageRoutes(config));
  app.route(HEALTH_API_PREFIX, health);

  app.notFound((c) =>
    c.json(
      {
        error: {
          code: "not_found",
          message: "Route not found."
        }
      },
      404
    )
  );

  app.onError((error, c) => {
    if (error instanceof HttpError) {
      return jsonError(c, error);
    }
    logError("unhandled request error", {
      path: c.req.path,
      method: c.req.method,
      error: error instanceof Error ? error.message : String(error)
    });
    return c.json(
      {
        error: {
          code: "internal_error",
          message: "Internal server error."
        }
      },
      500
    );
  });

  return app;
}
