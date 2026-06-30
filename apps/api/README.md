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

Local API runtime uses Postgres by default. Start the local database and apply
migrations before running the API:

```sh
npm run db:up
npm run db:migrate:local
```

Drizzle Kit owns migrations. Change app-owned database structure in
`db/schema/health.ts`, then run `npm run db:generate`. Supabase-specific RLS,
`auth.users` foreign keys, and triggers live as Drizzle custom SQL migrations in
`db/migrations`.

Use `DATABASE_URL=postgres://family_os:family_os@localhost:5432/family_os` for
local Docker Postgres. Release should point `DATABASE_URL` at Supabase Postgres
and set `HEALTH_API_SYNC_LOCAL_AUTH_USERS=false`; local can keep it `true`
because the migration helper installs a lightweight `auth.users` stub.

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

Create a family:

```sh
curl -X POST \
  -H "Authorization: Bearer <supabase_access_token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Jain Family"}' \
  http://localhost:3001/health/v1/families
```

Load the signed-in user's active family:

```sh
curl -H "Authorization: Bearer <supabase_access_token>" \
  http://localhost:3001/health/v1/families/current
```

Inspect an invite:

```sh
curl http://localhost:3001/health/v1/invites/<token>
```

Accept an invite:

```sh
curl -X POST \
  -H "Authorization: Bearer <supabase_access_token>" \
  http://localhost:3001/health/v1/invites/<token>/accept
```

List health profiles:

```sh
curl -H "Authorization: Bearer <supabase_access_token>" \
  http://localhost:3001/health/v1/people
```

Create a health profile as a manager:

```sh
curl -X POST \
  -H "Authorization: Bearer <supabase_access_token>" \
  -H "Content-Type: application/json" \
  -d '{"displayName":"Mom","relationshipLabel":"Mother"}' \
  http://localhost:3001/health/v1/people
```

Log a blood pressure reading:

```sh
curl -X POST \
  -H "Authorization: Bearer <supabase_access_token>" \
  -H "Content-Type: application/json" \
  -d '{"personId":"<profile_id>","systolic":121,"diastolic":79,"measuredAt":"2026-06-21T10:00:00.000Z"}' \
  http://localhost:3001/health/v1/readings/blood-pressure
```

List BP history:

```sh
curl -H "Authorization: Bearer <supabase_access_token>" \
  "http://localhost:3001/health/v1/readings/blood-pressure?personId=<profile_id>"
```

Log a blood sugar reading:

```sh
curl -X POST \
  -H "Authorization: Bearer <supabase_access_token>" \
  -H "Content-Type: application/json" \
  -d '{"personId":"<profile_id>","value":105,"unit":"mg/dL","context":"fasting","measuredAt":"2026-06-21T10:00:00.000Z"}' \
  http://localhost:3001/health/v1/readings/blood-glucose
```

List blood sugar history:

```sh
curl -H "Authorization: Bearer <supabase_access_token>" \
  "http://localhost:3001/health/v1/readings/blood-glucose?personId=<profile_id>"
```

Link the signed-in user's own profile for HealthKit import:

```sh
curl -X POST \
  -H "Authorization: Bearer <supabase_access_token>" \
  -H "Content-Type: application/json" \
  -d '{"personId":"<own_profile_id>"}' \
  http://localhost:3001/health/v1/healthkit/link-profile
```

Enable HealthKit categories and import samples through
`/health/v1/healthkit/sync/settings` and
`/health/v1/healthkit/samples/batch`. Family OS imports only from Apple Health;
third-party device apps should sync into HealthKit first.

Create a reminder:

```sh
curl -X POST \
  -H "Authorization: Bearer <supabase_access_token>" \
  -H "Content-Type: application/json" \
  -d '{"type":"blood_pressure","title":"BP check","message":"Please check BP","scheduleKind":"daily","timeOfDay":"08:00","timezone":"Asia/Bangkok","recipientUserIds":["<user_id>"]}' \
  http://localhost:3001/health/v1/reminders
```

Disable a reminder for yourself:

```sh
curl -X POST \
  -H "Authorization: Bearer <supabase_access_token>" \
  http://localhost:3001/health/v1/reminders/<reminder_id>/disable-for-me
```

For local smoke tests only, set both `HEALTH_API_ENABLE_DEV_AUTH=true` and
`HEALTH_API_DEV_AUTH_USER_ID=<uuid>`, then call `/me` with
`Authorization: Bearer dev-token`. This bypass is rejected in production.

Runtime hardening knobs:

- `HEALTH_API_REPOSITORY` defaults to `memory` for tests and `postgres` otherwise. Production rejects `memory`.
- `HEALTH_API_SYNC_LOCAL_AUTH_USERS` defaults to `true` for non-production Postgres runs and `false` in production.
- `HEALTH_API_CORS_ORIGIN` defaults to `*` outside production for local app/API smoke tests. Production must set an explicit origin.
- `HEALTH_API_RATE_LIMIT_WINDOW_MS` defaults to `60000`.
- `HEALTH_API_RATE_LIMIT_MAX_WRITES` defaults to `120` writes per window per bearer token, falling back to IP when no bearer token is present.
- `HEALTH_API_RATE_LIMIT_MAX_BUCKETS` defaults to `10000` in-memory buckets per API process. The Phase 1 limiter is process-local; multi-process deployments need a shared limiter.
