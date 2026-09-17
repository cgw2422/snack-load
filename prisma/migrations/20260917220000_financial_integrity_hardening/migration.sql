-- CreateEnum
CREATE TYPE "SaleDocumentType" AS ENUM ('INVOICE', 'SALES_RECEIPT');

-- AlterTable
ALTER TABLE "credit_memo" ADD COLUMN     "idempotency_key" TEXT,
ADD COLUMN     "tax_json" JSONB;

-- AlterTable
ALTER TABLE "credit_memo_item" ADD COLUMN     "tax_rate_applied" DECIMAL(9,6) NOT NULL DEFAULT 0,
ADD COLUMN     "taxable_amount" DECIMAL(14,4) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "external_mapping" DROP COLUMN "last_synced_at",
ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "last_attempted_at" TIMESTAMP(3),
ADD COLUMN     "last_error" TEXT,
ADD COLUMN     "last_succeeded_at" TIMESTAMP(3),
ADD COLUMN     "source_hash" TEXT,
ADD COLUMN     "status" "SyncStatus" NOT NULL DEFAULT 'PENDING',
ALTER COLUMN "external_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "sale" ADD COLUMN     "document_type" "SaleDocumentType",
ADD COLUMN     "tax_json" JSONB;

-- Backfill, once. From here on the value is chosen when the sale posts and is
-- never recomputed; this is the only place it is ever derived from state.
UPDATE "sale"
   SET "document_type" = CASE
         WHEN "balance_due" <= 0 AND "amount_paid" >= "total" THEN 'SALES_RECEIPT'::"SaleDocumentType"
         ELSE 'INVOICE'::"SaleDocumentType"
       END
 WHERE "document_type" IS NULL;

ALTER TABLE "sale" ALTER COLUMN "document_type" SET NOT NULL;

-- AlterTable
ALTER TABLE "sale_item" ADD COLUMN     "tax_rate_applied" DECIMAL(9,6) NOT NULL DEFAULT 0,
ADD COLUMN     "taxable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "taxable_amount" DECIMAL(14,4) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "tax_rate" ADD COLUMN     "code" TEXT,
ADD COLUMN     "jurisdiction" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "credit_memo_organization_id_idempotency_key_key" ON "credit_memo"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "external_mapping_organization_id_provider_status_idx" ON "external_mapping"("organization_id", "provider", "status");


-- Backfill the tax facts that posted documents were not carrying. Rows written
-- from here on get these at post time; this reconstructs what can be
-- reconstructed for rows written before, and nothing more.
UPDATE "sale_item"
   SET "taxable"        = ("tax_amount" > 0),
       "taxable_amount" = CASE WHEN "tax_amount" > 0 THEN "line_subtotal" - "discount_amount" ELSE 0 END,
       "tax_rate_applied" = CASE
         WHEN "tax_amount" > 0 AND ("line_subtotal" - "discount_amount") > 0
           THEN ROUND("tax_amount" / ("line_subtotal" - "discount_amount"), 6)
         ELSE 0
       END;

UPDATE "credit_memo_item"
   SET "taxable_amount" = CASE WHEN "tax_amount" > 0 THEN "line_subtotal" - "discount_amount" ELSE 0 END,
       "tax_rate_applied" = CASE
         WHEN "tax_amount" > 0 AND ("line_subtotal" - "discount_amount") > 0
           THEN ROUND("tax_amount" / ("line_subtotal" - "discount_amount"), 6)
         ELSE 0
       END;
