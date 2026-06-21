create table if not exists notification_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  device_token text not null,
  platform text not null check (platform = 'ios'),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (user_id, device_token)
);

create table if not exists notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  reminder_id uuid not null references reminders(id) on delete cascade,
  recipient_user_id uuid not null references auth.users(id),
  status text not null check (status in ('pending', 'sent', 'failed', 'opened')),
  scheduled_for timestamptz not null,
  sent_at timestamptz,
  opened_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);

alter table notification_devices enable row level security;
alter table notification_deliveries enable row level security;

create policy notification_devices_owner_select on notification_devices
  for select using (user_id = auth.uid());
create policy notification_devices_owner_insert on notification_devices
  for insert with check (user_id = auth.uid());
create policy notification_devices_owner_delete on notification_devices
  for delete using (user_id = auth.uid());

create policy notification_deliveries_family_member_select on notification_deliveries
  for select using (
    exists (
      select 1
      from reminders r
      join family_memberships fm on fm.family_id = r.family_id
      where r.id = notification_deliveries.reminder_id
        and fm.user_id = auth.uid()
        and fm.status = 'active'
    )
  );
