import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { actorOf } from '../auth/auth.js';
import { requireAdmin } from '../auth/scope.js';
import { ApiError, param, route } from '../lib/errors.js';
import { serializeLocation } from '../lib/serialize.js';

/**
 * Stock locations. Every authenticated user can read the list — a caller's account shows the
 * one they sell from, and the user form needs it to choose — but only an admin may change it.
 */
export const locationsRouter = Router();

locationsRouter.get(
  '/',
  route(async (_req, res) => {
    const locations = await prisma.location.findMany({
      where: { deletedAt: null },
      orderBy: { name: 'asc' },
    });
    res.json(locations.map(serializeLocation));
  }),
);

locationsRouter.post(
  '/',
  route(async (req, res) => {
    requireAdmin(actorOf(req));
    const name = String(req.body?.name ?? '').trim();
    if (!name) throw ApiError.badRequest('A location name is required');
    const location = await prisma.location.create({ data: { name } });
    res.status(201).json(serializeLocation(location));
  }),
);

locationsRouter.patch(
  '/:id',
  route(async (req, res) => {
    requireAdmin(actorOf(req));
    const name = String(req.body?.name ?? '').trim();
    if (!name) throw ApiError.badRequest('A location name is required');
    const location = await prisma.location.update({ where: { id: param(req, 'id') }, data: { name } });
    res.json(serializeLocation(location));
  }),
);

/**
 * Soft-delete a location, but only once it is empty. Refusing while it still holds stock or has
 * callers is the whole safety of it: deleting a location that holds stock would silently write
 * those units off (refreshTotal already ignores deleted locations), and deleting one a caller
 * sells from would strand that caller with nowhere to sell. Guard here, and the admin clears it
 * first — zero the stock per location, reassign the callers — then the delete goes through.
 */
locationsRouter.delete(
  '/:id',
  route(async (req, res) => {
    requireAdmin(actorOf(req));
    const id = param(req, 'id');
    await prisma.$transaction(async (tx) => {
      const location = await tx.location.findFirst({ where: { id, deletedAt: null } });
      if (!location) throw ApiError.notFound('Location not found');

      const callers = await tx.user.count({ where: { locationId: id, deletedAt: null } });
      if (callers > 0) {
        throw ApiError.badRequest(
          `This location is assigned to ${callers} caller${callers === 1 ? '' : 's'} — reassign them before deleting.`,
        );
      }
      const held = await tx.productLocationStock.aggregate({ where: { locationId: id }, _sum: { quantity: true } });
      if ((held._sum.quantity ?? 0) > 0) {
        throw ApiError.badRequest('This location still holds stock — set every medicine to 0 here before deleting.');
      }
      // Only zero-quantity rows can remain; drop them so none linger, then soft-delete the location.
      await tx.productLocationStock.deleteMany({ where: { locationId: id } });
      await tx.location.update({ where: { id }, data: { deletedAt: new Date() } });
    });
    res.status(204).end();
  }),
);
