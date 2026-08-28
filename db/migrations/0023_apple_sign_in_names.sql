-- Survives account delete. Apple only sends fullName on first Sign in with Apple.
CREATE TABLE apple_sign_in_names (
  apple_user_id text PRIMARY KEY,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE apple_sign_in_names ENABLE ROW LEVEL SECURITY;
