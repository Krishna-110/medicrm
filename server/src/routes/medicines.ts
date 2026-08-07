import { Router } from 'express';
import { prisma, type Tx } from '../db/prisma.js';
import { scopedFor } from '../db/scoped.js';
import { actorOf } from '../auth/auth.js';
import { ApiError, param, route } from '../lib/errors.js';
import { requireAdmin } from '../auth/scope.js';
import { serializeMedicine } from '../lib/serialize.js';
import { changeStock, setStock } from '../services/inventory.js';
import { auditCreate, auditUpdate } from '../services/audit.js';

export const medicinesRouter = Router();

/** A medicine with its per-location breakdown, for a response the Stock page can expand. */
const WITH_STOCK = {
  locationStocks: { where: { location: { deletedAt: null } }, include: { location: true } },
} as const;

/** The location a stock change targets: the one asked for, or Main Store when none is given. */
async function targetLocation(tx: Tx, locationId: unknown): Promise<string> {
  if (typeof locationId === 'string' && locationId) {
    const loc = await tx.location.findFirst({ where: { id: locationId, deletedAt: null }, select: { id: true } });
    if (!loc) throw ApiError.badRequest('Unknown location');
    return loc.id;
  }
  const main = await tx.location.findFirst({ where: { name: 'Main Store', deletedAt: null }, select: { id: true } });
  if (!main) throw ApiError.badRequest('No default location exists — create one first');
  return main.id;
}

/** The catalogue is shared reference data — every authenticated user reads it in full. */
medicinesRouter.get(
  '/',
  route(async (req, res) => {
    const products = await scopedFor(actorOf(req)).product.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
      // The per-location breakdown feeds the Stock page's expandable view; the serializer sums
      // it for the headline total.
      include: { locationStocks: { where: { location: { deletedAt: null } }, include: { location: true } } },
    });
    res.json(products.map(serializeMedicine));
  }),
);

medicinesRouter.post(
  '/',
  route(async (req, res) => {
    const actor = actorOf(req);
    requireAdmin(actor);
    const body = req.body ?? {};
    if (!body.name) throw ApiError.badRequest('name is required');

    const opening = body.stockQuantity === undefined ? 0 : Number(body.stockQuantity);
    if (!Number.isInteger(opening) || opening < 0) {
      throw ApiError.badRequest('Opening stock must be a whole number of 0 or more');
    }

    const product = await prisma.$transaction(async (tx) => {
      // Sequential, human-readable SKUs. Derived from the current count rather than a
      // sequence because a gap here is cosmetic, unlike an order number.
      const count = await tx.product.count();
      const created = await tx.product.create({
        data: {
          sku: `MED-${String(count + 1).padStart(5, '0')}`,
          genericName: body.genericName || body.name,
          brandName: body.name,
          dosageForm: body.dosageForm ?? null,
          unitPrice: Number(body.unitPrice) || 0,
          stockQuantity: 0,
          isActive: body.isActive ?? true,
        },
      });
      // Opening stock lands at a location — the one chosen, else Main Store — and setStock
      // refreshes the cached total from there. The column is no longer set directly.
      if (opening > 0) await setStock(tx, created.id, await targetLocation(tx, body.locationId), opening);
      await auditCreate(tx, actor, 'products', created);
      return tx.product.findUniqueOrThrow({ where: { id: created.id }, include: WITH_STOCK });
    });
    res.status(201).json(serializeMedicine(product));
  }),
);

medicinesRouter.patch(
  '/:id',
  route(async (req, res) => {
    const actor = actorOf(req);
    requireAdmin(actor);
    const id = param(req, 'id');
    const body = req.body ?? {};

    const before = await prisma.product.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw ApiError.notFound('Medicine not found');

    const data: Record<string, unknown> = {};
    if ('name' in body) data.brandName = body.name;
    if ('genericName' in body) data.genericName = body.genericName;
    if ('dosageForm' in body) data.dosageForm = body.dosageForm;
    if ('unitPrice' in body) data.unitPrice = Number(body.unitPrice) || 0;
    if ('isActive' in body) data.isActive = body.isActive;
    if (Object.keys(data).length === 0) throw ApiError.badRequest('no updatable fields provided');

    const product = await prisma.$transaction(async (tx) => {
      const updated = await tx.product.update({ where: { id }, data });
      await auditUpdate(tx, actor, 'products', before, updated);
      return tx.product.findUniqueOrThrow({ where: { id }, include: WITH_STOCK });
    });
    res.json(serializeMedicine(product));
  }),
);

medicinesRouter.post(
  '/:id/stock',
  route(async (req, res) => {
    const actor = actorOf(req);
    requireAdmin(actor);
    const id = param(req, 'id');
    const { mode, quantity } = req.body ?? {};

    if (mode !== 'add' && mode !== 'set') throw ApiError.badRequest("mode must be 'add' or 'set'");
    if (
      !Number.isInteger(quantity) ||
      (mode === 'add' && quantity <= 0) ||
      (mode === 'set' && quantity < 0)
    ) {
      throw ApiError.badRequest(
        mode === 'add'
          ? 'Quantity to add must be a whole number greater than 0'
          : 'Stock quantity must be a whole number of 0 or more',
      );
    }

    const before = await prisma.product.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw ApiError.notFound('Medicine not found');

    const product = await prisma.$transaction(async (tx) => {
      const locationId = await targetLocation(tx, req.body?.locationId);
      // add increments that location; set makes it absolute. Both refresh the cached total.
      if (mode === 'add') await changeStock(tx, id, locationId, quantity);
      else await setStock(tx, id, locationId, quantity);
      const updated = await tx.product.findUniqueOrThrow({ where: { id } });
      await auditUpdate(tx, actor, 'products', before, updated);
      return tx.product.findUniqueOrThrow({ where: { id }, include: WITH_STOCK });
    });
    res.json(serializeMedicine(product));
  }),
);

medicinesRouter.delete(
  '/:id',
  route(async (req, res) => {
    const actor = actorOf(req);
    requireAdmin(actor);
    const id = param(req, 'id');

    const before = await prisma.product.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw ApiError.notFound('Medicine not found');

    await prisma.$transaction(async (tx) => {
      const deleted = await tx.product.update({ where: { id }, data: { deletedAt: new Date() } });
      await auditUpdate(tx, actor, 'products', before, deleted);
    });
    res.status(204).end();
  }),
);
