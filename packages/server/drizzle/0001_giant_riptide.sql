CREATE TABLE "audit_export_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"audit_log_id" uuid NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"secret_hash" text,
	"secret_prefix" text,
	"cert_serial" text,
	"cert_fingerprint" text,
	"cert_pem" text,
	"entra_object_id" text,
	"entra_tenant_id" text,
	"label" text,
	"created_by" uuid,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "enrolment_tokens" ADD COLUMN "credential_mode" text DEFAULT 'token' NOT NULL;--> statement-breakpoint
ALTER TABLE "enrolment_tokens" ADD COLUMN "intended_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "csrf_token_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "identity_provider" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role_from_idp" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_export_queue" ADD CONSTRAINT "audit_export_queue_audit_log_id_audit_log_id_fk" FOREIGN KEY ("audit_log_id") REFERENCES "public"."audit_log"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_credentials" ADD CONSTRAINT "worker_credentials_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_export_queue_next_idx" ON "audit_export_queue" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX "worker_credentials_worker_idx" ON "worker_credentials" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "worker_credentials_mode_idx" ON "worker_credentials" USING btree ("mode");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_credentials_cert_serial_key" ON "worker_credentials" USING btree ("cert_serial");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_credentials_entra_oid_key" ON "worker_credentials" USING btree ("entra_object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_external_id_key" ON "users" USING btree ("external_id");