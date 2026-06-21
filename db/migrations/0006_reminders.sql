create table if not exists reminders (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  subject_person_id uuid references people(id),
  created_by_user_id uuid not null references auth.users(id),
  type text not null check (type in ('generic', 'blood_glucose', 'blood_pressure')),
  title text not null,
  message text not null,
  schedule_kind text not null check (schedule_kind in ('once', 'daily', 'weekly', 'custom_days')),
  time_of_day time,
  timezone text not null,
  days_of_week integer[],
  starts_on date,
  ends_on date,
  enabled boolean not null default true,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists reminder_recipients (
  id uuid primary key default gen_random_uuid(),
  reminder_id uuid not null references reminders(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  enabled boolean not null default true,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  unique (reminder_id, user_id)
);

alter table reminders enable row level security;
alter table reminder_recipients enable row level security;

create policy reminders_select_active_member on reminders for select using (
  deleted_at is null and exists (select 1 from family_memberships fm where fm.family_id = reminders.family_id and fm.user_id = auth.uid() and fm.status = 'active')
);
create policy reminders_insert_active_member on reminders for insert with check (
  created_by_user_id = auth.uid()
  and exists (select 1 from family_memberships fm where fm.family_id = reminders.family_id and fm.user_id = auth.uid() and fm.status = 'active')
  and (subject_person_id is null or exists (select 1 from people p where p.id = reminders.subject_person_id and p.family_id = reminders.family_id and p.status = 'active'))
);
create policy reminders_update_owner_or_manager on reminders for update using (
  deleted_at is null and (
    created_by_user_id = auth.uid()
    or exists (select 1 from family_memberships fm where fm.family_id = reminders.family_id and fm.user_id = auth.uid() and fm.role = 'manager' and fm.status = 'active')
  )
) with check (
  created_by_user_id = auth.uid()
  or exists (select 1 from family_memberships fm where fm.family_id = reminders.family_id and fm.user_id = auth.uid() and fm.role = 'manager' and fm.status = 'active')
);
create policy reminder_recipients_select_active_member on reminder_recipients for select using (
  exists (select 1 from reminders r join family_memberships fm on fm.family_id = r.family_id where r.id = reminder_recipients.reminder_id and fm.user_id = auth.uid() and fm.status = 'active')
);
create policy reminder_recipients_insert_active_member on reminder_recipients for insert with check (
  exists (
    select 1
    from reminders r
    join family_memberships actor on actor.family_id = r.family_id
    join family_memberships recipient on recipient.family_id = r.family_id
    where r.id = reminder_recipients.reminder_id
      and actor.user_id = auth.uid()
      and actor.status = 'active'
      and recipient.user_id = reminder_recipients.user_id
      and recipient.status = 'active'
  )
);
create policy reminder_recipients_update_self on reminder_recipients for update using (
  user_id = auth.uid()
) with check (
  user_id = auth.uid()
);
