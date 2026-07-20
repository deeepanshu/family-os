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
