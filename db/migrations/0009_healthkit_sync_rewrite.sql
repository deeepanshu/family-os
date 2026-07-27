-- HealthKit sync rewrite: immutable outbox events + backfill sessions.
-- Pre-launch clean cutover; imported HealthKit rows and repair state are discarded.

-- Drop repair protocol tables.
DROP TABLE IF EXISTS healthkit_repair_chunks CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS healthkit_repairs CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS healthkit_sync_receipts CASCADE;
--> statement-breakpoint

-- Discard HealthKit-imported canonical rows (settings / installations retained).
TRUNCATE TABLE health_step_hours;
--> statement-breakpoint
TRUNCATE TABLE health_sleep_days;
--> statement-breakpoint
TRUNCATE TABLE health_daily_metrics;
--> statement-breakpoint
TRUNCATE TABLE health_blood_pressure_readings;
--> statement-breakpoint
TRUNCATE TABLE health_blood_glucose_readings;
--> statement-breakpoint
TRUNCATE TABLE health_workouts;
--> statement-breakpoint

-- Replace repairing / repair_needed with backfilling on sync-state status.
ALTER TABLE healthkit_sync_state DROP CONSTRAINT IF EXISTS health_metric_sync_state_status_check;
--> statement-breakpoint
ALTER TABLE healthkit_sync_state DROP CONSTRAINT IF EXISTS healthkit_sync_state_status_check;
--> statement-breakpoint
UPDATE healthkit_sync_state
SET status = 'never_synced',
    last_error_code = null,
    coverage_start_at = null,
    coverage_end_at = null,
    last_successful_at = null,
    updated_at = now()
WHERE status IN ('repairing', 'repair_needed', 'ready', 'error');
--> statement-breakpoint
ALTER TABLE healthkit_sync_state
  ADD CONSTRAINT healthkit_sync_state_status_check
  CHECK (status IN ('never_synced', 'ready', 'backfilling', 'error', 'disabled'));
--> statement-breakpoint

CREATE TABLE healthkit_sync_events (
  event_id uuid PRIMARY KEY,
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  installation_id uuid NOT NULL,
  entity_key text NOT NULL,
  entity_version integer NOT NULL,
  group_key text NOT NULL,
  scope_key text NOT NULL,
  op text NOT NULL,
  session_id uuid,
  fingerprint text NOT NULL,
  apply_result text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT healthkit_sync_events_version_check CHECK (entity_version >= 1),
  CONSTRAINT healthkit_sync_events_op_check CHECK (op IN ('upsert', 'delete')),
  CONSTRAINT healthkit_sync_events_apply_check CHECK (apply_result IN ('applied', 'superseded', 'duplicate')),
  CONSTRAINT healthkit_sync_events_group_check CHECK (
    group_key IN (
      'activity', 'sleep', 'vitals', 'body', 'mobility',
      'workouts', 'mindfulness_environment', 'nutrition'
    )
  )
);
--> statement-breakpoint
CREATE INDEX healthkit_sync_events_person_received_idx
  ON healthkit_sync_events (person_id, received_at);
--> statement-breakpoint
CREATE INDEX healthkit_sync_events_session_scope_idx
  ON healthkit_sync_events (session_id, scope_key)
  WHERE session_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX healthkit_sync_events_retention_idx
  ON healthkit_sync_events (received_at);
--> statement-breakpoint

CREATE TABLE healthkit_sync_entities (
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  installation_id uuid NOT NULL,
  entity_key text NOT NULL,
  entity_version integer NOT NULL,
  fingerprint text NOT NULL,
  op text NOT NULL,
  last_event_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, installation_id, entity_key),
  CONSTRAINT healthkit_sync_entities_version_check CHECK (entity_version >= 1),
  CONSTRAINT healthkit_sync_entities_op_check CHECK (op IN ('upsert', 'delete'))
);
--> statement-breakpoint
CREATE INDEX healthkit_sync_entities_person_group_idx
  ON healthkit_sync_entities (person_id, installation_id);
--> statement-breakpoint

CREATE TABLE healthkit_backfill_sessions (
  session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  group_key text NOT NULL,
  installation_id uuid NOT NULL,
  timezone_version integer NOT NULL,
  range_start timestamptz NOT NULL,
  range_end timestamptz NOT NULL,
  range_start_day date NOT NULL,
  range_end_day date NOT NULL,
  required_scope_keys text[] NOT NULL,
  status text NOT NULL DEFAULT 'open',
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  aborted_at timestamptz,
  abort_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT healthkit_backfill_sessions_group_check CHECK (
    group_key IN (
      'activity', 'sleep', 'vitals', 'body', 'mobility',
      'workouts', 'mindfulness_environment', 'nutrition'
    )
  ),
  CONSTRAINT healthkit_backfill_sessions_tz_check CHECK (timezone_version >= 1),
  CONSTRAINT healthkit_backfill_sessions_day_order_check CHECK (range_start_day <= range_end_day),
  CONSTRAINT healthkit_backfill_sessions_status_check CHECK (
    status IN ('open', 'completing', 'completed', 'aborted', 'expired')
  )
);
--> statement-breakpoint
CREATE INDEX healthkit_backfill_sessions_person_group_idx
  ON healthkit_backfill_sessions (person_id, group_key, created_at);
--> statement-breakpoint

CREATE TABLE healthkit_backfill_scope_manifests (
  session_id uuid NOT NULL REFERENCES healthkit_backfill_sessions(session_id) ON DELETE CASCADE,
  scope_key text NOT NULL,
  event_count integer NOT NULL,
  manifest_hash text NOT NULL,
  status text NOT NULL DEFAULT 'accepted',
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, scope_key),
  CONSTRAINT healthkit_backfill_scope_manifests_count_check CHECK (event_count >= 0),
  CONSTRAINT healthkit_backfill_scope_manifests_status_check CHECK (status IN ('accepted'))
);
--> statement-breakpoint
