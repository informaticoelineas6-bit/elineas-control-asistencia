CREATE TABLE "attendance_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"incident_type" text NOT NULL,
	"date" date NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"manager_notes" text,
	"attendance_mark_id" uuid,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendance_incidents" ADD CONSTRAINT "attendance_incidents_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_incidents" ADD CONSTRAINT "attendance_incidents_attendance_mark_id_attendance_marks_id_fk" FOREIGN KEY ("attendance_mark_id") REFERENCES "public"."attendance_marks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_incidents_user_status_idx" ON "attendance_incidents" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "attendance_incidents_date_idx" ON "attendance_incidents" USING btree ("date");--> statement-breakpoint
CREATE INDEX "attendance_incidents_status_date_idx" ON "attendance_incidents" USING btree ("status","date" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_incidents_pending_unique_idx" ON "attendance_incidents" USING btree ("user_id","date","incident_type") WHERE status = 'pending';