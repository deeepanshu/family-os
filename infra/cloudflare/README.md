# Cloudflare Tunnel

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
