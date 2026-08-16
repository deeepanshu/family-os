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

## Crashlytics (Firebase)

Production crash and non-fatal reporting uses **Firebase Crashlytics**.

### One-time Firebase Console setup

1. Create a Firebase project (or reuse one) at [console.firebase.google.com](https://console.firebase.google.com).
2. Add an **iOS app** with bundle ID `com.deepanshujain.familyos`.
3. Download `GoogleService-Info.plist` and place it at:

   ```text
   apps/ios/FamilyOS/Resources/GoogleService-Info.plist
   ```

4. In Xcode, ensure the file is in the **FamilyOS** target **Copy Bundle Resources**
   (drag into `FamilyOS/Resources` if it is not already listed).
5. Enable **Crashlytics** for the project in the Firebase console
   (Build → Crashlytics → Get started).
6. Optional: enable Google Analytics in the same Firebase project for breadcrumb logs.

An example template lives at `FamilyOS/Resources/GoogleService-Info.plist.example`.
The app **builds and runs without** the real plist; Crashlytics stays disabled until the file is present.

`GoogleService-Info.plist` is client-safe (similar to the Supabase anon key). Commit the
real file so Xcode Cloud / TestFlight archives can upload dSYMs and report crashes.

### What the app does

- Initializes Firebase at launch via `CrashReporting.configure()`.
- **DEBUG** builds: Crashlytics collection is off (no local/simulator noise).
- **Release** builds: collection on; custom key `app_environment`; user id set to the
  Supabase user UUID only (never email, tokens, or health values).
- Xcode has a **Upload Crashlytics dSYMs** run-script phase (last build phase) for
  readable stack traces. The script no-ops if `GoogleService-Info.plist` is missing.
- SPM products: `FirebaseCore`, `FirebaseCrashlytics` from
  `https://github.com/firebase/firebase-ios-sdk.git`.

### Verify with a test crash (Release / device, no debugger)

1. Ship a temporary button that calls `fatalError("Crashlytics test")` (or use a one-off build).
2. Install and launch **without** the Xcode debugger attached.
3. Trigger the crash, relaunch the app so the report uploads.
4. Confirm the event in Firebase → Crashlytics (can take a few minutes).

Do not leave a test-crash control in production UI.

### Privacy

Do not send blood pressure/glucose values, free-text notes, or auth tokens through
`CrashReporting.record` / `log`. Prefer error domain/code and short, non-PHI context.

## Environments

Debug builds use the `local` environment:

- Health API: `http://localhost:3001/health/api/v1`
- Backend database: local Docker Postgres
- Auth: Supabase Auth for real Apple sign-in, or `dev-token` for local smoke
  tests when the backend enables dev auth

Release builds use the `release` environment:

- Health API: `https://familyos.deepanshujain.me/health/api/v1`
- Backend database: Supabase Postgres behind the Raspberry Pi API
- Auth: Supabase Auth with Sign in with Apple

The app reads these generated Info.plist keys:

- `FAMILY_OS_ENV`
- `HEALTH_API_BASE_URL`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are read from the tracked base config
files. The Release values are intentionally tracked because they are
client-safe values embedded in the app, which also makes them available to
Xcode Cloud:

- `Config/Local.xcconfig`
- `Config/Release.xcconfig`

Those files support ignored private overrides for local development:

- `Config/Local.private.xcconfig`
- `Config/Release.private.xcconfig`

Create `Local.private.xcconfig` from its example and put your local development
Supabase values there before using real Apple login. Do not put the Supabase
service-role key in any iOS configuration file.

```sh
cp apps/ios/Config/Local.private.xcconfig.example apps/ios/Config/Local.private.xcconfig
```

In `.xcconfig` files, write URLs as `https:/$()/your-project.supabase.co`.
Xcode expands that to `https://your-project.supabase.co`; a literal `https://`
is parsed as a comment after `https:`.

## Xcode Cloud TestFlight Workflow

The release workflow is configured in App Store Connect for the `FamilyOS`
scheme. It has this shape:

| Workflow setting | Value |
| --- | --- |
| Start condition | Git tag changes matching `release/*` |
| Action | Archive for iOS |
| Post-action | TestFlight internal distribution |
| Source ref | The pushed release tag |

Xcode Cloud assigns the Apple build number. It increments automatically after
the initial number is seeded in App Store Connect, so do not manually change
`CURRENT_PROJECT_VERSION` for a cloud release. The tag is a source-release
identifier, not the TestFlight build number.

GitHub Actions `.github/workflows/release-app.yml` creates the next
`release/<marketing-version>-N` tag when iOS changes land on `main`, or when
you run **Actions → Release App**. Xcode Cloud still starts from the tag, not
from the branch push.

```sh
# Manual fallback if GitHub Actions cannot push tags
git tag release/<marketing-version>-<release-sequence>
git push origin release/<marketing-version>-<release-sequence>
```

Each retry needs a new tag. Xcode Cloud must complete and Apple must process
the upload before testers can install it. A manual Xcode Cloud start is only a
recovery path and must select the intended release tag.

The current bootstrap screen can call:

- `GET /health/api/v1/healthcheck`
- `GET /health/api/v1/me` with `Authorization: Bearer <supabase_access_token>`
- `GET /health/api/v1/families/current`
- `POST /health/api/v1/families`
- `GET /health/api/v1/invites/{token}`
- `POST /health/api/v1/invites`
- `POST /health/api/v1/invites/{token}/accept`
- `GET /health/api/v1/people`
- `POST /health/api/v1/people`
- `POST /health/api/v1/readings/blood-pressure`
- `GET /health/api/v1/readings/blood-pressure`
- `POST /health/api/v1/readings/blood-glucose`
- `GET /health/api/v1/readings/blood-glucose`
- `POST /health/api/v1/reminders`
- `GET /health/api/v1/reminders`

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
