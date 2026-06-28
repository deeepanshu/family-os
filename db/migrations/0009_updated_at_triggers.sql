create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists families_set_updated_at on families;
create trigger families_set_updated_at
before update on families
for each row
execute function set_updated_at();

drop trigger if exists family_memberships_set_updated_at on family_memberships;
create trigger family_memberships_set_updated_at
before update on family_memberships
for each row
execute function set_updated_at();

drop trigger if exists family_invites_set_updated_at on family_invites;
create trigger family_invites_set_updated_at
before update on family_invites
for each row
execute function set_updated_at();

drop trigger if exists people_set_updated_at on people;
create trigger people_set_updated_at
before update on people
for each row
execute function set_updated_at();

drop trigger if exists blood_pressure_readings_set_updated_at on blood_pressure_readings;
create trigger blood_pressure_readings_set_updated_at
before update on blood_pressure_readings
for each row
execute function set_updated_at();

drop trigger if exists blood_glucose_readings_set_updated_at on blood_glucose_readings;
create trigger blood_glucose_readings_set_updated_at
before update on blood_glucose_readings
for each row
execute function set_updated_at();

drop trigger if exists reminders_set_updated_at on reminders;
create trigger reminders_set_updated_at
before update on reminders
for each row
execute function set_updated_at();
