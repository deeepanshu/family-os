create table if not exists families (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by_user_id uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists family_memberships (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  role text not null check (role in ('manager', 'member')),
  status text not null check (status in ('active', 'invited', 'removed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index family_memberships_family_user_idx
  on family_memberships (family_id, user_id);

create unique index family_memberships_one_active_family_per_user_idx
  on family_memberships (user_id)
  where status = 'active';

alter table families enable row level security;
alter table family_memberships enable row level security;

create policy families_select_active_member on families
  for select
  using (
    exists (
      select 1
      from family_memberships fm
      where fm.family_id = families.id
        and fm.user_id = auth.uid()
        and fm.status = 'active'
    )
  );

create policy families_insert_self on families
  for insert
  with check (created_by_user_id = auth.uid());

create policy family_memberships_select_active_member on family_memberships
  for select
  using (
    exists (
      select 1
      from family_memberships fm
      where fm.family_id = family_memberships.family_id
        and fm.user_id = auth.uid()
        and fm.status = 'active'
    )
  );

create policy family_memberships_insert_self_manager on family_memberships
  for insert
  with check (
    user_id = auth.uid()
    and role = 'manager'
    and status = 'active'
  );
