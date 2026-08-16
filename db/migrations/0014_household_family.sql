-- Household family: directed join label and one live pending invite.
ALTER TABLE family_memberships
  ADD COLUMN IF NOT EXISTS creator_relationship_label text;
--> statement-breakpoint
ALTER TABLE family_memberships
  DROP CONSTRAINT IF EXISTS family_memberships_creator_relationship_label_check;
--> statement-breakpoint
ALTER TABLE family_memberships
  ADD CONSTRAINT family_memberships_creator_relationship_label_check
  CHECK (
    creator_relationship_label IS NULL
    OR creator_relationship_label IN (
      'Father',
      'Mother',
      'Husband',
      'Wife',
      'Partner',
      'Son',
      'Daughter',
      'Brother',
      'Sister',
      'Grandfather',
      'Grandmother',
      'Grandson',
      'Granddaughter'
    )
  );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS family_invites_one_pending_per_family_idx
  ON family_invites (family_id)
  WHERE status = 'pending';
