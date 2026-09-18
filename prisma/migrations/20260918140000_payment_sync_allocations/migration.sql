-- CreateEnum
CREATE TYPE "PaymentSyncRepresentation" AS ENUM ('INVOICE_PAYMENT', 'SALES_RECEIPT', 'UNAPPLIED');

-- CreateTable
CREATE TABLE "payment_sync_allocation" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL DEFAULT 'QUICKBOOKS_ONLINE',
    "payment_id" TEXT NOT NULL,
    "sale_id" TEXT,
    "amount" DECIMAL(14,4) NOT NULL,
    "representation" "PaymentSyncRepresentation" NOT NULL,
    "external_id" TEXT,
    "explanation" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_sync_allocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_sync_allocation_organization_id_payment_id_idx" ON "payment_sync_allocation"("organization_id", "payment_id");

-- AddForeignKey
ALTER TABLE "payment_sync_allocation" ADD CONSTRAINT "payment_sync_allocation_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_sync_allocation" ADD CONSTRAINT "payment_sync_allocation_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_sync_allocation" ADD CONSTRAINT "payment_sync_allocation_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

