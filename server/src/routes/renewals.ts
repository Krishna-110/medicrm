import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { scopedFor } from '../db/scoped.js';
import { actorOf } from '../auth/auth.js';
import { ApiError, param, route, toDateOrNull } from '../lib/errors.js';
import { FOLLOW_UP_CONTACT, ORDER_CALLER, RENEWAL_CONTACT, serializeFollowUp, serializeOrder, serializeRenewal } from '../lib/serialize.js';
import { findCatalogueProductByName } from '../services/catalogue.js';
import { assertStockCovers, soonestRenewal } from '../services/conversion.js';
import { changeStock, resolveSellerLocation, stockAt } from '../services/inventory.js';
import { lineTotal, nextOrderNumber, payableAmount } from '../services/orders.js';
import { auditCreate } from '../services/audit.js';
import { addDays, istDayDiff } from '../lib/dates.js';
import { parseFollowUpSlot } from '../lib/vocab.js';

export const renewalsRouter = Router();

renewalsRouter.get(
  '/',
  route(async (req, res) => {
    const renewals = await scopedFor(actorOf(req)).renewal.findMany({
      where: { deletedAt: null },
      orderBy: { expiryDate: 'asc' },
      include: RENEWAL_CONTACT,
    });
    // status and daysRemaining are derived at serialization time — see lib/dates.ts.
    res.json(renewals.map(serializeRenewal));
  }),
);

renewalsRouter.post(
  '/:id/renew',
  route(async (req, res) => {
    const db = scopedFor(actorOf(req));
    const id = param(req, 'id');

    // Scoped, so a caller renewing someone else's renewal finds nothing and gets the same
    // 404 as one that does not exist.
    const renewal = await db.renewal.findFirst({
      where: { id, renewedAt: null, deletedAt: null },
    });
    if (!renewal) throw ApiError.notFound('Renewal not found');

    // Renewing is a sale, so it carries the same preconditions as converting a lead: what is
    // being reordered, for how long, proof of payment, and a discount that makes sense.
    //
    // A reorder is by DAYS of supply, not units — the same model as a lead, where a medicine
    // is sold once and `days` says how long it lasts. Quantity is always one per line, as it
    // is at conversion; there is no units field. Defaults to the renewal's own medicine when
    // the client sends nothing.
    const rawItems: unknown = req.body?.items;
    const items = (Array.isArray(rawItems) && rawItems.length
      ? rawItems
      : [{ name: renewal.medicineName }]) as { name?: unknown; days?: unknown; quantity?: unknown }[];

    // Blank days fall back to the length of the cycle being renewed.
    const defaultDays = Math.max(istDayDiff(renewal.renewalDate, renewal.orderDate), 1);

    const lines = items.map((item) => {
      const name = String(item?.name ?? '').trim();
      const rawDays = item?.days == null ? 0 : Number(item.days);
      if (!name) throw ApiError.badRequest('Every line needs a medicine');
      if (rawDays !== 0 && (!Number.isInteger(rawDays) || rawDays < 1)) {
        throw ApiError.badRequest(`Days for ${name} must be a whole number of 1 or more`);
      }
      const days = rawDays || defaultDays;
      const rawQuantity = item?.quantity == null ? null : Number(item.quantity);
      if (rawQuantity !== null && (!Number.isInteger(rawQuantity) || rawQuantity < 1)) {
        throw ApiError.badRequest(`Quantity for ${name} must be a whole number of 1 or more`);
      }
      const quantity = rawQuantity ?? days;
      return { name, quantity, days };
    });
    // Same rule as a first sale: the screenshot is recorded when given and never required.
    const paymentMode = req.body?.paymentMode === 'offline' ? 'offline' : 'online';
    const screenshot = String(req.body?.paymentScreenshot ?? '').trim();
    const discountType: 'none' | 'flat' | 'percentage' = req.body?.discountType ?? 'none';
    const discountValue = new Prisma.Decimal(req.body?.discountValue ?? 0);
    if (discountValue.lessThan(0)) throw ApiError.badRequest('Discount cannot be negative');
    if (discountType === 'percentage' && discountValue.greaterThan(100)) {
      throw ApiError.badRequest('A percentage discount cannot exceed 100');
    }

    /*
     * Renewing places the repeat order and rolls THIS renewal forward. The cycle does not
     * close and no second row is created.
     *
     * It used to stamp renewedAt and open a successor, which is defensible as a record but
     * read badly: the row being looked at froze with its old date, lost its Renew button, and
     * its days figure kept counting down past zero into a red negative, while the date that
     * had actually moved appeared on a new row further down the list. One renewal per
     * customer's course, whose date advances each time it is renewed, is what a caller is
     * actually tracking. The repeat sales remain fully recorded as orders, which is where the
     * money already lives.
     */
    const { renewal: updated, order } = await prisma.$transaction(async (tx) => {
      const renewed = await tx.renewal.findUniqueOrThrow({
        where: { id },
        include: RENEWAL_CONTACT,
      });

      const customer = await tx.customer.findUniqueOrThrow({ where: { id: renewed.customerId } });
      const previousOrder = renewed.orderId
        ? await tx.order.findUnique({ where: { id: renewed.orderId }, select: { leadId: true } })
        : null;
      // The reorder draws from the renewal's caller's location, the same as a conversion.
      const sellerLocationId = await resolveSellerLocation(tx, renewed.assignedCallerId);
      // Priced before the order is written, so totalAmount is right on insert rather than
      // patched afterwards. The renewal's own medicine uses its stored product link; anything
      // added in the dialog is matched by name, exactly as the lead form does.
      const priced = [];
      let total = new Prisma.Decimal(0);
      for (const line of lines) {
        const product =
          renewed.productId && line.name.toLowerCase() === renewed.medicineName.toLowerCase()
            ? await tx.product.findUnique({ where: { id: renewed.productId } })
            : await findCatalogueProductByName(tx, line.name);

        const unitPrice = product?.unitPrice ?? new Prisma.Decimal(0);
        const amount = lineTotal(line.quantity, unitPrice);
        total = total.add(amount);
        priced.push({ ...line, product, unitPrice, amount });
      }

      // Every catalogue line must be coverable at the seller's location before anything is
      // written — same rule as a conversion, so a shortfall rejects the whole reorder.
      for (const line of priced) {
        if (line.product) {
          assertStockCovers(line.name, await stockAt(tx, line.product.id, sellerLocationId), line.quantity);
        }
      }

      const created = await tx.order.create({
        data: {
          orderNumber: await nextOrderNumber(tx),
          customerId: customer.id,
          // Inherited from the order this renewal came from. orderScope requires a lead for a
          // caller, so an order without one would be invisible to the very person who placed
          // it — they would take the payment and then not find the order.
          leadId: previousOrder?.leadId ?? null,
          customerName: customer.fullName,
          shippingAddress: [customer.address, customer.city, customer.state, customer.pincode]
            .filter(Boolean)
            .join(', '),
          stage: 'confirmed',
          // Same rule as a first sale: paid on creation. A reorder is taken at the point the
          // customer agrees to it, and leaving it Pending kept renewals out of Sales.
          paymentStatus: 'paid',
          paymentMode,
          paymentScreenshot: screenshot || null,
          discountType,
          discountValue,
          totalAmount: total,
          payableAmount: payableAmount(total, discountType, discountValue),
          createdBy: actorOf(req).userId,
        },
      });

      for (const line of priced) {
        await tx.orderItem.create({
          data: {
            orderId: created.id,
            productId: line.product?.id ?? null,
            medicineNameSnapshot: line.name,
            quantity: line.quantity,
            unitPriceSnapshot: line.unitPrice,
            lineTotal: line.amount,
          },
        });

        // Deducts the units from the seller's location; coverage was asserted above.
        if (line.product) {
          await changeStock(tx, line.product.id, sellerLocationId, -line.quantity);
        }
      }
      await auditCreate(tx, actorOf(req), 'orders', created);

      /*
       * The same row, moved on to describe the reorder just placed: add a medicine here and
       * the next call is about both. It falls due when the shortest line runs out — one order,
       * one call, dated so nothing lapses unnoticed. An empty days field carries the previous
       * cycle's length over, so a 15-day course stays 15, and the grace window is inherited.
       *
       * Early renewals extend from the current renewal date: if the customer still has supply
       * remaining, the new supply is added on top so they don't lose any of their days!
       * If renewed on or after the renewal date (overdue), the new supply starts from today.
       */
      const prevSupply = Math.max(istDayDiff(renewed.renewalDate, renewed.orderDate), 1);
      const supplyDays = priced.length ? soonestRenewal(priced) : prevSupply;
      const graceDays = Math.max(istDayDiff(renewed.expiryDate, renewed.renewalDate), 0);
      const now = new Date();

      const remainingDays = istDayDiff(renewed.renewalDate, now);
      const baseDate = remainingDays > 0 ? renewed.renewalDate : now;
      const newRenewalDate = addDays(baseDate, supplyDays);
      const newExpiryDate = addDays(newRenewalDate, graceDays);

      const rolled = await tx.renewal.update({
        where: { id },
        data: {
          // Points at the order just placed — that is what this renewal is now a renewal of.
          orderId: created.id,
          // Only a single-medicine reorder has one product to point at.
          productId: priced.length === 1 ? (priced[0]?.product?.id ?? null) : null,
          medicineName: priced.map((l) => l.name).join(', '),
          orderDate: now,
          renewalDate: newRenewalDate,
          expiryDate: newExpiryDate,
          // Stays null: the renewal is live, and rolling it forward is not closing it.
          renewedAt: null,
        },
        include: RENEWAL_CONTACT,
      });
      // Mark any existing reminder follow-up for this cycle completed
      await tx.followUp.updateMany({
        where: { renewalId: id, status: 'pending', deletedAt: null },
        data: { status: 'completed', completedAt: now },
      });

      // Re-read with its lines. serializeOrder builds `medicines` from them, so returning the
      // bare created row would have handed the client an order with nothing in it — and the
      // Orders page would show an empty one until the next reload.
      const withItems = await tx.order.findUniqueOrThrow({
        where: { id: created.id },
        include: { items: { orderBy: { createdAt: 'asc' } }, ...ORDER_CALLER },
      });
      return { renewal: rolled, order: withItems };
    });

    // One renewal, rolled forward, plus the order it placed. There is no successor to report.
    res.json({ renewal: serializeRenewal(updated), order: serializeOrder(order) });
  }),
);

renewalsRouter.post(
  '/:id/remind',
  route(async (req, res) => {
    const actor = actorOf(req);
    const db = scopedFor(actor);
    const id = param(req, 'id');

    const renewal = await db.renewal.findFirst({ where: { id, deletedAt: null } });
    if (!renewal) throw ApiError.notFound('Renewal not found');

    // Defaults to the day the medicine runs out, which is when the call is actually worth
    // making. It used to hardcode now(), so a renewal due in three weeks put a task on the
    // caller's list today — "schedule" that could not schedule.
    const when = toDateOrNull('scheduledDate', req.body?.scheduledDate) ?? renewal.renewalDate;
    const notes = req.body?.notes ?? null;
    let slot;
    try {
      slot = parseFollowUpSlot(req.body?.slot);
    } catch (e) {
      throw ApiError.badRequest(e instanceof Error ? e.message : 'Invalid slot');
    }

    // One pending reminder per renewal, moved rather than stacked. The button had no guard,
    // so pressing it twice — easy on a phone — left two identical tasks to be completed
    // separately. Same rule the lead's follow-up date already follows.
    const existing = await prisma.followUp.findFirst({
      where: { renewalId: renewal.id, status: 'pending', deletedAt: null },
      orderBy: { scheduledAt: 'asc' },
      select: { id: true },
    });

    const followUp = existing
      ? await prisma.followUp.update({
          where: { id: existing.id },
          data: { scheduledAt: when, notes, slot },
          include: FOLLOW_UP_CONTACT,
        })
      : await prisma.followUp.create({
          data: {
            customerId: renewal.customerId,
            customerName: renewal.customerName,
            renewalId: renewal.id,
            scheduledAt: when,
            slot,
            type: 'reminder',
            status: 'pending',
            notes,
            // Inherited from the renewal, so the reminder lands with whoever owns it.
            assignedCallerId: renewal.assignedCallerId,
            createdBy: actor.userId,
          },
          include: FOLLOW_UP_CONTACT,
        });

    res.status(existing ? 200 : 201).json(serializeFollowUp(followUp));
  }),
);

renewalsRouter.delete(
  '/:id',
  route(async (req, res) => {
    const db = scopedFor(actorOf(req));
    const id = param(req, 'id');

    // Deliberately not admin-only: this is the "stop this renewal" action, and a caller
    // needs it for their own. The scope is what limits which ones they can reach.
    const renewal = await db.renewal.findFirst({ where: { id, deletedAt: null } });
    if (!renewal) throw ApiError.notFound('Renewal not found');

    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.renewal.update({ where: { id }, data: { deletedAt: now } });
      await tx.followUp.updateMany({
        where: { renewalId: id, deletedAt: null },
        data: { deletedAt: now },
      });
    });
    res.status(204).end();
  }),
);
