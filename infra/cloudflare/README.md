# Cloudflare Tunnel

## Health API (iOS)

Target public API:

```text
https://api.deepanshujain.me/health/v1
```

Expected local backend target:

```text
http://localhost:3001
```

If using a reverse proxy on the Raspberry Pi, route:

```text
/health/* -> localhost:3001
```

## MCP / OAuth public surface

ChatGPT and other MCP clients use the Family OS public origin (not necessarily
the same hostname as the iOS Health API):

```text
https://familyos.deepanshujain.me/api/mcp
https://familyos.deepanshujain.me/.well-known/oauth-protected-resource/api/mcp
https://familyos.deepanshujain.me/api/oauth/consent
```

Tunnel or reverse-proxy that origin to the same API process (`localhost:3001`)
**without stripping** `/api`. The app serves MCP at `/api/mcp` and well-known
metadata at `/.well-known/oauth-protected-resource/api/mcp`.

Smoke checks after deploy:

```sh
curl -sS https://familyos.deepanshujain.me/api/mcp/healthcheck
curl -sS https://familyos.deepanshujain.me/.well-known/oauth-protected-resource/api/mcp
curl -sS -o /dev/null -w "%{http_code}\n" \
  "https://familyos.deepanshujain.me/api/oauth/consent?authorization_id=test"
```

## Rate limiting (required before horizontal scale)

Family OS MCP tool rate limits (`McpRateLimiter`) are **process-local**. A
single API process is fine (Raspberry Pi / one container). Running multiple API
instances multiplies the effective limit.

Before scaling beyond one instance, put a shared limiter in front of MCP:

1. **Preferred for this deploy:** Cloudflare Rate Limiting (or WAF custom rule)
   on the public MCP hostname for path `/api/mcp*`.
2. Or replace `McpRateLimiter` with Redis / Postgres counters shared by all
   instances.

Suggested Cloudflare starting point (tune to traffic):

| Field | Value |
| --- | --- |
| If | URI Path starts with `/api/mcp` |
| Characteristics | IP + (optional) JWT `sub` / custom header if available |
| Rate | e.g. 60 requests / 1 minute |
| Action | Block or managed challenge |

In-app limits remain a second layer for single-process deploys; they are not a
cluster-wide control.
