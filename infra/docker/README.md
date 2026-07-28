# Docker

Production Raspberry Pi deployment runs the Health API with Docker Compose and
loads secrets from the repo-local ignored `.env` file.

Images are published by GitHub Actions to:

```text
ghcr.io/deeepanshu/family-os-health-api:<git-sha>
ghcr.io/deeepanshu/family-os-health-api:main
```

The Pi deploys via **rpi-manager** (`POST /hooks/deploy/family-os`), which sets
`IMAGE_TAG` and runs `docker compose pull && up -d` (no build on the Pi).

The `.env` file must keep `APNS_PRIVATE_KEY_PATH` aligned with the container
mount:

```sh
APNS_PRIVATE_KEY_PATH=/run/secrets/family-os/AuthKey_ZG4ATXBAJW.p8
```

### Manual deploy on the Pi

```sh
cd <repo>
export IMAGE_TAG=<git-sha-or-main>
docker compose --env-file .env -f infra/docker/compose.prod.yml pull
docker compose --env-file .env -f infra/docker/compose.prod.yml up -d
docker compose --env-file .env -f infra/docker/compose.mcp.prod.yml pull
docker compose --env-file .env -f infra/docker/compose.mcp.prod.yml up -d
```

Local rebuild (dev only):

```sh
export IMAGE_TAG=local
docker compose --env-file .env -f infra/docker/compose.prod.yml up -d --build
```

Smoke test on the Pi:

```sh
curl http://localhost:3001/health/api/v1/healthcheck
```

## Dedicated MCP process

Keep the iOS Health API on port `3001`. The MCP/OAuth surface runs the same API
runtime as a separate container, bound only to Pi loopback port `3002`.

The Cloudflare Tunnel ingress for `familyos.deepanshujain.me` must route to
`http://localhost:3002`.

See also: [rpi-manager](https://github.com/deeepanshu/rpi-manager).
