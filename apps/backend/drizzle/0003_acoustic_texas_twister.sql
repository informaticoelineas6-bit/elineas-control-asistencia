CREATE TABLE "employee_compensation" (
	"profile_id" uuid PRIMARY KEY NOT NULL,
	"monthly_salary" numeric(12, 2),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "employee_compensation" ADD CONSTRAINT "employee_compensation_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Traspaso del dato antes de borrar la columna (spec 02 §6a). Añadido a mano
-- sobre lo que generó drizzle-kit: sin esto, la migración perdería los sueldos
-- que ya estuvieran cargados en `profiles`.
INSERT INTO "employee_compensation" ("profile_id", "monthly_salary")
SELECT "id", "monthly_salary" FROM "profiles" WHERE "monthly_salary" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" DROP COLUMN "monthly_salary";
