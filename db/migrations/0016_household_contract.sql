-- Pre-launch: dissolve leftover personal workspaces so every user is solo
-- until they create a real family. Persist the pending invite token so the
-- creator can recopy the live HTTPS link after refresh.
--> statement-breakpoint
ALTER TABLE family_invites ADD COLUMN IF NOT EXISTS share_token text;
--> statement-breakpoint
UPDATE people
SET family_id = null, updated_at = now()
WHERE family_id IN (SELECT id FROM families WHERE kind = 'personal');
--> statement-breakpoint
UPDATE family_memberships
SET status = 'removed', updated_at = now()
WHERE status = 'active'
  AND family_id IN (SELECT id FROM families WHERE kind = 'personal');
--> statement-breakpoint
DELETE FROM families WHERE kind = 'personal';
