# Database Migrations

Drizzle Kit migration files live here.

## Source of Truth

`db/schema/health.ts` is the source of truth for app-owned tables, columns,
indexes, foreign keys, and check constraints. Use Drizzle Kit to generate schema
migrations:

```sh
npm run db:generate
```

Supabase-specific database behavior that Drizzle cannot model cleanly, including
RLS policies, `auth.uid()` policies, `auth.users` foreign keys, and trigger
functions, is kept as Drizzle custom migration SQL in this same directory. It is
not a second migration system; it is applied by the Drizzle migration journal in
order with generated migrations.

Apply migrations with:

```sh
npm run db:migrate
```

For plain local Postgres, run `npm run db:migrate:local`. That applies
`db/local/0000_auth_stub.sql` first so Supabase-specific references to
`auth.users`, `auth.uid()`, and `gen_random_uuid()` exist outside Supabase.
Do not use the local auth stub as a replacement for Supabase Auth in
production. Local runs are tracked by Drizzle in the `drizzle.__drizzle_migrations`
table so the helper can be run more than once.

If you already applied the old hand-written SQL migrations to a local Docker
volume, reset that local volume before running the Drizzle baseline. Do not do
that against production data.
