# Grafana dashboards

Dashboards in `dashboards/*.json` are owned by this repo.

On deploy, **rpi-manager** copies them into the shared observability stack
(`files/apps/`) and reloads Grafana over HTTP.

See: [homelab app-dashboards docs](https://github.com/deeepanshu/homelab/blob/main/observability/docs/app-dashboards.md)

| File | Grafana folder | UID |
|------|----------------|-----|
| `dashboards/family-os-api.json` | Apps | `family-os-api` |
