-- CreateEnum
CREATE TYPE "DeliveryChannel" AS ENUM ('EMAIL', 'SMS', 'LINK', 'PRINT', 'DOWNLOAD');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "receipt_delivery" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "sale_id" TEXT NOT NULL,
    "channel" "DeliveryChannel" NOT NULL,
    "destination" TEXT,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "provider" TEXT,
    "provider_message_id" TEXT,
    "failure_reason" TEXT,
    "sent_by_user_id" TEXT,
    "share_link_id" TEXT,
    "attempted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "receipt_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_share_link" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "sale_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "last_viewed_at" TIMESTAMP(3),
    "view_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "receipt_share_link_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "receipt_delivery_organization_id_sale_id_attempted_at_idx" ON "receipt_delivery"("organization_id", "sale_id", "attempted_at");

-- CreateIndex
CREATE INDEX "receipt_delivery_organization_id_status_attempted_at_idx" ON "receipt_delivery"("organization_id", "status", "attempted_at");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_share_link_token_hash_key" ON "receipt_share_link"("token_hash");

-- CreateIndex
CREATE INDEX "receipt_share_link_organization_id_sale_id_idx" ON "receipt_share_link"("organization_id", "sale_id");

-- AddForeignKey
ALTER TABLE "receipt_delivery" ADD CONSTRAINT "receipt_delivery_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_delivery" ADD CONSTRAINT "receipt_delivery_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_delivery" ADD CONSTRAINT "receipt_delivery_sent_by_user_id_fkey" FOREIGN KEY ("sent_by_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_delivery" ADD CONSTRAINT "receipt_delivery_share_link_id_fkey" FOREIGN KEY ("share_link_id") REFERENCES "receipt_share_link"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_share_link" ADD CONSTRAINT "receipt_share_link_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_share_link" ADD CONSTRAINT "receipt_share_link_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_share_link" ADD CONSTRAINT "receipt_share_link_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
