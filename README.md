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
- Raspberry Pi backend hosting through Cloudflare Tunnel.

## API

Base URL:

```text
https://api.deepanshujain.com/health/v1
```

Local API URL:

```text
http://localhost:3001/health/v1
```

## Phase 1

- Family setup.
- Family profiles.
- Family invites.
- Blood pressure readings.
- Blood sugar readings.
- Custom reminders.
- Push notifications.

See:

- [Ask](docs/ask.md)
- [Technical Design](docs/TECHNICAL_DESIGN.md)

## Local Setup

Install dependencies:

```sh
npm install
```

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
placeholders are treated as unset. `NODE_ENV` defaults to `development` and
`PORT` defaults to `3001`.

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
