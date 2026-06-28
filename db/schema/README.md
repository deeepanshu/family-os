# Database Schema

Supabase Postgres schema and Drizzle schema definitions live here.

Core Phase 1 tables:

- `user_profiles`
- `families`
- `family_memberships`
- `people`
- `blood_pressure_readings`
- `blood_glucose_readings`
- `notification_devices`
- `reminders`
- `reminder_recipients`
- `notification_deliveries`
- `audit_logs`

`health.ts` is the source of truth for app-owned database structure. Generate
migrations from it with `npm run db:generate`.

Supabase-owned auth storage is intentionally not modeled as a Drizzle-generated
table. The migration layer adds foreign keys to `auth.users` as custom Drizzle
SQL so Supabase release Postgres owns Auth and local Postgres can use
`db/local/0000_auth_stub.sql`.
