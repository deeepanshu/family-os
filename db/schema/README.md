# Database Schema

Supabase Postgres schema and Drizzle schema definitions will live here.

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

Current Drizzle schema starts in `health.ts` with `families`,
`family_memberships`, and `family_invites`. Later Phase 1 issues extend the
same file.
