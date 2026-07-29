CREATE TABLE "notification_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret" text,
	"secret_hint" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_delivered_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"rule_id" uuid,
	"channel_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"throttle_key" text NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"instance_id" uuid,
	"worker_id" uuid,
	"job_uuid" uuid,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"instance_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"job_name_contains" text,
	"channel_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"throttle_minutes" integer DEFAULT 60 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_instance_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"instance_name" text NOT NULL,
	"server_address" text NOT NULL,
	"auth_mode" text DEFAULT 'integrated' NOT NULL,
	"login_name" text,
	"credential_ciphertext" text,
	"credential_key_fingerprint" text,
	"credential_updated_at" timestamp with time zone,
	"credential_updated_by" uuid,
	"encrypt_tls" boolean DEFAULT true NOT NULL,
	"trust_server_certificate" boolean DEFAULT false NOT NULL,
	"environment_tag" text,
	"status" text DEFAULT 'awaiting_credentials' NOT NULL,
	"status_detail" text,
	"status_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "credential_public_key_pem" text;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "credential_key_fingerprint" text;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_event_id_notification_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."notification_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_rule_id_notification_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."notification_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_channel_id_notification_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_instance_configs" ADD CONSTRAINT "worker_instance_configs_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_channels_name_key" ON "notification_channels" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_event_channel_key" ON "notification_deliveries" USING btree ("event_id","channel_id");--> statement-breakpoint
CREATE INDEX "notification_deliveries_next_idx" ON "notification_deliveries" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "notification_deliveries_throttle_idx" ON "notification_deliveries" USING btree ("channel_id","throttle_key","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_events_dedupe_key" ON "notification_events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "notification_events_occurred_idx" ON "notification_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_rules_name_key" ON "notification_rules" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_instance_configs_key" ON "worker_instance_configs" USING btree ("worker_id","instance_name");--> statement-breakpoint
CREATE INDEX "worker_instance_configs_worker_idx" ON "worker_instance_configs" USING btree ("worker_id");