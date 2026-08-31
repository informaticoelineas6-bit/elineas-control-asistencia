CREATE TABLE "work_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"center_lat" double precision NOT NULL,
	"center_lng" double precision NOT NULL,
	"radius_meters" integer NOT NULL,
	"accuracy_threshold" integer NOT NULL,
	"block_on_poor_accuracy" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "selected_work_location_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "work_locations_name_lower_idx" ON "work_locations" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "work_locations_active_idx" ON "work_locations" USING btree ("is_active");--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_selected_work_location_id_work_locations_id_fk" FOREIGN KEY ("selected_work_location_id") REFERENCES "public"."work_locations"("id") ON DELETE set null ON UPDATE no action;