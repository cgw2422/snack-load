-- Returns and credit memos were scaffolded in the Phase 1 schema and never
-- written to: both tables are empty in every environment. Rather than patching
-- a half-built shape into the one this phase needs — a per-line disposition, a
-- credit memo with its own snapshotted lines, a refund document — the four
-- tables and their three enums are dropped and rebuilt below. This is safe
-- precisely because nothing has ever used them.
DROP TABLE IF EXISTS "sales_return_item" CASCADE;
DROP TABLE IF EXISTS "credit_memo_application" CASCADE;
DROP TABLE IF EXISTS "sales_return" CASCADE;
DROP TABLE IF EXISTS "credit_memo" CASCADE;
DROP TYPE IF EXISTS "ReturnDisposition" CASCADE;
DROP TYPE IF EXISTS "ReturnFinancialAction" CASCADE;
DROP TYPE IF EXISTS "CreditMemoStatus" CASCADE;
-- CreateEnum
CREATE TYPE "ReturnDisposition" AS ENUM ('RESTOCK_TRUCK', 'RESTOCK_WAREHOUSE', 'DAMAGED', 'EXPIRED', 'SUPPLIER_RETURN', 'NONE');

-- CreateEnum
CREATE TYPE "ReturnFinancialAction" AS ENUM ('APPLY_TO_BALANCE', 'ACCOUNT_CREDIT', 'REFUND', 'NONE');

-- CreateEnum
CREATE TYPE "CreditMemoStatus" AS ENUM ('OPEN', 'APPLIED', 'VOIDED');

-- CreateEnum
CREATE TYPE "CreditApplicationStatus" AS ENUM ('APPLIED', 'REVERSED');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('POSTED', 'VOIDED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "InventoryLocationKind" ADD VALUE 'DAMAGED_HOLD';
ALTER TYPE "InventoryLocationKind" ADD VALUE 'EXPIRED_HOLD';
ALTER TYPE "InventoryLocationKind" ADD VALUE 'SUPPLIER_RETURN_HOLD';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "InventoryTransactionType" ADD VALUE 'CUSTOMER_RETURN_SELLABLE';
ALTER TYPE "InventoryTransactionType" ADD VALUE 'CUSTOMER_RETURN_DAMAGED';
ALTER TYPE "InventoryTransactionType" ADD VALUE 'CUSTOMER_RETURN_EXPIRED';
ALTER TYPE "InventoryTransactionType" ADD VALUE 'CUSTOMER_RETURN_SUPPLIER';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ReturnReason" ADD VALUE 'PRICING_ERROR';
ALTER TYPE "ReturnReason" ADD VALUE 'DELIVERY_ERROR';

-- AlterTable
ALTER TABLE "inventory_location" ADD COLUMN     "sellable" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "receipt_delivery" ADD COLUMN     "credit_memo_id" TEXT,
ALTER COLUMN "sale_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "receipt_share_link" ADD COLUMN     "credit_memo_id" TEXT,
ALTER COLUMN "sale_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "sales_return" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "return_number" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "sale_id" TEXT,
    "route_stop_id" TEXT,
    "created_by_user_id" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" "ReturnReason" NOT NULL,
    "financial_action" "ReturnFinancialAction" NOT NULL,
    "subtotal" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "tax_total" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "status" "ReturnStatus" NOT NULL DEFAULT 'COMPLETED',
    "credit_memo_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "notes" TEXT,
    "voided_at" TIMESTAMP(3),
    "voided_by_user_id" TEXT,
    "void_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_return_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_return_item" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "return_id" TEXT NOT NULL,
    "sale_item_id" TEXT,
    "product_id" TEXT NOT NULL,
    "product_uom_id" TEXT NOT NULL,
    "product_name_snapshot" TEXT NOT NULL,
    "sku_snapshot" TEXT NOT NULL,
    "uom_label_snapshot" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "base_quantity" INTEGER NOT NULL,
    "unit_cost_at_sale" DECIMAL(16,6) NOT NULL DEFAULT 0,
    "disposition" "ReturnDisposition" NOT NULL,
    "reason" "ReturnReason" NOT NULL,
    "location_id" TEXT,
    "inventory_transaction_id" TEXT,

    CONSTRAINT "sales_return_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_memo" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "sale_id" TEXT,
    "issued_by_user_id" TEXT,
    "reason" "ReturnReason" NOT NULL DEFAULT 'OTHER',
    "subtotal" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "discount_total" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "tax_total" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "amount" DECIMAL(14,4) NOT NULL,
    "remaining_amount" DECIMAL(14,4) NOT NULL,
    "refunded_amount" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "status" "CreditMemoStatus" NOT NULL DEFAULT 'OPEN',
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "bill_to_json" JSONB,
    "issuer_json" JSONB,
    "voided_at" TIMESTAMP(3),
    "voided_by_user_id" TEXT,
    "void_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_memo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_memo_item" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "credit_memo_id" TEXT NOT NULL,
    "sale_item_id" TEXT,
    "product_id" TEXT,
    "product_uom_id" TEXT,
    "description_snapshot" TEXT NOT NULL,
    "sku_snapshot" TEXT NOT NULL DEFAULT '',
    "uom_label_snapshot" TEXT NOT NULL DEFAULT '',
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "base_quantity" INTEGER NOT NULL DEFAULT 0,
    "unit_price" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "line_subtotal" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "discount_amount" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "taxable" BOOLEAN NOT NULL DEFAULT false,
    "unit_cost_at_sale" DECIMAL(16,6) NOT NULL DEFAULT 0,
    "reason" "ReturnReason" NOT NULL DEFAULT 'OTHER',
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "credit_memo_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_memo_application" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "credit_memo_id" TEXT NOT NULL,
    "sale_id" TEXT NOT NULL,
    "amount" DECIMAL(14,4) NOT NULL,
    "status" "CreditApplicationStatus" NOT NULL DEFAULT 'APPLIED',
    "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_by_user_id" TEXT,
    "reversed_at" TIMESTAMP(3),

    CONSTRAINT "credit_memo_application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "refund_number" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "credit_memo_id" TEXT NOT NULL,
    "amount" DECIMAL(14,4) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issued_by_user_id" TEXT,
    "reference_number" TEXT,
    "notes" TEXT,
    "status" "RefundStatus" NOT NULL DEFAULT 'POSTED',
    "voided_at" TIMESTAMP(3),
    "voided_by_user_id" TEXT,
    "void_reason" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refund_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sales_return_credit_memo_id_key" ON "sales_return"("credit_memo_id");

-- CreateIndex
CREATE INDEX "sales_return_organization_id_customer_id_occurred_at_idx" ON "sales_return"("organization_id", "customer_id", "occurred_at");

-- CreateIndex
CREATE INDEX "sales_return_organization_id_sale_id_idx" ON "sales_return"("organization_id", "sale_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_return_organization_id_return_number_key" ON "sales_return"("organization_id", "return_number");

-- CreateIndex
CREATE UNIQUE INDEX "sales_return_organization_id_idempotency_key_key" ON "sales_return"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "sales_return_item_return_id_idx" ON "sales_return_item"("return_id");

-- CreateIndex
CREATE INDEX "sales_return_item_organization_id_sale_item_id_idx" ON "sales_return_item"("organization_id", "sale_item_id");

-- CreateIndex
CREATE INDEX "credit_memo_organization_id_customer_id_status_idx" ON "credit_memo"("organization_id", "customer_id", "status");

-- CreateIndex
CREATE INDEX "credit_memo_organization_id_issued_at_idx" ON "credit_memo"("organization_id", "issued_at");

-- CreateIndex
CREATE UNIQUE INDEX "credit_memo_organization_id_number_key" ON "credit_memo"("organization_id", "number");

-- CreateIndex
CREATE INDEX "credit_memo_item_credit_memo_id_idx" ON "credit_memo_item"("credit_memo_id");

-- CreateIndex
CREATE INDEX "credit_memo_item_organization_id_sale_item_id_idx" ON "credit_memo_item"("organization_id", "sale_item_id");

-- CreateIndex
CREATE INDEX "credit_memo_application_credit_memo_id_idx" ON "credit_memo_application"("credit_memo_id");

-- CreateIndex
CREATE INDEX "credit_memo_application_organization_id_sale_id_idx" ON "credit_memo_application"("organization_id", "sale_id");

-- CreateIndex
CREATE INDEX "refund_organization_id_customer_id_issued_at_idx" ON "refund"("organization_id", "customer_id", "issued_at");

-- CreateIndex
CREATE INDEX "refund_organization_id_credit_memo_id_idx" ON "refund"("organization_id", "credit_memo_id");

-- CreateIndex
CREATE UNIQUE INDEX "refund_organization_id_refund_number_key" ON "refund"("organization_id", "refund_number");

-- CreateIndex
CREATE UNIQUE INDEX "refund_organization_id_idempotency_key_key" ON "refund"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "receipt_delivery_organization_id_credit_memo_id_attempted_a_idx" ON "receipt_delivery"("organization_id", "credit_memo_id", "attempted_at");

-- CreateIndex
CREATE INDEX "receipt_share_link_organization_id_credit_memo_id_idx" ON "receipt_share_link"("organization_id", "credit_memo_id");

-- AddForeignKey
ALTER TABLE "receipt_delivery" ADD CONSTRAINT "receipt_delivery_credit_memo_id_fkey" FOREIGN KEY ("credit_memo_id") REFERENCES "credit_memo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_share_link" ADD CONSTRAINT "receipt_share_link_credit_memo_id_fkey" FOREIGN KEY ("credit_memo_id") REFERENCES "credit_memo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature" ADD CONSTRAINT "signature_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "sales_return"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return" ADD CONSTRAINT "sales_return_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return" ADD CONSTRAINT "sales_return_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return" ADD CONSTRAINT "sales_return_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return" ADD CONSTRAINT "sales_return_route_stop_id_fkey" FOREIGN KEY ("route_stop_id") REFERENCES "route_stop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return" ADD CONSTRAINT "sales_return_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return" ADD CONSTRAINT "sales_return_voided_by_user_id_fkey" FOREIGN KEY ("voided_by_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return" ADD CONSTRAINT "sales_return_credit_memo_id_fkey" FOREIGN KEY ("credit_memo_id") REFERENCES "credit_memo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_item" ADD CONSTRAINT "sales_return_item_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_item" ADD CONSTRAINT "sales_return_item_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "sales_return"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_item" ADD CONSTRAINT "sales_return_item_sale_item_id_fkey" FOREIGN KEY ("sale_item_id") REFERENCES "sale_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_item" ADD CONSTRAINT "sales_return_item_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_item" ADD CONSTRAINT "sales_return_item_product_uom_id_fkey" FOREIGN KEY ("product_uom_id") REFERENCES "product_uom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_item" ADD CONSTRAINT "sales_return_item_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "inventory_location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_item" ADD CONSTRAINT "sales_return_item_inventory_transaction_id_fkey" FOREIGN KEY ("inventory_transaction_id") REFERENCES "inventory_transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_memo" ADD CONSTRAINT "credit_memo_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_memo" ADD CONSTRAINT "credit_memo_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_memo" ADD CONSTRAINT "credit_memo_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_memo" ADD CONSTRAINT "credit_memo_issued_by_user_id_fkey" FOREIGN KEY ("issued_by_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_memo" ADD CONSTRAINT "credit_memo_voided_by_user_id_fkey" FOREIGN KEY ("voided_by_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_memo_item" ADD CONSTRAINT "credit_memo_item_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_memo_item" ADD CONSTRAINT "credit_memo_item_credit_memo_id_fkey" FOREIGN KEY ("credit_memo_id") REFERENCES "credit_memo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_memo_item" ADD CONSTRAINT "credit_memo_item_sale_item_id_fkey" FOREIGN KEY ("sale_item_id") REFERENCES "sale_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_memo_item" ADD CONSTRAINT "credit_memo_item_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_memo_item" ADD CONSTRAINT "credit_memo_item_product_uom_id_fkey" FOREIGN KEY ("product_uom_id") REFERENCES "product_uom"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_memo_application" ADD CONSTRAINT "credit_memo_application_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_memo_application" ADD CONSTRAINT "credit_memo_application_credit_memo_id_fkey" FOREIGN KEY ("credit_memo_id") REFERENCES "credit_memo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_memo_application" ADD CONSTRAINT "credit_memo_application_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_memo_application" ADD CONSTRAINT "credit_memo_application_applied_by_user_id_fkey" FOREIGN KEY ("applied_by_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_credit_memo_id_fkey" FOREIGN KEY ("credit_memo_id") REFERENCES "credit_memo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_issued_by_user_id_fkey" FOREIGN KEY ("issued_by_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_voided_by_user_id_fkey" FOREIGN KEY ("voided_by_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
