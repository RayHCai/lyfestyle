-- AlterTable
ALTER TABLE "automation_deploys" ADD COLUMN     "origin" TEXT NOT NULL DEFAULT 'chat',
ADD COLUMN     "run_id" UUID;

-- AlterTable
ALTER TABLE "conversations" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "page_views" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "pages" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "runs" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- CreateIndex
CREATE INDEX "pages_deleted_idx" ON "pages"("deleted_at");

-- AddForeignKey
ALTER TABLE "automation_deploys" ADD CONSTRAINT "automation_deploys_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

