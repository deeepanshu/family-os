const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export class LocalDemoSeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalDemoSeedError";
  }
}

export function assertLocalSeedTarget(input: { nodeEnv?: string; databaseUrl: string }): void {
  if (input.nodeEnv === "production") {
    throw new LocalDemoSeedError("local demo seed refuses NODE_ENV=production.");
  }

  let hostname: string;
  try {
    hostname = new URL(input.databaseUrl).hostname;
  } catch {
    throw new LocalDemoSeedError("DATABASE_URL is not a valid URL.");
  }

  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new LocalDemoSeedError(`local demo seed refuses non-loopback host ${hostname}.`);
  }
}
