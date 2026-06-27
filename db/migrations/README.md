# Database Migrations

Drizzle/Supabase migration files live here.

For plain local Postgres, run `npm run db:migrate:local`. That applies
`db/local/0000_auth_stub.sql` first so Supabase-specific references to
`auth.users`, `auth.uid()`, and `gen_random_uuid()` exist outside Supabase.
Do not use the local auth stub as a replacement for Supabase Auth in
production. Local runs are tracked in a `local_schema_migrations` table so the
helper can be run more than once.

- `0001_family_setup.sql` creates families, memberships, and baseline RLS
  select policies for active members.
- `0002_family_invites.sql` creates invite storage with hashed tokens and
  manager-only insert policy.
- `0003_people.sql` creates family health profiles with active-member read and
  manager write policies.
- `0004_blood_pressure.sql` creates BP readings with active-member read/create
  and owner-or-manager update policies.
- `0005_blood_glucose.sql` creates blood sugar readings with active-member
  read/create and owner-or-manager update policies.
- `0006_reminders.sql` creates reminders and reminder recipients.
- `0007_notifications.sql` creates APNs devices and delivery records.
- `0008_audit_logs.sql` creates family-scoped audit logs with RLS policies.
