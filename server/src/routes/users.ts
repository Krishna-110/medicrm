import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../db/prisma.js';
import { scopedFor } from '../db/scoped.js';
import { actorOf } from '../auth/auth.js';
import { ApiError, param, route } from '../lib/errors.js';
import { assertCanEditUser, assertNoPrivilegeEscalation, assertNoSelfRoleChange, isAdmin, requireAdmin } from '../auth/scope.js';
import { serializeUser } from '../lib/serialize.js';
import { auditCreate, auditUpdate } from '../services/audit.js';

export const usersRouter = Router();

const EDITABLE = ['name', 'phone', 'email', 'role', 'status', 'employeeId', 'avatarUrl'] as const;

usersRouter.get(
  '/',
  route(async (req, res) => {
    // A caller's scope narrows this to themselves, so the same query serves both roles.
    const users = await scopedFor(actorOf(req)).user.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
      include: { location: true },
    });
    res.json(users.map(serializeUser));
  }),
);

usersRouter.post(
  '/',
  route(async (req, res) => {
    const actor = actorOf(req);
    requireAdmin(actor);
    const body = req.body ?? {};
    for (const f of ['name', 'employeeId', 'phone', 'email']) {
      if (!body[f]) throw ApiError.badRequest(`${f} is required`);
    }

    const passwordHash = await bcrypt.hash(body.password || 'Welcome123!', 10);
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          name: body.name,
          employeeId: body.employeeId,
          phone: body.phone,
          // Lowercased on write — the unique index then gives case-insensitive uniqueness
          // without needing the citext extension.
          email: String(body.email).trim().toLowerCase(),
          role: body.role === 'admin' ? 'admin' : 'caller',
          // The location a caller will sell from, chosen at creation. An unknown id fails the
          // foreign key and surfaces as a 400.
          locationId: body.locationId ?? null,
          passwordHash,
        },
        include: { location: true },
      });
      await auditCreate(tx, actor, 'users', created);
      return created;
    });
    res.status(201).json(serializeUser(user));
  }),
);

usersRouter.patch(
  '/:id',
  route(async (req, res) => {
    const actor = actorOf(req);
    const id = param(req, 'id');
    const body = req.body ?? {};

    assertCanEditUser(actor, id);
    // Refused before any read, so the answer cannot depend on what the caller can see.
    assertNoPrivilegeEscalation(actor, body);

    const before = await scopedFor(actor).user.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw ApiError.notFound('User not found');

    // Needs the stored row to compare against, so it runs here rather than beside the
    // escalation check above — an unchanged role arriving with an ordinary self-edit is fine.
    assertNoSelfRoleChange(actor, id, body, before);

    const data: Record<string, unknown> = {};
    for (const f of EDITABLE) if (f in body) data[f] = body[f] ?? null;
    if (typeof data.email === 'string') data.email = data.email.trim().toLowerCase();
    // Reassigning a caller's location is admin-only — a caller cannot move their own stock
    // source. Kept out of EDITABLE, which a caller editing themselves may also write.
    if ('locationId' in body && isAdmin(actor)) data.locationId = body.locationId ?? null;

    const user = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({ where: { id }, data, include: { location: true } });
      await auditUpdate(tx, actor, 'users', before, updated);
      return updated;
    });
    res.json(serializeUser(user));
  }),
);

usersRouter.delete(
  '/:id',
  route(async (req, res) => {
    const actor = actorOf(req);
    requireAdmin(actor);
    const id = param(req, 'id');

    const before = await prisma.user.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw ApiError.notFound('User not found');

    /*
     * Removing a caller takes their workload with them.
     *
     * It used to remove only the account, which left every lead, follow-up and renewal behind
     * still pointing at someone who no longer existed. Those rows stayed live and stayed
     * counted: the lead list showed a dash where the owner should be, the calendar drew a call
     * nobody owned, and Pending Follow-ups counted calls no caller could see — a deleted
     * account cannot log in, and scoping only ever shows a caller their own work. Confusing to
     * look at, and the customer never got rung.
     *
     * Orders and customers deliberately stay. They are records of what a customer bought, not
     * of who sold it, and deleting them would rewrite past revenue every time someone leaves.
     * An order whose lead is gone still counts towards Sales, which is what keeps the totals
     * honest.
     *
     * Soft deletes throughout, matching the rest of the app: the rows remain in the database
     * and stay recoverable, they simply stop appearing anywhere.
     */
    const removed = await prisma.$transaction(async (tx) => {
      const deleted = await tx.user.update({ where: { id }, data: { deletedAt: new Date() } });
      // Existing sessions stop working immediately rather than lingering until they expire.
      await tx.session.deleteMany({ where: { userId: id } });

      const when = { deletedAt: new Date() };
      const live = { assignedCallerId: id, deletedAt: null };
      const leads = await tx.lead.updateMany({ where: live, data: when });
      const followUps = await tx.followUp.updateMany({ where: live, data: when });
      const renewals = await tx.renewal.updateMany({ where: live, data: when });

      await auditUpdate(tx, actor, 'users', before, deleted);
      return { leads: leads.count, followUps: followUps.count, renewals: renewals.count };
    });

    // Says what went with them, so the caller-facing message can be specific rather than
    // leaving an admin to guess what a deletion just took off the board.
    res.status(200).json({ removed });
  }),
);
