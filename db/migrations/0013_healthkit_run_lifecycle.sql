-- HealthKit run lifecycle: explicit initial-history completion markers.
-- Additive only. `needsInitialImport` is derived from these columns matching the
-- active installation and current timezone version; it is never inferred from
-- the attempt status label alone.

ALTER TABLE healthkit_sync_state
  ADD COLUMN IF NOT EXISTS history_import_completed_at timestamptz;
--> statement-breakpoint
ALTER TABLE healthkit_sync_state
  ADD COLUMN IF NOT EXISTS history_import_installation_id uuid;
--> statement-breakpoint
ALTER TABLE healthkit_sync_state
  ADD COLUMN IF NOT EXISTS history_import_timezone_version integer;
--> statement-breakpoint
ALTER TABLE healthkit_sync_state
  DROP CONSTRAINT IF EXISTS healthkit_sync_state_history_tz_version_check;
--> statement-breakpoint
ALTER TABLE healthkit_sync_state
  ADD CONSTRAINT healthkit_sync_state_history_tz_version_check
  CHECK (history_import_timezone_version IS NULL OR history_import_timezone_version >= 1);
--> statement-breakpoint

-- Existing groups that already completed a full import keep that completion:
-- mark history complete for rows that reached `ready` under the still-active
-- installation and current timezone version.
UPDATE healthkit_sync_state s
SET history_import_completed_at = s.last_successful_at,
    history_import_installation_id = i.installation_id,
    history_import_timezone_version = p.health_timezone_version,
    updated_at = now()
FROM healthkit_sync_profile_settings p
JOIN healthkit_sync_installations i
  ON i.person_id = p.person_id AND i.revoked_at IS NULL
WHERE p.person_id = s.person_id
  AND s.status = 'ready'
  AND s.last_successful_at IS NOT NULL;
