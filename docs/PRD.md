# Family OS PRD

## Overview

Family OS is an iOS-only app for managing family needs across multiple facets. Health is the first facet. Phase 1 focuses on blood pressure and blood sugar tracking for family members, with shared family visibility and flexible reminders.

The app is intended for private family use first, distributed through TestFlight.

## Goals

- Let a user sign in with Apple.
- Let a user create and manage a family.
- Let managers create family member health profiles.
- Let active family members record blood pressure readings.
- Let active family members record blood sugar readings.
- Let active family members view family health readings.
- Let users create custom reminders with selected recipients, times, and messages.
- Send push notifications for due reminders.

## Non-Goals For Phase 1

- HealthKit sync.
- Medical record uploads.
- ECG/lab/prescription document storage.
- OCR or AI summaries.
- Medication inventory.
- Android support.
- Web dashboard.
- Clinical decision support or medical diagnosis.

## Target Users

- Family manager: a family member who sets up and administers the family.
- Family member: a user who can view family readings and add their own readings/reminders.
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
- Managers can invite users to join the family in a later iteration.

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
- Basic trends/charts.
- Reminder list.

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
- Edit/delete readings they created.
- Edit/delete reminders they created.

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
- Trend Chart.
- Reminders.
- Create/Edit Reminder.
- Settings.

## Success Criteria For Phase 1

- A user can sign in with Apple.
- A user can create a family and become manager.
- A manager can create at least one profile.
- A family member can add BP and blood sugar readings.
- Family members can view all readings.
- Non-manager users can edit/delete only their own readings/reminders.
- Managers can edit/delete all family data.
- Custom reminders send APNs notifications to selected recipients.
- The backend is reachable at `https://api.deepanshujain.com/health/v1`.

## Future Phases

- HealthKit integration for steps, sleep, heart rate, and other metrics.
- Medical document uploads for ECGs, labs, prescriptions, and reports.
- Supabase Storage-backed file vault.
- Lab result structured entry and charting.
- HealthKit import normalization.
- OCR and AI summaries.
- Missed-reading escalation.
- CSV/PDF export.
- Web dashboard.
