# CI + Local Hooks Plan

## Summary

Add GitHub Actions as the required source of truth for `main` and PR quality
gates, plus repo-managed local git hooks for fast pre-commit and pre-push
protection. CI must validate backend TypeScript, Postgres/Drizzle migrations,
API tests including RLS, and iOS simulator build/tests without using real
Supabase or APNs secrets.

## Key Changes

- Add `.github/workflows/ci.yml` with required jobs:
  - `api`: `npm ci`, start Docker Postgres, run `npm run db:migrate:local`,
    `npm run typecheck -w @family-os/health-api`, and
    `npm run test -w @family-os/health-api`.
  - `workspace`: `npm ci` and `npm run typecheck` to catch root/workspace type
    drift.
  - `drizzle`: `npm ci`, `npm run db:check`, and a migration drift guard that
    fails if Drizzle schema changes would create uncommitted migration output.
  - `ios`: macOS runner, `xcodebuild build`, then `xcodebuild test` for
    `FamilyOS` on an available iOS simulator, with `CODE_SIGNING_ALLOWED=NO`.
- Use CI-only environment values:
  - `DATABASE_URL=postgres://family_os:family_os@localhost:5432/family_os`
  - `HEALTH_API_REPOSITORY=postgres`
  - `HEALTH_API_SYNC_LOCAL_AUTH_USERS=true`
  - fake test JWT/Supabase values only; no real Supabase or APNs secrets.
- Add repo-managed hooks:
  - `scripts/hooks/pre-commit`: run `npm run typecheck`.
  - `scripts/hooks/pre-push`: run API typecheck and unit tests
    (`npm run test:unit -w @family-os/health-api`), skipping iOS and the
    Postgres/RLS integration tests by default to avoid slow local pushes.
  - `scripts/install-git-hooks.sh`: sets
    `git config core.hooksPath scripts/hooks`.
  - Add `npm run hooks:install`.
- Split API test targets:
  - `npm run test -w @family-os/health-api`: full suite, including
    `apps/api/test/postgresRepository.test.ts` (used in CI with Postgres).
  - `npm run test:unit -w @family-os/health-api`: non-DB unit tests, excluding
    the Postgres/RLS integration test (used by the local pre-push hook).
  - `npm run test:integration -w @family-os/health-api`: Postgres/RLS-only
    integration test (`apps/api/test/postgresRepository.test.ts`).
- Document the split:
  - Local hooks catch common breakage before commit/push.
  - GitHub Actions are authoritative and include iOS + DB checks.

## Test Plan

- Validate locally before committing:
  - `npm run typecheck`
  - `npm run test:unit -w @family-os/health-api` (unit tests, no Postgres)
  - Full API validation (requires Postgres): `npm run test -w @family-os/health-api`
  - Postgres/RLS integration tests (requires Postgres): `npm run test:integration -w @family-os/health-api`
  - `xcodebuild test -project apps/ios/FamilyOS.xcodeproj -scheme FamilyOS -destination 'platform=iOS Simulator,name=iPhone 17' CODE_SIGNING_ALLOWED=NO`
- Validate hooks:
  - Run `npm run hooks:install`.
  - Make a harmless commit path and confirm pre-commit runs typecheck.
  - Push a branch and confirm pre-push runs API checks.
- Validate CI:
  - Push a branch.
  - Confirm API, workspace, Drizzle, and iOS jobs run.
  - Fix simulator destination if GitHub macOS runner lacks `iPhone 17`.
  - After first green run, mark all CI jobs as required branch protection checks
    for `main`.

## Assumptions

- GitHub Actions is the remote CI provider.
- iOS CI is required immediately, even if the first run needs runner-specific
  simulator adjustment.
- Local hooks should not require Docker or iOS simulator by default; CI covers
  those heavier checks.
- No production secrets are introduced into CI.
