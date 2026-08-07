-- Correctness-first HealthKit ops protocol.
-- Natural-key apply + short-TTL op receipts; drop versioned event/session tables.

CREATE TABLE IF NOT EXISTS healthkit_op_receipts (
  op_id uuid PRIMARY KEY,
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS healthkit_op_receipts_applied_at_idx
  ON healthkit_op_receipts (applied_at);

CREATE INDEX IF NOT EXISTS healthkit_op_receipts_person_idx
  ON healthkit_op_receipts (person_id, applied_at);

-- Allow syncing status (new name for first-import in progress). Keep backfilling for old rows.
ALTER TABLE healthkit_sync_state
  DROP CONSTRAINT IF EXISTS healthkit_sync_state_status_check;

ALTER TABLE healthkit_sync_state
  ADD CONSTRAINT healthkit_sync_state_status_check
  CHECK (status IN ('never_synced', 'syncing', 'ready', 'backfilling', 'error', 'disabled'));

-- Drop old protocol tables (clean cutover).
DROP TABLE IF EXISTS healthkit_backfill_scope_manifests;
DROP TABLE IF EXISTS healthkit_backfill_sessions;
DROP TABLE IF EXISTS healthkit_sync_events;
DROP TABLE IF EXISTS healthkit_sync_entities;
