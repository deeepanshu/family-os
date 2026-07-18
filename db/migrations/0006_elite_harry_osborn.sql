CREATE TABLE "mcp_connection_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"oauth_client_id" text NOT NULL,
	"capabilities" text[] NOT NULL,
	"consent_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_connection_grants_capabilities_check" CHECK (cardinality("mcp_connection_grants"."capabilities") > 0 and "mcp_connection_grants"."capabilities" <@ array['health_read']::text[])
);
--> statement-breakpoint
CREATE INDEX "mcp_connection_grants_user_client_idx" ON "mcp_connection_grants" USING btree ("user_id","oauth_client_id");--> statement-breakpoint
CREATE INDEX "mcp_connection_grants_user_created_idx" ON "mcp_connection_grants" USING btree ("user_id","created_at");