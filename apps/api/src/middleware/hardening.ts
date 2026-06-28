import { createHash, randomUUID } from "node:crypto";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import type { AppConfig } from "../config";
import { HttpError } from "../errors";
import type { AppVariables } from "../auth";

const writeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function corsMiddleware(config: AppConfig) {
  return cors({
    origin: config.HEALTH_API_CORS_ORIGIN,
    allowHeaders: ["authorization", "content-type", "accept", "x-request-id"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    exposeHeaders: ["x-request-id"],
    maxAge: 600
  });
}

export function requestLoggingMiddleware() {
  return createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
    const requestId = c.req.header("x-request-id") ?? randomUUID();
    const startedAt = Date.now();
    c.header("x-request-id", requestId);

    try {
      await next();
    } finally {
      if (c.get("config").NODE_ENV === "test") {
        return;
      }
      const durationMs = Date.now() - startedAt;
      console.info(
        JSON.stringify({
          requestId,
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
          durationMs
        })
      );
    }
  });
}

export function writeRateLimitMiddleware(config: AppConfig) {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
    if (!writeMethods.has(c.req.method)) {
      await next();
      return;
    }

    const now = Date.now();
    const windowMs = config.HEALTH_API_RATE_LIMIT_WINDOW_MS;
    const limit = config.HEALTH_API_RATE_LIMIT_MAX_WRITES;
    const key = rateLimitKey(c.req.header("authorization"), c.req.header("x-forwarded-for"));
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      evictExpiredBuckets(buckets, now);
      if (!bucket && buckets.size >= config.HEALTH_API_RATE_LIMIT_MAX_BUCKETS) {
        throw new HttpError(429, "rate_limited", "Too many write requests. Try again later.");
      }
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      await next();
      return;
    }

    if (bucket.count >= limit) {
      const retryAfterSeconds = Math.ceil((bucket.resetAt - now) / 1000);
      c.header("retry-after", String(retryAfterSeconds));
      throw new HttpError(429, "rate_limited", "Too many write requests. Try again later.");
    }

    bucket.count += 1;
    await next();
  });
}

function rateLimitKey(authorizationHeader?: string, forwardedFor?: string) {
  const token = authorizationHeader?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const source = token ? `bearer:${token}` : `ip:${forwardedFor?.split(",")[0]?.trim() || "anonymous"}`;
  return createHash("sha256").update(source).digest("hex");
}

function evictExpiredBuckets(buckets: Map<string, { resetAt: number }>, now: number) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
}
