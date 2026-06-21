# Database Migrations

Drizzle/Supabase migration files will live here.

- `0001_family_setup.sql` creates families, memberships, and baseline RLS
  select policies for active members.
- `0002_family_invites.sql` creates invite storage with hashed tokens and
  manager-only insert policy.
