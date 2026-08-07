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
