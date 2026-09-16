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
    "legal_name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "address_line1" TEXT,
    "address_line2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postal_code" TEXT,
    "country" TEXT NOT NULL DEFAULT 'US',
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "logo_url" TEXT,
    "receipt_footer" TEXT,
    "status" "OrganizationStatus" NOT NULL DEFAULT 'ACTIVE',
    "plan" TEXT NOT NULL DEFAULT 'standard',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "onboarding_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_user" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "password_algo" TEXT NOT NULL DEFAULT 'scrypt',
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "phone" TEXT,
    "avatar_url" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "last_login_at" TIMESTAMP(3),
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "employee_code" TEXT,
    "default_vehicle_id" TEXT,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permission" (
    "id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "permission" TEXT NOT NULL,

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitation" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "invited_by_user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "accepted_by_user_id" TEXT,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "client" "SessionClient" NOT NULL DEFAULT 'WEB',
    "user_agent" TEXT,
    "ip_address" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "account_number" TEXT,
    "contact_name" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address_line1" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postal_code" TEXT,
    "lead_time_days" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_category" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parent_id" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "upc" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "brand" TEXT,
    "category_id" TEXT,
    "supplier_id" TEXT,
    "base_uom_label" TEXT NOT NULL DEFAULT 'Each',
    "cost_per_base_unit" DECIMAL(16,6) NOT NULL DEFAULT 0,
    "reorder_point_base_units" INTEGER NOT NULL DEFAULT 0,
    "taxable" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "image_url" TEXT,
    "weight_grams" INTEGER,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_uom" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "code" "UomCode" NOT NULL,
    "label" TEXT NOT NULL,
    "base_units_per_uom" INTEGER NOT NULL,
    "price" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "barcode" TEXT,
    "is_base" BOOLEAN NOT NULL DEFAULT false,
    "is_default_sale_uom" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "product_uom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rate" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rate" DECIMAL(9,6) NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "tax_rate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_group" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "price_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_group_price" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "price_group_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "product_uom_id" TEXT,
    "price" DECIMAL(12,4) NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_to" TIMESTAMP(3),

    CONSTRAINT "price_group_price_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_price" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "product_uom_id" TEXT,
    "price" DECIMAL(12,4) NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_to" TIMESTAMP(3),

    CONSTRAINT "customer_price_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "account_number" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parent_company" TEXT,
    "address_line1" TEXT,
    "address_line2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postal_code" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "phone" TEXT,
    "email" TEXT,
    "price_group_id" TEXT,
    "payment_terms_code" "PaymentTerms" NOT NULL DEFAULT 'COD',
    "credit_limit" DECIMAL(14,4),
    "tax_exempt" BOOLEAN NOT NULL DEFAULT false,
    "tax_exempt_id" TEXT,
    "tax_rate_id" TEXT,
    "balance" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "delivery_instructions" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_visit_at" TIMESTAMP(3),
    "next_due_on" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_contact" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,

    CONSTRAINT "customer_contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_location" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "kind" "InventoryLocationKind" NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "address_line1" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postal_code" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "truck_number" TEXT NOT NULL,
    "license_plate" TEXT,
    "assigned_user_id" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_balance" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "avg_unit_cost" DECIMAL(16,6) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_balance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_transaction" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "type" "InventoryTransactionType" NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" TEXT,
    "reference_type" TEXT,
    "reference_id" TEXT,
    "reason_code" TEXT,
    "notes" TEXT,
    "idempotency_key" TEXT,
    "reversal_of_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_transaction_line" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "quantity_delta" INTEGER NOT NULL,
    "unit_cost" DECIMAL(16,6) NOT NULL,
    "balance_after" INTEGER NOT NULL,
    "notes" TEXT,

    CONSTRAINT "inventory_transaction_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receiving" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "supplier_id" TEXT,
    "warehouse_location_id" TEXT NOT NULL,
    "reference_number" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "received_by_user_id" TEXT,
    "notes" TEXT,
    "inventory_transaction_id" TEXT,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receiving_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receiving_item" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "receiving_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "product_uom_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "base_quantity" INTEGER NOT NULL,
    "unit_cost" DECIMAL(16,6) NOT NULL,
    "line_cost" DECIMAL(14,4) NOT NULL,

    CONSTRAINT "receiving_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "truck_load" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "route_id" TEXT,
    "runner_user_id" TEXT,
    "direction" "TruckLoadDirection" NOT NULL DEFAULT 'LOAD',
    "status" "TruckLoadStatus" NOT NULL DEFAULT 'DRAFT',
    "warehouse_location_id" TEXT NOT NULL,
    "loaded_at" TIMESTAMP(3),
    "created_by_user_id" TEXT,
    "notes" TEXT,
    "inventory_transaction_id" TEXT,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "truck_load_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "truck_load_item" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "truck_load_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "product_uom_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "base_quantity" INTEGER NOT NULL,

    CONSTRAINT "truck_load_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_template" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "color" TEXT,
    "day_of_week" "DayOfWeek",
    "default_runner_user_id" TEXT,
    "default_vehicle_id" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "route_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_schedule" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "route_template_id" TEXT NOT NULL,
    "frequency" "ScheduleFrequency" NOT NULL DEFAULT 'WEEKLY',
    "interval_days" INTEGER,
    "day_of_week" "DayOfWeek" NOT NULL,
    "week_of_cycle" INTEGER,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "window_start" TEXT,
    "window_end" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_serviced_on" DATE,
    "next_due_on" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "route_template_id" TEXT,
    "service_date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "runner_user_id" TEXT NOT NULL,
    "vehicle_id" TEXT,
    "status" "RouteStatus" NOT NULL DEFAULT 'PLANNED',
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "planned_stops" INTEGER NOT NULL DEFAULT 0,
    "planned_miles" DECIMAL(9,2),
    "planned_minutes" INTEGER,
    "actual_miles" DECIMAL(9,2),
    "start_odometer" INTEGER,
    "end_odometer" INTEGER,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "route_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_stop" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "route_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status" "RouteStopStatus" NOT NULL DEFAULT 'PENDING',
    "planned_arrival_at" TIMESTAMP(3),
    "arrived_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "distance_miles" DECIMAL(9,2),
    "duration_minutes" INTEGER,
    "outcome_reason" TEXT,
    "rescheduled_to_date" DATE,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "route_stop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_assignment_history" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "route_id" TEXT NOT NULL,
    "route_stop_id" TEXT,
    "from_user_id" TEXT,
    "to_user_id" TEXT NOT NULL,
    "reason" TEXT,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "route_assignment_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_closeout" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "route_id" TEXT NOT NULL,
    "status" "CloseoutStatus" NOT NULL DEFAULT 'OPEN',
    "submitted_at" TIMESTAMP(3),
    "submitted_by_user_id" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "reviewed_by_user_id" TEXT,
    "sales_total" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "returns_total" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "expected_cash" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "actual_cash" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "check_total" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "card_total" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "ach_total" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "on_account_total" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "cash_variance" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "route_closeout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_closeout_item" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "closeout_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "expected_quantity" INTEGER NOT NULL,
    "counted_quantity" INTEGER,
    "variance_quantity" INTEGER NOT NULL DEFAULT 0,
    "variance_value" DECIMAL(14,4) NOT NULL DEFAULT 0,

    CONSTRAINT "route_closeout_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "sale_number" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "route_id" TEXT,
    "route_stop_id" TEXT,
    "sold_by_user_id" TEXT NOT NULL,
    "status" "SaleStatus" NOT NULL DEFAULT 'DRAFT',
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "subtotal" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "discount_total" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "tax_total" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "amount_paid" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "credits_applied" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "balance_due" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "due_date" DATE,
    "payment_terms_code" "PaymentTerms" NOT NULL DEFAULT 'COD',
    "tax_exempt" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "inventory_transaction_id" TEXT,
    "voided_at" TIMESTAMP(3),
    "voided_by_user_id" TEXT,
    "void_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_item" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "sale_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "product_uom_id" TEXT NOT NULL,
    "product_name_snapshot" TEXT NOT NULL,
    "sku_snapshot" TEXT NOT NULL,
    "uom_label_snapshot" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "base_quantity" INTEGER NOT NULL,
    "unit_price" DECIMAL(12,4) NOT NULL,
    "line_subtotal" DECIMAL(14,4) NOT NULL,
    "discount_amount" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(14,4) NOT NULL,
    "unit_cost_at_sale" DECIMAL(16,6) NOT NULL DEFAULT 0,
    "price_source" "PriceSource" NOT NULL DEFAULT 'STANDARD',
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "sale_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "sale_id" TEXT NOT NULL,
    "receipt_number" TEXT NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signature_id" TEXT,
    "pdf_path" TEXT,
    "emailed_at" TIMESTAMP(3),
    "texted_at" TIMESTAMP(3),
    "printed_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "sale_id" TEXT,
    "return_id" TEXT,
    "signer_name" TEXT,
    "image_png" BYTEA NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "device_info" TEXT,

    CONSTRAINT "signature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" DECIMAL(14,4) NOT NULL,
    "unapplied_amount" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "received_by_user_id" TEXT,
    "route_stop_id" TEXT,
    "check_number" TEXT,
    "reference_number" TEXT,
    "processor_ref" TEXT,
    "notes" TEXT,
    "status" "PaymentStatus" NOT NULL DEFAULT 'POSTED',
    "reversed_at" TIMESTAMP(3),
    "reversed_by_user_id" TEXT,
    "reversal_of_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocation" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "sale_id" TEXT NOT NULL,
    "amount" DECIMAL(14,4) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocation_pkey" PRIMARY KEY ("id")
);

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
    "disposition" "ReturnDisposition" NOT NULL,
    "financial_action" "ReturnFinancialAction" NOT NULL,
    "subtotal" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "tax_total" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "status" "ReturnStatus" NOT NULL DEFAULT 'COMPLETED',
    "inventory_transaction_id" TEXT,
    "credit_memo_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_return_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_return_item" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "return_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "product_uom_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "base_quantity" INTEGER NOT NULL,
    "unit_price" DECIMAL(12,4) NOT NULL,
    "line_total" DECIMAL(14,4) NOT NULL,
    "reason" "ReturnReason" NOT NULL,
    "restock" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "sales_return_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_memo" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "amount" DECIMAL(14,4) NOT NULL,
    "remaining_amount" DECIMAL(14,4) NOT NULL,
    "status" "CreditMemoStatus" NOT NULL DEFAULT 'OPEN',
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_memo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_memo_application" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "credit_memo_id" TEXT NOT NULL,
    "sale_id" TEXT NOT NULL,
    "amount" DECIMAL(14,4) NOT NULL,
    "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_memo_application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_sequence" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "doc_type" TEXT NOT NULL,
    "prefix" TEXT NOT NULL DEFAULT '',
    "next_number" INTEGER NOT NULL DEFAULT 1,
    "pad_to" INTEGER NOT NULL DEFAULT 5,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_sequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_job" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "type" "ImportType" NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "storage_path" TEXT,
    "status" "ImportStatus" NOT NULL DEFAULT 'UPLOADED',
    "mode" "ImportMode" NOT NULL DEFAULT 'UPSERT',
    "match_key" "ImportMatchKey" NOT NULL DEFAULT 'SKU',
    "column_map_json" JSONB NOT NULL DEFAULT '{}',
    "reference_map_json" JSONB NOT NULL DEFAULT '{}',
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "ready_rows" INTEGER NOT NULL DEFAULT 0,
    "warning_rows" INTEGER NOT NULL DEFAULT 0,
    "error_rows" INTEGER NOT NULL DEFAULT 0,
    "imported_rows" INTEGER NOT NULL DEFAULT 0,
    "skipped_rows" INTEGER NOT NULL DEFAULT 0,
    "created_by_user_id" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "summary_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_row" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "import_job_id" TEXT NOT NULL,
    "row_number" INTEGER NOT NULL,
    "raw_json" JSONB NOT NULL,
    "normalized_json" JSONB NOT NULL DEFAULT '{}',
    "status" "ImportRowStatus" NOT NULL DEFAULT 'PENDING',
    "action" "ImportRowAction" NOT NULL DEFAULT 'CREATE',
    "messages_json" JSONB NOT NULL DEFAULT '[]',
    "target_type" TEXT,
    "target_id" TEXT,

    CONSTRAINT "import_row_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_connection" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "realm_id" TEXT,
    "company_name" TEXT,
    "access_token_encrypted" TEXT,
    "refresh_token_encrypted" TEXT,
    "token_expires_at" TIMESTAMP(3),
    "refresh_expires_at" TIMESTAMP(3),
    "connected_by_user_id" TEXT,
    "connected_at" TIMESTAMP(3),
    "last_sync_at" TIMESTAMP(3),
    "settings_json" JSONB NOT NULL DEFAULT '{}',
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_mapping" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "entity_type" TEXT NOT NULL,
    "local_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "external_sync_token" TEXT,
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_job" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "entity_type" TEXT NOT NULL,
    "local_id" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "payload_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "sync_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_log" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "sync_job_id" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "level" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "request_json" JSONB,
    "response_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_event" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload_json" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT,
    "type" TEXT NOT NULL,
    "severity" "NotificationSeverity" NOT NULL DEFAULT 'INFO',
    "title" TEXT NOT NULL,
    "body" TEXT,
    "data_json" JSONB NOT NULL DEFAULT '{}',
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "before_json" JSONB,
    "after_json" JSONB,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organization_slug_key" ON "organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_email_key" ON "app_user"("email");

-- CreateIndex
CREATE INDEX "app_user_status_idx" ON "app_user"("status");

-- CreateIndex
CREATE INDEX "membership_organization_id_status_idx" ON "membership"("organization_id", "status");

-- CreateIndex
CREATE INDEX "membership_user_id_idx" ON "membership"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "membership_organization_id_user_id_key" ON "membership"("organization_id", "user_id");

-- CreateIndex
CREATE INDEX "role_organization_id_idx" ON "role"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "role_organization_id_key_key" ON "role"("organization_id", "key");

-- CreateIndex
CREATE INDEX "role_permission_role_id_idx" ON "role_permission"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "role_permission_role_id_permission_key" ON "role_permission"("role_id", "permission");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_token_hash_key" ON "invitation"("token_hash");

-- CreateIndex
CREATE INDEX "invitation_organization_id_email_idx" ON "invitation"("organization_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_hash_key" ON "session"("token_hash");

-- CreateIndex
CREATE INDEX "session_user_id_idx" ON "session"("user_id");

-- CreateIndex
CREATE INDEX "session_expires_at_idx" ON "session"("expires_at");

-- CreateIndex
CREATE INDEX "supplier_organization_id_active_idx" ON "supplier"("organization_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_organization_id_name_key" ON "supplier"("organization_id", "name");

-- CreateIndex
CREATE INDEX "product_category_organization_id_active_idx" ON "product_category"("organization_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "product_category_organization_id_name_key" ON "product_category"("organization_id", "name");

-- CreateIndex
CREATE INDEX "product_organization_id_active_idx" ON "product"("organization_id", "active");

-- CreateIndex
CREATE INDEX "product_organization_id_name_idx" ON "product"("organization_id", "name");

-- CreateIndex
CREATE INDEX "product_organization_id_category_id_idx" ON "product"("organization_id", "category_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_organization_id_sku_key" ON "product"("organization_id", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "product_organization_id_upc_key" ON "product"("organization_id", "upc");

-- CreateIndex
CREATE INDEX "product_uom_organization_id_barcode_idx" ON "product_uom"("organization_id", "barcode");

-- CreateIndex
CREATE UNIQUE INDEX "product_uom_product_id_code_key" ON "product_uom"("product_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "tax_rate_organization_id_name_key" ON "tax_rate"("organization_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "price_group_organization_id_name_key" ON "price_group"("organization_id", "name");

-- CreateIndex
CREATE INDEX "price_group_price_organization_id_price_group_id_product_id_idx" ON "price_group_price"("organization_id", "price_group_id", "product_id");

-- CreateIndex
CREATE INDEX "customer_price_organization_id_customer_id_product_id_idx" ON "customer_price"("organization_id", "customer_id", "product_id");

-- CreateIndex
CREATE INDEX "customer_organization_id_active_name_idx" ON "customer"("organization_id", "active", "name");

-- CreateIndex
CREATE INDEX "customer_organization_id_next_due_on_idx" ON "customer"("organization_id", "next_due_on");

-- CreateIndex
CREATE UNIQUE INDEX "customer_organization_id_account_number_key" ON "customer"("organization_id", "account_number");

-- CreateIndex
CREATE INDEX "customer_contact_organization_id_customer_id_idx" ON "customer_contact"("organization_id", "customer_id");

-- CreateIndex
CREATE INDEX "inventory_location_organization_id_kind_active_idx" ON "inventory_location"("organization_id", "kind", "active");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_location_id_key" ON "warehouse"("location_id");

-- CreateIndex
CREATE INDEX "warehouse_organization_id_idx" ON "warehouse"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_location_id_key" ON "vehicle"("location_id");

-- CreateIndex
CREATE INDEX "vehicle_organization_id_active_idx" ON "vehicle"("organization_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_organization_id_truck_number_key" ON "vehicle"("organization_id", "truck_number");

-- CreateIndex
CREATE INDEX "inventory_balance_organization_id_product_id_idx" ON "inventory_balance"("organization_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_balance_location_id_product_id_key" ON "inventory_balance"("location_id", "product_id");

-- CreateIndex
CREATE INDEX "inventory_transaction_organization_id_type_occurred_at_idx" ON "inventory_transaction"("organization_id", "type", "occurred_at");

-- CreateIndex
CREATE INDEX "inventory_transaction_organization_id_reference_type_refere_idx" ON "inventory_transaction"("organization_id", "reference_type", "reference_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_transaction_organization_id_idempotency_key_key" ON "inventory_transaction"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "inventory_transaction_line_transaction_id_idx" ON "inventory_transaction_line"("transaction_id");

-- CreateIndex
CREATE INDEX "inventory_transaction_line_organization_id_product_id_locat_idx" ON "inventory_transaction_line"("organization_id", "product_id", "location_id");

-- CreateIndex
CREATE UNIQUE INDEX "receiving_inventory_transaction_id_key" ON "receiving"("inventory_transaction_id");

-- CreateIndex
CREATE INDEX "receiving_organization_id_received_at_idx" ON "receiving"("organization_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "receiving_organization_id_idempotency_key_key" ON "receiving"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "receiving_item_receiving_id_idx" ON "receiving_item"("receiving_id");

-- CreateIndex
CREATE UNIQUE INDEX "truck_load_inventory_transaction_id_key" ON "truck_load"("inventory_transaction_id");

-- CreateIndex
CREATE INDEX "truck_load_organization_id_vehicle_id_status_idx" ON "truck_load"("organization_id", "vehicle_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "truck_load_organization_id_idempotency_key_key" ON "truck_load"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "truck_load_item_truck_load_id_idx" ON "truck_load_item"("truck_load_id");

-- CreateIndex
CREATE INDEX "route_template_organization_id_active_idx" ON "route_template"("organization_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "route_template_organization_id_name_key" ON "route_template"("organization_id", "name");

-- CreateIndex
CREATE INDEX "customer_schedule_organization_id_day_of_week_active_idx" ON "customer_schedule"("organization_id", "day_of_week", "active");

-- CreateIndex
CREATE INDEX "customer_schedule_organization_id_next_due_on_idx" ON "customer_schedule"("organization_id", "next_due_on");

-- CreateIndex
CREATE UNIQUE INDEX "customer_schedule_customer_id_route_template_id_key" ON "customer_schedule"("customer_id", "route_template_id");

-- CreateIndex
CREATE INDEX "route_organization_id_runner_user_id_service_date_idx" ON "route"("organization_id", "runner_user_id", "service_date");

-- CreateIndex
CREATE INDEX "route_organization_id_service_date_status_idx" ON "route"("organization_id", "service_date", "status");

-- CreateIndex
CREATE UNIQUE INDEX "route_organization_id_route_template_id_service_date_key" ON "route"("organization_id", "route_template_id", "service_date");

-- CreateIndex
CREATE INDEX "route_stop_route_id_sequence_idx" ON "route_stop"("route_id", "sequence");

-- CreateIndex
CREATE INDEX "route_stop_organization_id_status_idx" ON "route_stop"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "route_stop_route_id_customer_id_key" ON "route_stop"("route_id", "customer_id");

-- CreateIndex
CREATE INDEX "route_assignment_history_organization_id_route_id_idx" ON "route_assignment_history"("organization_id", "route_id");

-- CreateIndex
CREATE UNIQUE INDEX "route_closeout_route_id_key" ON "route_closeout"("route_id");

-- CreateIndex
CREATE INDEX "route_closeout_organization_id_status_idx" ON "route_closeout"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "route_closeout_item_closeout_id_product_id_key" ON "route_closeout_item"("closeout_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_inventory_transaction_id_key" ON "sale"("inventory_transaction_id");

-- CreateIndex
CREATE INDEX "sale_organization_id_customer_id_occurred_at_idx" ON "sale"("organization_id", "customer_id", "occurred_at");

-- CreateIndex
CREATE INDEX "sale_organization_id_status_due_date_idx" ON "sale"("organization_id", "status", "due_date");

-- CreateIndex
CREATE INDEX "sale_organization_id_route_id_idx" ON "sale"("organization_id", "route_id");

-- CreateIndex
CREATE INDEX "sale_organization_id_sold_by_user_id_occurred_at_idx" ON "sale"("organization_id", "sold_by_user_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "sale_organization_id_sale_number_key" ON "sale"("organization_id", "sale_number");

-- CreateIndex
CREATE UNIQUE INDEX "sale_organization_id_idempotency_key_key" ON "sale"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "sale_item_sale_id_idx" ON "sale_item"("sale_id");

-- CreateIndex
CREATE INDEX "sale_item_organization_id_product_id_idx" ON "sale_item"("organization_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_sale_id_key" ON "receipt"("sale_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_signature_id_key" ON "receipt"("signature_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_organization_id_receipt_number_key" ON "receipt"("organization_id", "receipt_number");

-- CreateIndex
CREATE UNIQUE INDEX "signature_sale_id_key" ON "signature"("sale_id");

-- CreateIndex
CREATE UNIQUE INDEX "signature_return_id_key" ON "signature"("return_id");

-- CreateIndex
CREATE INDEX "signature_organization_id_idx" ON "signature"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_reversal_of_id_key" ON "payment"("reversal_of_id");

-- CreateIndex
CREATE INDEX "payment_organization_id_customer_id_received_at_idx" ON "payment"("organization_id", "customer_id", "received_at");

-- CreateIndex
CREATE INDEX "payment_organization_id_received_at_idx" ON "payment"("organization_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_organization_id_idempotency_key_key" ON "payment"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "payment_allocation_payment_id_idx" ON "payment_allocation"("payment_id");

-- CreateIndex
CREATE INDEX "payment_allocation_organization_id_sale_id_idx" ON "payment_allocation"("organization_id", "sale_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_return_inventory_transaction_id_key" ON "sales_return"("inventory_transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_return_credit_memo_id_key" ON "sales_return"("credit_memo_id");

-- CreateIndex
CREATE INDEX "sales_return_organization_id_customer_id_occurred_at_idx" ON "sales_return"("organization_id", "customer_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "sales_return_organization_id_return_number_key" ON "sales_return"("organization_id", "return_number");

-- CreateIndex
CREATE UNIQUE INDEX "sales_return_organization_id_idempotency_key_key" ON "sales_return"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "sales_return_item_return_id_idx" ON "sales_return_item"("return_id");

-- CreateIndex
CREATE INDEX "credit_memo_organization_id_customer_id_status_idx" ON "credit_memo"("organization_id", "customer_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "credit_memo_organization_id_number_key" ON "credit_memo"("organization_id", "number");

-- CreateIndex
CREATE INDEX "credit_memo_application_credit_memo_id_idx" ON "credit_memo_application"("credit_memo_id");

-- CreateIndex
CREATE INDEX "credit_memo_application_organization_id_sale_id_idx" ON "credit_memo_application"("organization_id", "sale_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_sequence_organization_id_doc_type_key" ON "document_sequence"("organization_id", "doc_type");

-- CreateIndex
CREATE INDEX "import_job_organization_id_type_created_at_idx" ON "import_job"("organization_id", "type", "created_at");

-- CreateIndex
CREATE INDEX "import_row_import_job_id_status_idx" ON "import_row"("import_job_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "import_row_import_job_id_row_number_key" ON "import_row"("import_job_id", "row_number");

-- CreateIndex
CREATE UNIQUE INDEX "integration_connection_organization_id_provider_key" ON "integration_connection"("organization_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "external_mapping_organization_id_provider_entity_type_local_key" ON "external_mapping"("organization_id", "provider", "entity_type", "local_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_mapping_organization_id_provider_entity_type_exter_key" ON "external_mapping"("organization_id", "provider", "entity_type", "external_id");

-- CreateIndex
CREATE INDEX "sync_job_status_next_attempt_at_idx" ON "sync_job"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "sync_job_organization_id_entity_type_local_id_idx" ON "sync_job"("organization_id", "entity_type", "local_id");

-- CreateIndex
CREATE INDEX "sync_log_sync_job_id_idx" ON "sync_log"("sync_job_id");

-- CreateIndex
CREATE INDEX "outbox_event_status_available_at_idx" ON "outbox_event"("status", "available_at");

-- CreateIndex
CREATE INDEX "notification_organization_id_user_id_read_at_idx" ON "notification"("organization_id", "user_id", "read_at");

-- CreateIndex
CREATE INDEX "audit_log_organization_id_entity_type_entity_id_created_at_idx" ON "audit_log"("organization_id", "entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_organization_id_created_at_idx" ON "audit_log"("organization_id", "created_at");

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_default_vehicle_id_fkey" FOREIGN KEY ("default_vehicle_id") REFERENCES "vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role" ADD CONSTRAINT "role_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_invited_by_user_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_accepted_by_user_id_fkey" FOREIGN KEY ("accepted_by_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier" ADD CONSTRAINT "supplier_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_category" ADD CONSTRAINT "product_category_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_category" ADD CONSTRAINT "product_category_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "product_category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "product_category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_uom" ADD CONSTRAINT "product_uom_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_uom" ADD CONSTRAINT "product_uom_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rate" ADD CONSTRAINT "tax_rate_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_group" ADD CONSTRAINT "price_group_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_group_price" ADD CONSTRAINT "price_group_price_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_group_price" ADD CONSTRAINT "price_group_price_price_group_id_fkey" FOREIGN KEY ("price_group_id") REFERENCES "price_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_group_price" ADD CONSTRAINT "price_group_price_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_group_price" ADD CONSTRAINT "price_group_price_product_uom_id_fkey" FOREIGN KEY ("product_uom_id") REFERENCES "product_uom"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_price" ADD CONSTRAINT "customer_price_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_price" ADD CONSTRAINT "customer_price_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_price" ADD CONSTRAINT "customer_price_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_price" ADD CONSTRAINT "customer_price_product_uom_id_fkey" FOREIGN KEY ("product_uom_id") REFERENCES "product_uom"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_price_group_id_fkey" FOREIGN KEY ("price_group_id") REFERENCES "price_group"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_tax_rate_id_fkey" FOREIGN KEY ("tax_rate_id") REFERENCES "tax_rate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_contact" ADD CONSTRAINT "customer_contact_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_contact" ADD CONSTRAINT "customer_contact_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_location" ADD CONSTRAINT "inventory_location_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse" ADD CONSTRAINT "warehouse_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse" ADD CONSTRAINT "warehouse_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "inventory_location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "inventory_location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_assigned_user_id_fkey" FOREIGN KEY ("assigned_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_balance" ADD CONSTRAINT "inventory_balance_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_balance" ADD CONSTRAINT "inventory_balance_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "inventory_location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_balance" ADD CONSTRAINT "inventory_balance_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transaction" ADD CONSTRAINT "inventory_transaction_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transaction" ADD CONSTRAINT "inventory_transaction_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transaction" ADD CONSTRAINT "inventory_transaction_reversal_of_id_fkey" FOREIGN KEY ("reversal_of_id") REFERENCES "inventory_transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transaction_line" ADD CONSTRAINT "inventory_transaction_line_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transaction_line" ADD CONSTRAINT "inventory_transaction_line_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "inventory_transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transaction_line" ADD CONSTRAINT "inventory_transaction_line_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transaction_line" ADD CONSTRAINT "inventory_transaction_line_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "inventory_location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receiving" ADD CONSTRAINT "receiving_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receiving" ADD CONSTRAINT "receiving_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receiving" ADD CONSTRAINT "receiving_warehouse_location_id_fkey" FOREIGN KEY ("warehouse_location_id") REFERENCES "inventory_location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receiving" ADD CONSTRAINT "receiving_received_by_user_id_fkey" FOREIGN KEY ("received_by_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receiving" ADD CONSTRAINT "receiving_inventory_transaction_id_fkey" FOREIGN KEY ("inventory_transaction_id") REFERENCES "inventory_transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receiving_item" ADD CONSTRAINT "receiving_item_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receiving_item" ADD CONSTRAINT "receiving_item_receiving_id_fkey" FOREIGN KEY ("receiving_id") REFERENCES "receiving"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receiving_item" ADD CONSTRAINT "receiving_item_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receiving_item" ADD CONSTRAINT "receiving_item_product_uom_id_fkey" FOREIGN KEY ("product_uom_id") REFERENCES "product_uom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "truck_load" ADD CONSTRAINT "truck_load_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "truck_load" ADD CONSTRAINT "truck_load_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "truck_load" ADD CONSTRAINT "truck_load_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "route"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "truck_load" ADD CONSTRAINT "truck_load_runner_user_id_fkey" FOREIGN KEY ("runner_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "truck_load" ADD CONSTRAINT "truck_load_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "truck_load" ADD CONSTRAINT "truck_load_inventory_transaction_id_fkey" FOREIGN KEY ("inventory_transaction_id") REFERENCES "inventory_transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "truck_load_item" ADD CONSTRAINT "truck_load_item_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "truck_load_item" ADD CONSTRAINT "truck_load_item_truck_load_id_fkey" FOREIGN KEY ("truck_load_id") REFERENCES "truck_load"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "truck_load_item" ADD CONSTRAINT "truck_load_item_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "truck_load_item" ADD CONSTRAINT "truck_load_item_product_uom_id_fkey" FOREIGN KEY ("product_uom_id") REFERENCES "product_uom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_template" ADD CONSTRAINT "route_template_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_template" ADD CONSTRAINT "route_template_default_runner_user_id_fkey" FOREIGN KEY ("default_runner_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_template" ADD CONSTRAINT "route_template_default_vehicle_id_fkey" FOREIGN KEY ("default_vehicle_id") REFERENCES "vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_schedule" ADD CONSTRAINT "customer_schedule_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_schedule" ADD CONSTRAINT "customer_schedule_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_schedule" ADD CONSTRAINT "customer_schedule_route_template_id_fkey" FOREIGN KEY ("route_template_id") REFERENCES "route_template"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route" ADD CONSTRAINT "route_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route" ADD CONSTRAINT "route_route_template_id_fkey" FOREIGN KEY ("route_template_id") REFERENCES "route_template"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route" ADD CONSTRAINT "route_runner_user_id_fkey" FOREIGN KEY ("runner_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route" ADD CONSTRAINT "route_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_stop" ADD CONSTRAINT "route_stop_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_stop" ADD CONSTRAINT "route_stop_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "route"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_stop" ADD CONSTRAINT "route_stop_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_assignment_history" ADD CONSTRAINT "route_assignment_history_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_assignment_history" ADD CONSTRAINT "route_assignment_history_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "route"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_assignment_history" ADD CONSTRAINT "route_assignment_history_route_stop_id_fkey" FOREIGN KEY ("route_stop_id") REFERENCES "route_stop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_assignment_history" ADD CONSTRAINT "route_assignment_history_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_assignment_history" ADD CONSTRAINT "route_assignment_history_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_assignment_history" ADD CONSTRAINT "route_assignment_history_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_closeout" ADD CONSTRAINT "route_closeout_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_closeout" ADD CONSTRAINT "route_closeout_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "route"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_closeout" ADD CONSTRAINT "route_closeout_submitted_by_user_id_fkey" FOREIGN KEY ("submitted_by_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_closeout" ADD CONSTRAINT "route_closeout_reviewed_by_user_id_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_closeout_item" ADD CONSTRAINT "route_closeout_item_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_closeout_item" ADD CONSTRAINT "route_closeout_item_closeout_id_fkey" FOREIGN KEY ("closeout_id") REFERENCES "route_closeout"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_closeout_item" ADD CONSTRAINT "route_closeout_item_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale" ADD CONSTRAINT "sale_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale" ADD CONSTRAINT "sale_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale" ADD CONSTRAINT "sale_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "route"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale" ADD CONSTRAINT "sale_route_stop_id_fkey" FOREIGN KEY ("route_stop_id") REFERENCES "route_stop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale" ADD CONSTRAINT "sale_sold_by_user_id_fkey" FOREIGN KEY ("sold_by_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale" ADD CONSTRAINT "sale_voided_by_user_id_fkey" FOREIGN KEY ("voided_by_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale" ADD CONSTRAINT "sale_inventory_transaction_id_fkey" FOREIGN KEY ("inventory_transaction_id") REFERENCES "inventory_transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_item" ADD CONSTRAINT "sale_item_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_item" ADD CONSTRAINT "sale_item_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_item" ADD CONSTRAINT "sale_item_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_item" ADD CONSTRAINT "sale_item_product_uom_id_fkey" FOREIGN KEY ("product_uom_id") REFERENCES "product_uom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt" ADD CONSTRAINT "receipt_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt" ADD CONSTRAINT "receipt_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt" ADD CONSTRAINT "receipt_signature_id_fkey" FOREIGN KEY ("signature_id") REFERENCES "signature"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature" ADD CONSTRAINT "signature_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature" ADD CONSTRAINT "signature_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature" ADD CONSTRAINT "signature_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "sales_return"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_received_by_user_id_fkey" FOREIGN KEY ("received_by_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_reversed_by_user_id_fkey" FOREIGN KEY ("reversed_by_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_route_stop_id_fkey" FOREIGN KEY ("route_stop_id") REFERENCES "route_stop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_reversal_of_id_fkey" FOREIGN KEY ("reversal_of_id") REFERENCES "payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocation" ADD CONSTRAINT "payment_allocation_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocation" ADD CONSTRAINT "payment_allocation_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocation" ADD CONSTRAINT "payment_allocation_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
ALTER TABLE "sales_return" ADD CONSTRAINT "sales_return_inventory_transaction_id_fkey" FOREIGN KEY ("inventory_transaction_id") REFERENCES "inventory_transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return" ADD CONSTRAINT "sales_return_credit_memo_id_fkey" FOREIGN KEY ("credit_memo_id") REFERENCES "credit_memo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_item" ADD CONSTRAINT "sales_return_item_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_item" ADD CONSTRAINT "sales_return_item_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "sales_return"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_item" ADD CONSTRAINT "sales_return_item_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_item" ADD CONSTRAINT "sales_return_item_product_uom_id_fkey" FOREIGN KEY ("product_uom_id") REFERENCES "product_uom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_memo" ADD CONSTRAINT "credit_memo_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_memo" ADD CONSTRAINT "credit_memo_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_memo_application" ADD CONSTRAINT "credit_memo_application_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_memo_application" ADD CONSTRAINT "credit_memo_application_credit_memo_id_fkey" FOREIGN KEY ("credit_memo_id") REFERENCES "credit_memo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_memo_application" ADD CONSTRAINT "credit_memo_application_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_sequence" ADD CONSTRAINT "document_sequence_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_job" ADD CONSTRAINT "import_job_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_job" ADD CONSTRAINT "import_job_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_row" ADD CONSTRAINT "import_row_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_row" ADD CONSTRAINT "import_row_import_job_id_fkey" FOREIGN KEY ("import_job_id") REFERENCES "import_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_connection" ADD CONSTRAINT "integration_connection_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_connection" ADD CONSTRAINT "integration_connection_connected_by_user_id_fkey" FOREIGN KEY ("connected_by_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_mapping" ADD CONSTRAINT "external_mapping_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_job" ADD CONSTRAINT "sync_job_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_log" ADD CONSTRAINT "sync_log_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_log" ADD CONSTRAINT "sync_log_sync_job_id_fkey" FOREIGN KEY ("sync_job_id") REFERENCES "sync_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
