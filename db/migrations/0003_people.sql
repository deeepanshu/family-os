create table if not exists people (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  linked_user_id uuid references auth.users(id),
  created_by_user_id uuid not null references auth.users(id),
  display_name text not null,
  relationship_label text,
  date_of_birth date,
  status text not null check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table people enable row level security;

create policy people_select_active_member on people
  for select
  using (
    people.status = 'active'
    and
    exists (
      select 1
      from family_memberships fm
      where fm.family_id = people.family_id
        and fm.user_id = auth.uid()
        and fm.status = 'active'
    )
  );

create policy people_insert_active_manager on people
  for insert
  with check (
    created_by_user_id = auth.uid()
    and exists (
      select 1
      from family_memberships fm
      where fm.family_id = people.family_id
        and fm.user_id = auth.uid()
        and fm.role = 'manager'
        and fm.status = 'active'
    )
  );

create policy people_update_active_manager on people
  for update
  using (
    exists (
      select 1
      from family_memberships fm
      where fm.family_id = people.family_id
        and fm.user_id = auth.uid()
        and fm.role = 'manager'
        and fm.status = 'active'
    )
  )
  with check (
    exists (
      select 1
      from family_memberships fm
      where fm.family_id = people.family_id
        and fm.user_id = auth.uid()
        and fm.role = 'manager'
        and fm.status = 'active'
    )
  );
