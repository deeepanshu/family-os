# Family OS Ask

## Overview

Family OS is an iOS-only app for managing family needs across multiple facets. Health is the first facet. Phase 1 focuses on blood pressure and blood sugar tracking for family members, with shared family visibility and flexible reminders.

The app is intended for private family use first, distributed through TestFlight.

## Goals

- Let a user sign in with Apple.
- Let a user create and manage a family.
- Let managers create family member health profiles.
- Let managers invite family members from day one.
- Let active family members record blood pressure readings.
- Let active family members record blood sugar readings.
- Let active family members view family health readings.
- Let users create custom reminders with selected recipients, times, and messages.
- Send push notifications for due reminders.

## Non-Goals For Phase 1

- Medical record uploads.
- ECG/lab/prescription document storage.
- OCR or AI summaries.
- Medication inventory.
- Android support.
- Web dashboard.
- Clinical decision support or medical diagnosis.
- Direct third-party health app integrations. Third-party apps should sync into
  Apple Health first; Family OS imports from HealthKit only.

## Target Users

- Family manager: a family member who sets up and administers the family.
- Family member: a user who can view family readings and add readings/reminders for any person in the family.
- Health profile subject: a person whose readings are tracked. This may or may not be a logged-in user.

## Phase 1 Scope

### Authentication

- Users sign in with Apple.
- Supabase Auth manages sessions and user identity.
- The iOS app sends the Supabase access token to the backend for authenticated API calls.

### Family Setup

- An authenticated user can create a family.
- The creator becomes a family manager.
- Managers can add/edit/delete family member health profiles.
- Managers can invite users to join the family.
- Phase 1 is multi-user from day one.

### Health Profiles

A health profile represents a person in the family.

Profiles support:

- Name.
- Relationship label.
- Optional date of birth or age.
- Active/inactive status.

### Blood Pressure Readings

Users can record:

- Person/profile.
- Systolic pressure in mmHg.
- Diastolic pressure in mmHg.
- Optional pulse.
- Measurement timestamp.
- Optional context.
- Optional notes.

### Blood Sugar Readings

Users can record:

- Person/profile.
- Glucose value.
- Unit: `mg/dL` for Phase 1.
- Measurement timestamp.
- Context:
  - `fasting`
  - `before_meal`
  - `after_meal`
  - `bedtime`
  - `random`
- Optional notes.

### Viewing

Users can view:

- Family dashboard.
- Latest BP and blood sugar readings per profile.
- Reading history by profile.
- Reminder list.

Charts are deferred. Phase 1 ships with latest values and history lists first.

### Reminders

Users can create custom reminders.

Reminder fields:

- Subject person/profile, optional.
- Type:
  - `generic`
  - `blood_glucose`
  - `blood_pressure`
- Custom title.
- Custom message.
- Selected recipients.
- Time of day.
- Timezone.
- Repeat schedule:
  - once
  - daily
  - weekly
  - selected days
- Enabled/disabled state.

When a reminder is due, the backend sends APNs push notifications to selected recipients.

Reminder behavior:

- Any active family member can create a reminder for any family profile.
- Any active family member can select any active family member as a recipient.
- Recipients can disable reminders for themselves.
- Tapping a reminder notification opens the relevant logging screen with person and context prefilled when available.
- Reminders are visible to active family members.

## Permissions

### Family Manager

A family manager can view, add, edit, and delete everything inside the family.

This includes:

- Family settings.
- Memberships.
- Profiles.
- Blood pressure readings.
- Blood sugar readings.
- Reminders.
- Reminder recipients.

### Active Family Member

An active family member can:

- View all family data.
- Create blood pressure readings.
- Create blood sugar readings.
- Create reminders.
- Create readings/reminders for any person in the family.
- Edit/delete readings they created.
- Edit/delete reminders they created.
- Disable reminders for themselves.

An active family member cannot:

- Edit/delete readings created by others unless they are a manager.
- Edit/delete reminders created by others unless they are a manager.
- Manage family membership or roles.
- Manage profiles unless they are a manager.

## Product Screens

- Sign In.
- Family Setup.
- Family Dashboard.
- Profile Detail.
- Add Blood Pressure Reading.
- Add Blood Sugar Reading.
- Reading History.
- Reminders.
- Create/Edit Reminder.
- Settings.

## Success Criteria For Phase 1

- A user can sign in with Apple.
- A user can create a family and become manager.
- A manager can create at least one profile.
- A manager can invite another user to the family.
- An invited user can join the family.
- A family member can add BP and blood sugar readings for any family profile.
- Family members can view all readings.
- Non-manager users can edit/delete only their own readings/reminders.
- Managers can edit/delete all family data.
- Custom reminders send APNs notifications to selected recipients.
- Recipients can disable reminder notifications for themselves.
- Tapping a reminder opens the relevant add-reading screen when the reminder type is BP or blood sugar.
- Deleted readings and reminders disappear from normal app views.
- Phase 1 is online-only.
- The backend is reachable at `https://api.deepanshujain.me/health/v1`.
- A user can import HealthKit readings for their own linked profile.

## Future Phases

- HealthKit integration for heart rate and additional metrics beyond steps,
  walking distance, sleep, BP, blood sugar, and weight.
- Medical document uploads for ECGs, labs, prescriptions, and reports.
- Supabase Storage-backed file vault.
- Lab result structured entry and charting.
- OCR and AI summaries.
- Missed-reading escalation.
- Offline entry and sync.
- Basic trends/charts for BP and glucose.
- CSV/PDF export.
- Web dashboard.
