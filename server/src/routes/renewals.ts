import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { scopedFor } from '../db/scoped.js';
import { actorOf } from '../auth/auth.js';
import { ApiError, param, route } from '../lib/errors.js';
import { serializeFollowUp, serializeOrder, serializeRenewal } from '../lib/serialize.js';
import { findCatalogueProductByName } from '../services/catalogue.js';
import { lineTotal, nextOrderNumber, payableAmount } from '../services/orders.js';
import { auditCreate } from '../services/audit.js';
import { addDays, istDayDiff } from '../lib/dates.js';

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

    // Renewing is a sale, so it carries the same preconditions as converting a lead: a
    // quantity, proof of payment, and a discount that makes sense.
    const quantity = Number(req.body?.quantity ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw ApiError.badRequest('Quantity must be a whole number of 1 or more');
    }
    const screenshot = String(req.body?.paymentScreenshot ?? '').trim();
    if (!screenshot) {
      throw ApiError.badRequest('A payment screenshot is required to renew');
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
    const { renewal: updated, order } = await prisma.$transaction(async (tx) => {
      const renewed = await tx.renewal.update({
        where: { id },
        data: { renewedAt: new Date() },
      });

      const customer = await tx.customer.findUniqueOrThrow({ where: { id: renewed.customerId } });
      const previousOrder = renewed.orderId
        ? await tx.order.findUnique({ where: { id: renewed.orderId }, select: { leadId: true } })
        : null;
      const product = renewed.productId
        ? await tx.product.findUnique({ where: { id: renewed.productId } })
        : await findCatalogueProductByName(tx, renewed.medicineName);

      const unitPrice = product?.unitPrice ?? new Prisma.Decimal(0);
      const total = lineTotal(quantity, unitPrice);

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
          paymentScreenshot: screenshot,
          discountType,
          discountValue,
          totalAmount: total,
          payableAmount: payableAmount(total, discountType, discountValue),
          createdBy: actorOf(req).userId,
        },
      });

      await tx.orderItem.create({
        data: {
          orderId: created.id,
          productId: product?.id ?? null,
          medicineNameSnapshot: renewed.medicineName,
          quantity,
          unitPriceSnapshot: unitPrice,
          lineTotal: total,
        },
      });

      // Same rule as conversion: fulfil and restock, never refuse the sale over a stale count.
      if (product) {
        await tx.product.update({
          where: { id: product.id },
          data: { stockQuantity: Math.max(product.stockQuantity - quantity, 0) },
        });
      }
      await auditCreate(tx, actorOf(req), 'orders', created);

      // The next cycle reuses this one's durations rather than a fixed constant, so a 15-day
      // course stays a 15-day course and a 90-day one stays 90.
      const supplyDays = Math.max(istDayDiff(renewed.renewalDate, renewed.orderDate), 1);
      const graceDays = Math.max(istDayDiff(renewed.expiryDate, renewed.renewalDate), 1);
      const from = renewed.renewedAt!;

      await tx.renewal.create({
        data: {
          customerId: renewed.customerId,
          customerName: renewed.customerName,
          // Points at the order just placed, not the original — that is what the next cycle
          // is a renewal of.
          orderId: created.id,
          productId: renewed.productId,
          medicineName: renewed.medicineName,
          orderDate: from,
          renewalDate: addDays(from, supplyDays),
          expiryDate: addDays(from, supplyDays + graceDays),
          assignedCallerId: renewed.assignedCallerId,
          previousRenewalId: renewed.id,
          createdBy: actorOf(req).userId,
        },
      });
      return { renewal: renewed, order: created };
    });

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

    const followUp = await prisma.followUp.create({
      data: {
        customerId: renewal.customerId,
        customerName: renewal.customerName,
        renewalId: renewal.id,
        scheduledAt: new Date(),
        type: 'reminder',
        status: 'pending',
        notes: req.body?.notes ?? null,
        // Inherited from the renewal, so the reminder lands with whoever owns it.
        assignedCallerId: renewal.assignedCallerId,
        createdBy: actor.userId,
      },
    });
    res.status(201).json(serializeFollowUp(followUp));
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
