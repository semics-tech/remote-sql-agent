CREATE TABLE "environment_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"subject_label" text,
	"environment_tag" text NOT NULL,
	"role" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "identity_groups" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "identity_groups_truncated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "environment_grants_subject_env_key" ON "environment_grants" USING btree ("subject_kind","subject_key","environment_tag");--> statement-breakpoint
CREATE INDEX "environment_grants_subject_idx" ON "environment_grants" USING btree ("subject_kind","subject_key");