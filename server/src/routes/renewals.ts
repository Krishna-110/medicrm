import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { scopedFor } from '../db/scoped.js';
import { actorOf } from '../auth/auth.js';
import { ApiError, param, route, toDateOrNull } from '../lib/errors.js';
import { FOLLOW_UP_CONTACT, serializeFollowUp, serializeOrder, serializeRenewal } from '../lib/serialize.js';
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
      : [{ name: renewal.medicineName }]) as { name?: unknown; days?: unknown }[];

    // Blank days fall back to the length of the cycle being renewed.
    const defaultDays = Math.max(istDayDiff(renewal.renewalDate, renewal.orderDate), 1);

    const lines = items.map((item) => {
      const name = String(item?.name ?? '').trim();
      // Days of supply, and — one unit per day — the quantity too: a 20-day reorder is 20
      // units, priced and stock-deducted as such. 0 means "not given, use the current cycle".
      const rawDays = item?.days == null ? 0 : Number(item.days);
      if (!name) throw ApiError.badRequest('Every line needs a medicine');
      if (rawDays !== 0 && (!Number.isInteger(rawDays) || rawDays < 1)) {
        throw ApiError.badRequest(`Days for ${name} must be a whole number of 1 or more`);
      }
      const days = rawDays || defaultDays;
      return { name, quantity: days, days };
    });
    // Same rule as a first sale: only a transfer leaves a screenshot behind, so only a
    // transfer can be asked for one. A reorder paid in cash has no image to produce.
    const paymentMode = req.body?.paymentMode === 'offline' ? 'offline' : 'online';
    const screenshot = String(req.body?.paymentScreenshot ?? '').trim();
    if (paymentMode === 'online' && !screenshot) {
      throw ApiError.badRequest('A payment screenshot is required for an online payment');
    }
    const discountType: 'none' | 'flat' | 'percentage' = req.body?.discountType ?? 'none';
    const discountValue = new Prisma.Decimal(req.body?.discountValue ?? 0);
    if (discountValue.lessThan(0)) throw ApiError.badRequest('Discount cannot be negative');
    if (discountType === 'percentage' && discountValue.greaterThan(100)) {
      throw ApiError.badRequest('A percentage discount cannot exceed 100');
    }

    // Renewing closes this cycle, places the repeat order, and opens the next one. Stamping
    // renewedAt alone ended the relationship: the customer dropped off the list entirely,
    // nobody would ever be prompted to call them again, and the repeat sale went unrecorded.
    // previousRenewalId has been in the schema from the start for exactly this chain.
    const { renewal: updated, order, next } = await prisma.$transaction(async (tx) => {
      const renewed = await tx.renewal.update({
        where: { id },
        data: { renewedAt: new Date() },
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

      // The next cycle describes the reorder just placed, not the one before it: add a
      // medicine here and the next call is about both. It falls due when the shortest line
      // runs out — one order, one call, dated so nothing lapses unnoticed. An empty days
      // field carries the previous cycle's length over, so a 15-day course stays 15. The
      // grace window is always inherited; the reorder does not expose it.
      const prevSupply = Math.max(istDayDiff(renewed.renewalDate, renewed.orderDate), 1);
      const supplyDays = priced.length ? soonestRenewal(priced) : prevSupply;
      const graceDays = Math.max(istDayDiff(renewed.expiryDate, renewed.renewalDate), 1);
      const from = renewed.renewedAt!;

      const nextCycle = await tx.renewal.create({
        data: {
          customerId: renewed.customerId,
          customerName: renewed.customerName,
          // Points at the order just placed, not the original — that is what the next cycle
          // is a renewal of.
          orderId: created.id,
          // Only a single-medicine reorder has one product to point at.
          productId: priced.length === 1 ? (priced[0]?.product?.id ?? null) : null,
          medicineName: priced.map((l) => l.name).join(', '),
          orderDate: from,
          renewalDate: addDays(from, supplyDays),
          expiryDate: addDays(from, supplyDays + graceDays),
          assignedCallerId: renewed.assignedCallerId,
          previousRenewalId: renewed.id,
          createdBy: actorOf(req).userId,
        },
      });
      // Re-read with its lines. serializeOrder builds `medicines` from them, so returning the
      // bare created row would have handed the client an order with nothing in it — and the
      // Orders page would show an empty one until the next reload.
      const withItems = await tx.order.findUniqueOrThrow({
        where: { id: created.id },
        include: { items: { orderBy: { createdAt: 'asc' } } },
      });
      return { renewal: renewed, order: withItems, next: nextCycle };
    });

    // The cycle just opened is returned alongside the one just closed. Without it the client
    // is told a renewal was completed but never told its successor exists, and the Renewals
    // page — the very list the user is looking at — silently omits the next call to make.
    res.json({
      renewal: serializeRenewal(updated),
      order: serializeOrder(order),
      nextRenewal: serializeRenewal(next),
    });
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

    await prisma.renewal.update({ where: { id }, data: { deletedAt: new Date() } });
    res.status(204).end();
  }),
);
