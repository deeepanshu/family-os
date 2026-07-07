# Project Commands

Run local Postgres with Colima/Docker and apply migrations:

```sh
colima start --cpu 2 --memory 4 --disk 20 --runtime docker
npm run db:up
npm run db:migrate:local
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
  HEALTH_API_BASE_URL=http://<YOUR_MAC_LAN_IP>:3001/health/v1 \
  FAMILY_OS_ENV=local \
  build
```

List connected devices when the destination name is unclear:

```sh
xcrun xctrace list devices
```
