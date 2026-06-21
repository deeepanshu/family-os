import { z } from "zod";

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);

const envSchema = z.object({
  NODE_ENV: z.preprocess(emptyToUndefined, z.string().default("development")),
  PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(3001)),
  DATABASE_URL: z.preprocess(emptyToUndefined, z.string().optional()),
  SUPABASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  SUPABASE_ANON_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  SUPABASE_JWT_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
  HEALTH_API_ENABLE_DEV_AUTH: z.preprocess(emptyToUndefined, z.coerce.boolean().default(false)),
  HEALTH_API_DEV_AUTH_USER_ID: z.preprocess(emptyToUndefined, z.string().uuid().optional())
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return envSchema.parse(env);
}
