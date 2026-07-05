DROP POLICY IF EXISTS family_memberships_select_active_member ON family_memberships;
--> statement-breakpoint
CREATE POLICY family_memberships_select_active_member ON family_memberships
  FOR SELECT
  USING (
    user_id = auth.uid()
    AND status = 'active'
  );
