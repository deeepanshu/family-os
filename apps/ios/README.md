# Family OS iOS

iOS app stack:

- Swift.
- SwiftUI.
- Sign in with Apple.
- Supabase Auth.
- APNs remote notifications.

Phase 1 planned screens:

- Sign In.
- Family Setup.
- Dashboard.
- Profile Detail.
- Add Blood Pressure Reading.
- Add Blood Sugar Reading.
- Reading History.
- Reminders.
- Create/Edit Reminder.
- Settings.

## Local Build

Open `FamilyOS.xcodeproj` in Xcode or build from the repository root:

```sh
xcodebuild \
  -project apps/ios/FamilyOS.xcodeproj \
  -scheme FamilyOS \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO \
  build
```

## Environments

Debug builds use the `local` environment:

- Health API: `http://localhost:3001/health/v1`
- Backend database: local Docker Postgres
- Auth: Supabase Auth for real Apple sign-in, or `dev-token` for local smoke
  tests when the backend enables dev auth

Release builds use the `release` environment:

- Health API: `https://api.deepanshujain.me/health/v1`
- Backend database: Supabase Postgres behind the Raspberry Pi API
- Auth: Supabase Auth with Sign in with Apple

The app reads these generated Info.plist keys:

- `FAMILY_OS_ENV`
- `HEALTH_API_BASE_URL`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are read from tracked base config files:

- `Config/Local.xcconfig`
- `Config/Release.xcconfig`

Those files include ignored private overrides:

- `Config/Local.private.xcconfig`
- `Config/Release.private.xcconfig`

Create the private files from the examples and put real Supabase values there
before using real Apple login:

```sh
cp apps/ios/Config/Local.private.xcconfig.example apps/ios/Config/Local.private.xcconfig
cp apps/ios/Config/Release.private.xcconfig.example apps/ios/Config/Release.private.xcconfig
```

In `.xcconfig` files, write URLs as `https:/$()/your-project.supabase.co`.
Xcode expands that to `https://your-project.supabase.co`; a literal `https://`
is parsed as a comment after `https:`.

The current bootstrap screen can call:

- `GET /health/v1/healthcheck`
- `GET /health/v1/me` with `Authorization: Bearer <supabase_access_token>`
- `GET /health/v1/families/current`
- `POST /health/v1/families`
- `GET /health/v1/invites/{token}`
- `POST /health/v1/invites`
- `POST /health/v1/invites/{token}/accept`
- `GET /health/v1/people`
- `POST /health/v1/people`
- `POST /health/v1/readings/blood-pressure`
- `GET /health/v1/readings/blood-pressure`
- `POST /health/v1/readings/blood-glucose`
- `GET /health/v1/readings/blood-glucose`
- `POST /health/v1/reminders`
- `GET /health/v1/reminders`

## Sign In With Apple

The app uses Apple's native `AuthenticationServices` flow and exchanges the
Apple identity token with Supabase Auth. In the app, enter:

- Supabase URL, for example `https://<project-ref>.supabase.co`
- Supabase anon key
- Health API base URL

The anon key is expected in the client. Do not put the Supabase service role key
in the iOS app.

Supabase must have the Apple provider enabled, and the Apple developer account
must enable Sign in with Apple for `com.deepanshujain.familyos`. The Xcode target
includes `FamilyOS.entitlements` with the Sign in with Apple capability.

For local backend smoke testing without Apple/Supabase, paste a temporary
Supabase access token or the development `dev-token` when the backend is running
with `HEALTH_API_ENABLE_DEV_AUTH=true`.

Remote notification payloads use these keys:

- `action` - routing action. Supported values:
  - `open_add_blood_glucose`
  - `open_add_blood_pressure`
  - `open_reminder`
- `subject_person_id` - optional health profile ID preselected when the notification is opened.
- `reminder_id` - optional identifier of the reminder that triggered the push.
