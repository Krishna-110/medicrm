import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { scopedFor } from '../db/scoped.js';
import { actorOf } from '../auth/auth.js';
import { ApiError, param, route } from '../lib/errors.js';
import { serializeOrder } from '../lib/serialize.js';
import { recalculateOrderTotals } from '../services/orders.js';
import { auditUpdate } from '../services/audit.js';

export const ordersRouter = Router();

const WITH_ITEMS = { items: { orderBy: { createdAt: 'asc' } } } as const;

ordersRouter.get(
  '/',
  route(async (req, res) => {
    const orders = await scopedFor(actorOf(req)).order.findMany({
      where: { deletedAt: null },
      include: WITH_ITEMS,
      orderBy: { createdAt: 'desc' },
    });
    res.json(orders.map(serializeOrder));
  }),
);

ordersRouter.patch(
  '/:id',
  route(async (req, res) => {
    const actor = actorOf(req);
    const id = param(req, 'id');
    const body = req.body ?? {};

    /*
     * A caller works their own order: moving it through the stages as it is prepared and
     * shipped, and recording the payment they collected. Editing was admin-only, so every one
     * of those controls sat on their screen and answered 403 — the order was theirs, the work
     * was theirs, and the app refused it.
     *
     * The scoped client is what confines them to their own: another caller's order is not
     * found, so it returns 404 without confirming the order exists. An admin's scope is empty,
     * so the same lookup reaches everything.
     */
    const before = await scopedFor(actor).order.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw ApiError.notFound('Order not found');

    const data: Record<string, unknown> = {};
    if ('stage' in body) data.stage = body.stage;
    if ('paymentStatus' in body) data.paymentStatus = body.paymentStatus;
    if ('discountType' in body) data.discountType = body.discountType;
    if ('discountValue' in body) data.discountValue = Number(body.discountValue) || 0;
    if (Object.keys(data).length === 0) throw ApiError.badRequest('no updatable fields provided');

    const order = await prisma.$transaction(async (tx) => {
      const updated = await tx.order.update({ where: { id }, data });
      // A discount change moves the payable amount, so the totals are rebuilt rather than
      // patched — the same recomputation any line-item change triggers.
      if ('discountType' in body || 'discountValue' in body) {
        await recalculateOrderTotals(tx, id);
      }
      await auditUpdate(tx, actor, 'orders', before, updated);
      return tx.order.findUniqueOrThrow({ where: { id }, include: WITH_ITEMS });
    });

    res.json(serializeOrder(order));
  }),
);
