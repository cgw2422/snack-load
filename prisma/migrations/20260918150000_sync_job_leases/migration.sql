-- AlterTable
ALTER TABLE "sync_job" ADD COLUMN     "lease_expires_at" TIMESTAMP(3),
ADD COLUMN     "lease_owner" TEXT,
ADD COLUMN     "reclaimed_count" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "sync_job_status_lease_expires_at_idx" ON "sync_job"("status", "lease_expires_at");

