import { z } from "zod";

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);

const envSchema = z.object({
  NODE_ENV: z.preprocess(emptyToUndefined, z.string().default("development")),
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
  HEALTH_API_RATE_LIMIT_MAX_BUCKETS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(10_000))
});

type ParsedAppConfig = z.infer<typeof envSchema>;
export type AppConfig = Omit<ParsedAppConfig, "HEALTH_API_CORS_ORIGIN"> & {
  HEALTH_API_CORS_ORIGIN: string;
  HEALTH_API_REPOSITORY: "memory" | "postgres";
  HEALTH_API_SYNC_LOCAL_AUTH_USERS: boolean;
};

export function loadConfig(env: Record<string, unknown> = process.env): AppConfig {
  const config = envSchema.parse(env);
  if (config.NODE_ENV === "production" && !config.HEALTH_API_CORS_ORIGIN) {
    throw new Error("HEALTH_API_CORS_ORIGIN must be configured in production.");
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
      config.HEALTH_API_SYNC_LOCAL_AUTH_USERS ?? (repository === "postgres" && config.NODE_ENV !== "production")
  };
}
