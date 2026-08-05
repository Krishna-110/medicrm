import { Router } from 'express';
import { prisma, type Tx } from '../db/prisma.js';
import { scopedFor } from '../db/scoped.js';
import { actorOf } from '../auth/auth.js';
import { ApiError, param, route, toDateOrNull } from '../lib/errors.js';
import { assertCanChangeLeadLifecycle, assertLeadAssignable, isAdmin } from '../auth/scope.js';
import { normalizeIndianMobile } from '../lib/mobile.js';
import { serializeFollowUp, serializeLead, serializeLeadActivity, serializeLeadMedicine, serializeOrder } from '../lib/serialize.js';
import { findCatalogueProductByName } from '../services/catalogue.js';
import { convertLeadToOrder, previewConversion } from '../services/conversion.js';
import {
  recountAssignedLeads,
  recordAssignment,
  scheduleNextFollowUp,
  syncNextFollowUp,
} from '../services/leads.js';
import { auditCreate, auditUpdate } from '../services/audit.js';

export const leadsRouter = Router();

/** Children a lead is always returned with. Activities newest-first, medicines in entry order. */
export const WITH_CHILDREN = {
  medicines: { orderBy: { createdAt: 'asc' } },
  activities: { orderBy: { createdAt: 'desc' } },
} as const;

/** API field -> column, for PATCH. Only these are editable. */
const EDITABLE = {
  customerName: 'customerName',
  mobile: 'mobile',
  alternateNumber: 'alternateNumber',
  address: 'address',
  city: 'city',
  state: 'state',
  pincode: 'pincode',
  doctorName: 'doctorName',
  disease: 'disease',
  leadSource: 'leadSource',
  status: 'status',
  notes: 'notes',
  paymentScreenshot: 'paymentScreenshot',
  nextFollowUp: 'nextFollowUpAt',
  lastFollowUp: 'lastFollowUpAt',
} as const;

/**
 * Columns in EDITABLE that hold a DateTime. The client sends a date input's value, which is
 * either 'YYYY-MM-DD' or '' — neither of which Prisma accepts for a DateTime.
 *
 * Both spellings used to 500: the string was handed to Prisma untouched, and `?? null` does
 * not catch '' because an empty string is not nullish. So setting a follow-up date failed,
 * and so did clearing one.
 */
const DATE_COLUMNS = new Set(['nextFollowUpAt', 'lastFollowUpAt']);

/**
 * Adds one medicine to a lead, linked to the catalogue where the name matches.
 *
 * Shared by create and edit because the edit path used to omit the lookup and store
 * productId as null. That looked harmless — the name is what the form shows — but the
 * product is where conversion reads the price from, so editing a lead's medicines silently
 * repriced it to zero. A lead created and converted billed correctly; the same lead opened,
 * saved and converted billed nothing.
 */
async function createLeadMedicine(
  tx: Tx,
  leadId: string,
  m: { name: string; days?: number | string },
) {
  const product = await findCatalogueProductByName(tx, m.name);
  return tx.leadMedicine.create({
    data: {
      leadId,
      productId: product?.id ?? null,
      medicineName: m.name,
      days: Number(m.days) || 1,
    },
  });
}

const REQUIRED = ['customerName', 'mobile', 'address', 'city', 'state', 'pincode', 'disease'] as const;

leadsRouter.get(
  '/',
  route(async (req, res) => {
    const db = scopedFor(actorOf(req));
    const leads = await db.lead.findMany({
      where: { deletedAt: null },
      include: WITH_CHILDREN,
      orderBy: { createdAt: 'desc' },
    });
    res.json(leads.map(serializeLead));
  }),
);

leadsRouter.get(
  '/:id',
  route(async (req, res) => {
    const db = scopedFor(actorOf(req));
    const lead = await db.lead.findFirst({
      where: { id: param(req, 'id'), deletedAt: null },
      include: WITH_CHILDREN,
    });
    // Out of scope and non-existent are both 404 — telling a caller a lead exists but is
    // someone else's leaks the fact it exists.
    if (!lead) throw ApiError.notFound('Lead not found');
    res.json(serializeLead(lead));
  }),
);

leadsRouter.post(
  '/',
  route(async (req, res) => {
    const actor = actorOf(req);
    const body = req.body ?? {};

    for (const field of REQUIRED) {
      if (!body[field]) throw ApiError.badRequest(`${field} is required`);
    }
    const medicines: { name: string; days?: number | string }[] = Array.isArray(body.medicines)
      ? body.medicines
      : [];
    if (medicines.length === 0) throw ApiError.badRequest('at least one medicine is required');

    // A caller's lead is force-assigned to them; only an admin may assign elsewhere.
    const assignedCallerId = isAdmin(actor) ? (body.assignedCaller ?? null) : actor.userId;
    assertLeadAssignable(actor, assignedCallerId);

    const lead = await prisma.$transaction(async (tx) => {
      const created = await tx.lead.create({
        data: {
          customerName: body.customerName,
          mobile: normalizeIndianMobile(body.mobile) ?? body.mobile,
          alternateNumber: body.alternateNumber ?? null,
          address: body.address,
          city: body.city,
          state: body.state,
          pincode: body.pincode,
          doctorName: body.doctorName ?? null,
          disease: body.disease,
          notes: body.notes ?? null,
          assignedCallerId,
          leadSource: body.leadSource ?? 'other',
          // Denormalised so the list view and search have something to match on without
          // joining every lead's medicines.
          medicineRequired: medicines.map((m) => m.name).join(', '),
          quantity: 1,
          createdBy: actor.userId,
        },
      });

      for (const m of medicines) {
        await createLeadMedicine(tx, created.id, m);
      }

      await tx.leadActivity.create({
        data: {
          leadId: created.id,
          activityType: 'created',
          description: `Lead created — ${body.disease}`,
          createdBy: actor.userId,
        },
      });

      if (assignedCallerId) {
        await recordAssignment(tx, actor, created.id, null, assignedCallerId);
        await recountAssignedLeads(tx, [assignedCallerId]);
      }
      await auditCreate(tx, actor, 'leads', created);

      return tx.lead.findUniqueOrThrow({ where: { id: created.id }, include: WITH_CHILDREN });
    });

    res.status(201).json(serializeLead(lead));
  }),
);

leadsRouter.patch(
  '/:id',
  route(async (req, res) => {
    const actor = actorOf(req);
    const db = scopedFor(actor);
    const body = req.body ?? {};

    const before = await db.lead.findFirst({ where: { id: param(req, 'id'), deletedAt: null } });
    if (!before) throw ApiError.notFound('Lead not found');

    // Selling requires the details that make an order fulfillable.
    const targetStatus = 'status' in body ? body.status : before.status;
    if (targetStatus === 'sold') {
      const address = 'address' in body ? body.address : before.address;
      const pincode = 'pincode' in body ? body.pincode : before.pincode;
      const screenshot = 'paymentScreenshot' in body ? body.paymentScreenshot : before.paymentScreenshot;
      if (!String(address ?? '').trim()) throw ApiError.badRequest('Address is required when Lead Status is Sold');
      if (!String(pincode ?? '').trim()) throw ApiError.badRequest('Pincode is required when Lead Status is Sold');
      if (!String(screenshot ?? '').trim()) {
        throw ApiError.badRequest('Payment Screenshot is required when Lead Status is Sold');
      }
    }

    if ('assignedCaller' in body) assertLeadAssignable(actor, body.assignedCaller ?? null);

    const data: Record<string, unknown> = {};
    for (const [apiField, column] of Object.entries(EDITABLE)) {
      // `in` rather than a truthiness check, so an explicit null clears the field.
      if (!(apiField in body)) continue;
      data[column] = DATE_COLUMNS.has(column)
        ? toDateOrNull(apiField, body[apiField])
        : (body[apiField] ?? null);
    }
    if (typeof data.mobile === 'string') data.mobile = normalizeIndianMobile(data.mobile);
    if ('assignedCaller' in body) data.assignedCallerId = body.assignedCaller ?? null;

    const lead = await prisma.$transaction(async (tx) => {
      const updated = await tx.lead.update({ where: { id: before.id }, data });

      if ('assignedCaller' in body && before.assignedCallerId !== updated.assignedCallerId) {
        await recordAssignment(tx, actor, updated.id, before.assignedCallerId, updated.assignedCallerId);
        await recountAssignedLeads(
          tx,
          [before.assignedCallerId, updated.assignedCallerId].filter((v): v is string => !!v),
        );
      }

      if (Array.isArray(body.medicines)) {
        await tx.leadMedicine.deleteMany({ where: { leadId: updated.id } });
        for (const m of body.medicines as { name: string; days?: number }[]) {
          await createLeadMedicine(tx, updated.id, m);
        }
      }

      // Setting the date has to schedule something. On its own it only wrote a column that
      // the calendar and the lead's own follow-up list never read, so the date showed in the
      // leads table and the task it implied existed nowhere.
      if ('nextFollowUp' in body) {
        await scheduleNextFollowUp(tx, actor, updated, toDateOrNull('nextFollowUp', body.nextFollowUp));
      }

      await auditUpdate(tx, actor, 'leads', before, updated);
      return tx.lead.findUniqueOrThrow({ where: { id: updated.id }, include: WITH_CHILDREN });
    });

    res.json(serializeLead(lead));
  }),
);

leadsRouter.delete(
  '/:id',
  route(async (req, res) => {
    const actor = actorOf(req);
    // Soft delete is an admin action even for a caller's own lead — a caller closing a lead
    // uses a status, not deletion.
    assertCanChangeLeadLifecycle(actor);

    const db = scopedFor(actor);
    const lead = await db.lead.findFirst({ where: { id: param(req, 'id'), deletedAt: null } });
    if (!lead) throw ApiError.notFound('Lead not found');

    await prisma.$transaction(async (tx) => {
      const deleted = await tx.lead.update({
        where: { id: lead.id },
        data: { deletedAt: new Date() },
      });
      if (lead.assignedCallerId) await recountAssignedLeads(tx, [lead.assignedCallerId]);
      await auditUpdate(tx, actor, 'leads', lead, deleted);
    });

    res.status(204).end();
  }),
);

leadsRouter.post(
  '/:id/activities',
  route(async (req, res) => {
    const actor = actorOf(req);
    const db = scopedFor(actor);
    const body = req.body ?? {};
    if (!body.description) throw ApiError.badRequest('description is required');

    const lead = await db.lead.findFirst({ where: { id: param(req, 'id'), deletedAt: null } });
    if (!lead) throw ApiError.notFound('Lead not found');

    // The medicine is optional and was previously read from the body and thrown away, so a
    // caller who noted "patient also wants X" while logging a call lost X silently.
    const { activity, medicine } = await prisma.$transaction(async (tx) => {
      const created = await tx.leadActivity.create({
        data: {
          leadId: lead.id,
          activityType: body.activityType ?? 'comment',
          description: body.description,
          createdBy: actor.userId,
        },
      });
      const added = body.medicine?.name
        ? await createLeadMedicine(tx, lead.id, body.medicine)
        : null;
      return { activity: created, medicine: added };
    });

    res.status(201).json({
      activity: serializeLeadActivity(activity),
      medicine: medicine ? serializeLeadMedicine(medicine) : null,
    });
  }),
);

// What the conversion would produce, priced but not written. The confirmation dialog shows
// this before asking for a payment screenshot.
leadsRouter.get(
  '/:id/convert-preview',
  route(async (req, res) => {
    const { lines, totalAmount } = await previewConversion(actorOf(req), param(req, 'id'));
    res.json({
      items: lines.map((l) => ({
        name: l.name,
        quantity: l.quantity,
        unitPrice: Number(l.unitPrice),
        lineTotal: Number(l.lineTotal),
        // Flagged so the dialog can say why a line is priced at zero, rather than showing a
        // free medicine and leaving the user to wonder.
        inCatalogue: l.productId !== null,
      })),
      totalAmount: Number(totalAmount),
    });
  }),
);

leadsRouter.post(
  '/:id/convert',
  route(async (req, res) => {
    const actor = actorOf(req);
    const body = req.body ?? {};
    const order = await convertLeadToOrder(
      actor,
      param(req, 'id'),
      {
        paymentScreenshot: body.paymentScreenshot,
        discountType: body.discountType,
        discountValue: body.discountValue,
      },
      body.unitPrice ?? 0,
    );
    const lead = await scopedFor(actor).lead.findFirst({
      where: { id: param(req, 'id') },
      include: WITH_CHILDREN,
    });
    res.json({ order: serializeOrder(order), lead: lead ? serializeLead(lead) : null });
  }),
);

leadsRouter.post(
  '/:id/follow-ups',
  route(async (req, res) => {
    const actor = actorOf(req);
    const db = scopedFor(actor);
    const body = req.body ?? {};
    if (!body.scheduledDate) throw ApiError.badRequest('scheduledDate is required');

    const lead = await db.lead.findFirst({ where: { id: param(req, 'id'), deletedAt: null } });
    if (!lead) throw ApiError.notFound('Lead not found');

    const when = toDateOrNull('scheduledDate', body.scheduledDate);
    if (!when) throw ApiError.badRequest('scheduledDate is required');

    const followUp = await prisma.$transaction(async (tx) => {
      const created = await tx.followUp.create({
        data: {
          leadId: lead.id,
          customerId: lead.customerId,
          customerName: lead.customerName,
          scheduledAt: when,
          type: body.type ?? 'call',
          status: 'pending',
          notes: body.notes ?? null,
          // Inherited from the lead rather than required in the payload.
          assignedCallerId: lead.assignedCallerId,
          createdBy: actor.userId,
        },
      });
      // The other half of the same problem: the lead's NEXT FOLLOW-UP column stayed empty
      // while a follow-up sat scheduled against it.
      await syncNextFollowUp(tx, lead.id);
      return created;
    });

    res.status(201).json(serializeFollowUp(followUp));
  }),
);
