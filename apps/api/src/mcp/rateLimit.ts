import { HttpError } from "../errors";

type Bucket = {
  count: number;
  resetAt: number;
};

/**
 * Process-local MCP tool rate limiter.
 *
 * **Single-process only.** Counters live in an in-memory Map. Each API process
 * applies its own full limit, so N instances multiply effective throughput by N.
 *
 * Horizontal scaling is unsupported until this is replaced with a shared
 * limiter (Cloudflare rate limiting on `/api/mcp`, Redis, or Postgres). See
 * `infra/cloudflare/README.md` for the gateway path. Single-process Raspberry Pi
 * deploys are the intended production topology for Release 1.
 */
export class McpRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly windowMs: number,
    private readonly maxCalls: number,
    private readonly maxBuckets = 10_000
  ) {}

  check(userId: string, oauthClientId: string): void {
    const now = Date.now();
    const key = `${userId}:${oauthClientId}`;
    const bucket = this.buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      this.evictExpired(now);
      if (!bucket && this.buckets.size >= this.maxBuckets) {
        throw new HttpError(429, "rate_limited", "Too many MCP requests. Try again later.");
      }
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }

    if (bucket.count >= this.maxCalls) {
      throw new HttpError(429, "rate_limited", "Too many MCP requests. Try again later.");
    }

    bucket.count += 1;
  }

  private evictExpired(now: number) {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
      }
    }
  }
}
