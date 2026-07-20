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
   * Public origin hosting MCP (scheme + host only).
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
  MCP_RESOURCE_NAME: z.preprocess(emptyToUndefined, z.string().default("Family OS Health MCP")),
  MCP_CONSENT_VERSION: z.preprocess(emptyToUndefined, z.string().default("2026-07-18")),
  MCP_TOOL_TIMEOUT_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(10_000)),
  MCP_MAX_RESULT_CHARS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(32_000)),
  HEALTH_API_MCP_DEV_OAUTH_CLIENT_ID: z.preprocess(emptyToUndefined, z.string().default("family-os-dev"))
});

type ParsedAppConfig = z.infer<typeof envSchema>;
export type AppConfig = Omit<ParsedAppConfig, "HEALTH_API_CORS_ORIGIN" | "MCP_PUBLIC_ORIGIN" | "MCP_PUBLIC_PATH"> & {
  HEALTH_API_CORS_ORIGIN: string;
  HEALTH_API_REPOSITORY: "memory" | "postgres";
  HEALTH_API_SYNC_LOCAL_AUTH_USERS: boolean;
  MCP_PUBLIC_ORIGIN?: string;
  MCP_PUBLIC_PATH: string;
};

function normalizePublicPath(path: string): string {
  const withSlash = path.startsWith("/") ? path : `/${path}`;
  return withSlash.replace(/\/$/, "") || DEFAULT_MCP_PUBLIC_PATH;
}

export function loadConfig(env: Record<string, unknown> = process.env): AppConfig {
  const config = envSchema.parse(env);
  if (config.NODE_ENV === "production" && !config.HEALTH_API_CORS_ORIGIN) {
    throw new Error("HEALTH_API_CORS_ORIGIN must be configured in production.");
  }

  const originFromLegacy = config.MCP_PUBLIC_BASE_URL?.replace(/\/$/, "");
  const mcpPublicOrigin = config.MCP_PUBLIC_ORIGIN?.replace(/\/$/, "") ?? originFromLegacy;
  const mcpPublicPath = normalizePublicPath(config.MCP_PUBLIC_PATH);

  if (config.NODE_ENV === "production" && !mcpPublicOrigin) {
    throw new Error("MCP_PUBLIC_ORIGIN must be configured in production.");
  }
  if (config.NODE_ENV === "production" && !config.SUPABASE_URL) {
    throw new Error("SUPABASE_URL must be configured in production.");
  }
  if (config.NODE_ENV === "production" && !config.SUPABASE_ANON_KEY) {
    throw new Error("SUPABASE_ANON_KEY must be configured in production for the OAuth consent page.");
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
    MCP_PUBLIC_PATH: mcpPublicPath
  };
}
