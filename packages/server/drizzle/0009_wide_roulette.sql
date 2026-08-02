CREATE TABLE "agent_log_scrub_configs" (
	"worker_id" uuid PRIMARY KEY NOT NULL,
	"allowed_severities" jsonb DEFAULT '["error","warning","info"]'::jsonb NOT NULL,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "agent_log_scrub_configs" ADD CONSTRAINT "agent_log_scrub_configs_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_log_scrub_configs" ADD CONSTRAINT "agent_log_scrub_configs_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;