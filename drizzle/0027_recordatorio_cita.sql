ALTER TABLE "booking" ADD COLUMN "reminder_at" timestamp;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "reminder_status" text;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "reminder_error" text;--> statement-breakpoint
ALTER TABLE "calendar_settings" ADD COLUMN "reminder_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_settings" ADD COLUMN "reminder_text" text;--> statement-breakpoint
ALTER TABLE "calendar_settings" ADD COLUMN "reminder_template_id" text;--> statement-breakpoint
ALTER TABLE "calendar_settings" ADD CONSTRAINT "calendar_settings_reminder_template_id_template_id_fk" FOREIGN KEY ("reminder_template_id") REFERENCES "public"."template"("id") ON DELETE set null ON UPDATE no action;