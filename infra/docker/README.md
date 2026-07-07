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
curl http://localhost:3001/health/v1/healthcheck
```
