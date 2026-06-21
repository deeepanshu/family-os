import { jwtVerify } from "jose";
import { createMiddleware } from "hono/factory";
import type { AppConfig } from "./config";
import { HttpError } from "./errors";

export type AuthUser = {
  id: string;
  email?: string;
};

export type AppVariables = {
  config: AppConfig;
  user: AuthUser;
};

const bearerPrefix = "Bearer ";

export function requireAuth() {
  return createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
    const config = c.get("config");
    const header = c.req.header("authorization");
    if (!header?.startsWith(bearerPrefix)) {
      throw new HttpError(401, "missing_authorization", "Authorization bearer token is required.");
    }

    const token = header.slice(bearerPrefix.length).trim();
    if (!token) {
      throw new HttpError(401, "missing_authorization", "Authorization bearer token is required.");
    }

    if (
      config.NODE_ENV !== "production" &&
      config.HEALTH_API_ENABLE_DEV_AUTH &&
      config.HEALTH_API_DEV_AUTH_USER_ID &&
      token === "dev-token"
    ) {
      c.set("user", { id: config.HEALTH_API_DEV_AUTH_USER_ID });
      await next();
      return;
    }

    if (!config.SUPABASE_JWT_SECRET) {
      throw new HttpError(500, "auth_not_configured", "Supabase JWT verification is not configured.");
    }

    try {
      const secret = new TextEncoder().encode(config.SUPABASE_JWT_SECRET);
      const { payload } = await jwtVerify(token, secret, {
        issuer: config.SUPABASE_URL ? `${config.SUPABASE_URL}/auth/v1` : undefined,
        audience: "authenticated"
      });
      if (!payload.sub) {
        throw new HttpError(401, "invalid_token", "Token subject is required.");
      }
      if (payload.role !== "authenticated") {
        throw new HttpError(401, "invalid_token", "Token role must be authenticated.");
      }

      c.set("user", {
        id: payload.sub,
        email: typeof payload.email === "string" ? payload.email : undefined
      });
      await next();
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }
      throw new HttpError(401, "invalid_token", "Bearer token could not be verified.");
    }
  });
}
