# Solo-First Family OS Plan

## Summary

Make Family OS usable for one person immediately after sign-in, while preserving the current family/workspace architecture. A new user gets a private personal workspace and creates a linked self profile. Family sharing is optional and happens later through invites.

## Backend/API Changes

- Add `families.kind` with values `personal` and `family`.
  - Drizzle schema + migration.
  - Existing rows default to `family`.
  - New bootstrap-created rows use `personal`.
  - API `Family` response includes `kind`.
  - iOS `Family` model includes `kind`.
- Add `POST /health/v1/bootstrap`.
  - Auth required.
  - Idempotent.
  - If user has active workspace, return it.
  - If user has none, create `personal` workspace named `My Health` and manager membership.
  - Response:

    ```ts
    {
      family: FamilyResponse,
      profiles: HealthProfile[],
      selfProfile: HealthProfile | null,
      needsProfileSetup: boolean
    }
    ```

- Add `POST /health/v1/me/profile`.
  - Auth required.
  - Requires active workspace.
  - Request:

    ```ts
    {
      displayName: string
    }
    ```

  - Creates active profile with:
    - `linked_user_id = auth user id`
    - `relationship_label = "Self"`
  - If linked self profile already exists, return it idempotently.
  - Response:

    ```ts
    HealthProfile
    ```

- Keep `POST /health/v1/people` manager-only for creating profiles for other people.
- Keep `POST /health/v1/families` for explicit/manual family creation and existing tests.
- Keep `POST /health/v1/healthkit/link-profile` for backward compatibility, but the normal iOS solo flow should not use it.
- Update both repository implementations:
  - Postgres repository.
  - In-memory repository used by tests.
- Update RLS:
  - Keep manager profile insert/update rules.
  - Add self-profile insert rule allowing an active member to insert only when `linked_user_id = auth.uid()` and relationship label is `Self`.

## Invite + Workspace Rules

- Creating the first invite from a `personal` workspace converts it to `family`.
- Accepting an invite:
  - If user has no active workspace, accept normally.
  - If user has an active `family` workspace, reject with conflict.
  - If user has an active `personal` workspace, allow switching only when:
    - workspace has exactly one active membership,
    - workspace has zero reminders,
    - workspace has zero manual BP readings,
    - workspace has zero manual blood sugar readings.
  - Switch transaction must:
    - lock current active membership,
    - verify the safe-switch rules,
    - mark old personal membership `removed`,
    - accept invite,
    - insert new active membership.
- iOS invite deep link flow:
  - If app opens with invite token and user is signed out, store pending invite token locally.
  - After sign-in, accept invite before calling bootstrap.
  - Then call bootstrap and continue normal routing.

## iOS UX Changes

- After sign-in, run startup routing:
  - if pending invite token exists, accept invite first,
  - call bootstrap,
  - route based on bootstrap response.
- Routing:
  - signed out -> Sign In
  - signed in + startup loading -> loading screen
  - signed in + `needsProfileSetup` -> `SetUpProfileView`
  - signed in + self profile exists -> main tabs
- Add `SetUpProfileView`.
  - Title: `Set up your profile`
  - Field: `Name`
  - CTA: `Continue`
  - Calls `POST /me/profile`.
- Home:
  - Defaults to linked self profile.
  - Shows latest BP, latest blood sugar, and HealthKit summaries for self.
  - Buttons:
    - `Record BP`
    - `Record Blood Sugar`
  - Hide profile picker when only one profile exists.
- Reading sheets:
  - Default to linked self profile.
  - Hide profile picker for one profile.
  - Show profile picker only when multiple profiles exist.
- History:
  - Default to linked self profile.
  - Hide profile picker for one profile.
  - Show profile filter only when multiple profiles exist.
- Profile tab:
  - Shows `Your profile`.
  - Shows HealthKit sync status and controls.
  - HealthKit sync always targets linked self profile.
  - Remove normal-user "Link selected profile" UI.
- Family tab:
  - Keep tab label `Family`.
  - For `personal` workspace, show:
    - `You are using Family OS for yourself`
    - `Invite family`
    - `Add another health profile`
  - For `family` workspace, show members, invites, roles, and health profiles.
- Copy cleanup:
  - `Record Diabetes` -> `Record Blood Sugar`
  - `Family Profiles` -> `Health Profiles`
  - Do not show `Create Family` during first-run onboarding.

## Data / Permission Rules

- `people.linked_user_id` is the source of truth for "this profile belongs to this account."
- One user can have at most one active linked self profile in their active workspace.
- Managers can create/manage any family health profile.
- Active members can create their own linked self profile only through `/me/profile`.
- HealthKit sync can only import into the authenticated user's linked self profile.
- Manual readings can still be logged for any family profile by active family members, per existing Phase 1 permissions.

## Tests

- Backend:
  - bootstrap creates `personal` workspace for brand-new user.
  - bootstrap is idempotent.
  - bootstrap returns `needsProfileSetup = true` when no linked self profile exists.
  - `/me/profile` creates linked self profile.
  - `/me/profile` returns existing linked self profile idempotently.
  - `/people` remains manager-only.
  - first invite from personal workspace converts workspace to `family`.
  - invite acceptance works for user with no workspace.
  - invite acceptance rejects user with active `family` workspace.
  - invite acceptance switches safe empty `personal` workspace.
  - invite acceptance rejects unsafe `personal` workspace with manual readings/reminders.
  - HealthKit import rejects when no linked self profile exists.
  - HealthKit import uses linked self profile only.
  - RLS allows self-profile insert and blocks arbitrary member profile insert.
- iOS:
  - signed-in new user routes to profile setup.
  - user with self profile routes to Home.
  - pending invite is accepted before bootstrap.
  - Home defaults to self profile.
  - profile picker hidden for one profile.
  - profile picker visible for multiple profiles.
  - reading sheets default to self profile.
  - HealthKit screen syncs only to self profile.
  - personal Family tab shows solo sharing state.

## Assumptions

- Solo mode is not a separate app mode.
- A one-person `personal` family is the internal workspace for individual use.
- Inviting family converts the workspace from `personal` to `family`.
- HealthKit never syncs into another person's profile from the current user's phone.
- First self-profile setup only collects name; date of birth can be added later.
