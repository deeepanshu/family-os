create table if not exists family_invites (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  invited_by_user_id uuid not null references auth.users(id),
  email text,
  token_hash text not null,
  role text not null check (role in ('manager', 'member')),
  status text not null check (status in ('pending', 'accepted', 'revoked', 'expired')),
  expires_at timestamptz not null,
  accepted_by_user_id uuid references auth.users(id),
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index family_invites_token_hash_idx
  on family_invites (token_hash);

alter table family_invites enable row level security;

create policy family_invites_select_active_member on family_invites
  for select
  using (
    exists (
      select 1
      from family_memberships fm
      where fm.family_id = family_invites.family_id
        and fm.user_id = auth.uid()
        and fm.status = 'active'
    )
  );

create policy family_invites_insert_active_manager on family_invites
  for insert
  with check (
    invited_by_user_id = auth.uid()
    and exists (
      select 1
      from family_memberships fm
      where fm.family_id = family_invites.family_id
        and fm.user_id = auth.uid()
        and fm.role = 'manager'
        and fm.status = 'active'
    )
  );

-- Token lookup and accept flows should be implemented by the backend through
-- security-definer RPCs that take token_hash, verify expiry/status/email, and
-- perform the invite update plus membership insert in one transaction. Direct
-- table policies intentionally do not expose pending invites to non-members.
