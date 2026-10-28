-- Jobs (a prompt on a schedule) become automations (approved code on a schedule). Each job carries
-- over with its id as an automation whose code runs the old prompt through ctx.agent, so schedules
-- keep firing and usage stays attributed to it.

-- CreateTable
CREATE TABLE "automations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "schedule" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "code" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "state" JSONB NOT NULL DEFAULT '{}',
    "next_run_at" TIMESTAMPTZ(6),
    "last_run_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_deploys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "automation_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "schedule" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(6),

    CONSTRAINT "automation_deploys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "automation_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "error" TEXT,
    "output" TEXT,
    "logs" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" BIGSERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "source" TEXT,
    "automation_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- Carry jobs over
INSERT INTO "automations" ("id", "name", "schedule", "timezone", "enabled", "code", "next_run_at", "last_run_at", "created_at", "updated_at")
SELECT "id", "name", "schedule", "timezone", "enabled",
       'export default (ctx) => ctx.agent(' || to_json("prompt")::text || ');',
       "next_run_at", "last_run_at", "created_at", "updated_at"
FROM "jobs";

-- DropForeignKey
ALTER TABLE "runs" DROP CONSTRAINT "runs_job_id_jobs_id_fk";

-- DropIndex
DROP INDEX "runs_job_idx";

-- AlterTable
ALTER TABLE "runs" DROP COLUMN "job_id",
ADD COLUMN     "automation_run_id" UUID,
ADD COLUMN     "budget_usd" DOUBLE PRECISION NOT NULL DEFAULT 5;

UPDATE "runs" SET "kind" = 'automation' WHERE "kind" = 'job';

-- AlterTable
ALTER TABLE "usage_records" RENAME COLUMN "job_id" TO "automation_id";

UPDATE "usage_records" SET "kind" = 'automation' WHERE "kind" = 'job';

-- DropTable
DROP TABLE "jobs";

-- CreateIndex
CREATE INDEX "automation_deploys_status_idx" ON "automation_deploys"("status", "created_at");

-- CreateIndex
CREATE INDEX "automation_runs_started_idx" ON "automation_runs"("started_at");

-- CreateIndex
CREATE INDEX "automation_runs_automation_idx" ON "automation_runs"("automation_id", "started_at");

-- CreateIndex
CREATE INDEX "runs_automation_run_idx" ON "runs"("automation_run_id");

-- AddForeignKey
ALTER TABLE "automation_deploys" ADD CONSTRAINT "automation_deploys_automation_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "automations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "automations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_automation_run_id_fkey" FOREIGN KEY ("automation_run_id") REFERENCES "automation_runs"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

