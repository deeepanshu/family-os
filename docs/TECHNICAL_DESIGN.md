# Family OS Technical Design

## Locked Stack

- Platform: iOS only.
- iOS app: Swift + SwiftUI.
- Auth: Sign in with Apple through Supabase Auth.
- Backend runtime: Bun.
- Backend framework: Hono.
- Backend language: TypeScript.
- Validation: Zod.
- Database: Supabase Postgres.
- Query layer: Drizzle.
- Storage: Supabase Storage.
- Permissions: backend authorization plus Postgres RLS.
- Notifications: APNs.
- Backend host: Raspberry Pi.
- Public ingress: Cloudflare Tunnel via `cloudflared`.
- API base URL: `https://api.deepanshujain.com/health/v1`.
- Distribution: TestFlight.

## Repository Structure

```text
family-os/
  apps/
    ios/
    api/
      src/

  db/
    migrations/
    schema/

  docs/
    ask.md
    TECHNICAL_DESIGN.md

  infra/
    cloudflare/
    systemd/
    docker/

  packages/
    shared/
      src/

  .env.example
  README.md
```

## Architecture

```text
SwiftUI iOS app
  |
  | HTTPS JSON API
  | Authorization: Bearer <supabase_access_token>
  v
Bun + Hono backend on Raspberry Pi
  |
  | Supabase JWT verification
  | Drizzle SQL queries
  v
Supabase Postgres

Backend
  |
  v
APNs

Cloudflare
  |
  v
Cloudflare Tunnel
  |
  v
Raspberry Pi
  |
  v
Reverse proxy / Bun service
```

## API Routing

Public API hostname:

```text
https://api.deepanshujain.com
```

Health facet API prefix:

```text
/health/v1
```

Example endpoints:

```text
GET    /health/v1/healthcheck

POST   /health/v1/families
GET    /health/v1/families/current

POST   /health/v1/invites
GET    /health/v1/invites/:token
POST   /health/v1/invites/:token/accept

POST   /health/v1/people
GET    /health/v1/people
GET    /health/v1/people/:id
PATCH  /health/v1/people/:id
DELETE /health/v1/people/:id

POST   /health/v1/readings/blood-pressure
GET    /health/v1/readings/blood-pressure
GET    /health/v1/readings/blood-pressure/:id
PATCH  /health/v1/readings/blood-pressure/:id
DELETE /health/v1/readings/blood-pressure/:id

POST   /health/v1/readings/blood-glucose
GET    /health/v1/readings/blood-glucose
GET    /health/v1/readings/blood-glucose/:id
PATCH  /health/v1/readings/blood-glucose/:id
DELETE /health/v1/readings/blood-glucose/:id

POST   /health/v1/devices
DELETE /health/v1/devices/:id

POST   /health/v1/reminders
GET    /health/v1/reminders
GET    /health/v1/reminders/:id
PATCH  /health/v1/reminders/:id
DELETE /health/v1/reminders/:id
POST   /health/v1/reminders/:id/test
```

## Auth Flow

1. User signs in with Apple in the SwiftUI app.
2. Apple returns an identity token.
3. The app passes the Apple token to Supabase Auth.
4. Supabase returns a session and access token.
5. The app sends the access token to the backend:

```http
Authorization: Bearer <supabase_access_token>
```

6. The backend verifies the Supabase JWT.
7. The backend uses `auth.users.id` as the canonical user ID.

The Supabase service role key must never be shipped in the iOS app.

## Permission Model

### Roles

```text
manager
member
```

### Membership Status

```text
active
invited
removed
```

### Rules

Family manager:

```text
Can view/add/edit/delete everything inside the family.
```

Active family member:

```text
Can view all family data.
Can create readings for any family profile.
Can create reminders for any family profile.
Can select any active family member as a reminder recipient.
Can edit/delete readings they created.
Can edit/delete reminders they created.
Can disable reminder notifications for themselves.
Cannot manage family roles, memberships, or profiles.
```

Permission checks are enforced in the backend and mirrored with Postgres RLS where practical.

## Data Model

### users

Supabase owns `auth.users`. Application-specific profile fields can live in `user_profiles`.

### user_profiles

```text
id uuid primary key references auth.users(id)
display_name text
created_at timestamptz
updated_at timestamptz
```

### families

```text
id uuid primary key
name text not null
created_by_user_id uuid not null references auth.users(id)
created_at timestamptz
updated_at timestamptz
```

### family_memberships

```text
id uuid primary key
family_id uuid not null references families(id)
user_id uuid not null references auth.users(id)
role text not null check role in ('manager', 'member')
status text not null check status in ('active', 'invited', 'removed')
created_at timestamptz
updated_at timestamptz

unique (family_id, user_id)
```

### family_invites

```text
id uuid primary key
family_id uuid not null references families(id)
invited_by_user_id uuid not null references auth.users(id)
email text
token_hash text not null
role text not null check role in ('manager', 'member')
status text not null check status in ('pending', 'accepted', 'revoked', 'expired')
expires_at timestamptz not null
accepted_by_user_id uuid references auth.users(id)
accepted_at timestamptz
created_at timestamptz
updated_at timestamptz

unique (token_hash)
```

### people

Health profiles tracked inside a family.

```text
id uuid primary key
family_id uuid not null references families(id)
linked_user_id uuid references auth.users(id)
created_by_user_id uuid not null references auth.users(id)
display_name text not null
relationship_label text
date_of_birth date
status text not null check status in ('active', 'inactive')
created_at timestamptz
updated_at timestamptz
```

### blood_pressure_readings

```text
id uuid primary key
family_id uuid not null references families(id)
person_id uuid not null references people(id)
recorded_by_user_id uuid not null references auth.users(id)
systolic integer not null
diastolic integer not null
pulse integer
measured_at timestamptz not null
context text
notes text
deleted_at timestamptz
created_at timestamptz
updated_at timestamptz
```

Suggested validation:

```text
systolic: 50-260
diastolic: 30-180
pulse: 30-220
```

### blood_glucose_readings

```text
id uuid primary key
family_id uuid not null references families(id)
person_id uuid not null references people(id)
recorded_by_user_id uuid not null references auth.users(id)
value numeric(6,2) not null
unit text not null check unit in ('mg/dL')
measured_at timestamptz not null
context text not null check context in ('fasting', 'before_meal', 'after_meal', 'bedtime', 'random')
notes text
created_at timestamptz
updated_at timestamptz
```

Suggested validation:

```text
value: 20-700 mg/dL
```

### notification_devices

```text
id uuid primary key
user_id uuid not null references auth.users(id)
device_token text not null
platform text not null check platform in ('ios')
created_at timestamptz
last_seen_at timestamptz

unique (user_id, device_token)
```

### reminders

```text
id uuid primary key
family_id uuid not null references families(id)
subject_person_id uuid references people(id)
created_by_user_id uuid not null references auth.users(id)
type text not null check type in ('generic', 'blood_glucose', 'blood_pressure')
title text not null
message text not null
schedule_kind text not null check schedule_kind in ('once', 'daily', 'weekly', 'custom_days')
time_of_day time
timezone text not null
days_of_week integer[]
starts_on date
ends_on date
enabled boolean not null default true
created_at timestamptz
updated_at timestamptz
```

### reminder_recipients

```text
id uuid primary key
reminder_id uuid not null references reminders(id)
user_id uuid not null references auth.users(id)
enabled boolean not null default true
disabled_at timestamptz
created_at timestamptz

unique (reminder_id, user_id)
```

### notification_deliveries

```text
id uuid primary key
reminder_id uuid not null references reminders(id)
recipient_user_id uuid not null references auth.users(id)
status text not null check status in ('pending', 'sent', 'failed', 'opened')
scheduled_for timestamptz not null
sent_at timestamptz
opened_at timestamptz
error text
created_at timestamptz
```

### audit_logs

```text
id uuid primary key
family_id uuid references families(id)
actor_user_id uuid references auth.users(id)
action text not null
entity_type text not null
entity_id uuid
metadata jsonb
created_at timestamptz
```

Example actions:

```text
family_created
profile_created
profile_updated
profile_deleted
bp_reading_created
bp_reading_updated
bp_reading_deleted
glucose_reading_created
glucose_reading_updated
glucose_reading_deleted
reminder_created
reminder_updated
reminder_deleted
permission_changed
```

## RLS Strategy

RLS should be enabled on family-scoped tables.

Baseline select rule:

```text
Allow select if auth.uid() is an active member of the row's family.
```

Manager write rule:

```text
Allow insert/update/delete if auth.uid() is an active manager of the row's family.
```

Member-owned write rule:

```text
Allow update/delete on readings/reminders if auth.uid() created the row.
```

The backend still performs explicit authorization checks before writing. RLS is defense in depth and protects direct Supabase access.

## Notification Design

The iOS app registers for remote notifications and sends the APNs device token to:

```text
POST /health/v1/devices
```

Reminder scheduler:

1. Runs on the Raspberry Pi.
2. Finds enabled reminders due for the current minute/window.
3. Expands selected recipients.
4. Creates `notification_deliveries` rows.
5. Sends APNs pushes to active recipient devices.
6. Updates delivery status.

Reminder tap behavior:

```text
blood_glucose -> open add blood sugar screen with subject/context prefilled
blood_pressure -> open add blood pressure screen with subject prefilled
generic -> open reminder detail
```

Push payload example:

```json
{
  "aps": {
    "alert": {
      "title": "Blood Sugar Reminder",
      "body": "Please check fasting sugar."
    },
    "sound": "default"
  },
  "reminder_id": "00000000-0000-0000-0000-000000000000",
  "subject_person_id": "00000000-0000-0000-0000-000000000000",
  "action": "open_add_blood_glucose"
}
```

## Raspberry Pi Deployment

The backend runs on the Raspberry Pi and is exposed through Cloudflare Tunnel.

Recommended local ports:

```text
family-os-health-api: localhost:3001
```

Cloudflare/Caddy style routing:

```text
api.deepanshujain.com/health/* -> localhost:3001
```

Operational requirements:

- `GET /health/v1/healthcheck`.
- Process restart via systemd or Docker Compose.
- `cloudflared` already running.
- Uptime monitoring for the healthcheck endpoint.
- Logs retained locally.
- Secrets stored outside git.

Required environment variables:

```text
DATABASE_URL=
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_JWT_SECRET=
APNS_TEAM_ID=
APNS_KEY_ID=
APNS_BUNDLE_ID=
APNS_PRIVATE_KEY_PATH=
```

## Security Requirements

- HTTPS only.
- Verify Supabase JWTs on all protected backend routes.
- Never expose Supabase service role key to iOS.
- Enable RLS on family-scoped tables.
- Store secrets in `.env` on the Raspberry Pi with strict permissions.
- Add basic rate limiting on write endpoints.
- Validate all request bodies with Zod.
- Write audit logs for important health/family changes.
- Deleted readings and reminders disappear from normal app views.
- Phase 1 is online-only.

## Phase 1 Implementation Order

1. Create monorepo skeleton.
2. Create Supabase project.
3. Define database schema and migrations.
4. Configure Supabase Auth with Sign in with Apple.
5. Build Bun/Hono backend skeleton.
6. Add JWT auth middleware.
7. Add family/invite/profile APIs.
8. Add BP/glucose APIs.
9. Add reminder/device APIs.
10. Add APNs sender and scheduler.
11. Build SwiftUI sign-in flow.
12. Build home/profile/readings UI.
13. Build reminders UI.
14. Deploy backend to Raspberry Pi behind Cloudflare Tunnel.
15. Distribute through TestFlight.

## Deferred Technical Decisions

- Whether to use Docker Compose or systemd for the first Pi deployment.
- Whether to use Caddy/Nginx in front of the Bun service or route tunnel directly.
- Export format and retention policy.
- Exact invite delivery channel beyond link/token.
