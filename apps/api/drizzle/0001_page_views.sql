CREATE TABLE "page_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"origin" text NOT NULL,
	"path" text NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"referrer" text,
	"ip" text,
	"user_agent" text,
	"language" text,
	"props" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "page_views_created_idx" ON "page_views" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "page_views_origin_idx" ON "page_views" USING btree ("origin","created_at");