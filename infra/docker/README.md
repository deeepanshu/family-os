# Docker

Production Raspberry Pi deployment runs the Health API with Docker Compose and
loads secrets from the repo-local ignored `.env` file.

The `.env` file must keep `APNS_PRIVATE_KEY_PATH` aligned with the container
mount:

```sh
APNS_PRIVATE_KEY_PATH=/run/secrets/family-os/AuthKey_ZG4ATXBAJW.p8
```

Deploy or restart:

```sh
cd <repo>
docker compose --env-file .env -f infra/docker/compose.prod.yml up -d --build
docker compose --env-file .env -f infra/docker/compose.prod.yml logs -f health-api
```

Smoke test on the Pi:

```sh
curl http://localhost:3001/health/api/v1/healthcheck
```

## Dedicated MCP process

Keep the iOS Health API on port `3001`. The MCP/OAuth surface runs the same API
runtime as a separate container, bound only to Pi loopback port `3002`:

```sh
cd <repo>
docker compose --env-file .env -f infra/docker/compose.mcp.prod.yml up -d --build
docker compose --env-file .env -f infra/docker/compose.mcp.prod.yml logs -f family-os-mcp
```

The Cloudflare Tunnel ingress for `familyos.deepanshujain.me` must route to
`http://localhost:3002`.
