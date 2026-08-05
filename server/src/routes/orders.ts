import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { scopedFor } from '../db/scoped.js';
import { actorOf } from '../auth/auth.js';
import { ApiError, param, route } from '../lib/errors.js';
import { isAdmin } from '../auth/scope.js';
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

    // Editing an order is admin-only, but which refusal depends on whether the caller can see
    // it. A flat 404 was the old behaviour, inherited from a row filter that simply matched
    // nothing — which meant a caller clicking their OWN order, visible on their own screen,
    // was told it did not exist.
    //
    // An order inside their scope therefore gets 403 and a reason: they are already looking at
    // it, so nothing is revealed. Anything else stays 404, since naming it would confirm an
    // order exists to someone with no business knowing that.
    if (!isAdmin(actor)) {
      const visible = await scopedFor(actor).order.findFirst({
        where: { id, deletedAt: null },
        select: { id: true },
      });
      if (!visible) throw ApiError.notFound('Order not found');
      throw ApiError.forbidden("You don't have permission to update this order.");
    }

    const before = await prisma.order.findFirst({ where: { id, deletedAt: null } });
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
