# Family OS

iOS-only family management app. Health is the first facet.

## Locked Stack

- SwiftUI iOS app.
- Bun + Hono TypeScript backend.
- Supabase Auth with Sign in with Apple.
- Supabase Postgres.
- Drizzle.
- Supabase Storage.
- APNs notifications.
- Production API at `https://familyos.deepanshujain.me` (Cloudflare Tunnel).

## API

Base URL:

```text
https://familyos.deepanshujain.me/health/api/v1
```

Local API URL:

```text
http://localhost:3001/health/api/v1
```

## Environments

The iOS app has two build-time environments:

- `local` - Debug builds. Uses `http://localhost:3001/health/api/v1`, which points
  at the local Bun API from the iOS simulator. The local API uses Docker
  Postgres through `DATABASE_URL`.
- `release` - Release builds. Uses
  `https://familyos.deepanshujain.me/health/api/v1`. Release database storage is
  Supabase Postgres.

Both environments use Supabase Auth for real Sign in with Apple. The local
backend can bypass Supabase only for smoke tests when
`HEALTH_API_ENABLE_DEV_AUTH=true` and the app uses `dev-token` from the debug
developer sheet.

## Phase 1

- Family setup.
- Family profiles.
- Family invites.
- Blood pressure readings.
- Blood sugar readings.
- Custom reminders.
- Push notifications.
- HealthKit-only import for Apple Health readings.

See [Ask](docs/ask.md).

## Local Setup

Install dependencies:

```sh
npm install
```

Start lightweight local Docker with Colima:

```sh
colima start --cpu 2 --memory 4 --disk 20 --runtime docker
```

Start local Postgres and apply migrations:

```sh
npm run db:up
npm run db:migrate:local
npm run db:seed:local
```

`db:seed:local` writes demo HealthKit history for the Debug `dev-token` user
(`00000000-0000-4000-8000-000000000001`). Run the API with
`HEALTH_API_ENABLE_DEV_AUTH=true` as below, then open a Debug build and tap
**Continue**. Switch **Profile** to **MJ** for a second member with BP only.
The command refuses `NODE_ENV=production` and non-loopback `DATABASE_URL`.

Generate and apply database migrations through Drizzle Kit:

```sh
npm run db:generate
npm run db:migrate
```

`db/schema/health.ts` owns app table structure. Supabase RLS policies,
`auth.users` foreign keys, and triggers live as custom SQL inside the same
Drizzle migration folder and are applied by Drizzle's migration journal. The
local migration helper only adds a local Supabase Auth shim before invoking
Drizzle.

Run backend checks:

```sh
npm run typecheck
npm test
```

Run the Health API with Bun:

```sh
npm run api:dev
```

Backend environment placeholders are documented in `.env.example`. Empty
placeholders are treated as unset. `NODE_ENV` defaults to `development`,
`PORT` defaults to `3001`, and local Docker Postgres uses
`postgres://family_os:family_os@localhost:5432/family_os`.

For local smoke tests only, set both `HEALTH_API_ENABLE_DEV_AUTH=true` and
`HEALTH_API_DEV_AUTH_USER_ID=<uuid>`, then call protected endpoints with
`Authorization: Bearer dev-token`. The bypass is rejected in production.

Build the iOS shell:

```sh
xcodebuild \
  -project apps/ios/FamilyOS.xcodeproj \
  -scheme FamilyOS \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO \
  build
```

## CI and Local Hooks

GitHub Actions in `.github/workflows/ci.yml` are the authoritative quality gate
for `main` and pull requests. The workflow runs:

- `workspace` - typechecks the whole monorepo.
- `api` - starts Docker Postgres, applies local migrations, typechecks the
  Health API, and runs API tests including RLS against Postgres.
- `drizzle` - runs `db:check` and fails if schema changes would produce
  uncommitted migration output.
- `ios` - builds and tests the `FamilyOS` scheme on a macOS runner with
  `CODE_SIGNING_ALLOWED=NO`.

CI uses fake JWT/Supabase values only; no production secrets are included.

## Xcode Cloud Releases

Xcode Cloud archives the iOS app. GitHub Actions starts those archives; merge
and `release/*` tags do not.

Two Xcode Cloud workflows exist in App Store Connect for the `FamilyOS` scheme:

- **Release TestFlight** — archive + internal TestFlight.
- **App Store Release** — archive for App Store Connect. Not auto-submitted.

Xcode Cloud owns the Apple build number. Do not change `CURRENT_PROJECT_VERSION`
for a cloud release.

### TestFlight

Any pushed branch:

1. GitHub → **Actions → TestFlight → Run workflow**.
2. **Use workflow from** the branch to ship.
3. GitHub starts Xcode Cloud on that SHA. Watch App Store Connect; the Action
   does not wait for the archive.

Retry = run the Action again. Feature branches created before this workflow
landed on `main` need a rebase first.

A branch TestFlight becomes the latest build testers auto-update to (same
bundle ID and marketing version as `main`).

### App Store Archive

`main` only:

1. GitHub → **Actions → App Store Archive → Run workflow**.
2. Use workflow from `main`.
3. Attach the Cloud build in App Store Connect and submit for review.

### GitHub secrets

Both Actions need an App Store Connect API key with Xcode Cloud access:

- `APP_STORE_CONNECT_ISSUER_ID`
- `APP_STORE_CONNECT_KEY_ID`
- `APP_STORE_CONNECT_PRIVATE_KEY` (`.p8` contents)

In App Store Connect, turn off the `release/*` tag start condition on **Release
TestFlight** so leftover tags cannot auto-ship.

Install the repo-managed local git hooks for faster pre-commit and pre-push
feedback:

```sh
npm run hooks:install
```

- `pre-commit` runs `npm run typecheck`.
- `pre-push` runs the Health API typecheck and unit tests. Postgres/RLS
  integration tests and iOS build/test are skipped locally by default; CI covers
  them.
