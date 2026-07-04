ALTER TABLE "families" ADD COLUMN "kind" text DEFAULT 'family' NOT NULL;--> statement-breakpoint
ALTER TABLE "families" ADD CONSTRAINT "families_kind_check" CHECK ("families"."kind" in ('personal', 'family'));
--> statement-breakpoint
CREATE POLICY people_insert_self ON people
  FOR INSERT
  WITH CHECK (
    linked_user_id = auth.uid()
    AND relationship_label = 'Self'
    AND created_by_user_id = auth.uid()
    AND status = 'active'
    AND EXISTS (
      SELECT 1
      FROM family_memberships fm
      WHERE fm.family_id = people.family_id
        AND fm.user_id = auth.uid()
        AND fm.status = 'active'
    )
  );
--> statement-breakpoint
CREATE POLICY families_update_kind_manager ON families
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM family_memberships fm
      WHERE fm.family_id = families.id
        AND fm.user_id = auth.uid()
        AND fm.role = 'manager'
        AND fm.status = 'active'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM family_memberships fm
      WHERE fm.family_id = families.id
        AND fm.user_id = auth.uid()
        AND fm.role = 'manager'
        AND fm.status = 'active'
    )
  );