ALTER TABLE "families" ADD CONSTRAINT "families_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "family_memberships" ADD CONSTRAINT "family_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "family_invites" ADD CONSTRAINT "family_invites_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "auth"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "family_invites" ADD CONSTRAINT "family_invites_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "auth"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_linked_user_id_users_id_fk" FOREIGN KEY ("linked_user_id") REFERENCES "auth"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "blood_pressure_readings" ADD CONSTRAINT "blood_pressure_readings_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "auth"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "blood_glucose_readings" ADD CONSTRAINT "blood_glucose_readings_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "auth"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "reminder_recipients" ADD CONSTRAINT "reminder_recipients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "notification_devices" ADD CONSTRAINT "notification_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "auth"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE families ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE family_memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE family_invites ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE people ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE blood_pressure_readings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE blood_glucose_readings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE reminder_recipients ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notification_devices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY families_select_active_member ON families
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM family_memberships fm
      WHERE fm.family_id = families.id
        AND fm.user_id = auth.uid()
        AND fm.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY families_insert_self ON families
  FOR INSERT
  WITH CHECK (created_by_user_id = auth.uid());
--> statement-breakpoint
CREATE POLICY family_memberships_select_active_member ON family_memberships
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM family_memberships fm
      WHERE fm.family_id = family_memberships.family_id
        AND fm.user_id = auth.uid()
        AND fm.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY family_memberships_insert_self_manager ON family_memberships
  FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND role = 'manager'
    AND status = 'active'
  );
--> statement-breakpoint
CREATE POLICY family_invites_select_active_member ON family_invites
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM family_memberships fm
      WHERE fm.family_id = family_invites.family_id
        AND fm.user_id = auth.uid()
        AND fm.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY family_invites_insert_active_manager ON family_invites
  FOR INSERT
  WITH CHECK (
    invited_by_user_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM family_memberships fm
      WHERE fm.family_id = family_invites.family_id
        AND fm.user_id = auth.uid()
        AND fm.role = 'manager'
        AND fm.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY people_select_active_member ON people
  FOR SELECT
  USING (
    people.status = 'active'
    AND EXISTS (
      SELECT 1
      FROM family_memberships fm
      WHERE fm.family_id = people.family_id
        AND fm.user_id = auth.uid()
        AND fm.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY people_insert_active_manager ON people
  FOR INSERT
  WITH CHECK (
    created_by_user_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM family_memberships fm
      WHERE fm.family_id = people.family_id
        AND fm.user_id = auth.uid()
        AND fm.role = 'manager'
        AND fm.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY people_update_active_manager ON people
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM family_memberships fm
      WHERE fm.family_id = people.family_id
        AND fm.user_id = auth.uid()
        AND fm.role = 'manager'
        AND fm.status = 'active'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM family_memberships fm
      WHERE fm.family_id = people.family_id
        AND fm.user_id = auth.uid()
        AND fm.role = 'manager'
        AND fm.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY bp_select_active_member ON blood_pressure_readings
  FOR SELECT
  USING (
    deleted_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM family_memberships fm
      WHERE fm.family_id = blood_pressure_readings.family_id
        AND fm.user_id = auth.uid()
        AND fm.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY bp_insert_active_member ON blood_pressure_readings
  FOR INSERT
  WITH CHECK (
    recorded_by_user_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM family_memberships fm
      WHERE fm.family_id = blood_pressure_readings.family_id
        AND fm.user_id = auth.uid()
        AND fm.status = 'active'
    )
    AND EXISTS (
      SELECT 1
      FROM people p
      WHERE p.id = blood_pressure_readings.person_id
        AND p.family_id = blood_pressure_readings.family_id
        AND p.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY bp_update_owner_or_manager ON blood_pressure_readings
  FOR UPDATE
  USING (
    deleted_at IS NULL
    AND (
      recorded_by_user_id = auth.uid()
      OR EXISTS (
        SELECT 1
        FROM family_memberships fm
        WHERE fm.family_id = blood_pressure_readings.family_id
          AND fm.user_id = auth.uid()
          AND fm.role = 'manager'
          AND fm.status = 'active'
      )
    )
  )
  WITH CHECK (
    recorded_by_user_id = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM family_memberships fm
      WHERE fm.family_id = blood_pressure_readings.family_id
        AND fm.user_id = auth.uid()
        AND fm.role = 'manager'
        AND fm.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY glucose_select_active_member ON blood_glucose_readings
  FOR SELECT
  USING (
    deleted_at IS NULL
    AND EXISTS (
      SELECT 1 FROM family_memberships fm
      WHERE fm.family_id = blood_glucose_readings.family_id
        AND fm.user_id = auth.uid()
        AND fm.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY glucose_insert_active_member ON blood_glucose_readings
  FOR INSERT
  WITH CHECK (
    recorded_by_user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM family_memberships fm
      WHERE fm.family_id = blood_glucose_readings.family_id
        AND fm.user_id = auth.uid()
        AND fm.status = 'active'
    )
    AND EXISTS (
      SELECT 1 FROM people p
      WHERE p.id = blood_glucose_readings.person_id
        AND p.family_id = blood_glucose_readings.family_id
        AND p.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY glucose_update_owner_or_manager ON blood_glucose_readings
  FOR UPDATE
  USING (
    deleted_at IS NULL
    AND (
      recorded_by_user_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM family_memberships fm
        WHERE fm.family_id = blood_glucose_readings.family_id
          AND fm.user_id = auth.uid()
          AND fm.role = 'manager'
          AND fm.status = 'active'
      )
    )
  )
  WITH CHECK (
    recorded_by_user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM family_memberships fm
      WHERE fm.family_id = blood_glucose_readings.family_id
        AND fm.user_id = auth.uid()
        AND fm.role = 'manager'
        AND fm.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY reminders_select_active_member ON reminders
  FOR SELECT
  USING (
    deleted_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM family_memberships fm
      WHERE fm.family_id = reminders.family_id
        AND fm.user_id = auth.uid()
        AND fm.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY reminders_insert_active_member ON reminders
  FOR INSERT
  WITH CHECK (
    created_by_user_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM family_memberships fm
      WHERE fm.family_id = reminders.family_id
        AND fm.user_id = auth.uid()
        AND fm.status = 'active'
    )
    AND (
      subject_person_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM people p
        WHERE p.id = reminders.subject_person_id
          AND p.family_id = reminders.family_id
          AND p.status = 'active'
      )
    )
  );
--> statement-breakpoint
CREATE POLICY reminders_update_owner_or_manager ON reminders
  FOR UPDATE
  USING (
    deleted_at IS NULL
    AND (
      created_by_user_id = auth.uid()
      OR EXISTS (
        SELECT 1
        FROM family_memberships fm
        WHERE fm.family_id = reminders.family_id
          AND fm.user_id = auth.uid()
          AND fm.role = 'manager'
          AND fm.status = 'active'
      )
    )
  )
  WITH CHECK (
    created_by_user_id = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM family_memberships fm
      WHERE fm.family_id = reminders.family_id
        AND fm.user_id = auth.uid()
        AND fm.role = 'manager'
        AND fm.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY reminder_recipients_select_active_member ON reminder_recipients
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM reminders r
      JOIN family_memberships fm ON fm.family_id = r.family_id
      WHERE r.id = reminder_recipients.reminder_id
        AND fm.user_id = auth.uid()
        AND fm.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY reminder_recipients_insert_active_member ON reminder_recipients
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM reminders r
      JOIN family_memberships actor ON actor.family_id = r.family_id
      JOIN family_memberships recipient ON recipient.family_id = r.family_id
      WHERE r.id = reminder_recipients.reminder_id
        AND actor.user_id = auth.uid()
        AND actor.status = 'active'
        AND recipient.user_id = reminder_recipients.user_id
        AND recipient.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY reminder_recipients_update_self ON reminder_recipients
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
--> statement-breakpoint
CREATE POLICY notification_devices_owner_select ON notification_devices
  FOR SELECT
  USING (user_id = auth.uid());
--> statement-breakpoint
CREATE POLICY notification_devices_owner_insert ON notification_devices
  FOR INSERT
  WITH CHECK (user_id = auth.uid());
--> statement-breakpoint
CREATE POLICY notification_devices_owner_delete ON notification_devices
  FOR DELETE
  USING (user_id = auth.uid());
--> statement-breakpoint
CREATE POLICY notification_deliveries_family_member_select ON notification_deliveries
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM reminders r
      JOIN family_memberships fm ON fm.family_id = r.family_id
      WHERE r.id = notification_deliveries.reminder_id
        AND fm.user_id = auth.uid()
        AND fm.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY audit_logs_select_active_member ON audit_logs
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM family_memberships fm
      WHERE fm.family_id = audit_logs.family_id
        AND fm.user_id = auth.uid()
        AND fm.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY audit_logs_insert_active_member ON audit_logs
  FOR INSERT
  WITH CHECK (
    actor_user_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM family_memberships fm
      WHERE fm.family_id = audit_logs.family_id
        AND fm.user_id = auth.uid()
        AND fm.status = 'active'
    )
  );
--> statement-breakpoint
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER families_set_updated_at
BEFORE UPDATE ON families
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER family_memberships_set_updated_at
BEFORE UPDATE ON family_memberships
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER family_invites_set_updated_at
BEFORE UPDATE ON family_invites
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER people_set_updated_at
BEFORE UPDATE ON people
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER blood_pressure_readings_set_updated_at
BEFORE UPDATE ON blood_pressure_readings
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER blood_glucose_readings_set_updated_at
BEFORE UPDATE ON blood_glucose_readings
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER reminders_set_updated_at
BEFORE UPDATE ON reminders
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
