import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { scopedFor } from '../db/scoped.js';
import { ApiError } from '../lib/errors.js';
import { normalizeIndianMobile } from '../lib/mobile.js';
import { addDays } from '../lib/dates.js';
import { isAdmin, type Actor } from '../auth/scope.js';
import { findCatalogueProductByName } from './catalogue.js';
import { lineTotal, nextOrderNumber, payableAmount } from './orders.js';
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
  quantity: number;
  unitPrice: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  /** Days of supply, which is what decides when the renewal falls due. */
  days: number;
};

/**
 * What converting this lead would cost, at today's catalogue prices.
 *
 * Shared by the conversion itself and by the preview the confirmation dialog shows, so the
 * figure the user approves is produced by the same code that later bills it. Computing the
 * preview separately would have been easy and would have drifted.
 */
export async function quoteLead(
  db: Pick<Prisma.TransactionClient, 'product'>,
  lead: LeadWithMedicines,
  fallbackUnitPrice: Prisma.Decimal | number = 0,
): Promise<{ lines: QuoteLine[]; totalAmount: Prisma.Decimal }> {
  // Falls back to the lead's single denormalised medicine when no rows exist — older leads
  // predate the lead_medicines table and must still be convertible.
  const requested = lead.medicines.length
    ? lead.medicines.map((m) => ({
        productId: m.productId,
        name: m.medicineName,
        quantity: 1,
        days: m.days || DEFAULT_SUPPLY_DAYS,
      }))
    : lead.medicineRequired
      ? [{
          productId: null,
          name: lead.medicineRequired,
          quantity: Math.max(lead.quantity ?? 1, 1),
          days: DEFAULT_SUPPLY_DAYS,
        }]
      : [];

  if (requested.length === 0) {
    throw ApiError.badRequest('This lead has no medicines to convert');
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
 * The priced lines the conversion dialog shows before anything is written.
 *
 * Runs the same ownership and already-converted checks as the conversion, so a lead that
 * cannot be converted says so when the dialog opens rather than after the user has uploaded
 * a screenshot and pressed confirm.
 */
export async function previewConversion(actor: Actor, leadId: string) {
  // Read through the scoped client, so someone else's lead is simply absent and this answers
  // 404 — the same as GET /leads/:id. The conversion itself answers 403 with an explanation,
  // which is right for an action but wrong for a read: it would confirm the lead exists to
  // someone with no business knowing that.
  const lead = await scopedFor(actor).lead.findFirst({
    where: { id: leadId, deletedAt: null },
    include: { medicines: { orderBy: { createdAt: 'asc' } } },
  });
  if (!lead) throw ApiError.notFound('Lead not found');
  if (lead.status === 'converted') {
    throw ApiError.badRequest('This lead has already been converted');
  }
  return quoteLead(prisma, lead);
}

export type ConversionInput = {
  paymentScreenshot: string;
  discountType?: 'none' | 'flat' | 'percentage';
  discountValue?: Prisma.Decimal | number;
};

export async function convertLeadToOrder(
  actor: Actor,
  leadId: string,
  input: ConversionInput,
  fallbackUnitPrice: Prisma.Decimal | number = 0,
) {
  // Proof of payment is a precondition, not a detail to be filled in later. Checked before
  // the transaction opens so a missing screenshot costs nothing.
  const screenshot = String(input.paymentScreenshot ?? '').trim();
  if (!screenshot) {
    throw ApiError.badRequest('A payment screenshot is required to convert a lead into an order');
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
    await tx.lead.update({ where: { id: lead.id }, data: { paymentScreenshot: screenshot } });

    const order = await tx.order.create({
      data: {
        orderNumber: await nextOrderNumber(tx),
        customerId,
        leadId: lead.id,
        paymentScreenshot: screenshot,
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
    const { lines, totalAmount } = await quoteLead(tx, lead, fallbackUnitPrice);

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

      // Stock floors at zero rather than blocking the sale. A pharmacy fulfils and restocks;
      // it does not refuse a customer because a counter is stale.
      if (line.productId) {
        const product = await tx.product.findUnique({ where: { id: line.productId } });
        if (product) {
          await tx.product.update({
            where: { id: product.id },
            data: { stockQuantity: Math.max(product.stockQuantity - line.quantity, 0) },
          });
        }
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
      data: { status: 'converted' },
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
