CREATE TABLE "attendance_marks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"mark_type" text NOT NULL,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"work_date" date,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"accuracy" double precision NOT NULL,
	"distance_to_center" double precision,
	"inside_geofence" boolean,
	"work_location_id" uuid,
	"department_id" uuid,
	"blocked" boolean DEFAULT false NOT NULL,
	"block_reason" text,
	"is_late" boolean DEFAULT false NOT NULL,
	"late_minutes" integer DEFAULT 0 NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendance_marks" ADD CONSTRAINT "attendance_marks_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_marks" ADD CONSTRAINT "attendance_marks_work_location_id_work_locations_id_fk" FOREIGN KEY ("work_location_id") REFERENCES "public"."work_locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_marks" ADD CONSTRAINT "attendance_marks_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_marks_user_time_idx" ON "attendance_marks" USING btree ("user_id","marked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "attendance_marks_time_idx" ON "attendance_marks" USING btree ("marked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "attendance_marks_user_workdate_idx" ON "attendance_marks" USING btree ("user_id","work_date");--> statement-breakpoint
CREATE INDEX "attendance_marks_department_workdate_idx" ON "attendance_marks" USING btree ("department_id","work_date");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_marks_valid_minute_idx" ON "attendance_marks" USING btree ("user_id","mark_type",date_trunc('minute', "marked_at" at time zone 'UTC')) WHERE not blocked;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_marks_blocked_minute_idx" ON "attendance_marks" USING btree ("user_id","mark_type",date_trunc('minute', "marked_at" at time zone 'UTC')) WHERE blocked;