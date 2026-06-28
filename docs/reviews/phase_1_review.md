# Family OS — Thorough Code Review Report

**Scope:** Full repository review focused on pragmatism and scalability.  
**Reviewer:** OpenCode (kimi-k2.7-code)  
**Date:** 2026-06-27  
**Repo state:** `a95f07f` — all 55 API tests passing, TypeScript typecheck passing.

## Follow-up Status — 2026-06-28

Fixed after this review:

- Runtime API no longer defaults to in-memory outside tests. `HEALTH_API_REPOSITORY` defaults to `memory` for tests and `postgres` otherwise; production rejects `memory`.
- Postgres persistence is wired through a DI layer for local Docker Postgres and release Supabase Postgres via `DATABASE_URL`.
- Postgres implementation is split by unit under `apps/api/src/repositories/postgres/` rather than a single large repository file.
- Added local Postgres API integration coverage for family, invite, profile, and BP history flow.
- Added `updated_at` triggers.
- Added request IDs, structured request logging, CORS, and write rate limiting.
- iOS `HealthAPIClient` now parses server error bodies.

Still remaining:

- Add production infra files: Dockerfile/systemd service, Cloudflare tunnel config, reverse proxy routing, and backup script.
- Split the public backend repository interface itself into smaller domain interfaces. The implementation is split, but route injection still uses one `FamilyRepository` facade.
- Improve iOS architecture with dependency injection, typed Swift enums, and typed request bodies instead of `AnyEncodable`.
- Add CI for API typecheck/tests and iOS build.
- Document production deployment and restore runbook.
- Decide whether to move from hand-written SQL plus Drizzle schema mirror to a single migration source of truth.

---

## Executive Summary

The project is a **well-organized Phase 1 prototype** with a clean monorepo layout, thoughtful Postgres schema, strong RLS policies, and good test coverage for the API surface. However, it currently sits in an **architectural “implementation gap”**: the backend has a complete Drizzle schema and SQL migrations, but the running API uses a single **in-memory repository** (`InMemoryFamilyRepository`). No production data layer is wired up. That makes the codebase pragmatic for demos and local unit tests, but **not yet pragmatic for shipping**, and several structural choices will not scale once real persistence, multi-facet expansion, or a team is added.

**Verdict:** Solid foundations and good discipline, but the next milestone must be “persist to Postgres with a real repository” before adding features.

---

## What Is Done Well

| Area | Observation |
|------|-------------|
| **Monorepo layout** | Clear `apps/*`, `packages/*`, `db/*`, `infra/*`, `docs/*` separation. READMEs are accurate. |
| **Shared contracts** | `@family-os/shared` centralizes API prefix, envelope shapes, and core types. |
| **Auth middleware** | `auth.ts` correctly verifies Supabase JWTs, checks role/issuer/audience, and gates dev-token bypass by environment. Fails closed when `SUPABASE_JWT_SECRET` is missing. |
| **Error envelope** | Consistent `{ data }` / `{ error: { code, message } }` format across routes. |
| **Input validation** | Zod schemas per route; body/param/query separation is clean. |
| **RLS policies** | SQL migrations include defensible row-level security for family scoping, manager checks, and owner-or-manager updates. |
| **Test coverage** | 55 API tests exercise auth, families, invites, profiles, readings, reminders, devices, audit logs, and notification scheduling. |
| **iOS sign-in** | Native Sign in with Apple + Supabase token exchange is implemented without shipping the service role key. |
| **Security-definer mindset** | Migrations comment that invite token lookups should be RPCs, indicating awareness of token-hash exposure risks. |

---

## Critical Blockers (Must Fix Before Production)

### 1. The Backend Has No Persistent Data Layer
`apps/api/src/repositories/families.ts` contains `InMemoryFamilyRepository`, and `createApp` defaults to it. There is **no Drizzle/postgres repository implementation**. The API dependencies list `drizzle-orm` and `postgres`, but they are unused.

**Impact:** Every deploy loses all data; the project cannot be used for real families.

**Required fix:** Implement a `PostgresFamilyRepository` (or split into per-domain repositories) and wire it in `server.ts` / `createApp` when `DATABASE_URL` is present. Keep `InMemoryFamilyRepository` for tests only.

### 2. Monolithic Repository Pattern
All domain logic — families, memberships, invites, profiles, BP/glucose readings, reminders, devices, deliveries, audit logs — lives in one 936-line `families.ts` file with one `FamilyRepository` interface.

**Impact:** This file will become unmaintainable as soon as the real DB layer is added. It violates single-responsibility and will create merge conflicts and slow onboarding.

**Required fix:** Split into domain repositories (`FamilyRepository`, `InviteRepository`, `ProfileRepository`, `ReadingRepository`, `ReminderRepository`, `DeviceRepository`, `AuditLogRepository`). Compose them in `createApp`.

### 3. iOS App Is a Bootstrap Shell, Not a Product UI
The SwiftUI layer is functional for smoke testing but lacks the depth described in `ask.md`:
- No persistent local models / Core Data / SwiftData.
- No offline support (acknowledged as Phase 1 online-only, but no sync architecture is in place for later).
- ViewModels are extensions of a single `HealthBootstrapViewModel`, creating tight coupling.
- UI uses stringly-typed state (e.g., `glucoseContext` as `String`, not an enum).
- No dependency injection; `URLSession.shared`, `UserDefaults.standard`, `KeychainStore()`, `HealthAPIClient()`, `SupabaseAuthClient()` are all instantiated directly.

**Impact:** The app will be hard to unit test and hard to evolve into the full Phase 1 screens.

---

## Backend Review

### Architecture: Good bones, wrong runtime default
- `app.ts` cleanly mounts route groups under `/health/v1`.
- Each route file applies `requireAuth()` correctly (note: invites intentionally leaves `GET /:token` public).
- Route handlers are thin; logic lives in the repository. This is good.
- The default repository being in-memory is the only thing preventing this from being a reasonable production skeleton.

**Scalability concern:** The single `FamilyRepository` interface couples unrelated domains. As soon as you add a second facet (e.g., documents, medications), every new domain will be forced into the same interface or will require refactoring.

### Data Model & Schema
- `db/schema/health.ts` is comprehensive and matches the migrations well.
- Good use of PostgreSQL-native types: `uuid`, `timestamptz`, `date`, `time`, `numeric(6,2)`, `integer[]`, `jsonb`.
- Indexes are appropriate: family/person/measured_at composite, deleted-at partial indexes, unique constraints.
- `deletedAt` soft-delete pattern is consistent.

**Gaps:**
- No `updated_at` auto-update trigger or `ON UPDATE` mechanism is visible in migrations. The schema has `defaultNow()` but no automatic `updated_at` refresh. Many backend frameworks forget this; it will cause stale `updatedAt` values.
- No `user_profiles` table despite it being listed in `docs/schema/README.md` and `TECHNICAL_DESIGN.md`. The app currently relies only on `auth.users`.
- No migration runner for Drizzle; the project uses hand-written SQL applied via `psql` shell script. That is fine for Phase 1, but it means the Drizzle schema is only documentation, not a source of truth.

### Authorization
- Backend enforces family membership and manager checks in-memory.
- RLS mirrors the rules in Postgres.
- `requireAuth` dev-token bypass is correctly rejected in production.

**Gaps:**
- No rate limiting on any endpoint. The technical design calls for “basic rate limiting on write endpoints.”
- No CORS configuration. Running behind Cloudflare Tunnel does not remove the need for explicit CORS.
- No request ID / structured logging. Errors are `console.error`-ed only.
- No audit of authentication failures.

### API Design
- RESTful resource layout is clear.
- Envelope response shape is consistent.
- Zod validation covers ranges, enums, datetime, UUIDs.

**Gaps:**
- List endpoints have `limit` but no pagination cursor/offset. For family data this is fine now, but audit logs and reading history will grow.
- No OpenAPI / spec generation.
- `PATCH` on readings allows partial updates but does not validate business rules beyond ranges (e.g., can you change `personId`? The `updateBody` correctly omits it, which is good).
- Reminder update body allows `recipientUserIds`, which rebuilds recipients. That is pragmatic, but concurrent edits could lose state.

### Testing
- 55 tests pass, including auth edge cases and cross-family isolation.
- Tests use `createApp` with injected in-memory repository and config. This is a good pattern.

**Gaps:**
- No integration tests against Postgres/Drizzle. Once a real repository exists, the current test suite will not catch DB-specific bugs (RLS, transactions, constraints).
- No load or concurrency tests.

---

## iOS Review

### Structure
- Clean separation into `Clients`, `Models`, `Services`, `ViewModels`, `Views`.
- `FamilyOSApp.swift` handles notification delegate and routing.

### Concerns

| Concern | Detail |
|---------|--------|
| **God ViewModel** | `HealthBootstrapViewModel` owns sub-view-models, but most business logic is added via `extension HealthBootstrapViewModel`. This makes the type enormous and hard to test in isolation. |
| **No DI** | Services are created inside view models. Swapping a client for testing requires subclassing or rewriting. |
| **State scattered** | `connection`, `auth`, `family`, `profiles`, `readings` are separate observed objects republished manually. A single state tree or dependency graph would be cleaner. |
| **Stringly-typed enums** | `glucoseContext`, `role`, `status` are `String` in Swift. Use typed enums with `Codable` for compile-time safety. |
| **Keychain vs UserDefaults** | Tokens go to Keychain, but user id/email go to UserDefaults. That is acceptable for non-sensitive data, but there is no migration or consistency guard if one store is cleared. |
| **AnyEncodable** | Used to build heterogeneous request bodies. A typed `Encodable` struct per endpoint would be safer and self-documenting. |
| **Error handling** | `badStatus(Int)` discards server error bodies. The API returns `{ error: { code, message } }`, but the client never reads it, so users see only “Health API returned HTTP 409.” |
| **No token refresh flow** | `refreshSession` exists in `SupabaseAuthClient`, but no view model calls it automatically when a 401 is received. |

### Pragmatism
The iOS app is pragmatic as a bootstrap, but it is not yet the product described in the design doc. It will need a real architecture pass before Phase 1 ships.

---

## Database / DevOps / Infra

### Good
- `docker-compose.yml` provides local Postgres.
- `scripts/migrate-local-postgres.sh` is a simple, idempotent migration runner.
- `.env.example` documents all required variables.
- RLS migrations are detailed.

### Gaps
- **No `updated_at` trigger:** Add a Postgres function/trigger or Drizzle `.$onUpdate()` to keep `updated_at` accurate.
- **No seed data / fixtures** for local development.
- **Infra is placeholder-only:** `infra/docker/` and `infra/systemd/` contain only READMEs. No service file, no Dockerfile, no Caddy/Nginx config, no Cloudflare tunnel setup script.
- **No CI/CD:** No GitHub Actions for typecheck/tests/iOS build.
- **No backup/restore docs** for the Raspberry Pi deployment.

---

## Pragmatism Assessment

The codebase is **pragmatic for a solo developer iterating on Phase 1 locally**. It prioritizes:
- Fast feedback (Bun hot reload, in-memory repo, Vitest).
- Clear contracts between iOS and backend.
- Working auth and family/reading/reminder flows.

It is **not pragmatic for shipping**, because:
- The persistence layer is missing.
- Infra deployment files are missing.
- The iOS UI is not yet product-quality.

The next pragmatic milestone should be: **“Deploy the backend to the Raspberry Pi with real Postgres and run the iOS app against it.”** That will force the missing pieces to surface.

---

## Scalability Assessment

### Code scalability: Moderate risk
- Monolithic repository will block parallel feature work.
- Tight iOS view model coupling will block UI expansion.
- No event-driven or CQRS patterns; audit logs are written inline. That is fine for low volume.

### Data scalability: Low risk for Phase 1, but needs attention
- Schema is normalized.
- Partial indexes on soft deletes are correct.
- Missing pagination will become a problem for history/audit.

### Operational scalability: High risk
- No observability (logs, metrics, health beyond a single endpoint).
- No rate limiting.
- No automated backups documented.
- Single Raspberry Pi + Cloudflare Tunnel is acceptable for a family app but needs documented recovery steps.

---

## Prioritized Recommendations

### P0 — Ship Blockers
1. **Implement a Drizzle/Postgres repository.** Split the monolith into domain repositories. Wire the real repository in `server.ts` when `DATABASE_URL` is set; keep in-memory only for tests.
2. **Add `updated_at` triggers** in migrations or Drizzle config.
3. **Add request logging, rate limiting, and CORS** to the Hono app.
4. **Add infra files:** Dockerfile or systemd service, Cloudflare tunnel config, reverse proxy routing, backup script.

### P1 — Architecture
5. **Split `FamilyRepository`** into smaller interfaces and implementations.
6. **Introduce dependency injection** on iOS (e.g., environment object, composition root, or SwiftUI `.environmentObject`).
7. **Add typed Swift enums** for glucose context, roles, and statuses.
8. **Add server error body parsing** in `HealthAPIClient` so users see meaningful messages.

### P2 — Quality & Future-Proofing
9. **Add Postgres integration tests** (e.g., spin up testcontainer or reuse local Docker) that run the same scenarios against the real repository.
10. **Add CI** for `npm run typecheck`, `npm test`, and `xcodebuild` of the iOS shell.
11. **Document the production deployment runbook** (env files, tunnel, DB migrations, Pi updates).
12. **Consider a real Supabase/Drizzle migration workflow** instead of maintaining two sources of truth (`.sql` files and `health.ts`).

---

## Bottom Line

Family OS has **strong foundations**: good separation of concerns, secure auth, a solid data model, and useful tests. The biggest issue is that the backend currently lives in RAM while pretending to be a Postgres-backed service. Fix the data layer, split the repository, add operational glue, and tighten the iOS architecture, and this becomes a pragmatic, scalable base for the health facet and future facets. Until then, it is a high-quality prototype.
