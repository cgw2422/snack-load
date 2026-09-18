-- CreateEnum
CREATE TYPE "SyncErrorCategory" AS ENUM ('TRANSIENT', 'VALIDATION', 'MAPPING', 'TAX_MISMATCH', 'AMOUNT_MISMATCH', 'AUTHORIZATION', 'DEPENDENCY', 'EXTERNAL_CONFLICT');

-- CreateEnum
CREATE TYPE "QuickBooksEnvironment" AS ENUM ('SANDBOX', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "CogsBatchStatus" AS ENUM ('DRAFT', 'POSTED', 'VOIDED');

-- AlterEnum
BEGIN;
CREATE TYPE "IntegrationStatus_new" AS ENUM ('DISCONNECTED', 'CONNECTING', 'CONNECTED', 'NEEDS_REAUTH', 'ERROR');
ALTER TABLE "public"."integration_connection" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "integration_connection" ALTER COLUMN "status" TYPE "IntegrationStatus_new" USING ("status"::text::"IntegrationStatus_new");
ALTER TYPE "IntegrationStatus" RENAME TO "IntegrationStatus_old";
ALTER TYPE "IntegrationStatus_new" RENAME TO "IntegrationStatus";
DROP TYPE "public"."IntegrationStatus_old";
ALTER TABLE "integration_connection" ALTER COLUMN "status" SET DEFAULT 'DISCONNECTED';
COMMIT;

-- AlterEnum
ALTER TYPE "SyncStatus" ADD VALUE 'BLOCKED_DEPENDENCY';

-- AlterTable
ALTER TABLE "integration_connection" ADD COLUMN     "environment" "QuickBooksEnvironment" NOT NULL DEFAULT 'SANDBOX',
ADD COLUMN     "granted_scope" TEXT,
ADD COLUMN     "last_sync_attempt_at" TIMESTAMP(3),
ADD COLUMN     "oauth_state" TEXT,
ADD COLUMN     "oauth_state_issued_at" TIMESTAMP(3),
ADD COLUMN     "token_rotated_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "sync_job" ADD COLUMN     "blocked_on_job_id" TEXT,
ADD COLUMN     "error_category" "SyncErrorCategory",
ADD COLUMN     "error_code" TEXT,
ADD COLUMN     "last_attempted_at" TIMESTAMP(3),
ADD COLUMN     "request_id" TEXT,
ADD COLUMN     "source_hash" TEXT;

-- Every job carries an Intuit request id, minted once and reused on retries.
-- Nullable only for the instant it takes to backfill: no rows exist yet, and a
-- job without one could create a duplicate document on its first retry.
UPDATE "sync_job" SET "request_id" = gen_random_uuid()::text WHERE "request_id" IS NULL;
ALTER TABLE "sync_job" ALTER COLUMN "request_id" SET NOT NULL;

-- CreateTable
CREATE TABLE "cogs_journal_batch" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "status" "CogsBatchStatus" NOT NULL DEFAULT 'DRAFT',
    "sales_cogs" DECIMAL(16,4) NOT NULL DEFAULT 0,
    "return_cogs" DECIMAL(16,4) NOT NULL DEFAULT 0,
    "total_cogs" DECIMAL(16,4) NOT NULL DEFAULT 0,
    "source_hash" TEXT NOT NULL,
    "sale_count" INTEGER NOT NULL DEFAULT 0,
    "return_count" INTEGER NOT NULL DEFAULT 0,
    "created_by_user_id" TEXT,
    "posted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cogs_journal_batch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cogs_journal_batch_organization_id_status_idx" ON "cogs_journal_batch"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "cogs_journal_batch_organization_id_period_start_period_end_key" ON "cogs_journal_batch"("organization_id", "period_start", "period_end");

-- CreateIndex
CREATE INDEX "sync_job_organization_id_status_created_at_idx" ON "sync_job"("organization_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "sync_job_organization_id_provider_entity_type_local_id_oper_key" ON "sync_job"("organization_id", "provider", "entity_type", "local_id", "operation");

-- AddForeignKey
ALTER TABLE "sync_job" ADD CONSTRAINT "sync_job_blocked_on_job_id_fkey" FOREIGN KEY ("blocked_on_job_id") REFERENCES "sync_job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cogs_journal_batch" ADD CONSTRAINT "cogs_journal_batch_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cogs_journal_batch" ADD CONSTRAINT "cogs_journal_batch_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

