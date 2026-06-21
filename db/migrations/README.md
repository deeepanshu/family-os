# Database Migrations

Drizzle/Supabase migration files will live here.

- `0001_family_setup.sql` creates families, memberships, and baseline RLS
  select policies for active members.
- `0002_family_invites.sql` creates invite storage with hashed tokens and
  manager-only insert policy.
- `0003_people.sql` creates family health profiles with active-member read and
  manager write policies.
- `0004_blood_pressure.sql` creates BP readings with active-member read/create
  and owner-or-manager update policies.
