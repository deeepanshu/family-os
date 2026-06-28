import { HEALTH_API_PREFIX, type AuthSessionResponse, type HealthcheckResponse } from "@family-os/shared";
import { Hono } from "hono";
import type { AppConfig } from "./config";
import { loadConfig } from "./config";
import { HttpError, jsonError } from "./errors";
import { requireAuth, type AppVariables } from "./auth";
import type { FamilyRepository } from "./repositories/families";
import { createFamilyRoutes } from "./routes/families";
import { createInviteRoutes } from "./routes/invites";
import { createPeopleRoutes } from "./routes/people";
import { createBloodPressureRoutes } from "./routes/bloodPressure";
import { createBloodGlucoseRoutes } from "./routes/bloodGlucose";
import { createReminderRoutes } from "./routes/reminders";
import { createDeviceRoutes } from "./routes/devices";
import { createAuditLogRoutes } from "./routes/auditLogs";
import { corsMiddleware, requestLoggingMiddleware, writeRateLimitMiddleware } from "./middleware/hardening";
import { createDependencies, repositoriesFromFamilyRepository } from "./dependencies";
import type { AppRepositories } from "./repositories/contracts";

export type AppOptions = {
  config?: Partial<AppConfig>;
  familyRepository?: FamilyRepository;
  repositories?: AppRepositories;
};

export function createApp(options: AppOptions = {}) {
  const config = options.config ? loadConfig(options.config) : loadConfig();
  const dependencies = options.repositories
    ? { repositories: options.repositories }
    : options.familyRepository
      ? { repositories: repositoriesFromFamilyRepository(options.familyRepository) }
      : createDependencies(config);
  const repositories = dependencies.repositories;
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

  health.route("/families", createFamilyRoutes(repositories.families));
  health.route("/invites", createInviteRoutes(repositories.invites));
  health.route("/people", createPeopleRoutes(repositories.profiles));
  health.route("/readings/blood-pressure", createBloodPressureRoutes(repositories.readings));
  health.route("/readings/blood-glucose", createBloodGlucoseRoutes(repositories.readings));
  health.route("/reminders", createReminderRoutes(repositories.reminders));
  health.route("/devices", createDeviceRoutes(repositories.devices));
  health.route("/audit-logs", createAuditLogRoutes(repositories.auditLogs));

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
    console.error(error);
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
