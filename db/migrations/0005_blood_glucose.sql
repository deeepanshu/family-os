create table if not exists blood_glucose_readings (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  person_id uuid not null references people(id) on delete cascade,
  recorded_by_user_id uuid not null references auth.users(id),
  value numeric(6,2) not null check (value between 20 and 700),
  unit text not null check (unit = 'mg/dL'),
  context text not null check (context in ('fasting', 'before_meal', 'after_meal', 'bedtime', 'random')),
  measured_at timestamptz not null,
  notes text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index glucose_family_person_measured_idx
  on blood_glucose_readings (family_id, person_id, measured_at desc)
  where deleted_at is null;

alter table blood_glucose_readings enable row level security;

create policy glucose_select_active_member on blood_glucose_readings
  for select
  using (
    deleted_at is null
    and exists (
      select 1 from family_memberships fm
      where fm.family_id = blood_glucose_readings.family_id
        and fm.user_id = auth.uid()
        and fm.status = 'active'
    )
  );

create policy glucose_insert_active_member on blood_glucose_readings
  for insert
  with check (
    recorded_by_user_id = auth.uid()
    and exists (
      select 1 from family_memberships fm
      where fm.family_id = blood_glucose_readings.family_id
        and fm.user_id = auth.uid()
        and fm.status = 'active'
    )
    and exists (
      select 1 from people p
      where p.id = blood_glucose_readings.person_id
        and p.family_id = blood_glucose_readings.family_id
        and p.status = 'active'
    )
  );

create policy glucose_update_owner_or_manager on blood_glucose_readings
  for update
  using (
    deleted_at is null
    and (
      recorded_by_user_id = auth.uid()
      or exists (
        select 1 from family_memberships fm
        where fm.family_id = blood_glucose_readings.family_id
          and fm.user_id = auth.uid()
          and fm.role = 'manager'
          and fm.status = 'active'
      )
    )
  )
  with check (
    recorded_by_user_id = auth.uid()
    or exists (
      select 1 from family_memberships fm
      where fm.family_id = blood_glucose_readings.family_id
        and fm.user_id = auth.uid()
        and fm.role = 'manager'
        and fm.status = 'active'
    )
  );
