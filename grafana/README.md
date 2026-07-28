# Grafana dashboards

Dashboards in `dashboards/*.json` are owned by this repo.

On deploy, **rpi-manager** copies them into the shared observability stack
(`files/apps/`) and reloads Grafana over HTTP.

See: [rpi-observability app-dashboards docs](https://github.com/deeepanshu/rpi-observability/blob/main/docs/app-dashboards.md)

| File | Grafana folder | UID |
|------|----------------|-----|
| `dashboards/family-os-api.json` | Apps | `family-os-api` |
