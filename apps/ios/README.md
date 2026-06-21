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
