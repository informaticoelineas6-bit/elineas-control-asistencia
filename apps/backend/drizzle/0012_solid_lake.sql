CREATE TABLE "attendance_absence_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"date" date NOT NULL,
	"is_justified" boolean NOT NULL,
	"notes" text,
	"reviewed_by" uuid NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_absence_reviews_user_date_key" UNIQUE("user_id","date")
);
--> statement-breakpoint
CREATE TABLE "payroll_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"currency" text DEFAULT 'CUP' NOT NULL,
	"category" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"source_type" text,
	"source_id" uuid,
	"effective_period" date NOT NULL,
	"created_by" uuid,
	"reverted_by" uuid,
	"reverted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendance_absence_reviews" ADD CONSTRAINT "attendance_absence_reviews_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_absence_reviews_user_date_idx" ON "attendance_absence_reviews" USING btree ("user_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_adjustments_active_source_idx" ON "payroll_adjustments" USING btree ("source_type","source_id") WHERE status = 'active' and source_id is not null;--> statement-breakpoint
CREATE INDEX "payroll_adjustments_period_idx" ON "payroll_adjustments" USING btree ("effective_period","user_id");--> statement-breakpoint
CREATE INDEX "payroll_adjustments_user_status_idx" ON "payroll_adjustments" USING btree ("user_id","status");