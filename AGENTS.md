# Project Commands

Run local Postgres with Colima/Docker and apply migrations:

```sh
colima start --cpu 2 --memory 4 --disk 20 --runtime docker
npm run db:up
npm run db:migrate:local
npm run db:seed:local
```

Run the local Health API with the local Postgres user and the dev-token smoke-test auth path:

```sh
DATABASE_URL=postgres://family_os:family_os@localhost:5432/family_os \
HEALTH_API_REPOSITORY=postgres \
HEALTH_API_SYNC_LOCAL_AUTH_USERS=true \
HEALTH_API_ENABLE_DEV_AUTH=true \
HEALTH_API_DEV_AUTH_USER_ID=00000000-0000-4000-8000-000000000001 \
npm run api:dev
```

The iOS local dev sign-in uses `Bearer dev-token`; the API maps it to
`HEALTH_API_DEV_AUTH_USER_ID`. This bypass is for local smoke testing only and
must stay disabled in production.

`npm run db:seed:local` fills the Debug user (`…0001`) so Home/History are not
empty. Debug build → **Continue**. Profile picker: **DJDJ** (or the existing
Self name) has steps/sleep/BP/workouts; **MJ** has BP only. Same-day re-run
upserts. Loopback Postgres only — refused in production.

For a physical iPhone, `localhost` means the phone itself. Build with the Mac's
LAN IP in `HEALTH_API_BASE_URL`:

```sh
ipconfig getifaddr en0
```

```sh
xcodebuild \
  -project apps/ios/FamilyOS.xcodeproj \
  -scheme FamilyOS \
  -configuration Debug \
  -destination 'platform=iOS,name=<YOUR_IPHONE_NAME>' \
  DEVELOPMENT_TEAM=LG9UP2KBHV \
  HEALTH_API_BASE_URL=http://<YOUR_MAC_LAN_IP>:3001/health/api/v1 \
  FAMILY_OS_ENV=local \
  build
```

List connected devices when the destination name is unclear:

```sh
xcrun xctrace list devices
```

## Xcode Cloud Releases

GitHub Actions starts Xcode Cloud. Merge and `release/*` tags do not.

- **Actions → TestFlight** — any pushed branch. Waits for DJ to approve the
  `testflight` environment, then archives that SHA and uploads internal
  TestFlight. `.github/workflows/testflight.yml`.
- **Actions → App Store Archive** — `main` only. Waits for DJ to approve the
  `app-store` environment, then archives for App Store Connect; does not
  submit. `.github/workflows/app-store-archive.yml`.

`scripts/start-xcode-cloud.mjs` calls App Store Connect (`POST /v1/ciBuildRuns`).
Needs repo secrets `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_KEY_ID`,
and `APP_STORE_CONNECT_PRIVATE_KEY`.

Xcode Cloud workflows: **Release TestFlight**
(`367FA404-8D98-4F7B-A133-A9E1929A82C8`), **App Store Release**
(`47172e26-3833-4bcd-8891-12c2b610006f`). Cloud owns the Apple build number.
