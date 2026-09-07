CREATE TABLE "attendance_daily_facts" (
	"user_id" uuid NOT NULL,
	"date" date NOT NULL,
	"department_id" uuid,
	"status" text NOT NULL,
	"absence_code" text,
	"in_timestamp" timestamp with time zone,
	"out_timestamp" timestamp with time zone,
	"late_minutes" integer,
	"worked_minutes" integer,
	"rule_version_id" uuid NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_daily_facts_user_id_date_pk" PRIMARY KEY("user_id","date")
);
--> statement-breakpoint
CREATE TABLE "attendance_rule_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"params" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_rule_versions_version_key" UNIQUE("version")
);
--> statement-breakpoint
CREATE TABLE "report_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"department_id" uuid,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"requested_by" uuid NOT NULL,
	"artifact_bucket" text,
	"artifact_path" text,
	"checksum" text,
	"row_count" integer,
	"duration_ms" integer,
	"error_message" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"rule_version_id" uuid NOT NULL,
	"started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendance_daily_facts" ADD CONSTRAINT "attendance_daily_facts_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_daily_facts" ADD CONSTRAINT "attendance_daily_facts_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_daily_facts" ADD CONSTRAINT "attendance_daily_facts_rule_version_id_attendance_rule_versions_id_fk" FOREIGN KEY ("rule_version_id") REFERENCES "public"."attendance_rule_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_rule_version_id_attendance_rule_versions_id_fk" FOREIGN KEY ("rule_version_id") REFERENCES "public"."attendance_rule_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_daily_facts_department_date_idx" ON "attendance_daily_facts" USING btree ("department_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_rule_versions_active_idx" ON "attendance_rule_versions" USING btree ("is_active") WHERE is_active;--> statement-breakpoint
CREATE UNIQUE INDEX "report_runs_active_unique_idx" ON "report_runs" USING btree ("scope",coalesce("department_id", '00000000-0000-0000-0000-000000000000'::uuid),"period_start") WHERE status in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "report_runs_status_idx" ON "report_runs" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "report_runs_created_idx" ON "report_runs" USING btree ("created_at" DESC NULLS LAST);