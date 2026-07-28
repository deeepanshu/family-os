# Docker

Production Raspberry Pi deployment runs the Health API with Docker Compose and
loads secrets from the repo-local ignored `.env` file.

Images are published by GitHub Actions to:

```text
ghcr.io/deeepanshu/family-os-health-api:<git-sha>
ghcr.io/deeepanshu/family-os-health-api:main
```

The Pi deploys via **rpi-manager** (`POST /hooks/deploy/family-os`), which sets
`IMAGE_TAG` and runs:

1. `docker compose pull`
2. **migrate** (one-shot `migrate` service — no-op if nothing pending)
3. `docker compose up -d` for API + MCP

No image **build** on the Pi. Migrations use `DATABASE_URL` from `.env`
(e.g. Supabase) inside the same release image as the API.

### Manual migrate (same image tag as the running app)

```sh
cd <repo>
export IMAGE_TAG=<git-sha-or-main>
docker compose --env-file .env -f infra/docker/compose.prod.yml --profile migrate run --rm migrate
```

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

## Observability (OTLP → Grafana)

Production compose attaches both API and MCP to the external Docker network
`observability` and sets:

```text
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
OTEL_SERVICE_NAME=family-os-health-api   # or family-os-mcp
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=prod
```

Request logs and errors are exported as OTLP logs (and still printed to
stdout). In Grafana/Loki:

```logql
{service_name="family-os-health-api"}
{service_name="family-os-mcp"}
```

Requires the shared stack from `rpi-observability` to be up first (`make network && make up`).

See also: [rpi-manager](https://github.com/deeepanshu/rpi-manager).
