# Family OS Health API

Backend stack:

- Bun.
- Hono.
- TypeScript.
- Zod.
- Drizzle.
- Supabase Postgres.

Local default port:

```text
3001
```

## Local Development

Install dependencies from the repository root:

```sh
npm install
```

Run the API with Bun:

```sh
npm run api:dev
```

The Health facet is mounted at:

```text
http://localhost:3001/health/v1
```

Public operational check:

```sh
curl http://localhost:3001/health/v1/healthcheck
```

Protected bootstrap check:

```sh
curl -H "Authorization: Bearer <supabase_access_token>" \
  http://localhost:3001/health/v1/me
```

For local smoke tests only, set both `HEALTH_API_ENABLE_DEV_AUTH=true` and
`HEALTH_API_DEV_AUTH_USER_ID=<uuid>`, then call `/me` with
`Authorization: Bearer dev-token`. This bypass is rejected in production.
