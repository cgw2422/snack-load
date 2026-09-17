import { Prisma } from "@/generated/prisma/client";
import { db } from "@/server/db/tenant";
import type { AuthContext } from "@/server/auth/context";
import { requirePermission } from "@/server/auth/context";
import { conflict, notFound } from "@/lib/errors";
import { m, round2, toAmountString } from "@/server/domain/money";
import { nextDocumentNumber } from "./inventory.service";
import { writeAudit } from "./audit.service";
import type {
  ApplyCreditInput,
  CreateAdjustmentCreditInput,
  CreateRefundInput,
} from "@/lib/schemas/returns";

/**
 * Credit memos, allocations and refunds (spec §4, §6–§9).
 *
 * The distinction this file exists to protect: **an unapplied credit has not
 * reduced any invoice.** A store with a $500 invoice and a $100 credit owes
 * $500 and holds $100 — not "owes $400" — until somebody applies the credit,
 * at which point a `CreditMemoApplication` says which invoice it went to and
 * by how much. Netting the two in a balance field would be a number nobody can
 * reconcile against a document (spec §12).
 *
 * A credit memo's `remainingAmount` is therefore the money still unspent:
 *
 *     amount = Σ applications(APPLIED) + refundedAmount + remainingAmount
 *
 * and that identity is asserted by the reconciliation suite.
 */

export type CreditPosition = {
  /** Open invoice balances. Never negative. */
  openInvoices: string;
  /** Unapplied payment over-payment sitting on the account. */
  paymentCredit: string;
  /** Unspent credit-memo money. */
  memoCredit: string;
  /** paymentCredit + memoCredit. */
  totalCredit: string;
  /** openInvoices − totalCredit. Negative means the store is in credit. */
  net: string;
};

/**
 * One store's whole financial position (spec §7).
 *
 * Read from the documents every time, never from a cached net figure, so it
 * cannot drift away from the invoices and credits it claims to summarise.
 */
export async function getCreditPosition(
  ctx: AuthContext,
  customerId: string,
): Promise<CreditPosition> {
  const prisma = db(ctx);

  const [invoices, payments, memos] = await Promise.all([
    prisma.sale.aggregate({
      where: { customerId, status: "COMPLETED", balanceDue: { gt: 0 } },
      _sum: { balanceDue: true },
    }),
    prisma.payment.aggregate({
      where: { customerId, status: "POSTED", unappliedAmount: { gt: 0 } },
      _sum: { unappliedAmount: true },
    }),
    prisma.creditMemo.aggregate({
      where: {
        customerId,
        status: { in: ["OPEN", "APPLIED"] },
        remainingAmount: { gt: 0 },
      },
      _sum: { remainingAmount: true },
    }),
  ]);

  const openInvoices = m(invoices._sum.balanceDue ?? 0);
  const paymentCredit = m(payments._sum.unappliedAmount ?? 0);
  const memoCredit = m(memos._sum.remainingAmount ?? 0);
  const totalCredit = paymentCredit.plus(memoCredit);

  return {
    openInvoices: toAmountString(openInvoices),
    paymentCredit: toAmountString(paymentCredit),
    memoCredit: toAmountString(memoCredit),
    totalCredit: toAmountString(totalCredit),
    net: toAmountString(openInvoices.minus(totalCredit)),
  };
}

export type ApplyCreditResult = {
  creditMemoId: string;
  applied: string;
  remaining: string;
  invoices: { saleId: string; saleNumber: string; amount: string }[];
};

/**
 * Applies credit to open invoices (spec §6).
 *
 * The invoice the credit was raised against is settled first, then the rest
 * oldest-first. Each application reduces exactly one invoice's `balanceDue` and
 * is recorded as its own row, so "which invoice did that credit go to" always
 * has an answer.
 */
export async function applyCreditMemo(
  ctx: AuthContext,
  input: ApplyCreditInput,
): Promise<ApplyCreditResult> {
  requirePermission(ctx, "credit:apply");
  const prisma = db(ctx);

  const memo = await prisma.creditMemo.findFirst({
    where: { id: input.creditMemoId },
    select: {
      id: true,
      number: true,
      customerId: true,
      status: true,
      remainingAmount: true,
      saleId: true,
      customer: { select: { name: true } },
    },
  });
  if (!memo) throw notFound("That credit memo");
  if (memo.status === "VOIDED")
    throw conflict(`${memo.number} has been voided.`);

  let available = m(memo.remainingAmount);
  if (available.lessThanOrEqualTo(0)) {
    return {
      creditMemoId: memo.id,
      applied: "0.00",
      remaining: "0.00",
      invoices: [],
    };
  }

  const openInvoices = await prisma.sale.findMany({
    where: {
      customerId: memo.customerId,
      status: "COMPLETED",
      balanceDue: { gt: 0 },
    },
    orderBy: [{ dueDate: "asc" }, { occurredAt: "asc" }],
    select: { id: true, saleNumber: true, balanceDue: true },
  });

  // The invoice the credit came from goes first, then oldest.
  //
  // Pure oldest-first is what a payment does, and it is what this did until a
  // run-through showed how it reads at the counter: a runner takes a case back
  // off today's bill, chooses "credit it against what they owe", and today's
  // bill does not move because the money went to something from three weeks
  // ago. The store is looking at the invoice in their hand. So the originating
  // invoice is settled first and only the remainder ages backwards — which
  // still clears old debt, just not ahead of the debt being disputed.
  const open =
    memo.saleId && openInvoices.some((sale) => sale.id === memo.saleId)
      ? [
          openInvoices.find((sale) => sale.id === memo.saleId)!,
          ...openInvoices.filter((sale) => sale.id !== memo.saleId),
        ]
      : openInvoices;

  const wanted = new Map(
    (input.allocations ?? []).map((a) => [a.saleId, round2(a.amount)]),
  );
  if (wanted.size > 0) {
    for (const saleId of wanted.keys()) {
      if (!open.some((sale) => sale.id === saleId)) {
        throw conflict("That invoice is not open on this account.");
      }
    }
  }

  const plan: {
    saleId: string;
    saleNumber: string;
    amount: ReturnType<typeof m>;
  }[] = [];
  for (const sale of open) {
    if (available.lessThanOrEqualTo(0)) break;

    const ceiling = m(sale.balanceDue);
    const requested = wanted.size > 0 ? wanted.get(sale.id) : ceiling;
    if (!requested || requested.lessThanOrEqualTo(0)) continue;

    if (requested.greaterThan(ceiling)) {
      throw conflict(
        `${sale.saleNumber} only has ${toAmountString(ceiling)} outstanding; cannot apply ${toAmountString(requested)}.`,
      );
    }

    const amount = requested.greaterThan(available) ? available : requested;
    plan.push({ saleId: sale.id, saleNumber: sale.saleNumber, amount });
    available = available.minus(amount);
  }

  if (plan.length === 0) {
    return {
      creditMemoId: memo.id,
      applied: "0.00",
      remaining: toAmountString(m(memo.remainingAmount)),
      invoices: [],
    };
  }

  const applied = plan.reduce((total, p) => total.plus(p.amount), m(0));

  await prisma.$transaction(async (tx) => {
    for (const entry of plan) {
      await tx.creditMemoApplication.create({
        data: {
          organizationId: ctx.organizationId,
          creditMemoId: memo.id,
          saleId: entry.saleId,
          amount: toAmountString(entry.amount),
          appliedByUserId: ctx.userId,
        },
      });

      const sale = await tx.sale.findFirstOrThrow({
        where: { id: entry.saleId },
        select: { balanceDue: true, creditsApplied: true },
      });
      await tx.sale.update({
        where: { id: entry.saleId },
        data: {
          balanceDue: toAmountString(m(sale.balanceDue).minus(entry.amount)),
          creditsApplied: toAmountString(
            m(sale.creditsApplied).plus(entry.amount),
          ),
        },
      });
    }

    const remaining = available;
    await tx.creditMemo.update({
      where: { id: memo.id },
      data: {
        remainingAmount: toAmountString(remaining),
        status: remaining.lessThanOrEqualTo(0) ? "APPLIED" : "OPEN",
      },
    });

    // The AR cache follows the invoices it summarises.
    await tx.customer.update({
      where: { id: memo.customerId },
      data: { balance: { decrement: toAmountString(applied) } },
    });

    await writeAudit(tx, ctx, {
      action: "credit.applied",
      entityType: "CreditMemo",
      entityId: memo.id,
      after: {
        creditMemo: memo.number,
        customerName: memo.customer.name,
        applied: toAmountString(applied),
        remaining: toAmountString(remaining),
        invoices: plan.map((p) => ({
          saleNumber: p.saleNumber,
          amount: toAmountString(p.amount),
        })),
      },
    });
  });

  return {
    creditMemoId: memo.id,
    applied: toAmountString(applied),
    remaining: toAmountString(available),
    invoices: plan.map((p) => ({
      saleId: p.saleId,
      saleNumber: p.saleNumber,
      amount: toAmountString(p.amount),
    })),
  };
}

/**
 * Unapplies a credit from an invoice.
 *
 * The application row is marked REVERSED rather than deleted, so the history
 * still shows that the credit was once applied and then taken back. Needed
 * before a credit memo can be voided (spec §9).
 */
export async function unapplyCreditMemo(
  ctx: AuthContext,
  creditMemoId: string,
): Promise<{ restored: string }> {
  requirePermission(ctx, "credit:apply");
  const prisma = db(ctx);

  const memo = await prisma.creditMemo.findFirst({
    where: { id: creditMemoId },
    select: {
      id: true,
      number: true,
      customerId: true,
      remainingAmount: true,
      status: true,
      applications: {
        where: { status: "APPLIED" },
        select: { id: true, saleId: true, amount: true },
      },
    },
  });
  if (!memo) throw notFound("That credit memo");
  if (memo.applications.length === 0) return { restored: "0.00" };

  const restored = memo.applications.reduce(
    (total, a) => total.plus(m(a.amount)),
    m(0),
  );

  await prisma.$transaction(async (tx) => {
    for (const application of memo.applications) {
      await tx.creditMemoApplication.update({
        where: { id: application.id },
        data: { status: "REVERSED", reversedAt: new Date() },
      });

      const sale = await tx.sale.findFirstOrThrow({
        where: { id: application.saleId },
        select: { balanceDue: true, creditsApplied: true },
      });
      await tx.sale.update({
        where: { id: application.saleId },
        data: {
          balanceDue: toAmountString(
            m(sale.balanceDue).plus(application.amount),
          ),
          creditsApplied: toAmountString(
            m(sale.creditsApplied).minus(application.amount),
          ),
        },
      });
    }

    await tx.creditMemo.update({
      where: { id: memo.id },
      data: {
        remainingAmount: toAmountString(m(memo.remainingAmount).plus(restored)),
        status: "OPEN",
      },
    });

    await tx.customer.update({
      where: { id: memo.customerId },
      data: { balance: { increment: toAmountString(restored) } },
    });

    await writeAudit(tx, ctx, {
      action: "credit.unapplied",
      entityType: "CreditMemo",
      entityId: memo.id,
      after: { creditMemo: memo.number, restored: toAmountString(restored) },
    });
  });

  return { restored: toAmountString(restored) };
}

export type RefundResult = {
  refundId: string;
  refundNumber: string;
  amount: string;
  remainingCredit: string;
  replayed: boolean;
};

/**
 * Money leaving the drawer (spec §8).
 *
 * A refund is not a reversed payment. Reversing a payment says the money never
 * arrived; a refund says it arrived and was given back, and an audit needs both
 * stories told separately. The refund draws down the credit memo it is paid
 * from, so a store cannot be refunded twice for the same return.
 */
export async function issueRefund(
  ctx: AuthContext,
  input: CreateRefundInput,
): Promise<RefundResult> {
  requirePermission(ctx, "refund:create");
  const prisma = db(ctx);

  const replay = await prisma.refund.findFirst({
    where: { idempotencyKey: input.idempotencyKey },
    select: {
      id: true,
      refundNumber: true,
      amount: true,
      creditMemo: { select: { remainingAmount: true } },
    },
  });
  if (replay) {
    return {
      refundId: replay.id,
      refundNumber: replay.refundNumber,
      amount: toAmountString(replay.amount),
      remainingCredit: toAmountString(replay.creditMemo.remainingAmount),
      replayed: true,
    };
  }

  const memo = await prisma.creditMemo.findFirst({
    where: { id: input.creditMemoId },
    select: {
      id: true,
      number: true,
      customerId: true,
      status: true,
      remainingAmount: true,
      refundedAmount: true,
      customer: { select: { name: true } },
    },
  });
  if (!memo) throw notFound("That credit memo");
  if (memo.status === "VOIDED")
    throw conflict(`${memo.number} has been voided.`);

  const amount = round2(input.amount);
  if (amount.lessThanOrEqualTo(0))
    throw conflict("Enter how much is being refunded.");
  if (amount.greaterThan(m(memo.remainingAmount))) {
    throw conflict(
      `${memo.number} has ${toAmountString(memo.remainingAmount)} left. ` +
        "Apply or release the rest before refunding more.",
    );
  }

  const remaining = m(memo.remainingAmount).minus(amount);

  const created = await prisma.$transaction(async (tx) => {
    const refundNumber = await nextDocumentNumber(
      tx,
      ctx.organizationId,
      "REFUND",
    );

    const refund = await tx.refund.create({
      data: {
        organizationId: ctx.organizationId,
        refundNumber,
        customerId: memo.customerId,
        creditMemoId: memo.id,
        amount: toAmountString(amount),
        method: input.method,
        issuedByUserId: ctx.userId,
        referenceNumber: input.referenceNumber || null,
        notes: input.notes || null,
        idempotencyKey: input.idempotencyKey,
      },
      select: { id: true, refundNumber: true },
    });

    await tx.creditMemo.update({
      where: { id: memo.id },
      data: {
        remainingAmount: toAmountString(remaining),
        refundedAmount: toAmountString(m(memo.refundedAmount).plus(amount)),
        status: remaining.lessThanOrEqualTo(0) ? "APPLIED" : "OPEN",
      },
    });

    await writeAudit(tx, ctx, {
      action: "refund.issued",
      entityType: "Refund",
      entityId: refund.id,
      after: {
        refundNumber: refund.refundNumber,
        creditMemo: memo.number,
        customerName: memo.customer.name,
        amount: toAmountString(amount),
        method: input.method,
        reference: input.referenceNumber || null,
      },
    });

    return refund;
  });

  return {
    refundId: created.id,
    refundNumber: created.refundNumber,
    amount: toAmountString(amount),
    remainingCredit: toAmountString(remaining),
    replayed: false,
  };
}

/** Voiding a refund puts the money back on the credit memo, not into the void. */
export async function voidRefund(
  ctx: AuthContext,
  refundId: string,
  reason: string,
): Promise<void> {
  requirePermission(ctx, "refund:void");
  const prisma = db(ctx);

  const refund = await prisma.refund.findFirst({
    where: { id: refundId },
    select: {
      id: true,
      refundNumber: true,
      status: true,
      amount: true,
      creditMemo: {
        select: {
          id: true,
          number: true,
          remainingAmount: true,
          refundedAmount: true,
          status: true,
        },
      },
    },
  });
  if (!refund) throw notFound("That refund");
  if (refund.status !== "POSTED")
    throw conflict("That refund has already been voided.");

  await prisma.$transaction(async (tx) => {
    await tx.refund.update({
      where: { id: refund.id },
      data: {
        status: "VOIDED",
        voidedAt: new Date(),
        voidedByUserId: ctx.userId,
        voidReason: reason,
      },
    });

    // The credit comes back unless the memo itself was voided, in which case
    // there is nothing to come back to.
    if (refund.creditMemo.status !== "VOIDED") {
      await tx.creditMemo.update({
        where: { id: refund.creditMemo.id },
        data: {
          remainingAmount: toAmountString(
            m(refund.creditMemo.remainingAmount).plus(refund.amount),
          ),
          refundedAmount: toAmountString(
            m(refund.creditMemo.refundedAmount).minus(refund.amount),
          ),
          status: "OPEN",
        },
      });
    }

    await writeAudit(tx, ctx, {
      action: "refund.voided",
      entityType: "Refund",
      entityId: refund.id,
      after: {
        refundNumber: refund.refundNumber,
        creditMemo: refund.creditMemo.number,
        amount: toAmountString(refund.amount),
        reason,
      },
    });
  });
}

/**
 * A credit with no goods behind it (spec §3): a pricing mistake, a goodwill
 * gesture. It issues money and nothing else — no ledger line, no COGS reversal.
 */
export async function createAdjustmentCredit(
  ctx: AuthContext,
  input: CreateAdjustmentCreditInput,
): Promise<{
  creditMemoId: string;
  number: string;
  amount: string;
  applied: string;
  remaining: string;
}> {
  requirePermission(ctx, "credit:create");
  const prisma = db(ctx);

  const replay = await replayAdjustmentCredit(ctx, input.idempotencyKey);
  if (replay) return replay;

  const customer = await prisma.customer.findFirst({
    where: { id: input.customerId },
    select: { id: true, name: true },
  });
  if (!customer) throw notFound("That store");

  const subtotal = round2(input.amount);
  const tax = round2(input.taxAmount ?? 0);
  const total = subtotal.plus(tax);
  if (total.lessThanOrEqualTo(0)) throw conflict("Enter how much to credit.");

  const parties = await snapshotParties(ctx, customer.id);

  let memo: { id: string; number: string };
  try {
    memo = await prisma.$transaction(async (tx) => {
      const number = await nextDocumentNumber(
        tx,
        ctx.organizationId,
        "CREDIT_MEMO",
      );

      const created = await tx.creditMemo.create({
        data: {
          organizationId: ctx.organizationId,
          customerId: customer.id,
          number,
          saleId: input.saleId || null,
          issuedByUserId: ctx.userId,
          reason: input.reason,
          subtotal: toAmountString(subtotal),
          taxTotal: toAmountString(tax),
          amount: toAmountString(total),
          remainingAmount: toAmountString(total),
          // Dedicated column, unique per organization. `notes` is what a human
          // typed and nothing else; it is printed on the credit, and a key hidden
          // in it was both visible accounting data and defeatable by editing.
          idempotencyKey: input.idempotencyKey,
          notes: input.notes || null,
          billToJson: parties.billTo,
          issuerJson: parties.issuer,
          items: {
            create: [
              {
                organizationId: ctx.organizationId,
                saleItemId: null,
                descriptionSnapshot: input.description,
                quantity: 0,
                baseQuantity: 0,
                lineSubtotal: toAmountString(subtotal),
                taxableAmount: toAmountString(
                  tax.greaterThan(0) ? subtotal : 0,
                ),
                // Derived from the two figures somebody typed, because a hand-
                // written credit has no rate behind it to snapshot.
                taxRateApplied:
                  tax.greaterThan(0) && subtotal.greaterThan(0)
                    ? tax.dividedBy(subtotal).toDecimalPlaces(6).toString()
                    : "0",
                taxAmount: toAmountString(tax),
                lineTotal: toAmountString(total),
                taxable: tax.greaterThan(0),
                // Nothing came back, so there is no cost to reverse.
                unitCostAtSale: "0",
                reason: input.reason,
              },
            ],
          },
        },
        select: { id: true, number: true },
      });

      await writeAudit(tx, ctx, {
        action: "credit.issued",
        entityType: "CreditMemo",
        entityId: created.id,
        after: {
          number: created.number,
          customerName: customer.name,
          amount: toAmountString(total),
          reason: input.reason,
          description: input.description,
        },
      });

      return created;
    });
  } catch (error) {
    if (!isDuplicateKeyViolation(error)) throw error;

    // Two requests carrying one key were in flight together, and the unique
    // index settled it. Postgres makes the loser wait on the winner's row and
    // only then rejects, so the winner has committed and its document is
    // readable now. One credit is posted, and the caller cannot tell which of
    // the two requests created it — which is what idempotent means.
    const settled = await replayAdjustmentCredit(ctx, input.idempotencyKey);
    if (settled) return settled;
    throw error;
  }

  if (input.financialAction === "APPLY_TO_BALANCE") {
    const result = await applyCreditMemo(ctx, { creditMemoId: memo.id });
    return {
      creditMemoId: memo.id,
      number: memo.number,
      amount: toAmountString(total),
      applied: result.applied,
      remaining: result.remaining,
    };
  }

  return {
    creditMemoId: memo.id,
    number: memo.number,
    amount: toAmountString(total),
    applied: "0.00",
    remaining: toAmountString(total),
  };
}

/** Voiding a credit memo that has not been spent (spec §9). */
export async function voidCreditMemo(
  ctx: AuthContext,
  creditMemoId: string,
  reason: string,
): Promise<void> {
  requirePermission(ctx, "credit:void");
  const prisma = db(ctx);

  const memo = await prisma.creditMemo.findFirst({
    where: { id: creditMemoId },
    select: {
      id: true,
      number: true,
      status: true,
      amount: true,
      remainingAmount: true,
      return: { select: { id: true, returnNumber: true } },
      applications: { where: { status: "APPLIED" }, select: { id: true } },
      refunds: { where: { status: "POSTED" }, select: { refundNumber: true } },
    },
  });
  if (!memo) throw notFound("That credit memo");
  if (memo.status === "VOIDED")
    throw conflict("That credit memo has already been voided.");

  if (memo.refunds.length > 0) {
    throw conflict(
      `${memo.number} has been refunded (${memo.refunds.map((r) => r.refundNumber).join(", ")}). ` +
        "Void the refund first.",
    );
  }
  if (memo.applications.length > 0) {
    throw conflict(
      `${memo.number} is applied to an invoice. Unapply it first.`,
    );
  }
  if (memo.return) {
    throw conflict(
      `${memo.number} was issued by return ${memo.return.returnNumber}. Void the return instead, ` +
        "so the goods go back as well as the money.",
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.creditMemo.update({
      where: { id: memo.id },
      data: {
        status: "VOIDED",
        remainingAmount: "0",
        voidedAt: new Date(),
        voidedByUserId: ctx.userId,
        voidReason: reason,
      },
    });

    await writeAudit(tx, ctx, {
      action: "credit.voided",
      entityType: "CreditMemo",
      entityId: memo.id,
      after: {
        number: memo.number,
        amount: toAmountString(memo.amount),
        reason,
      },
    });
  });
}

/**
 * The store and company header, snapshotted onto a credit memo exactly as it is
 * onto a sale, so a reprint next year shows the address the goods went to.
 */
export async function snapshotParties(
  ctx: AuthContext,
  customerId: string,
): Promise<{ billTo: Prisma.InputJsonObject; issuer: Prisma.InputJsonObject }> {
  const prisma = db(ctx);

  const [customer, issuer] = await Promise.all([
    prisma.customer.findFirstOrThrow({
      where: { id: customerId },
      select: {
        name: true,
        accountNumber: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        state: true,
        postalCode: true,
        phone: true,
        email: true,
      },
    }),
    prisma.organization.findFirstOrThrow({
      where: { id: ctx.organizationId },
      select: {
        name: true,
        legalName: true,
        phone: true,
        email: true,
        logoUrl: true,
        receiptFooter: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        state: true,
        postalCode: true,
      },
    }),
  ]);

  return {
    billTo: party({ ...customer, subtitle: `#${customer.accountNumber}` }),
    issuer: {
      ...party({ ...issuer, subtitle: issuer.legalName }),
      logoUrl: issuer.logoUrl,
      footer: issuer.receiptFooter,
    },
  };
}

function party(source: {
  name: string;
  subtitle: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  phone: string | null;
  email: string | null;
}): Prisma.InputJsonObject {
  const cityLine = [source.city, source.state].filter(Boolean).join(", ");
  return {
    name: source.name,
    subtitle: source.subtitle,
    addressLines: [
      source.addressLine1,
      source.addressLine2,
      [cityLine, source.postalCode].filter(Boolean).join(" "),
    ].filter((line) => Boolean(line && line.trim())),
    phone: source.phone,
    email: source.email,
  };
}

// ─── adjustment-credit idempotency ───────────────────────────────────────────

/**
 * Returns the credit a key has already posted, or null.
 *
 * Reads the dedicated column, not `notes`. The key never touches accounting
 * data: it is not printed on the document, editing the note cannot defeat it,
 * and two credits that happen to carry the same human note are two credits.
 */
async function replayAdjustmentCredit(
  ctx: AuthContext,
  idempotencyKey: string,
): Promise<{
  creditMemoId: string;
  number: string;
  amount: string;
  applied: string;
  remaining: string;
} | null> {
  const existing = await db(ctx).creditMemo.findFirst({
    where: { idempotencyKey },
    select: { id: true, number: true, amount: true, remainingAmount: true },
  });
  if (!existing) return null;

  return {
    creditMemoId: existing.id,
    number: existing.number,
    amount: toAmountString(existing.amount),
    applied: toAmountString(m(existing.amount).minus(existing.remainingAmount)),
    remaining: toAmountString(existing.remainingAmount),
  };
}

/** Postgres 23505 through Prisma, i.e. somebody else got there first. */
function isDuplicateKeyViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}
