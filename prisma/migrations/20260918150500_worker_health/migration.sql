-- AlterTable
ALTER TABLE "integration_connection" ADD COLUMN     "last_worker_id" TEXT,
ADD COLUMN     "last_worker_run_at" TIMESTAMP(3);

