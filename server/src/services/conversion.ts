import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { scopedFor } from '../db/scoped.js';
import { ApiError } from '../lib/errors.js';
import { normalizeIndianMobile } from '../lib/mobile.js';
import { addDays } from '../lib/dates.js';
import { isAdmin, type Actor } from '../auth/scope.js';
import { findCatalogueProductByName } from './catalogue.js';
import { lineTotal, nextOrderNumber, payableAmount } from './orders.js';
import { changeStock, resolveSellerLocation, stockAt } from './inventory.js';
import { auditCreate, auditUpdate } from './audit.js';

/**
 * Converting a lead into an order.
 *
 * This was `convert_lead_to_order`, a SECURITY DEFINER PL/pgSQL routine. Being DEFINER meant
 * it ran with the owner's privileges and so had to re-implement the caller-ownership check
 * itself — reading a session variable to find out who was asking. That indirection is the
 * single thing that made the old design fragile: on a connection where the variable had not
 * been set it read NULL, the check never matched, and the guard silently passed.
 *
 * Here the actor is a parameter. There is no second source of truth about who is calling.
 *
 * Everything happens in one interactive transaction: customer resolution, the order, its
 * lines, stock deduction, the lead's status change and the activity record. A partial
 * conversion — an order with no lines, or stock deducted for an order that failed — is the
 * failure mode worth designing against.
 */
type LeadWithMedicines = {
  id: string;
  quantity: number | null;
  medicineRequired: string | null;
  medicines: { productId: string | null; medicineName: string; days: number | null }[];
};

/** A lead medicine with no stated duration. One month is the usual course here. */
const DEFAULT_SUPPLY_DAYS = 30;

/**
 * Days between a course running out and the renewal being written off.
 *
 * renewalDate is when the medicine runs out — the renewal shows as due from then. expiryDate
 * is the end of the window to act, after which renewalStatus() calls it overdue. The gap is
 * how long a caller has to chase it before it counts as lost.
 */
const RENEWAL_GRACE_DAYS = 7;

export type QuoteLine = {
  productId: string | null;
  name: string;
  /** Units, which equal the days of supply — one unit per day. */
  quantity: number;
  unitPrice: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  /** Days of supply; equal to quantity, and what decides when the renewal falls due. */
  days: number;
};

/**
 * What converting this lead would cost, at today's catalogue prices.
 *
 * Shared by the conversion itself and by the preview the confirmation dialog shows, so the
 * figure the user approves is produced by the same code that later bills it. Computing the
 * preview separately would have been easy and would have drifted.
 */
/** A medicine and its tenure, as chosen at the point of sale. */
export type QuoteRequest = { productId?: string | null; name: string; days: number };

/**
 * Prices an explicit list of medicines.
 *
 * The list arrives from the conversion dialog, where the sale is actually composed. It used
 * to be read off the lead, which meant the medicines had to be guessed at capture time —
 * before anyone knew what the customer would buy.
 */
export async function quoteItems(
  db: Pick<Prisma.TransactionClient, 'product'>,
  items: QuoteRequest[],
  fallbackUnitPrice: Prisma.Decimal | number = 0,
): Promise<{ lines: QuoteLine[]; totalAmount: Prisma.Decimal }> {
  // One unit per day of supply: days is the quantity. Twenty days is twenty units, billed at
  // twenty times the unit price and taking twenty off stock.
  const requested = items
    .map((m) => {
      const days = Number(m.days) || DEFAULT_SUPPLY_DAYS;
      return { productId: m.productId ?? null, name: String(m.name ?? '').trim(), days, quantity: days };
    })
    .filter((m) => m.name);

  if (requested.length === 0) {
    throw ApiError.badRequest('Choose at least one medicine to convert this lead');
  }

  const lines: QuoteLine[] = [];
  let totalAmount = new Prisma.Decimal(0);
  for (const item of requested) {
    // Falls back to matching the name when the stored link is missing. Leads edited before
    // the catalogue lookup was added to that path have productId null on rows whose medicine
    // is very much in the catalogue, and pricing those at zero would be wrong about data
    // that is right there. The link is the fast path, not the only one.
    const product = item.productId
      ? await db.product.findUnique({ where: { id: item.productId } })
      : await findCatalogueProductByName(db, item.name);

    const unitPrice = product?.unitPrice ?? new Prisma.Decimal(fallbackUnitPrice);
    const total_ = lineTotal(item.quantity, unitPrice);
    totalAmount = totalAmount.add(total_);
    lines.push({
      productId: product?.id ?? null,
      name: item.name,
      quantity: item.quantity,
      unitPrice,
      lineTotal: total_,
      days: item.days,
    });
  }
  return { lines, totalAmount };
}

/**
 * Refuses a sale the catalogue cannot cover. Days are units, so a 20-day order needs 20 in
 * stock; if it is not there the whole order is rejected and an admin has to restock first —
 * they are the only role that can. Replaces the old "fulfil anyway and floor at zero".
 */
export function assertStockCovers(name: string, available: number, needed: number) {
  if (available < needed) {
    throw ApiError.badRequest(
      `Not enough ${name} in stock — ${available} in stock, ${needed} needed. Ask an admin to update the stock.`,
    );
  }
}

/** The lead a conversion may proceed against, or the reason it may not. */
async function loadConvertibleLead(db: Prisma.TransactionClient, actor: Actor, leadId: string) {
  const lead = await db.lead.findFirst({
    where: { id: leadId, deletedAt: null },
    include: { medicines: { orderBy: { createdAt: 'asc' } } },
  });
  if (!lead) throw ApiError.notFound('Lead not found');

  // Ownership. A caller may convert only their own lead.
  if (!isAdmin(actor) && lead.assignedCallerId !== actor.userId) {
    throw ApiError.forbidden('You may only convert your own leads');
  }
  if (lead.status === 'converted') {
    throw ApiError.badRequest('This lead has already been converted');
  }
  return lead;
}

/**
 * Whether this lead can be converted, and where it would sell from.
 *
 * It no longer prices anything: the medicines are chosen in the dialog now, not carried on
 * the lead, so there is nothing to quote until the user has composed the sale. What the
 * dialog cannot work out for itself is which location the stock would leave — that follows
 * the lead's assigned caller, not whoever is looking at the screen — so that is what this
 * answers. Prices and stock come from the catalogue the client already holds, and the
 * conversion re-prices authoritatively from its own copy before billing anything.
 *
 * Runs the same ownership and already-converted checks as the conversion, so a lead that
 * cannot be converted says so when the dialog opens rather than after the user has composed
 * an order and uploaded a screenshot.
 */
export async function previewConversion(actor: Actor, leadId: string) {
  // Read through the scoped client, so someone else's lead is simply absent and this answers
  // 404 — the same as GET /leads/:id. The conversion itself answers 403 with an explanation,
  // which is right for an action but wrong for a read: it would confirm the lead exists to
  // someone with no business knowing that.
  const lead = await scopedFor(actor).lead.findFirst({
    where: { id: leadId, deletedAt: null },
    select: { id: true, status: true, assignedCallerId: true },
  });
  if (!lead) throw ApiError.notFound('Lead not found');
  if (lead.status === 'converted') {
    throw ApiError.badRequest('This lead has already been converted');
  }

  // Resolved softly so the dialog can explain a missing caller or location rather than the
  // whole preview failing; the conversion itself enforces it hard.
  const caller = lead.assignedCallerId
    ? await prisma.user.findUnique({
        where: { id: lead.assignedCallerId },
        select: { location: { select: { name: true } } },
      })
    : null;

  return { locationName: caller?.location?.name ?? null };
}

export type ConversionInput = {
  paymentScreenshot: string;
  /** The sale, as composed in the dialog: which medicines, and for how many days each. */
  items: QuoteRequest[];
  /** 'online' demands the screenshot; 'offline' is cash in hand and has none. */
  paymentMode?: 'online' | 'offline';
  discountType?: 'none' | 'flat' | 'percentage';
  discountValue?: Prisma.Decimal | number;
};

export async function convertLeadToOrder(
  actor: Actor,
  leadId: string,
  input: ConversionInput,
  fallbackUnitPrice: Prisma.Decimal | number = 0,
) {
  // Proof of payment is a precondition, not a detail to be filled in later — but only for a
  // transfer, which leaves a screenshot behind. Cash over the counter has none to show, and
  // demanding one there meant inventing an image to record a sale that plainly happened.
  const paymentMode = input.paymentMode === 'offline' ? 'offline' : 'online';
  const screenshot = String(input.paymentScreenshot ?? '').trim();
  if (paymentMode === 'online' && !screenshot) {
    throw ApiError.badRequest('A payment screenshot is required for an online payment');
  }
  const discountType = input.discountType ?? 'none';
  const discountValue = new Prisma.Decimal(input.discountValue ?? 0);
  if (discountValue.lessThan(0)) {
    throw ApiError.badRequest('Discount cannot be negative');
  }
  if (discountType === 'percentage' && discountValue.greaterThan(100)) {
    throw ApiError.badRequest('A percentage discount cannot exceed 100');
  }

  return prisma.$transaction(async (tx) => {
    const lead = await loadConvertibleLead(tx, actor, leadId);

    // The location this sale draws from — the lead's caller's. Resolved up front so a lead
    // with no caller or a caller with no location is refused before any writes.
    const sellerLocationId = await resolveSellerLocation(tx, lead.assignedCallerId);

    // ── 1. resolve or create the customer ────────────────────────────────────────────────
    // Deduped on the normalised mobile, so "+91 98765 43210" and "09876543210" find the same
    // person rather than creating a second record.
    let customerId = lead.customerId;
    if (!customerId) {
      const mobile = normalizeIndianMobile(lead.mobile);
      const existing = mobile
        ? await tx.customer.findFirst({ where: { primaryMobile: mobile, deletedAt: null } })
        : null;

      if (existing) {
        customerId = existing.id;
      } else {
        const customer = await tx.customer.create({
          data: {
            fullName: lead.customerName,
            primaryMobile: mobile ?? lead.mobile,
            alternateMobile: lead.alternateNumber,
            address: lead.address,
            city: lead.city,
            state: lead.state,
            pincode: lead.pincode,
            doctorName: lead.doctorName,
          },
        });
        customerId = customer.id;
        await auditCreate(tx, actor, 'customers', customer);
      }
      await tx.lead.update({ where: { id: lead.id }, data: { customerId } });
    }

    const customer = await tx.customer.findUniqueOrThrow({ where: { id: customerId } });

    // ── 2. the order ─────────────────────────────────────────────────────────────────────
    // Kept on the order, which is what it is proof of, and on the lead, which is where the
    // existing UI reads payment proof from. The lead holds only the most recent, so the
    // order's copy is the one that stays true once a customer buys twice. Required to get
    // this far, so the order is paid by construction rather than by inspecting the lead.
    // Nothing to copy for a cash sale, and writing an empty string over the lead's existing
    // proof would lose the record of an earlier transfer.
    if (screenshot) {
      await tx.lead.update({ where: { id: lead.id }, data: { paymentScreenshot: screenshot } });
    }

    const order = await tx.order.create({
      data: {
        orderNumber: await nextOrderNumber(tx),
        customerId,
        leadId: lead.id,
        paymentScreenshot: screenshot || null,
        paymentMode,
        customerName: customer.fullName,
        shippingAddress: [lead.address, lead.city, lead.state, lead.pincode].filter(Boolean).join(', '),
        stage: 'confirmed',
        paymentStatus: 'paid',
        discountType,
        discountValue,
        createdBy: actor.userId,
      },
    });

    // ── 3. one line per requested medicine ───────────────────────────────────────────────
    // Priced by the same function that produced the preview the user just approved.
    // Re-priced here from the catalogue rather than trusting the figures the dialog showed:
    // the client computes the same total for display, but this is the copy that bills.
    const { lines, totalAmount } = await quoteItems(tx, input.items ?? [], fallbackUnitPrice);

    // Every catalogue line must be coverable at the seller's location before anything is
    // written, so a shortfall rejects the whole order rather than half-filling it.
    for (const line of lines) {
      if (line.productId) {
        assertStockCovers(line.name, await stockAt(tx, line.productId, sellerLocationId), line.quantity);
      }
    }

    for (const line of lines) {
      await tx.orderItem.create({
        data: {
          orderId: order.id,
          productId: line.productId,
          medicineNameSnapshot: line.name,
          quantity: line.quantity,
          unitPriceSnapshot: line.unitPrice,
          lineTotal: line.lineTotal,
        },
      });

      // Deducts the units from the seller's location. Coverage was asserted above.
      if (line.productId) {
        await changeStock(tx, line.productId, sellerLocationId, -line.quantity);
      }

      // One renewal per medicine, due when that medicine runs out.
      //
      // Nothing in the application created these before — only the seed did — so the whole
      // renewals feature had no input and sat empty on a real database. Conversion is where
      // the facts are: the customer, the medicine, and how many days of it were sold.
      await tx.renewal.create({
        data: {
          customerId,
          customerName: customer.fullName,
          orderId: order.id,
          productId: line.productId,
          medicineName: line.name,
          orderDate: order.createdAt,
          renewalDate: addDays(order.createdAt, line.days),
          expiryDate: addDays(order.createdAt, line.days + RENEWAL_GRACE_DAYS),
          // Follows the lead's owner, so it lands with whoever has the relationship.
          assignedCallerId: lead.assignedCallerId,
          createdBy: actor.userId,
        },
      });
    }

    const priced = await tx.order.update({
      where: { id: order.id },
      data: {
        totalAmount,
        payableAmount: payableAmount(totalAmount, order.discountType, order.discountValue),
      },
      include: { items: true },
    });
    await auditCreate(tx, actor, 'orders', priced);

    // ── 4. close the lead ────────────────────────────────────────────────────────────────
    const converted = await tx.lead.update({
      where: { id: lead.id },
      // convertedAt is stamped here, in the same transaction as the order, so the moment the
      // lead became a customer is recorded rather than inferred from its dates later.
      data: { status: 'converted', convertedAt: new Date() },
    });
    await auditUpdate(tx, actor, 'leads', lead, converted);

    await tx.leadActivity.create({
      data: {
        leadId: lead.id,
        activityType: 'status_change',
        description: `Lead converted to order ${priced.orderNumber}`,
        createdBy: actor.userId,
      },
    });

    return priced;
  });
}
