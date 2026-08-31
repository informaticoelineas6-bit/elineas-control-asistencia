CREATE TABLE "department_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"department_id" uuid NOT NULL,
	"checkin_start_time" time NOT NULL,
	"checkin_end_time" time NOT NULL,
	"checkout_start_time" time NOT NULL,
	"checkout_end_time" time NOT NULL,
	"timezone" text NOT NULL,
	"allow_early_checkin" boolean DEFAULT false NOT NULL,
	"allow_late_checkout" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "department_schedules_department_id_unique" UNIQUE("department_id")
);
--> statement-breakpoint
CREATE TABLE "work_calendar" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"department_id" uuid NOT NULL,
	"date" date NOT NULL,
	"is_workday" boolean NOT NULL,
	"late_tolerance_minutes" integer,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_calendar_department_date_key" UNIQUE("department_id","date")
);
--> statement-breakpoint
ALTER TABLE "department_schedules" ADD CONSTRAINT "department_schedules_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_calendar" ADD CONSTRAINT "work_calendar_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_calendar_department_date_idx" ON "work_calendar" USING btree ("department_id","date");