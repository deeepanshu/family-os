import { z } from "zod";

/** Default public path of the MCP resource relative to the public origin. */
export const DEFAULT_MCP_PUBLIC_PATH = "/api/mcp";

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);

const envSchema = z.object({
  NODE_ENV: z.preprocess(emptyToUndefined, z.string().default("development")),
  HOST: z.preprocess(emptyToUndefined, z.string().default("0.0.0.0")),
  PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(3001)),
  DATABASE_URL: z.preprocess(emptyToUndefined, z.string().optional()),
  HEALTH_API_REPOSITORY: z.preprocess(emptyToUndefined, z.enum(["memory", "postgres"]).optional()),
  HEALTH_API_SYNC_LOCAL_AUTH_USERS: z.preprocess(emptyToUndefined, z.coerce.boolean().optional()),
  SUPABASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  SUPABASE_ANON_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  SUPABASE_JWT_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
  HEALTH_API_ENABLE_DEV_AUTH: z.preprocess(emptyToUndefined, z.coerce.boolean().default(false)),
  HEALTH_API_DEV_AUTH_USER_ID: z.preprocess(emptyToUndefined, z.string().uuid().optional()),
  HEALTH_API_CORS_ORIGIN: z.preprocess(emptyToUndefined, z.string().optional()),
  HEALTH_API_RATE_LIMIT_WINDOW_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(60_000)),
  HEALTH_API_RATE_LIMIT_MAX_WRITES: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(120)),
  HEALTH_API_RATE_LIMIT_MAX_BUCKETS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(10_000)),
  /**
   * Public origin hosting MCP (scheme + host only — no path, query, or fragment).
   * Example: https://familyos.deepanshujain.me
   */
  MCP_PUBLIC_ORIGIN: z.preprocess(emptyToUndefined, z.string().url().optional()),
  /**
   * Public path of the MCP endpoint on that origin.
   * Default /api/mcp → resource https://origin/api/mcp and metadata at
   * /.well-known/oauth-protected-resource/api/mcp
   */
  MCP_PUBLIC_PATH: z.preprocess(emptyToUndefined, z.string().default(DEFAULT_MCP_PUBLIC_PATH)),
  /**
   * @deprecated Prefer MCP_PUBLIC_ORIGIN + MCP_PUBLIC_PATH.
   * If set without MCP_PUBLIC_ORIGIN, treated as the public origin (not the resource URL).
   */
  MCP_PUBLIC_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  /**
   * Comma-separated Supabase OAuth client IDs allowed to receive Family OS MCP
   * health grants. Required in production. When empty outside production, any
   * registered OAuth client may consent (local/dev only).
   */
  MCP_ALLOWED_OAUTH_CLIENT_IDS: z.preprocess(emptyToUndefined, z.string().optional()),
  MCP_RESOURCE_NAME: z.preprocess(emptyToUndefined, z.string().default("Family OS Health MCP")),
  MCP_CONSENT_VERSION: z.preprocess(emptyToUndefined, z.string().default("2026-07-18")),
  MCP_TOOL_TIMEOUT_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(10_000)),
  MCP_MAX_RESULT_CHARS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(32_000)),
  MCP_RATE_LIMIT_WINDOW_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(60_000)),
  MCP_RATE_LIMIT_MAX_CALLS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(60)),
  HEALTH_API_MCP_DEV_OAUTH_CLIENT_ID: z.preprocess(emptyToUndefined, z.string().default("family-os-dev"))
});

type ParsedAppConfig = z.infer<typeof envSchema>;
export type AppConfig = Omit<
  ParsedAppConfig,
  "HEALTH_API_CORS_ORIGIN" | "MCP_PUBLIC_ORIGIN" | "MCP_PUBLIC_PATH" | "MCP_ALLOWED_OAUTH_CLIENT_IDS"
> & {
  HEALTH_API_CORS_ORIGIN: string;
  HEALTH_API_REPOSITORY: "memory" | "postgres";
  HEALTH_API_SYNC_LOCAL_AUTH_USERS: boolean;
  MCP_PUBLIC_ORIGIN?: string;
  MCP_PUBLIC_PATH: string;
  /** Parsed allowlist; empty means unrestricted (non-production only). */
  MCP_ALLOWED_OAUTH_CLIENT_IDS: string[];
};

function normalizePublicPath(path: string): string {
  const withSlash = path.startsWith("/") ? path : `/${path}`;
  return withSlash.replace(/\/$/, "") || DEFAULT_MCP_PUBLIC_PATH;
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/**
 * Parse and validate a public origin: scheme + host (+ optional port) only.
 * Rejects path, query, and fragment so MCP_PUBLIC_PATH is not double-applied.
 *
 * Scheme policy:
 * - https: always allowed
 * - http: only loopback (localhost / 127.0.0.1 / ::1), and never in production
 * - other schemes: rejected
 */
export function parsePublicOrigin(
  value: string,
  envName: string,
  options: { nodeEnv?: string } = {}
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${envName} must be a valid URL origin (e.g. https://familyos.example.com).`);
  }
  if (url.username || url.password) {
    throw new Error(`${envName} must not include credentials.`);
  }
  const path = url.pathname;
  if (path !== "" && path !== "/") {
    throw new Error(
      `${envName} must be an origin only (scheme + host), with no path. Got path "${path}". Use MCP_PUBLIC_PATH for the MCP path.`
    );
  }
  if (url.search) {
    throw new Error(`${envName} must be an origin only and must not include a query string.`);
  }
  if (url.hash) {
    throw new Error(`${envName} must be an origin only and must not include a fragment.`);
  }

  const isProduction = options.nodeEnv === "production";
  if (url.protocol === "https:") {
    // always ok
  } else if (url.protocol === "http:") {
    if (isProduction) {
      throw new Error(`${envName} must use https: in production (HTTP would expose bearer tokens in transit).`);
    }
    if (!isLoopbackHostname(url.hostname)) {
      throw new Error(
        `${envName} may use http: only for loopback hosts (localhost, 127.0.0.1, ::1). Use https: for non-local origins.`
      );
    }
  } else {
    throw new Error(`${envName} must use https: (or http: on loopback for local development only).`);
  }

  return url.origin;
}

function parseOAuthClientAllowlist(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  const ids = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return [...new Set(ids)];
}

/** True when the OAuth client may receive / use MCP health grants. */
export function isMcpOAuthClientAllowed(config: AppConfig, oauthClientId: string): boolean {
  if (config.MCP_ALLOWED_OAUTH_CLIENT_IDS.length === 0) {
    return true;
  }
  return config.MCP_ALLOWED_OAUTH_CLIENT_IDS.includes(oauthClientId);
}

export function loadConfig(env: Record<string, unknown> = process.env): AppConfig {
  const config = envSchema.parse(env);
  if (config.NODE_ENV === "production" && !config.HEALTH_API_CORS_ORIGIN) {
    throw new Error("HEALTH_API_CORS_ORIGIN must be configured in production.");
  }

  const originRaw = config.MCP_PUBLIC_ORIGIN ?? config.MCP_PUBLIC_BASE_URL;
  const mcpPublicOrigin = originRaw
    ? parsePublicOrigin(originRaw, config.MCP_PUBLIC_ORIGIN ? "MCP_PUBLIC_ORIGIN" : "MCP_PUBLIC_BASE_URL", {
        nodeEnv: config.NODE_ENV
      })
    : undefined;
  const mcpPublicPath = normalizePublicPath(config.MCP_PUBLIC_PATH);
  const allowedOAuthClientIds = parseOAuthClientAllowlist(config.MCP_ALLOWED_OAUTH_CLIENT_IDS);

  if (config.NODE_ENV === "production" && !mcpPublicOrigin) {
    throw new Error("MCP_PUBLIC_ORIGIN must be configured in production.");
  }
  if (config.NODE_ENV === "production" && !config.SUPABASE_URL) {
    throw new Error("SUPABASE_URL must be configured in production.");
  }
  if (config.NODE_ENV === "production" && !config.SUPABASE_ANON_KEY) {
    throw new Error("SUPABASE_ANON_KEY must be configured in production for the OAuth consent page.");
  }
  if (config.NODE_ENV === "production" && allowedOAuthClientIds.length === 0) {
    throw new Error(
      "MCP_ALLOWED_OAUTH_CLIENT_IDS must be configured in production (comma-separated Supabase OAuth client IDs eligible for MCP health access)."
    );
  }
  const repository = config.HEALTH_API_REPOSITORY ?? (config.NODE_ENV === "test" ? "memory" : "postgres");
  if (config.NODE_ENV === "production" && repository === "memory") {
    throw new Error("HEALTH_API_REPOSITORY=memory is not allowed in production.");
  }
  if (repository === "postgres" && !config.DATABASE_URL) {
    throw new Error("DATABASE_URL must be configured when HEALTH_API_REPOSITORY=postgres.");
  }
  return {
    ...config,
    HEALTH_API_CORS_ORIGIN: config.HEALTH_API_CORS_ORIGIN ?? "*",
    HEALTH_API_REPOSITORY: repository,
    HEALTH_API_SYNC_LOCAL_AUTH_USERS:
      config.HEALTH_API_SYNC_LOCAL_AUTH_USERS ?? (repository === "postgres" && config.NODE_ENV !== "production"),
    MCP_PUBLIC_ORIGIN: mcpPublicOrigin,
    MCP_PUBLIC_PATH: mcpPublicPath,
    MCP_ALLOWED_OAUTH_CLIENT_IDS: allowedOAuthClientIds
  };
}
