import { unsafeDb } from '@/server/db/client'
import { db } from '@/server/db/tenant'
import type { AuthContext } from '@/server/auth/context'
import { requirePermission } from '@/server/auth/context'
import { notFound } from '@/lib/errors'
import { toAmountString } from '@/server/domain/money'
import { Prisma } from '@/generated/prisma/client'
import type { DocumentParty, ReceiptDocument } from './types'

/**
 * The credit memo as a document (spec §10).
 *
 * Built into the same `ReceiptDocument` shape a receipt uses, so the web view,
 * the full-page PDF, the thermal roll, the email and the share link are the
 * ones already written and tested — a credit memo cannot drift into looking
 * like a different product.
 *
 * Everything is read from the snapshots taken when the credit was issued. A
 * credit reprinted next year shows the price that was actually credited, the
 * store's address at the time, and the company name that issued it.
 */

const SELECT = {
  id: true, number: true, status: true, issuedAt: true, notes: true, reason: true,
  subtotal: true, discountTotal: true, taxTotal: true, amount: true,
  remainingAmount: true, refundedAmount: true,
  billToJson: true, issuerJson: true,
  voidedAt: true, voidReason: true,
  customer: {
    select: {
      id: true, name: true, accountNumber: true, phone: true, email: true,
      addressLine1: true, addressLine2: true, city: true, state: true, postalCode: true,
    },
  },
  sale: { select: { id: true, saleNumber: true } },
  issuedBy: { select: { firstName: true, lastName: true } },
  voidedBy: { select: { firstName: true, lastName: true } },
  items: {
    orderBy: { sortOrder: 'asc' },
    select: {
      id: true, descriptionSnapshot: true, skuSnapshot: true, uomLabelSnapshot: true,
      quantity: true, unitPrice: true, lineSubtotal: true, discountAmount: true,
      taxAmount: true, lineTotal: true,
    },
  },
  applications: {
    where: { status: 'APPLIED' as const },
    select: { amount: true, sale: { select: { saleNumber: true } } },
  },
  refunds: {
    where: { status: 'POSTED' as const },
    select: { amount: true, method: true, referenceNumber: true, refundNumber: true },
  },
  return: {
    select: {
      returnNumber: true,
      items: {
        select: {
          productNameSnapshot: true, quantity: true, uomLabelSnapshot: true, disposition: true,
        },
      },
    },
  },
} satisfies Prisma.CreditMemoSelect

type MemoRow = Prisma.CreditMemoGetPayload<{ select: typeof SELECT }>

const ORG_SELECT = {
  name: true, legalName: true, phone: true, email: true, logoUrl: true,
  receiptFooter: true, addressLine1: true, addressLine2: true, city: true,
  state: true, postalCode: true, currency: true, timezone: true,
} satisfies Prisma.OrganizationSelect

type OrgRow = Prisma.OrganizationGetPayload<{ select: typeof ORG_SELECT }>

const DISPOSITION_LABELS: Record<string, string> = {
  RESTOCK_TRUCK: 'Back on the truck',
  RESTOCK_WAREHOUSE: 'Back to the warehouse',
  DAMAGED: 'Written off — damaged',
  EXPIRED: 'Written off — expired',
  SUPPLIER_RETURN: 'Returned to supplier',
  NONE: 'No goods returned',
}

const REASON_LABELS: Record<string, string> = {
  DAMAGED: 'Damaged',
  EXPIRED: 'Expired',
  WRONG_ITEM: 'Wrong product',
  UNSOLD: 'Unsold stock',
  SWAP: 'Product swap',
  PRICING_ERROR: 'Pricing error',
  DELIVERY_ERROR: 'Delivery error',
  OTHER: 'Other',
}

export async function getCreditDocument(
  ctx: AuthContext,
  creditMemoId: string,
): Promise<ReceiptDocument> {
  requirePermission(ctx, 'receipt:read')
  const prisma = db(ctx)

  const [memo, organization] = await Promise.all([
    prisma.creditMemo.findFirst({ where: { id: creditMemoId }, select: SELECT }),
    prisma.organization.findFirstOrThrow({
      where: { id: ctx.organizationId },
      select: ORG_SELECT,
    }),
  ])
  if (!memo) throw notFound('That credit memo')

  return shape(memo, organization)
}

/** The same document for a visitor holding a valid share link (docs/04 §5). */
export async function getPublicCreditDocument(
  organizationId: string,
  creditMemoId: string,
): Promise<ReceiptDocument> {
  const [memo, organization] = await Promise.all([
    unsafeDb.creditMemo.findFirst({
      where: { id: creditMemoId, organizationId },
      select: SELECT,
    }),
    unsafeDb.organization.findFirstOrThrow({ where: { id: organizationId }, select: ORG_SELECT }),
  ])
  if (!memo) throw notFound('That credit memo')

  return shape(memo, organization)
}

function shape(memo: MemoRow, organization: OrgRow): ReceiptDocument {
  const storedIssuer = asParty(memo.issuerJson)
  const storedBillTo = asParty(memo.billToJson)
  const issuerExtras = asIssuerExtras(memo.issuerJson)

  const issuer: DocumentParty = storedIssuer ?? {
    name: organization.name,
    subtitle: organization.legalName,
    addressLines: addressLines(organization),
    phone: organization.phone,
    email: organization.email,
  }

  const billTo: DocumentParty = storedBillTo ?? {
    name: memo.customer.name,
    subtitle: `#${memo.customer.accountNumber}`,
    addressLines: addressLines(memo.customer),
    phone: memo.customer.phone,
    email: memo.customer.email,
  }

  const applied = memo.applications.reduce((total, a) => total + Number(a.amount), 0)
  const refunded = Number(memo.refundedAmount)
  const remaining = Number(memo.remainingAmount)

  return {
    kind: 'creditMemo',
    documentId: memo.id,
    saleId: memo.sale?.id ?? '',
    saleNumber: memo.return?.returnNumber ?? memo.number,
    receiptNumber: memo.number,
    status: memo.status === 'VOIDED' ? 'VOIDED' : 'COMPLETED',
    occurredAt: memo.issuedAt.toISOString(),
    issuedAt: memo.issuedAt.toISOString(),
    dueDate: null,
    paymentTermsCode: 'CREDIT',
    notes: memo.notes,

    issuer,
    logoUrl: issuerExtras.logoUrl ?? organization.logoUrl,
    footer: issuerExtras.footer ?? organization.receiptFooter,
    currency: organization.currency,
    timeZone: organization.timezone,

    billTo,
    customerId: memo.customer.id,
    soldByName: memo.issuedBy
      ? `${memo.issuedBy.firstName} ${memo.issuedBy.lastName}`.trim()
      : '',

    lines: memo.items.map((item) => ({
      id: item.id,
      name: item.descriptionSnapshot,
      sku: item.skuSnapshot,
      uomLabel: item.uomLabelSnapshot,
      quantity: item.quantity,
      unitPrice: toAmountString(item.unitPrice),
      lineSubtotal: toAmountString(item.lineSubtotal),
      discountAmount: toAmountString(item.discountAmount),
      taxAmount: toAmountString(item.taxAmount),
      lineTotal: toAmountString(item.lineTotal),
    })),
    subtotal: toAmountString(memo.subtotal),
    discountTotal: toAmountString(memo.discountTotal),
    taxTotal: toAmountString(memo.taxTotal),
    total: toAmountString(memo.amount),
    // On a credit memo these read as "of the credit, this much is spent" and
    // "this much is still available".
    amountPaid: toAmountString(applied + refunded),
    balanceDue: toAmountString(remaining),
    payments: memo.refunds.map((refund) => ({
      method: refund.method,
      amount: toAmountString(refund.amount),
      reference: refund.referenceNumber ?? refund.refundNumber,
    })),

    signature: null,

    void: memo.voidedAt
      ? {
          voidedAt: memo.voidedAt.toISOString(),
          reason: memo.voidReason,
          voidedByName: memo.voidedBy
            ? `${memo.voidedBy.firstName} ${memo.voidedBy.lastName}`.trim()
            : null,
        }
      : null,

    credit: {
      againstSaleNumber: memo.sale?.saleNumber ?? null,
      reason: REASON_LABELS[memo.reason] ?? memo.reason,
      disposition: describeDisposition(memo, applied, refunded, remaining),
      applied: toAmountString(applied),
      refunded: toAmountString(refunded),
      remaining: toAmountString(remaining),
      returnedLines: (memo.return?.items ?? []).map((item) => ({
        name: item.productNameSnapshot,
        quantity: item.quantity,
        uomLabel: item.uomLabelSnapshot,
        disposition: DISPOSITION_LABELS[item.disposition] ?? item.disposition,
      })),
    },

    headerFromSnapshot: storedIssuer !== null && storedBillTo !== null,
  }
}

/**
 * One line telling the store what actually happened to their money — the
 * question a credit memo exists to answer (spec §10).
 */
function describeDisposition(
  memo: MemoRow,
  applied: number,
  refunded: number,
  remaining: number,
): string {
  if (memo.status === 'VOIDED') return 'Voided — this credit no longer applies'

  const parts: string[] = []
  if (applied > 0) {
    const invoices = memo.applications.map((a) => a.sale.saleNumber).join(', ')
    parts.push(`Applied to ${invoices}`)
  }
  if (refunded > 0) {
    const methods = [...new Set(memo.refunds.map((r) => r.method.toLowerCase()))].join(' and ')
    parts.push(`Refunded by ${methods}`)
  }
  if (remaining > 0) parts.push('Available as credit on your account')

  return parts.length > 0 ? parts.join(' · ') : 'Available as credit on your account'
}

function addressLines(source: {
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  state: string | null
  postalCode: string | null
}): string[] {
  const cityLine = [source.city, source.state].filter(Boolean).join(', ')
  return [
    source.addressLine1,
    source.addressLine2,
    [cityLine, source.postalCode].filter(Boolean).join(' '),
  ].filter((line): line is string => Boolean(line && line.trim()))
}

function asParty(value: unknown): DocumentParty | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.name !== 'string') return null

  return {
    name: raw.name,
    subtitle: typeof raw.subtitle === 'string' ? raw.subtitle : null,
    addressLines: Array.isArray(raw.addressLines)
      ? raw.addressLines.filter((line): line is string => typeof line === 'string')
      : [],
    phone: typeof raw.phone === 'string' ? raw.phone : null,
    email: typeof raw.email === 'string' ? raw.email : null,
  }
}

function asIssuerExtras(value: unknown): { logoUrl: string | null; footer: string | null } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { logoUrl: null, footer: null }
  }
  const raw = value as Record<string, unknown>
  return {
    logoUrl: typeof raw.logoUrl === 'string' ? raw.logoUrl : null,
    footer: typeof raw.footer === 'string' ? raw.footer : null,
  }
}
