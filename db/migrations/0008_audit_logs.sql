create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  actor_user_id uuid references auth.users(id),
  action text not null,
  resource_type text not null,
  resource_id uuid not null,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_logs_family_created_idx on audit_logs (family_id, created_at desc);
create index if not exists audit_logs_resource_idx on audit_logs (resource_type, resource_id);

alter table audit_logs enable row level security;

create policy audit_logs_select_active_member on audit_logs for select using (
  exists (
    select 1
    from family_memberships fm
    where fm.family_id = audit_logs.family_id
      and fm.user_id = auth.uid()
      and fm.status = 'active'
  )
);

create policy audit_logs_insert_active_member on audit_logs for insert with check (
  actor_user_id = auth.uid()
  and exists (
    select 1
    from family_memberships fm
    where fm.family_id = audit_logs.family_id
      and fm.user_id = auth.uid()
      and fm.status = 'active'
  )
);
