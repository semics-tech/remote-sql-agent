CREATE TABLE "agent_log_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"logged_at" timestamp with time zone NOT NULL,
	"severity" text,
	"message" text NOT NULL,
	"process_info" text,
	"dedupe_key" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text,
	"detail" jsonb,
	"remote_address" text
);
--> statement-breakpoint
CREATE TABLE "commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"instance_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"job_uuid" uuid,
	"payload" jsonb NOT NULL,
	"base_definition_hash" text,
	"state" text DEFAULT 'pending_approval' NOT NULL,
	"issued_by" uuid,
	"approved_by" uuid,
	"signature" text,
	"result_code" text,
	"result_detail" text,
	"sql_error_number" integer,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "enrolment_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"host_name" text NOT NULL,
	"created_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by_worker_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"instance_name" text NOT NULL,
	"server_name" text,
	"sql_version" text,
	"sql_edition" text,
	"agent_status" text DEFAULT 'unknown' NOT NULL,
	"environment_tag" text,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_activity" (
	"instance_id" uuid NOT NULL,
	"job_uuid" uuid NOT NULL,
	"state" text NOT NULL,
	"current_step_id" integer,
	"current_step_name" text,
	"started_at" timestamp with time zone,
	"last_executed_step_at" timestamp with time zone,
	"next_scheduled_run_at" timestamp with time zone,
	"last_run_outcome" smallint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_activity_instance_id_job_uuid_pk" PRIMARY KEY("instance_id","job_uuid")
);
--> statement-breakpoint
CREATE TABLE "job_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"job_uuid" uuid NOT NULL,
	"sql_instance_id" bigint NOT NULL,
	"step_id" integer NOT NULL,
	"step_name" text,
	"run_status" smallint NOT NULL,
	"run_datetime" timestamp with time zone NOT NULL,
	"run_duration_seconds" integer DEFAULT 0 NOT NULL,
	"message" text,
	"retries_attempted" integer DEFAULT 0 NOT NULL,
	"server" text,
	"sql_severity" integer DEFAULT 0 NOT NULL,
	"sql_message_id" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"job_uuid" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"definition_hash" text NOT NULL,
	"origin" text NOT NULL,
	"command_id" uuid,
	"created_by" text,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"job_uuid" uuid NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"category_name" text,
	"owner_login_name" text,
	"description" text,
	"current_version_no" integer DEFAULT 0 NOT NULL,
	"current_definition_hash" text,
	"is_drifted" boolean DEFAULT false NOT NULL,
	"drift_detected_at" timestamp with time zone,
	"last_run_status" smallint,
	"last_run_at" timestamp with time zone,
	"last_run_duration_seconds" integer,
	"next_run_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"private_key_pem" text NOT NULL,
	"public_key_pem" text NOT NULL,
	"certificate_pem" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"remote_address" text
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"instance_id" uuid PRIMARY KEY NOT NULL,
	"history_high_water_mark" bigint DEFAULT 0 NOT NULL,
	"agent_log_high_water_mark" timestamp with time zone,
	"last_snapshot_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'Viewer' NOT NULL,
	"display_name" text,
	"disabled_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_name" text NOT NULL,
	"cert_serial" text,
	"cert_expires_at" timestamp with time zone,
	"cert_revoked_at" timestamp with time zone,
	"version" text,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_capability_reported" text,
	"connected_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"last_remote_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_log_entries" ADD CONSTRAINT "agent_log_entries_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commands" ADD CONSTRAINT "commands_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commands" ADD CONSTRAINT "commands_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_activity" ADD CONSTRAINT "job_activity_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_history" ADD CONSTRAINT "job_history_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_versions" ADD CONSTRAINT "job_versions_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_log_dedupe_key" ON "agent_log_entries" USING btree ("instance_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "agent_log_time_idx" ON "agent_log_entries" USING btree ("instance_id","logged_at");--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor","at");--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action","at");--> statement-breakpoint
CREATE INDEX "commands_state_idx" ON "commands" USING btree ("state");--> statement-breakpoint
CREATE INDEX "commands_worker_idx" ON "commands" USING btree ("worker_id","state");--> statement-breakpoint
CREATE INDEX "commands_issued_at_idx" ON "commands" USING btree ("issued_at");--> statement-breakpoint
CREATE UNIQUE INDEX "enrolment_tokens_hash_key" ON "enrolment_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "instances_worker_name_key" ON "instances" USING btree ("worker_id","instance_name");--> statement-breakpoint
CREATE UNIQUE INDEX "job_history_instance_sqlid_key" ON "job_history" USING btree ("instance_id","sql_instance_id");--> statement-breakpoint
CREATE INDEX "job_history_job_idx" ON "job_history" USING btree ("instance_id","job_uuid","run_datetime");--> statement-breakpoint
CREATE INDEX "job_history_run_datetime_idx" ON "job_history" USING btree ("run_datetime");--> statement-breakpoint
CREATE INDEX "job_history_status_idx" ON "job_history" USING btree ("run_status","run_datetime");--> statement-breakpoint
CREATE UNIQUE INDEX "job_versions_key" ON "job_versions" USING btree ("instance_id","job_uuid","version_no");--> statement-breakpoint
CREATE INDEX "job_versions_lookup_idx" ON "job_versions" USING btree ("instance_id","job_uuid");--> statement-breakpoint
CREATE INDEX "job_versions_hash_idx" ON "job_versions" USING btree ("definition_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_instance_uuid_key" ON "jobs" USING btree ("instance_id","job_uuid");--> statement-breakpoint
CREATE INDEX "jobs_instance_idx" ON "jobs" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "jobs_name_idx" ON "jobs" USING btree ("name");--> statement-breakpoint
CREATE INDEX "jobs_drift_idx" ON "jobs" USING btree ("is_drifted");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_key" ON "users" USING btree ("username");--> statement-breakpoint
CREATE UNIQUE INDEX "workers_host_name_key" ON "workers" USING btree ("host_name");