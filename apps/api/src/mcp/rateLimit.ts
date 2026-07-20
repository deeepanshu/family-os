import { HttpError } from "../errors";

type Bucket = {
  count: number;
  resetAt: number;
};

/**
 * Process-local MCP tool rate limiter.
 *
 * WARNING: Counters live in an in-memory Map. Each API process applies its own
 * full limit, so horizontal scale multiplies effective throughput. Before
 * running more than one API instance, move this to a shared store (gateway
 * rate limit, Redis, or Postgres). Single-process Raspberry Pi deploys are fine.
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
