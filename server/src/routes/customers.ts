import { Router } from 'express';
import { scopedFor } from '../db/scoped.js';
import { actorOf } from '../auth/auth.js';
import { route } from '../lib/errors.js';
import { serializeCustomer } from '../lib/serialize.js';

export const customersRouter = Router();

/*
 * People who have bought. Scoped through the work that reaches them — a caller sees a customer
 * they hold a lead, renewal or follow-up for; an admin sees everyone. customerScope has been
 * defined and tested since the beginning and had no route to serve until now, which is why the
 * dashboard was counting converted leads instead.
 */
customersRouter.get(
  '/',
  route(async (req, res) => {
    const db = scopedFor(actorOf(req));
    const customers = await db.customer.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    res.json(customers.map(serializeCustomer));
  }),
);
