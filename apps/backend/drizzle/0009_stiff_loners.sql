CREATE TABLE "rest_group_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid,
	"user_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rest_group_members_user_from_key" UNIQUE("user_id","effective_from")
);
--> statement-breakpoint
CREATE TABLE "rest_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"department_id" uuid NOT NULL,
	"name" text NOT NULL,
	"days_of_week" integer[] NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_rest_schedule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"days_of_week" integer[] NOT NULL,
	"effective_from" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_rest_schedule_user_from_key" UNIQUE("user_id","effective_from")
);
--> statement-breakpoint
ALTER TABLE "rest_group_members" ADD CONSTRAINT "rest_group_members_group_id_rest_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."rest_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rest_group_members" ADD CONSTRAINT "rest_group_members_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rest_groups" ADD CONSTRAINT "rest_groups_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_rest_schedule" ADD CONSTRAINT "user_rest_schedule_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rest_group_members_user_from_idx" ON "rest_group_members" USING btree ("user_id","effective_from" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "rest_group_members_group_idx" ON "rest_group_members" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rest_groups_department_name_lower_idx" ON "rest_groups" USING btree ("department_id",lower("name"));--> statement-breakpoint
CREATE INDEX "rest_groups_department_idx" ON "rest_groups" USING btree ("department_id","is_active");--> statement-breakpoint
CREATE INDEX "user_rest_schedule_user_from_idx" ON "user_rest_schedule" USING btree ("user_id","effective_from" DESC NULLS LAST);