-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REMOVED');

-- CreateEnum
CREATE TYPE "SessionClient" AS ENUM ('WEB', 'NATIVE', 'API');

-- CreateEnum
CREATE TYPE "UomCode" AS ENUM ('EACH', 'CASE', 'BOX', 'PACK', 'TRAY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "PaymentTerms" AS ENUM ('COD', 'NET7', 'NET15', 'NET30', 'NET60');

-- CreateEnum
CREATE TYPE "InventoryLocationKind" AS ENUM ('WAREHOUSE', 'VEHICLE');

-- CreateEnum
CREATE TYPE "InventoryTransactionType" AS ENUM ('SUPPLIER_RECEIPT', 'TRUCK_LOAD', 'TRUCK_UNLOAD', 'TRANSFER', 'SALE', 'CUSTOMER_RETURN', 'DAMAGE', 'EXPIRED', 'MISSING', 'SAMPLE', 'CORRECTION', 'COUNT_ADJUSTMENT', 'REVERSAL');

-- CreateEnum
CREATE TYPE "TruckLoadDirection" AS ENUM ('LOAD', 'UNLOAD');

-- CreateEnum
CREATE TYPE "TruckLoadStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DayOfWeek" AS ENUM ('MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY');

-- CreateEnum
CREATE TYPE "ScheduleFrequency" AS ENUM ('WEEKLY', 'BIWEEKLY', 'TRIWEEKLY', 'MONTHLY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "RouteStatus" AS ENUM ('PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RouteStopStatus" AS ENUM ('PENDING', 'EN_ROUTE', 'ARRIVED', 'COMPLETED', 'SKIPPED', 'NO_SALE', 'STORE_CLOSED', 'RESCHEDULED');

-- CreateEnum
CREATE TYPE "CloseoutStatus" AS ENUM ('OPEN', 'SUBMITTED', 'APPROVED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "SaleStatus" AS ENUM ('DRAFT', 'COMPLETED', 'VOIDED');

-- CreateEnum
CREATE TYPE "PriceSource" AS ENUM ('STANDARD', 'GROUP', 'CUSTOMER', 'PROMO', 'MANUAL');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CHECK', 'CARD', 'ACH', 'OTHER');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "ReturnReason" AS ENUM ('EXPIRED', 'DAMAGED', 'WRONG_ITEM', 'UNSOLD', 'SWAP', 'OTHER');

-- CreateEnum
CREATE TYPE "ReturnDisposition" AS ENUM ('TRUCK', 'WAREHOUSE', 'DESTROY');

-- CreateEnum
CREATE TYPE "ReturnFinancialAction" AS ENUM ('REFUND', 'ACCOUNT_CREDIT', 'REPLACEMENT', 'CREDIT_MEMO', 'NONE');

-- CreateEnum
CREATE TYPE "ReturnStatus" AS ENUM ('COMPLETED', 'VOIDED');

-- CreateEnum
CREATE TYPE "CreditMemoStatus" AS ENUM ('OPEN', 'APPLIED', 'VOIDED');

-- CreateEnum
CREATE TYPE "ImportType" AS ENUM ('PRODUCTS', 'CUSTOMERS');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('UPLOADED', 'MAPPING', 'VALIDATING', 'PREVIEW', 'IMPORTING', 'COMPLETED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "ImportMode" AS ENUM ('CREATE_ONLY', 'UPDATE_ONLY', 'UPSERT');

-- CreateEnum
CREATE TYPE "ImportMatchKey" AS ENUM ('SKU', 'UPC', 'ACCOUNT_NUMBER', 'NAME');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('PENDING', 'READY', 'WARNING', 'ERROR', 'IMPORTED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ImportRowAction" AS ENUM ('CREATE', 'UPDATE', 'SKIP');

-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('QUICKBOOKS_ONLINE');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('CONNECTED', 'DISCONNECTED', 'EXPIRED', 'ERROR');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'SYNCED', 'FAILED', 'RETRYING', 'NEEDS_ATTENTION');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "NotificationSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateTable
CREATE TABLE "organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "legalName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "country" TEXT NOT NULL DEFAULT 'US',
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "logoUrl" TEXT,
    "receiptFooter" TEXT,
    "status" "OrganizationStatus" NOT NULL DEFAULT 'ACTIVE',
    "plan" TEXT NOT NULL DEFAULT 'standard',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "onboardingJson" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_user" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "passwordAlgo" TEXT NOT NULL DEFAULT 'scrypt',
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phone" TEXT,
    "avatarUrl" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastLoginAt" TIMESTAMP(3),
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "employeeCode" TEXT,
    "defaultVehicleId" TEXT,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permission" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "invitedByUserId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedByUserId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "client" "SessionClient" NOT NULL DEFAULT 'WEB',
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accountNumber" TEXT,
    "contactName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "addressLine1" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "leadTimeDays" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_category" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "upc" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "brand" TEXT,
    "categoryId" TEXT,
    "supplierId" TEXT,
    "baseUomLabel" TEXT NOT NULL DEFAULT 'Each',
    "costPerBaseUnit" DECIMAL(16,6) NOT NULL DEFAULT 0,
    "reorderPointBaseUnits" INTEGER NOT NULL DEFAULT 0,
    "taxable" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "imageUrl" TEXT,
    "weightGrams" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_uom" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "code" "UomCode" NOT NULL,
    "label" TEXT NOT NULL,
    "baseUnitsPerUom" INTEGER NOT NULL,
    "price" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "barcode" TEXT,
    "isBase" BOOLEAN NOT NULL DEFAULT false,
    "isDefaultSaleUom" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "product_uom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rate" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rate" DECIMAL(9,6) NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "tax_rate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_group" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "price_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_group_price" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "priceGroupId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productUomId" TEXT,
    "price" DECIMAL(12,4) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),

    CONSTRAINT "price_group_price_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_price" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productUomId" TEXT,
    "price" DECIMAL(12,4) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),

    CONSTRAINT "customer_price_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentCompany" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "phone" TEXT,
    "email" TEXT,
    "priceGroupId" TEXT,
    "paymentTermsCode" "PaymentTerms" NOT NULL DEFAULT 'COD',
    "creditLimit" DECIMAL(14,4),
    "taxExempt" BOOLEAN NOT NULL DEFAULT false,
    "taxExemptId" TEXT,
    "taxRateId" TEXT,
    "balance" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "deliveryInstructions" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastVisitAt" TIMESTAMP(3),
    "nextDueOn" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_contact" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,

    CONSTRAINT "customer_contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_location" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "InventoryLocationKind" NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "addressLine1" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "truckNumber" TEXT NOT NULL,
    "licensePlate" TEXT,
    "assignedUserId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_balance" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "avgUnitCost" DECIMAL(16,6) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_balance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_transaction" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" "InventoryTransactionType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "reasonCode" TEXT,
    "notes" TEXT,
    "idempotencyKey" TEXT,
    "reversalOfId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_transaction_line" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "quantityDelta" INTEGER NOT NULL,
    "unitCost" DECIMAL(16,6) NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "notes" TEXT,

    CONSTRAINT "inventory_transaction_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receiving" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "supplierId" TEXT,
    "warehouseLocationId" TEXT NOT NULL,
    "referenceNumber" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedByUserId" TEXT,
    "notes" TEXT,
    "inventoryTransactionId" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receiving_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receiving_item" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "receivingId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productUomId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "baseQuantity" INTEGER NOT NULL,
    "unitCost" DECIMAL(16,6) NOT NULL,
    "lineCost" DECIMAL(14,4) NOT NULL,

    CONSTRAINT "receiving_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "truck_load" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "routeId" TEXT,
    "runnerUserId" TEXT,
    "direction" "TruckLoadDirection" NOT NULL DEFAULT 'LOAD',
    "status" "TruckLoadStatus" NOT NULL DEFAULT 'DRAFT',
    "warehouseLocationId" TEXT NOT NULL,
    "loadedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "notes" TEXT,
    "inventoryTransactionId" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "truck_load_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "truck_load_item" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "truckLoadId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productUomId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "baseQuantity" INTEGER NOT NULL,

    CONSTRAINT "truck_load_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_template" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "color" TEXT,
    "dayOfWeek" "DayOfWeek",
    "defaultRunnerUserId" TEXT,
    "defaultVehicleId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "route_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_schedule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "routeTemplateId" TEXT NOT NULL,
    "frequency" "ScheduleFrequency" NOT NULL DEFAULT 'WEEKLY',
    "intervalDays" INTEGER,
    "dayOfWeek" "DayOfWeek" NOT NULL,
    "weekOfCycle" INTEGER,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "windowStart" TEXT,
    "windowEnd" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastServicedOn" DATE,
    "nextDueOn" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "routeTemplateId" TEXT,
    "serviceDate" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "runnerUserId" TEXT NOT NULL,
    "vehicleId" TEXT,
    "status" "RouteStatus" NOT NULL DEFAULT 'PLANNED',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "plannedStops" INTEGER NOT NULL DEFAULT 0,
    "plannedMiles" DECIMAL(9,2),
    "plannedMinutes" INTEGER,
    "actualMiles" DECIMAL(9,2),
    "startOdometer" INTEGER,
    "endOdometer" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "route_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_stop" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status" "RouteStopStatus" NOT NULL DEFAULT 'PENDING',
    "plannedArrivalAt" TIMESTAMP(3),
    "arrivedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "distanceMiles" DECIMAL(9,2),
    "durationMinutes" INTEGER,
    "outcomeReason" TEXT,
    "rescheduledToDate" DATE,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "route_stop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_assignment_history" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "routeStopId" TEXT,
    "fromUserId" TEXT,
    "toUserId" TEXT NOT NULL,
    "reason" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "route_assignment_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_closeout" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "status" "CloseoutStatus" NOT NULL DEFAULT 'OPEN',
    "submittedAt" TIMESTAMP(3),
    "submittedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewedByUserId" TEXT,
    "salesTotal" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "returnsTotal" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "expectedCash" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "actualCash" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "checkTotal" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "cardTotal" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "achTotal" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "onAccountTotal" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "cashVariance" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "route_closeout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_closeout_item" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "closeoutId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "expectedQuantity" INTEGER NOT NULL,
    "countedQuantity" INTEGER,
    "varianceQuantity" INTEGER NOT NULL DEFAULT 0,
    "varianceValue" DECIMAL(14,4) NOT NULL DEFAULT 0,

    CONSTRAINT "route_closeout_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "saleNumber" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "routeId" TEXT,
    "routeStopId" TEXT,
    "soldByUserId" TEXT NOT NULL,
    "status" "SaleStatus" NOT NULL DEFAULT 'DRAFT',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "subtotal" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "discountTotal" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "amountPaid" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "creditsApplied" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "balanceDue" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "dueDate" DATE,
    "paymentTermsCode" "PaymentTerms" NOT NULL DEFAULT 'COD',
    "taxExempt" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "inventoryTransactionId" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedByUserId" TEXT,
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_item" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productUomId" TEXT NOT NULL,
    "productNameSnapshot" TEXT NOT NULL,
    "skuSnapshot" TEXT NOT NULL,
    "uomLabelSnapshot" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "baseQuantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(12,4) NOT NULL,
    "lineSubtotal" DECIMAL(14,4) NOT NULL,
    "discountAmount" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(14,4) NOT NULL,
    "unitCostAtSale" DECIMAL(16,6) NOT NULL DEFAULT 0,
    "priceSource" "PriceSource" NOT NULL DEFAULT 'STANDARD',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "sale_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "receiptNumber" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signatureId" TEXT,
    "pdfPath" TEXT,
    "emailedAt" TIMESTAMP(3),
    "textedAt" TIMESTAMP(3),
    "printedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "saleId" TEXT,
    "returnId" TEXT,
    "signerName" TEXT,
    "imagePng" BYTEA NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deviceInfo" TEXT,

    CONSTRAINT "signature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" DECIMAL(14,4) NOT NULL,
    "unappliedAmount" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedByUserId" TEXT,
    "routeStopId" TEXT,
    "checkNumber" TEXT,
    "referenceNumber" TEXT,
    "processorRef" TEXT,
    "notes" TEXT,
    "status" "PaymentStatus" NOT NULL DEFAULT 'POSTED',
    "reversedAt" TIMESTAMP(3),
    "reversedByUserId" TEXT,
    "reversalOfId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "amount" DECIMAL(14,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_return" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "returnNumber" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "saleId" TEXT,
    "routeStopId" TEXT,
    "createdByUserId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" "ReturnReason" NOT NULL,
    "disposition" "ReturnDisposition" NOT NULL,
    "financialAction" "ReturnFinancialAction" NOT NULL,
    "subtotal" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "status" "ReturnStatus" NOT NULL DEFAULT 'COMPLETED',
    "inventoryTransactionId" TEXT,
    "creditMemoId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_return_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_return_item" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productUomId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "baseQuantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(12,4) NOT NULL,
    "lineTotal" DECIMAL(14,4) NOT NULL,
    "reason" "ReturnReason" NOT NULL,
    "restock" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "sales_return_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_memo" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "amount" DECIMAL(14,4) NOT NULL,
    "remainingAmount" DECIMAL(14,4) NOT NULL,
    "status" "CreditMemoStatus" NOT NULL DEFAULT 'OPEN',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_memo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_memo_application" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "creditMemoId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "amount" DECIMAL(14,4) NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_memo_application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_sequence" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "prefix" TEXT NOT NULL DEFAULT '',
    "nextNumber" INTEGER NOT NULL DEFAULT 1,
    "padTo" INTEGER NOT NULL DEFAULT 5,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_sequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_job" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" "ImportType" NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "storagePath" TEXT,
    "status" "ImportStatus" NOT NULL DEFAULT 'UPLOADED',
    "mode" "ImportMode" NOT NULL DEFAULT 'UPSERT',
    "matchKey" "ImportMatchKey" NOT NULL DEFAULT 'SKU',
    "columnMapJson" JSONB NOT NULL DEFAULT '{}',
    "referenceMapJson" JSONB NOT NULL DEFAULT '{}',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "readyRows" INTEGER NOT NULL DEFAULT 0,
    "warningRows" INTEGER NOT NULL DEFAULT 0,
    "errorRows" INTEGER NOT NULL DEFAULT 0,
    "importedRows" INTEGER NOT NULL DEFAULT 0,
    "skippedRows" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "summaryJson" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_row" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "importJobId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "rawJson" JSONB NOT NULL,
    "normalizedJson" JSONB NOT NULL DEFAULT '{}',
    "status" "ImportRowStatus" NOT NULL DEFAULT 'PENDING',
    "action" "ImportRowAction" NOT NULL DEFAULT 'CREATE',
    "messagesJson" JSONB NOT NULL DEFAULT '[]',
    "targetType" TEXT,
    "targetId" TEXT,

    CONSTRAINT "import_row_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_connection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "realmId" TEXT,
    "companyName" TEXT,
    "accessTokenEncrypted" TEXT,
    "refreshTokenEncrypted" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "refreshExpiresAt" TIMESTAMP(3),
    "connectedByUserId" TEXT,
    "connectedAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "settingsJson" JSONB NOT NULL DEFAULT '{}',
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_mapping" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "entityType" TEXT NOT NULL,
    "localId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "externalSyncToken" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_job" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "entityType" TEXT NOT NULL,
    "localId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "payloadJson" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "sync_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_log" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "syncJobId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "level" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "requestJson" JSONB,
    "responseJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_event" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "type" TEXT NOT NULL,
    "severity" "NotificationSeverity" NOT NULL DEFAULT 'INFO',
    "title" TEXT NOT NULL,
    "body" TEXT,
    "dataJson" JSONB NOT NULL DEFAULT '{}',
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "beforeJson" JSONB,
    "afterJson" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organization_slug_key" ON "organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_email_key" ON "app_user"("email");

-- CreateIndex
CREATE INDEX "app_user_status_idx" ON "app_user"("status");

-- CreateIndex
CREATE INDEX "membership_organizationId_status_idx" ON "membership"("organizationId", "status");

-- CreateIndex
CREATE INDEX "membership_userId_idx" ON "membership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "membership_organizationId_userId_key" ON "membership"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "role_organizationId_idx" ON "role"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "role_organizationId_key_key" ON "role"("organizationId", "key");

-- CreateIndex
CREATE INDEX "role_permission_roleId_idx" ON "role_permission"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "role_permission_roleId_permission_key" ON "role_permission"("roleId", "permission");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_tokenHash_key" ON "invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "invitation_organizationId_email_idx" ON "invitation"("organizationId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "session_tokenHash_key" ON "session"("tokenHash");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "session"("userId");

-- CreateIndex
CREATE INDEX "session_expiresAt_idx" ON "session"("expiresAt");

-- CreateIndex
CREATE INDEX "supplier_organizationId_active_idx" ON "supplier"("organizationId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_organizationId_name_key" ON "supplier"("organizationId", "name");

-- CreateIndex
CREATE INDEX "product_category_organizationId_active_idx" ON "product_category"("organizationId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "product_category_organizationId_name_key" ON "product_category"("organizationId", "name");

-- CreateIndex
CREATE INDEX "product_organizationId_active_idx" ON "product"("organizationId", "active");

-- CreateIndex
CREATE INDEX "product_organizationId_name_idx" ON "product"("organizationId", "name");

-- CreateIndex
CREATE INDEX "product_organizationId_categoryId_idx" ON "product"("organizationId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "product_organizationId_sku_key" ON "product"("organizationId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "product_organizationId_upc_key" ON "product"("organizationId", "upc");

-- CreateIndex
CREATE INDEX "product_uom_organizationId_barcode_idx" ON "product_uom"("organizationId", "barcode");

-- CreateIndex
CREATE UNIQUE INDEX "product_uom_productId_code_key" ON "product_uom"("productId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "tax_rate_organizationId_name_key" ON "tax_rate"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "price_group_organizationId_name_key" ON "price_group"("organizationId", "name");

-- CreateIndex
CREATE INDEX "price_group_price_organizationId_priceGroupId_productId_idx" ON "price_group_price"("organizationId", "priceGroupId", "productId");

-- CreateIndex
CREATE INDEX "customer_price_organizationId_customerId_productId_idx" ON "customer_price"("organizationId", "customerId", "productId");

-- CreateIndex
CREATE INDEX "customer_organizationId_active_name_idx" ON "customer"("organizationId", "active", "name");

-- CreateIndex
CREATE INDEX "customer_organizationId_nextDueOn_idx" ON "customer"("organizationId", "nextDueOn");

-- CreateIndex
CREATE UNIQUE INDEX "customer_organizationId_accountNumber_key" ON "customer"("organizationId", "accountNumber");

-- CreateIndex
CREATE INDEX "customer_contact_organizationId_customerId_idx" ON "customer_contact"("organizationId", "customerId");

-- CreateIndex
CREATE INDEX "inventory_location_organizationId_kind_active_idx" ON "inventory_location"("organizationId", "kind", "active");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_locationId_key" ON "warehouse"("locationId");

-- CreateIndex
CREATE INDEX "warehouse_organizationId_idx" ON "warehouse"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_locationId_key" ON "vehicle"("locationId");

-- CreateIndex
CREATE INDEX "vehicle_organizationId_active_idx" ON "vehicle"("organizationId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_organizationId_truckNumber_key" ON "vehicle"("organizationId", "truckNumber");

-- CreateIndex
CREATE INDEX "inventory_balance_organizationId_productId_idx" ON "inventory_balance"("organizationId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_balance_locationId_productId_key" ON "inventory_balance"("locationId", "productId");

-- CreateIndex
CREATE INDEX "inventory_transaction_organizationId_type_occurredAt_idx" ON "inventory_transaction"("organizationId", "type", "occurredAt");

-- CreateIndex
CREATE INDEX "inventory_transaction_organizationId_referenceType_referenc_idx" ON "inventory_transaction"("organizationId", "referenceType", "referenceId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_transaction_organizationId_idempotencyKey_key" ON "inventory_transaction"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "inventory_transaction_line_transactionId_idx" ON "inventory_transaction_line"("transactionId");

-- CreateIndex
CREATE INDEX "inventory_transaction_line_organizationId_productId_locatio_idx" ON "inventory_transaction_line"("organizationId", "productId", "locationId");

-- CreateIndex
CREATE UNIQUE INDEX "receiving_inventoryTransactionId_key" ON "receiving"("inventoryTransactionId");

-- CreateIndex
CREATE INDEX "receiving_organizationId_receivedAt_idx" ON "receiving"("organizationId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "receiving_organizationId_idempotencyKey_key" ON "receiving"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "receiving_item_receivingId_idx" ON "receiving_item"("receivingId");

-- CreateIndex
CREATE UNIQUE INDEX "truck_load_inventoryTransactionId_key" ON "truck_load"("inventoryTransactionId");

-- CreateIndex
CREATE INDEX "truck_load_organizationId_vehicleId_status_idx" ON "truck_load"("organizationId", "vehicleId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "truck_load_organizationId_idempotencyKey_key" ON "truck_load"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "truck_load_item_truckLoadId_idx" ON "truck_load_item"("truckLoadId");

-- CreateIndex
CREATE INDEX "route_template_organizationId_active_idx" ON "route_template"("organizationId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "route_template_organizationId_name_key" ON "route_template"("organizationId", "name");

-- CreateIndex
CREATE INDEX "customer_schedule_organizationId_dayOfWeek_active_idx" ON "customer_schedule"("organizationId", "dayOfWeek", "active");

-- CreateIndex
CREATE INDEX "customer_schedule_organizationId_nextDueOn_idx" ON "customer_schedule"("organizationId", "nextDueOn");

-- CreateIndex
CREATE UNIQUE INDEX "customer_schedule_customerId_routeTemplateId_key" ON "customer_schedule"("customerId", "routeTemplateId");

-- CreateIndex
CREATE INDEX "route_organizationId_runnerUserId_serviceDate_idx" ON "route"("organizationId", "runnerUserId", "serviceDate");

-- CreateIndex
CREATE INDEX "route_organizationId_serviceDate_status_idx" ON "route"("organizationId", "serviceDate", "status");

-- CreateIndex
CREATE UNIQUE INDEX "route_organizationId_routeTemplateId_serviceDate_key" ON "route"("organizationId", "routeTemplateId", "serviceDate");

-- CreateIndex
CREATE INDEX "route_stop_routeId_sequence_idx" ON "route_stop"("routeId", "sequence");

-- CreateIndex
CREATE INDEX "route_stop_organizationId_status_idx" ON "route_stop"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "route_stop_routeId_customerId_key" ON "route_stop"("routeId", "customerId");

-- CreateIndex
CREATE INDEX "route_assignment_history_organizationId_routeId_idx" ON "route_assignment_history"("organizationId", "routeId");

-- CreateIndex
CREATE UNIQUE INDEX "route_closeout_routeId_key" ON "route_closeout"("routeId");

-- CreateIndex
CREATE INDEX "route_closeout_organizationId_status_idx" ON "route_closeout"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "route_closeout_item_closeoutId_productId_key" ON "route_closeout_item"("closeoutId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "sale_inventoryTransactionId_key" ON "sale"("inventoryTransactionId");

-- CreateIndex
CREATE INDEX "sale_organizationId_customerId_occurredAt_idx" ON "sale"("organizationId", "customerId", "occurredAt");

-- CreateIndex
CREATE INDEX "sale_organizationId_status_dueDate_idx" ON "sale"("organizationId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "sale_organizationId_routeId_idx" ON "sale"("organizationId", "routeId");

-- CreateIndex
CREATE INDEX "sale_organizationId_soldByUserId_occurredAt_idx" ON "sale"("organizationId", "soldByUserId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "sale_organizationId_saleNumber_key" ON "sale"("organizationId", "saleNumber");

-- CreateIndex
CREATE UNIQUE INDEX "sale_organizationId_idempotencyKey_key" ON "sale"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "sale_item_saleId_idx" ON "sale_item"("saleId");

-- CreateIndex
CREATE INDEX "sale_item_organizationId_productId_idx" ON "sale_item"("organizationId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_saleId_key" ON "receipt"("saleId");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_signatureId_key" ON "receipt"("signatureId");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_organizationId_receiptNumber_key" ON "receipt"("organizationId", "receiptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "signature_saleId_key" ON "signature"("saleId");

-- CreateIndex
CREATE UNIQUE INDEX "signature_returnId_key" ON "signature"("returnId");

-- CreateIndex
CREATE INDEX "signature_organizationId_idx" ON "signature"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_reversalOfId_key" ON "payment"("reversalOfId");

-- CreateIndex
CREATE INDEX "payment_organizationId_customerId_receivedAt_idx" ON "payment"("organizationId", "customerId", "receivedAt");

-- CreateIndex
CREATE INDEX "payment_organizationId_receivedAt_idx" ON "payment"("organizationId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "payment_organizationId_idempotencyKey_key" ON "payment"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "payment_allocation_paymentId_idx" ON "payment_allocation"("paymentId");

-- CreateIndex
CREATE INDEX "payment_allocation_organizationId_saleId_idx" ON "payment_allocation"("organizationId", "saleId");

-- CreateIndex
CREATE UNIQUE INDEX "sales_return_inventoryTransactionId_key" ON "sales_return"("inventoryTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "sales_return_creditMemoId_key" ON "sales_return"("creditMemoId");

-- CreateIndex
CREATE INDEX "sales_return_organizationId_customerId_occurredAt_idx" ON "sales_return"("organizationId", "customerId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "sales_return_organizationId_returnNumber_key" ON "sales_return"("organizationId", "returnNumber");

-- CreateIndex
CREATE UNIQUE INDEX "sales_return_organizationId_idempotencyKey_key" ON "sales_return"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "sales_return_item_returnId_idx" ON "sales_return_item"("returnId");

-- CreateIndex
CREATE INDEX "credit_memo_organizationId_customerId_status_idx" ON "credit_memo"("organizationId", "customerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "credit_memo_organizationId_number_key" ON "credit_memo"("organizationId", "number");

-- CreateIndex
CREATE INDEX "credit_memo_application_creditMemoId_idx" ON "credit_memo_application"("creditMemoId");

-- CreateIndex
CREATE INDEX "credit_memo_application_organizationId_saleId_idx" ON "credit_memo_application"("organizationId", "saleId");

-- CreateIndex
CREATE UNIQUE INDEX "document_sequence_organizationId_docType_key" ON "document_sequence"("organizationId", "docType");

-- CreateIndex
CREATE INDEX "import_job_organizationId_type_createdAt_idx" ON "import_job"("organizationId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "import_row_importJobId_status_idx" ON "import_row"("importJobId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "import_row_importJobId_rowNumber_key" ON "import_row"("importJobId", "rowNumber");

-- CreateIndex
CREATE UNIQUE INDEX "integration_connection_organizationId_provider_key" ON "integration_connection"("organizationId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "external_mapping_organizationId_provider_entityType_localId_key" ON "external_mapping"("organizationId", "provider", "entityType", "localId");

-- CreateIndex
CREATE UNIQUE INDEX "external_mapping_organizationId_provider_entityType_externa_key" ON "external_mapping"("organizationId", "provider", "entityType", "externalId");

-- CreateIndex
CREATE INDEX "sync_job_status_nextAttemptAt_idx" ON "sync_job"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "sync_job_organizationId_entityType_localId_idx" ON "sync_job"("organizationId", "entityType", "localId");

-- CreateIndex
CREATE INDEX "sync_log_syncJobId_idx" ON "sync_log"("syncJobId");

-- CreateIndex
CREATE INDEX "outbox_event_status_availableAt_idx" ON "outbox_event"("status", "availableAt");

-- CreateIndex
CREATE INDEX "notification_organizationId_userId_readAt_idx" ON "notification"("organizationId", "userId", "readAt");

-- CreateIndex
CREATE INDEX "audit_log_organizationId_entityType_entityId_createdAt_idx" ON "audit_log"("organizationId", "entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_log_organizationId_createdAt_idx" ON "audit_log"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_defaultVehicleId_fkey" FOREIGN KEY ("defaultVehicleId") REFERENCES "vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role" ADD CONSTRAINT "role_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_invitedByUserId_fkey" FOREIGN KEY ("invitedByUserId") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_acceptedByUserId_fkey" FOREIGN KEY ("acceptedByUserId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier" ADD CONSTRAINT "supplier_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_category" ADD CONSTRAINT "product_category_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_category" ADD CONSTRAINT "product_category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "product_category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "product_category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_uom" ADD CONSTRAINT "product_uom_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_uom" ADD CONSTRAINT "product_uom_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rate" ADD CONSTRAINT "tax_rate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_group" ADD CONSTRAINT "price_group_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_group_price" ADD CONSTRAINT "price_group_price_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_group_price" ADD CONSTRAINT "price_group_price_priceGroupId_fkey" FOREIGN KEY ("priceGroupId") REFERENCES "price_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_group_price" ADD CONSTRAINT "price_group_price_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_group_price" ADD CONSTRAINT "price_group_price_productUomId_fkey" FOREIGN KEY ("productUomId") REFERENCES "product_uom"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_price" ADD CONSTRAINT "customer_price_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_price" ADD CONSTRAINT "customer_price_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_price" ADD CONSTRAINT "customer_price_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_price" ADD CONSTRAINT "customer_price_productUomId_fkey" FOREIGN KEY ("productUomId") REFERENCES "product_uom"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_priceGroupId_fkey" FOREIGN KEY ("priceGroupId") REFERENCES "price_group"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_taxRateId_fkey" FOREIGN KEY ("taxRateId") REFERENCES "tax_rate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_contact" ADD CONSTRAINT "customer_contact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_contact" ADD CONSTRAINT "customer_contact_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_location" ADD CONSTRAINT "inventory_location_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse" ADD CONSTRAINT "warehouse_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse" ADD CONSTRAINT "warehouse_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "inventory_location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "inventory_location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_balance" ADD CONSTRAINT "inventory_balance_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_balance" ADD CONSTRAINT "inventory_balance_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "inventory_location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_balance" ADD CONSTRAINT "inventory_balance_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transaction" ADD CONSTRAINT "inventory_transaction_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transaction" ADD CONSTRAINT "inventory_transaction_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transaction" ADD CONSTRAINT "inventory_transaction_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "inventory_transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transaction_line" ADD CONSTRAINT "inventory_transaction_line_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transaction_line" ADD CONSTRAINT "inventory_transaction_line_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "inventory_transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transaction_line" ADD CONSTRAINT "inventory_transaction_line_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transaction_line" ADD CONSTRAINT "inventory_transaction_line_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "inventory_location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receiving" ADD CONSTRAINT "receiving_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receiving" ADD CONSTRAINT "receiving_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receiving" ADD CONSTRAINT "receiving_warehouseLocationId_fkey" FOREIGN KEY ("warehouseLocationId") REFERENCES "inventory_location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receiving" ADD CONSTRAINT "receiving_receivedByUserId_fkey" FOREIGN KEY ("receivedByUserId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receiving" ADD CONSTRAINT "receiving_inventoryTransactionId_fkey" FOREIGN KEY ("inventoryTransactionId") REFERENCES "inventory_transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receiving_item" ADD CONSTRAINT "receiving_item_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receiving_item" ADD CONSTRAINT "receiving_item_receivingId_fkey" FOREIGN KEY ("receivingId") REFERENCES "receiving"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receiving_item" ADD CONSTRAINT "receiving_item_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receiving_item" ADD CONSTRAINT "receiving_item_productUomId_fkey" FOREIGN KEY ("productUomId") REFERENCES "product_uom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "truck_load" ADD CONSTRAINT "truck_load_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "truck_load" ADD CONSTRAINT "truck_load_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "truck_load" ADD CONSTRAINT "truck_load_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "route"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "truck_load" ADD CONSTRAINT "truck_load_runnerUserId_fkey" FOREIGN KEY ("runnerUserId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "truck_load" ADD CONSTRAINT "truck_load_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "truck_load" ADD CONSTRAINT "truck_load_inventoryTransactionId_fkey" FOREIGN KEY ("inventoryTransactionId") REFERENCES "inventory_transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "truck_load_item" ADD CONSTRAINT "truck_load_item_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "truck_load_item" ADD CONSTRAINT "truck_load_item_truckLoadId_fkey" FOREIGN KEY ("truckLoadId") REFERENCES "truck_load"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "truck_load_item" ADD CONSTRAINT "truck_load_item_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "truck_load_item" ADD CONSTRAINT "truck_load_item_productUomId_fkey" FOREIGN KEY ("productUomId") REFERENCES "product_uom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_template" ADD CONSTRAINT "route_template_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_template" ADD CONSTRAINT "route_template_defaultRunnerUserId_fkey" FOREIGN KEY ("defaultRunnerUserId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_template" ADD CONSTRAINT "route_template_defaultVehicleId_fkey" FOREIGN KEY ("defaultVehicleId") REFERENCES "vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_schedule" ADD CONSTRAINT "customer_schedule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_schedule" ADD CONSTRAINT "customer_schedule_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_schedule" ADD CONSTRAINT "customer_schedule_routeTemplateId_fkey" FOREIGN KEY ("routeTemplateId") REFERENCES "route_template"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route" ADD CONSTRAINT "route_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route" ADD CONSTRAINT "route_routeTemplateId_fkey" FOREIGN KEY ("routeTemplateId") REFERENCES "route_template"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route" ADD CONSTRAINT "route_runnerUserId_fkey" FOREIGN KEY ("runnerUserId") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route" ADD CONSTRAINT "route_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_stop" ADD CONSTRAINT "route_stop_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_stop" ADD CONSTRAINT "route_stop_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "route"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_stop" ADD CONSTRAINT "route_stop_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_assignment_history" ADD CONSTRAINT "route_assignment_history_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_assignment_history" ADD CONSTRAINT "route_assignment_history_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "route"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_assignment_history" ADD CONSTRAINT "route_assignment_history_routeStopId_fkey" FOREIGN KEY ("routeStopId") REFERENCES "route_stop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_assignment_history" ADD CONSTRAINT "route_assignment_history_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_assignment_history" ADD CONSTRAINT "route_assignment_history_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_assignment_history" ADD CONSTRAINT "route_assignment_history_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_closeout" ADD CONSTRAINT "route_closeout_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_closeout" ADD CONSTRAINT "route_closeout_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "route"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_closeout" ADD CONSTRAINT "route_closeout_submittedByUserId_fkey" FOREIGN KEY ("submittedByUserId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_closeout" ADD CONSTRAINT "route_closeout_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_closeout_item" ADD CONSTRAINT "route_closeout_item_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_closeout_item" ADD CONSTRAINT "route_closeout_item_closeoutId_fkey" FOREIGN KEY ("closeoutId") REFERENCES "route_closeout"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_closeout_item" ADD CONSTRAINT "route_closeout_item_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale" ADD CONSTRAINT "sale_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale" ADD CONSTRAINT "sale_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale" ADD CONSTRAINT "sale_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "route"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale" ADD CONSTRAINT "sale_routeStopId_fkey" FOREIGN KEY ("routeStopId") REFERENCES "route_stop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale" ADD CONSTRAINT "sale_soldByUserId_fkey" FOREIGN KEY ("soldByUserId") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale" ADD CONSTRAINT "sale_voidedByUserId_fkey" FOREIGN KEY ("voidedByUserId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale" ADD CONSTRAINT "sale_inventoryTransactionId_fkey" FOREIGN KEY ("inventoryTransactionId") REFERENCES "inventory_transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_item" ADD CONSTRAINT "sale_item_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_item" ADD CONSTRAINT "sale_item_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_item" ADD CONSTRAINT "sale_item_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_item" ADD CONSTRAINT "sale_item_productUomId_fkey" FOREIGN KEY ("productUomId") REFERENCES "product_uom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt" ADD CONSTRAINT "receipt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt" ADD CONSTRAINT "receipt_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt" ADD CONSTRAINT "receipt_signatureId_fkey" FOREIGN KEY ("signatureId") REFERENCES "signature"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature" ADD CONSTRAINT "signature_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature" ADD CONSTRAINT "signature_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature" ADD CONSTRAINT "signature_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "sales_return"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_receivedByUserId_fkey" FOREIGN KEY ("receivedByUserId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_reversedByUserId_fkey" FOREIGN KEY ("reversedByUserId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_routeStopId_fkey" FOREIGN KEY ("routeStopId") REFERENCES "route_stop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocation" ADD CONSTRAINT "payment_allocation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocation" ADD CONSTRAINT "payment_allocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocation" ADD CONSTRAINT "payment_allocation_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return" ADD CONSTRAINT "sales_return_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return" ADD CONSTRAINT "sales_return_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return" ADD CONSTRAINT "sales_return_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return" ADD CONSTRAINT "sales_return_routeStopId_fkey" FOREIGN KEY ("routeStopId") REFERENCES "route_stop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return" ADD CONSTRAINT "sales_return_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return" ADD CONSTRAINT "sales_return_inventoryTransactionId_fkey" FOREIGN KEY ("inventoryTransactionId") REFERENCES "inventory_transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return" ADD CONSTRAINT "sales_return_creditMemoId_fkey" FOREIGN KEY ("creditMemoId") REFERENCES "credit_memo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_item" ADD CONSTRAINT "sales_return_item_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_item" ADD CONSTRAINT "sales_return_item_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "sales_return"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_item" ADD CONSTRAINT "sales_return_item_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_item" ADD CONSTRAINT "sales_return_item_productUomId_fkey" FOREIGN KEY ("productUomId") REFERENCES "product_uom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_memo" ADD CONSTRAINT "credit_memo_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_memo" ADD CONSTRAINT "credit_memo_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_memo_application" ADD CONSTRAINT "credit_memo_application_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_memo_application" ADD CONSTRAINT "credit_memo_application_creditMemoId_fkey" FOREIGN KEY ("creditMemoId") REFERENCES "credit_memo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_memo_application" ADD CONSTRAINT "credit_memo_application_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_sequence" ADD CONSTRAINT "document_sequence_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_job" ADD CONSTRAINT "import_job_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_job" ADD CONSTRAINT "import_job_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_row" ADD CONSTRAINT "import_row_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_row" ADD CONSTRAINT "import_row_importJobId_fkey" FOREIGN KEY ("importJobId") REFERENCES "import_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_connection" ADD CONSTRAINT "integration_connection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_connection" ADD CONSTRAINT "integration_connection_connectedByUserId_fkey" FOREIGN KEY ("connectedByUserId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_mapping" ADD CONSTRAINT "external_mapping_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_job" ADD CONSTRAINT "sync_job_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_log" ADD CONSTRAINT "sync_log_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_log" ADD CONSTRAINT "sync_log_syncJobId_fkey" FOREIGN KEY ("syncJobId") REFERENCES "sync_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
