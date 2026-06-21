create table if not exists blood_pressure_readings (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  person_id uuid not null references people(id) on delete cascade,
  recorded_by_user_id uuid not null references auth.users(id),
  systolic integer not null check (systolic between 50 and 260),
  diastolic integer not null check (diastolic between 30 and 180),
  pulse integer check (pulse between 30 and 220),
  measured_at timestamptz not null,
  context text,
  notes text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index bp_family_person_measured_idx
  on blood_pressure_readings (family_id, person_id, measured_at desc)
  where deleted_at is null;

alter table blood_pressure_readings enable row level security;

create policy bp_select_active_member on blood_pressure_readings
  for select
  using (
    deleted_at is null
    and exists (
      select 1
      from family_memberships fm
      where fm.family_id = blood_pressure_readings.family_id
        and fm.user_id = auth.uid()
        and fm.status = 'active'
    )
  );

create policy bp_insert_active_member on blood_pressure_readings
  for insert
  with check (
    recorded_by_user_id = auth.uid()
    and exists (
      select 1
      from family_memberships fm
      where fm.family_id = blood_pressure_readings.family_id
        and fm.user_id = auth.uid()
        and fm.status = 'active'
    )
    and exists (
      select 1
      from people p
      where p.id = blood_pressure_readings.person_id
        and p.family_id = blood_pressure_readings.family_id
        and p.status = 'active'
    )
  );

create policy bp_update_owner_or_manager on blood_pressure_readings
  for update
  using (
    deleted_at is null
    and (
      recorded_by_user_id = auth.uid()
      or exists (
        select 1
        from family_memberships fm
        where fm.family_id = blood_pressure_readings.family_id
          and fm.user_id = auth.uid()
          and fm.role = 'manager'
          and fm.status = 'active'
      )
    )
  )
  with check (
    recorded_by_user_id = auth.uid()
    or exists (
      select 1
      from family_memberships fm
      where fm.family_id = blood_pressure_readings.family_id
        and fm.user_id = auth.uid()
        and fm.role = 'manager'
        and fm.status = 'active'
    )
  );

-- Soft deletes set deleted_at. Direct hard delete remains denied by default RLS.
