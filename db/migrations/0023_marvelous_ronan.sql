CREATE TABLE "apple_sign_in_names" (
	"apple_user_id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "apple_sign_in_names" ENABLE ROW LEVEL SECURITY;
