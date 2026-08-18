import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/db/prisma.js';

/**
 * The HTTP contract, driven in-process with supertest.
 *
 * app.ts exports the app without listening, so there is no port and no server lifecycle
 * here. This is the layer the frontend actually consumes, so it is also the layer that
 * proves the rewrite is equivalent to what came before.
 *
 * Convention worth stating: a refused write is asserted BOTH by status and by re-reading the
 * row. A 403 that still wrote is exactly the bug this suite exists to catch, and a status
 * assertion alone cannot tell the difference.
 */

const ADMIN = { email: 'aarav.sharma@medicrm.in', password: 'admin123' };
const CALLER = { email: 'sneha.iyer@medicrm.in', password: 'caller123' };
const OTHER = { email: 'ananya.desai@medicrm.in', password: 'caller123' };
const INACTIVE = { email: 'kavya.reddy@medicrm.in', password: 'caller123' };

type Session = { token: string; userId: string; role: string };

async function login(creds: { email: string; password: string }): Promise<Session> {
  const res = await request(app).post('/api/auth/login').send(creds);
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.token, userId: res.body.user.id, role: res.body.user.role };
}

const as = (s: Session) => ({
  get: (u: string) => request(app).get(u).set('Authorization', `Bearer ${s.token}`),
  post: (u: string, b?: unknown) => request(app).post(u).set('Authorization', `Bearer ${s.token}`).send(b ?? {}),
  patch: (u: string, b?: unknown) => request(app).patch(u).set('Authorization', `Bearer ${s.token}`).send(b ?? {}),
  delete: (u: string) => request(app).delete(u).set('Authorization', `Bearer ${s.token}`),
});

let admin: Session;
let caller: Session;
let other: Session;
let uniq = 0;
const nextId = () => `${Date.now()}${uniq++}`;

/**
 * A conversion payload. The screenshot is mandatory, so tests that are about something else
 * still have to supply one — and tests asserting a different rejection must supply one too,
 * or they would pass on the missing-screenshot 400 instead of the reason they mean to check.
 *
 * `items` is the sale. It is sent here rather than read off the lead, because the medicines
 * are chosen in the conversion dialog now; the default mirrors leadPayload's own default so
 * a test that cares about neither stays short.
 */
const convertPayload = (over: Record<string, unknown> = {}) => ({
  paymentScreenshot: 'data:image/png;base64,iVBORw0KGgo=',
  items: [{ name: 'Atorva', days: 1 }],
  discountType: 'none',
  discountValue: 0,
  ...over,
});

const leadPayload = (over: Record<string, unknown> = {}) => ({
  customerName: `T Lead ${nextId()}`,
  mobile: '9000000001',
  address: '1 Test Street',
  city: 'Mumbai',
  state: 'Maharashtra',
  pincode: '400001',
  disease: 'Hypertension',
  // One day = one unit. The default is a single day so a plain conversion takes one unit and
  // bills the unit price once, keeping tests that are not about days simple; the days/stock
  // tests set their own values against seeded stock.
  medicines: [{ name: 'Atorva', days: 1 }],
  ...over,
});

beforeAll(async () => {
  [admin, caller, other] = await Promise.all([login(ADMIN), login(CALLER), login(OTHER)]);
});

/** Sets a medicine's stock, so a days test isn't at the mercy of what the suite has drawn down. */
async function setStock(name: string, quantity: number) {
  const med = (await as(admin).get('/api/medicines')).body.find((m: { name: string }) => m.name === name);
  await as(admin).post(`/api/medicines/${med.id}/stock`, { mode: 'set', quantity });
}

describe('authentication', () => {
  it('signs in an admin and a caller', () => {
    expect(admin.role).toBe('admin');
    expect(caller.role).toBe('caller');
  });

  it('answers 401 identically for wrong password, unknown email and inactive account', async () => {
    // Identical responses on purpose — distinguishing them tells an attacker which addresses
    // are real, and which accounts merely need reactivating.
    for (const creds of [
      { ...ADMIN, password: 'wrong' },
      { email: 'nobody@medicrm.in', password: 'x' },
      INACTIVE,
    ]) {
      const res = await request(app).post('/api/auth/login').send(creds);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid email or password');
    }
  });

  it('requires a token, and rejects a malformed one', async () => {
    expect((await request(app).get('/api/leads')).status).toBe(401);
    expect((await as({ token: 'nope', userId: '', role: '' }).get('/api/leads')).status).toBe(401);
  });

  it('GET /auth/me nests the user, and never leaks a password hash', async () => {
    const res = await as(caller).get('/api/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(caller.userId);
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash/i);
  });

  it('logout invalidates the token immediately', async () => {
    const s = await login(OTHER);
    expect((await as(s).post('/api/auth/logout')).status).toBe(204);
    expect((await as(s).get('/api/leads')).status).toBe(401);
  });

  it('changing a password requires the current one', async () => {
    const s = await login(OTHER);
    const bad = await as(s).patch('/api/auth/password', { currentPassword: 'wrong', newPassword: 'abcdef' });
    expect(bad.status).toBe(400);
    // Same value in and out, so the fixture credentials keep working.
    const ok = await as(s).patch('/api/auth/password', {
      currentPassword: OTHER.password, newPassword: OTHER.password,
    });
    expect(ok.status).toBe(204);
  });
});

describe('read scoping over HTTP', () => {
  it.each(['/api/leads', '/api/users', '/api/renewals'])('%s narrows for a caller', async (url) => {
    const [a, c] = await Promise.all([as(admin).get(url), as(caller).get(url)]);
    expect(a.status).toBe(200);
    expect(c.body.length).toBeGreaterThan(0);
    expect(c.body.length).toBeLessThan(a.body.length);
  });

  it('every lead a caller sees is their own', async () => {
    const res = await as(caller).get('/api/leads');
    expect(res.body.every((l: { assignedCaller: string }) => l.assignedCaller === caller.userId)).toBe(true);
  });

  it('the catalogue is shared, not narrowed', async () => {
    const [a, c] = await Promise.all([as(admin).get('/api/medicines'), as(caller).get('/api/medicines')]);
    expect(c.body.length).toBe(a.body.length);
    expect(c.body.length).toBeGreaterThan(0);
  });

  it('notifications are a personal inbox even for an admin', async () => {
    // An admin's scope is unrestricted, so without explicit self-scoping this would return
    // every user's notifications into the bell icon.
    const res = await as(admin).get('/api/notifications');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(0); // the fixture's only notification belongs to the caller
    expect((await as(caller).get('/api/notifications')).body.length).toBeGreaterThan(0);
  });

  it('lookups serve the frontend’s dropdowns', async () => {
    const res = await as(caller).get('/api/lookups');
    expect(res.status).toBe(200);
    for (const key of ['leadStatuses', 'leadSources', 'orderStages', 'paymentStatuses', 'followUpTypes', 'followUpStatuses']) {
      expect(res.body[key]?.length, key).toBeGreaterThan(0);
    }
  });
});

describe('dashboard', () => {
  it('the status breakdown always sums to the total', async () => {
    // Everything is computed live, so these cannot disagree. The previous implementation read
    // the total live but the breakdown from a matview refreshed every five minutes, and an
    // admin could be shown a breakdown that did not add up to the number beside it.
    const res = await as(admin).get('/api/dashboard');
    const sum = res.body.leadStatusBreakdown.reduce((n: number, r: { count: number }) => n + Number(r.count), 0);
    expect(sum).toBe(res.body.totalLeads);
  });

  it('still sums immediately after a write, with no refresh', async () => {
    const before = (await as(admin).get('/api/dashboard')).body;
    expect((await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }))).status).toBe(201);
    const after = (await as(admin).get('/api/dashboard')).body;
    const sum = after.leadStatusBreakdown.reduce((n: number, r: { count: number }) => n + Number(r.count), 0);
    expect(after.totalLeads).toBe(before.totalLeads + 1);
    expect(sum).toBe(after.totalLeads);
  });

  it('callsDoneToday counts calls made, not calls scheduled', async () => {
    // The distinction the card was pulled over: a call booked for today has not been made,
    // and a call made today against an old booking still counts.
    const before = (await as(admin).get('/api/dashboard')).body.callsDoneToday;
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));

    // Booked for today, not yet dialled — must not count.
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    await as(admin).post(`/api/leads/${lead.id}/follow-ups`, { scheduledDate: today });
    expect((await as(admin).get('/api/dashboard')).body.callsDoneToday).toBe(before);

    // Scheduled long ago, completed now — must count, on today.
    const { body: old } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));
    const backlog = await as(admin).post(`/api/leads/${old.id}/follow-ups`, { scheduledDate: '2026-01-05' });
    await as(admin).patch(`/api/follow-ups/${backlog.body.id}`, { status: 'completed' });
    expect((await as(admin).get('/api/dashboard')).body.callsDoneToday).toBe(before + 1);

    // Undone, and it stops counting — the stamp is cleared, not merely ignored.
    await as(admin).patch(`/api/follow-ups/${backlog.body.id}`, { status: 'pending' });
    expect((await as(admin).get('/api/dashboard')).body.callsDoneToday).toBe(before);
  });

  it('pendingFollowUps counts follow-ups, not leads parked in a status', async () => {
    // The bug this pins: it counted leads whose status was follow_up_pending, so booking a
    // call on a lead in any other status moved nothing and a full day could report zero.
    const before = (await as(admin).get('/api/dashboard')).body.pendingFollowUps;

    const { body: lead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));
    expect(lead.status).not.toBe('follow_up_pending');
    await as(admin).post(`/api/leads/${lead.id}/follow-ups`, { scheduledDate: '2026-12-01' });

    const after = (await as(admin).get('/api/dashboard')).body.pendingFollowUps;
    expect(after).toBe(before + 1);

    // And completing it takes the count back down.
    const mine = (await as(admin).get('/api/follow-ups')).body
      .find((f: { leadId?: string; status: string }) => f.leadId === lead.id && f.status === 'pending');
    await as(admin).patch(`/api/follow-ups/${mine.id}`, { status: 'completed' });
    expect((await as(admin).get('/api/dashboard')).body.pendingFollowUps).toBe(before);
  });

  it('caller totals are smaller, and cross-caller comparisons are admin-only', async () => {
    const [a, c] = await Promise.all([as(admin).get('/api/dashboard'), as(caller).get('/api/dashboard')]);
    expect(c.body.totalLeads).toBeLessThan(a.body.totalLeads);
    expect(a.body.salesByCaller.length).toBeGreaterThan(0);
    expect(c.body.salesByCaller).toEqual([]);
    expect(c.body.callerPerformance).toEqual([]);
  });
});

describe('lead lifecycle', () => {
  it('creates, normalises the mobile, patches, and records an activity', async () => {
    const created = await as(admin).post('/api/leads', leadPayload({ mobile: '+91 98765 12345', assignedCaller: caller.userId }));
    expect(created.status).toBe(201);
    expect(created.body.mobile).toBe('9876512345');
    expect(created.body.medicines).toHaveLength(1);
    const id = created.body.id;

    expect((await as(admin).patch(`/api/leads/${id}`, { notes: 'edited' })).status).toBe(200);
    expect((await as(admin).post(`/api/leads/${id}/activities`, { description: 'rang' })).status).toBe(201);
    expect((await as(admin).post(`/api/leads/${id}/follow-ups`, { scheduledDate: '2026-12-01', type: 'call' })).status).toBe(201);
  });

  it('sets, round-trips and clears the follow-up date', async () => {
    // Regression. nextFollowUpAt is a DateTime, but a date input sends 'YYYY-MM-DD' or ''.
    // Both went to Prisma untouched — '' is not nullish, so `?? null` never caught it — and
    // both returned 500, meaning a follow-up date could neither be set nor removed.
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));

    const set = await as(admin).patch(`/api/leads/${lead.id}`, { nextFollowUp: '2026-12-24' });
    expect(set.status).toBe(200);
    // Round-trips as the same calendar date, rather than slipping a day through the timezone.
    expect(set.body.nextFollowUp).toBe('2026-12-24');

    const cleared = await as(admin).patch(`/api/leads/${lead.id}`, { nextFollowUp: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.nextFollowUp).toBe('');

    const bad = await as(admin).patch(`/api/leads/${lead.id}`, { nextFollowUp: 'not-a-date' });
    expect(bad.status).toBe(400);
  });

  it('prices a converted order the same whether or not the lead was edited', async () => {
    // The edit path rebuilt lead_medicines without the catalogue lookup, so productId came
    // back null. The name still displayed correctly, which is why it went unnoticed — but
    // conversion reads the price from the product, so an edited lead converted at zero.
    const price = async (edit: boolean) => {
      const { body: lead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));
      if (edit) {
        await as(admin).patch(`/api/leads/${lead.id}`, { medicines: [{ name: 'Atorva', days: 1 }] });
      }
      const res = await as(admin).post(`/api/leads/${lead.id}/convert`, convertPayload());
      return Number(res.body.order.totalAmount);
    };

    const untouched = await price(false);
    expect(untouched).toBeGreaterThan(0); // guards the comparison below from passing on 0 === 0
    expect(await price(true)).toBe(untouched);
  });

  it('prices a sale sent by name alone, matching the catalogue', async () => {
    // The dialog sends what the caller picked — a name and a tenure — with no product id.
    // Pricing that at zero would be wrong about data sitting right there, so the quote
    // resolves the name against the catalogue.
    await setStock('Atorva', 999);
    const atorva = (await as(admin).get('/api/medicines')).body.find((m: { name: string }) => m.name === 'Atorva');
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));

    const res = await as(admin).post(`/api/leads/${lead.id}/convert`, convertPayload({
      items: [{ name: 'Atorva', days: 15 }],
    }));
    expect(res.status).toBe(200);
    // Days are units: 15 days bills 15 × the unit price.
    expect(Number(res.body.order.totalAmount)).toBe(atorva.unitPrice * 15);
    expect(res.body.order.medicines[0].quantity).toBe(15);
  });

  it('refuses to convert without a payment screenshot', async () => {
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));

    for (const missing of [{}, { paymentScreenshot: '' }, { paymentScreenshot: '   ' }]) {
      const res = await as(admin).post(`/api/leads/${lead.id}/convert`, missing);
      expect(res.status, JSON.stringify(missing)).toBe(400);
      expect(String(res.body.error)).toMatch(/payment screenshot/i);
    }

    // Refused, not half-done: no order, and the lead is still open.
    expect(await prisma.order.count({ where: { leadId: lead.id } })).toBe(0);
    expect((await as(admin).get(`/api/leads/${lead.id}`)).body.status).not.toBe('converted');
  });

  it('applies a discount and records the order as paid', async () => {
    await setStock('Atorva', 999);
    const atorva = (await as(admin).get('/api/medicines')).body.find((m: { name: string }) => m.name === 'Atorva');
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));

    const res = await as(admin).post(`/api/leads/${lead.id}/convert`, convertPayload({
      items: [{ name: 'Atorva', days: 1 }],
      discountType: 'percentage',
      discountValue: 25,
    }));
    expect(res.status).toBe(200);
    // The dialog shows days × unit price, so the order must bill exactly that.
    expect(Number(res.body.order.totalAmount)).toBe(atorva.unitPrice);
    expect(Number(res.body.order.payableAmount)).toBe(atorva.unitPrice * 0.75);
    expect(res.body.order.paymentStatus).toBe('paid');
  });

  it('rejects a discount that is negative or over 100 percent', async () => {
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));

    for (const bad of [
      { discountType: 'percentage', discountValue: 150 },
      { discountType: 'flat', discountValue: -5 },
    ]) {
      const res = await as(admin).post(`/api/leads/${lead.id}/convert`, convertPayload(bad));
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    // Still convertible afterwards — a rejected attempt must not consume the lead.
    expect((await as(admin).post(`/api/leads/${lead.id}/convert`, convertPayload())).status).toBe(200);
  });

  it('the preview refuses a lead the caller does not own', async () => {
    // Same checks as the conversion, so an unauthorised lead fails when the dialog opens
    // rather than after a screenshot has been uploaded.
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: other.userId }));
    expect((await as(caller).get(`/api/leads/${lead.id}/convert-preview`)).status).toBe(404);
  });

  it('converts to an order, deducting stock and closing the lead', async () => {
    const product = await prisma.product.findFirstOrThrow({ where: { brandName: 'Atorva' } });
    const stockBefore = product.stockQuantity;

    const lead = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));
    const res = await as(admin).post(`/api/leads/${lead.body.id}/convert`, convertPayload());
    expect(res.status).toBe(200);
    expect(res.body.order.orderNumber).toMatch(/^ORD-\d{4}-\d{4}$/);
    expect(res.body.order.medicines).toHaveLength(1);
    expect(res.body.lead.status).toBe('converted');

    const after = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.stockQuantity).toBe(stockBefore - 1);

    // A second conversion is refused rather than producing a duplicate order.
    expect((await as(admin).post(`/api/leads/${lead.body.id}/convert`, convertPayload())).status).toBe(400);
  });

  it('soft-deletes rather than destroying', async () => {
    const lead = await as(admin).post('/api/leads', leadPayload());
    expect((await as(admin).delete(`/api/leads/${lead.body.id}`)).status).toBe(204);
    const row = await prisma.lead.findUnique({ where: { id: lead.body.id } });
    expect(row).not.toBeNull();
    expect(row!.deletedAt).not.toBeNull();
  });

  it('reassignment moves both counters and the assignment history', async () => {
    const lead = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));
    const before = await prisma.user.findUniqueOrThrow({ where: { id: other.userId } });

    expect((await as(admin).patch(`/api/leads/${lead.body.id}`, { assignedCaller: other.userId })).status).toBe(200);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: other.userId } });
    expect(after.assignedLeadsCount).toBe(before.assignedLeadsCount + 1);

    const history = await prisma.leadAssignment.findMany({ where: { leadId: lead.body.id }, orderBy: { assignedAt: 'asc' } });
    expect(history).toHaveLength(2);
    expect(history[0]!.unassignedAt).not.toBeNull(); // the first assignment was closed off
    expect(history[1]!.callerId).toBe(other.userId);
  });
});

describe('follow-up scheduling stays in step with the lead', () => {
  // lead.nextFollowUpAt is a denormalised copy of "the earliest pending follow-up", and
  // nothing kept the two together: setting the date scheduled nothing, and scheduling a
  // follow-up left the date empty. A lead showed a NEXT FOLLOW-UP the calendar had never
  // heard of, which is precisely how it was noticed.
  const followUpsFor = async (leadId: string) => {
    const res = await as(admin).get('/api/follow-ups');
    return (res.body as { leadId?: string }[]).filter((f) => f.leadId === leadId);
  };

  it('setting the date on a lead schedules a real follow-up', async () => {
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));
    await as(admin).patch(`/api/leads/${lead.id}`, { nextFollowUp: '2026-09-15' });

    const followUps = await followUpsFor(lead.id);
    expect(followUps).toHaveLength(1);
    expect(followUps[0]).toMatchObject({ scheduledDate: '2026-09-15', status: 'pending' });
  });

  it('moving the date moves the same follow-up rather than adding another', async () => {
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));
    await as(admin).patch(`/api/leads/${lead.id}`, { nextFollowUp: '2026-09-15' });
    await as(admin).patch(`/api/leads/${lead.id}`, { nextFollowUp: '2026-09-20' });

    const followUps = await followUpsFor(lead.id);
    expect(followUps).toHaveLength(1);
    expect(followUps[0]).toMatchObject({ scheduledDate: '2026-09-20' });
  });

  it('clearing the date retires the follow-up', async () => {
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));
    await as(admin).patch(`/api/leads/${lead.id}`, { nextFollowUp: '2026-09-15' });
    const cleared = await as(admin).patch(`/api/leads/${lead.id}`, { nextFollowUp: '' });

    expect(cleared.body.nextFollowUp).toBe('');
    expect(await followUpsFor(lead.id)).toHaveLength(0);
  });

  it('scheduling a follow-up directly fills in the lead’s date', async () => {
    // The other direction, which was equally broken.
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));
    await as(admin).post(`/api/leads/${lead.id}/follow-ups`, { scheduledDate: '2026-10-05', type: 'call' });

    const after = await as(admin).get(`/api/leads/${lead.id}`);
    expect(after.body.nextFollowUp).toBe('2026-10-05');
  });

  it('converting creates ONE renewal for the order, due when its shortest line runs out', async () => {
    // One order is one call. Per-medicine renewals put the same customer on the list once per
    // line, so a three-medicine sale looked like three people to ring on three days.
    // Identified by what is new rather than by name: every lead here shares one mobile, so
    // they all resolve to the same customer and customerName cannot tell them apart.
    const before = new Set(
      (await as(admin).get('/api/renewals')).body.map((r: { id: string }) => r.id),
    );

    const { body: lead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));
    await as(admin).post(`/api/leads/${lead.id}/convert`, convertPayload({
      items: [{ name: 'Atorva', days: 30 }, { name: 'Sansamrit', days: 15 }],
    }));

    const mine = (await as(admin).get('/api/renewals')).body
      .filter((r: { id: string }) => !before.has(r.id));
    expect(mine).toHaveLength(1);
    // Named for everything in the order, so the caller knows what the conversation covers.
    expect(mine[0].medicineName).toBe('Atorva, Sansamrit');

    // Dated by the SHORTEST line: 15 days, not 30, or the Sansamrit runs out unnoticed while
    // the Atorva is still in supply.
    const days = Math.round(
      (new Date(mine[0].renewalDate).getTime() - new Date(mine[0].orderDate).getTime()) / 86_400_000,
    );
    expect(days).toBe(15);
  });

  it('falls due on the tenure sold, when the order is all one tenure', async () => {
    // The ordinary case: everything on the order shares a tenure, so the renewal is simply
    // that many days out — 60 days sold, 60 days until the call.
    await setStock('Atorva', 999);
    await setStock('Sansamrit', 999);
    const before = new Set((await as(admin).get('/api/renewals')).body.map((r: { id: string }) => r.id));
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));
    await as(admin).post(`/api/leads/${lead.id}/convert`, convertPayload({
      items: [{ name: 'Atorva', days: 60 }, { name: 'Sansamrit', days: 60 }],
    }));

    const [renewal] = (await as(admin).get('/api/renewals')).body
      .filter((r: { id: string }) => !before.has(r.id));
    const days = Math.round(
      (new Date(renewal.renewalDate).getTime() - new Date(renewal.orderDate).getTime()) / 86_400_000,
    );
    expect(days).toBe(60);
  });

  it('renewing opens the next cycle rather than ending the relationship', async () => {
    // renew stamped renewedAt and stopped. The customer dropped off the list for good and
    // nobody would ever be prompted to call them again — previousRenewalId had sat unused in
    // the schema since the beginning for exactly this.
    const before = new Set(
      (await as(admin).get('/api/renewals')).body.map((r: { id: string }) => r.id),
    );
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({
      assignedCaller: caller.userId,
      medicines: [{ name: 'Atorva', days: 30 }],
    }));
    await as(admin).post(`/api/leads/${lead.id}/convert`, convertPayload());

    const [renewal] = (await as(admin).get('/api/renewals')).body
      .filter((r: { id: string }) => !before.has(r.id));
    // Renewing is a sale now, so it carries the same preconditions as a conversion.
    expect((await as(admin).post(`/api/renewals/${renewal.id}/renew`, {})).status).toBe(400);

    await setStock('Atorva', 999);
    const renewed = await as(admin).post(`/api/renewals/${renewal.id}/renew`, {
      items: [{ name: 'Atorva', days: 30 }],
      paymentScreenshot: 'data:image/png;base64,AAA',
      discountType: 'flat',
      discountValue: 100,
    });
    expect(renewed.status).toBe(200);
    // It places the repeat order and applies the discount, not just a status flip.
    expect(renewed.body.order.payableAmount).toBe(renewed.body.order.totalAmount - 100);
    expect(renewed.body.renewal.status).toBe('renewed');

    const after = (await as(admin).get('/api/renewals')).body
      .filter((r: { id: string }) => !before.has(r.id));
    expect(after).toHaveLength(2);
    expect(after.filter((r: { status: string }) => r.status === 'renewed')).toHaveLength(1);
    // The successor is live, so the customer stays in the follow-up cycle.
    expect(after.filter((r: { status: string }) => r.status !== 'renewed')).toHaveLength(1);
  });

  it('a sale deducts from the caller’s location, and no other', async () => {
    // The point of the whole feature: a caller sells from their assigned location only. A
    // caller at West, a lead of theirs — converting it must draw from West and leave Main
    // Store alone, even though the same medicine sits at both.
    const main = (await as(admin).get('/api/locations')).body.find((l: { name: string }) => l.name === 'Main Store');
    const { body: west } = await as(admin).post('/api/locations', { name: `West ${nextId()}` });
    const atorva = (await as(admin).get('/api/medicines')).body.find((m: { name: string }) => m.name === 'Atorva');

    await as(admin).post(`/api/medicines/${atorva.id}/stock`, { mode: 'set', quantity: 100, locationId: main.id });
    await as(admin).post(`/api/medicines/${atorva.id}/stock`, { mode: 'set', quantity: 100, locationId: west.id });

    const stockAt = async (locationId: string) => {
      const m = (await as(admin).get('/api/medicines')).body.find((x: { id: string }) => x.id === atorva.id);
      return m.locations.find((s: { locationId: string }) => s.locationId === locationId)?.quantity ?? 0;
    };

    // A caller assigned to West sells from West.
    const { body: westCaller } = await as(admin).post('/api/users', {
      name: 'West Caller', employeeId: `WC${nextId()}`, phone: '9000000222',
      email: `west${nextId()}@medicrm.in`, role: 'caller', locationId: west.id,
    });
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({
      assignedCaller: westCaller.id,
      medicines: [{ name: 'Atorva', days: 30 }],
    }));
    expect((await as(admin).post(`/api/leads/${lead.id}/convert`, convertPayload({
      items: [{ name: 'Atorva', days: 30 }],
    }))).status).toBe(200);

    expect(await stockAt(west.id)).toBe(70); // 100 - 30, the caller's location
    expect(await stockAt(main.id)).toBe(100); // untouched
  });

  it('a caller with no location cannot sell — the sale is refused', async () => {
    const { body: noLoc } = await as(admin).post('/api/users', {
      name: 'No Location', employeeId: `NL${nextId()}`, phone: '9000000123',
      email: `noloc${nextId()}@medicrm.in`, role: 'caller',
    });
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: noLoc.id }));

    const res = await as(admin).post(`/api/leads/${lead.id}/convert`, convertPayload());
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/no location/i);
    // Nothing was written — the lead is still convertible once a location is set.
    expect((await as(admin).get(`/api/leads/${lead.id}`)).body.status).not.toBe('converted');
  });

  it('refuses a conversion the catalogue cannot cover, and touches nothing', async () => {
    // Days are units, so a 50-day order needs 50 in stock. Below that the whole order is
    // rejected — the old behaviour fulfilled anyway and floored stock at zero. Admin is the
    // only role that can restock, which the message says.
    await setStock('Atorva', 10);
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({
      assignedCaller: caller.userId,
      medicines: [{ name: 'Atorva', days: 50 }],
    }));

    const res = await as(admin).post(`/api/leads/${lead.id}/convert`, convertPayload({
      items: [{ name: 'Atorva', days: 50 }],
    }));
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/ask an admin to update the stock/i);

    // Whole order refused: the caller's location stock is unchanged and the lead is still
    // convertible. Checked at Main Store — the caller's location — not the cross-location total.
    const atorva = (await as(admin).get('/api/medicines')).body.find((m: { name: string }) => m.name === 'Atorva');
    const mainStock = atorva.locations.find((s: { locationName: string }) => s.locationName === 'Main Store')?.quantity;
    expect(mainStock).toBe(10);
    const after = await as(admin).get(`/api/leads/${lead.id}`);
    expect(after.body.status).not.toBe('converted');
  });

  it('days on the reorder line sets when the next renewal falls due', async () => {
    // The reported confusion: the dialog billed by a quantity box, so entering 20 charged for
    // 20 units and did nothing to the supply period. Days are units now, like a lead, and days
    // is also what dates the next renewal.
    await setStock('Atorva', 999);
    const before = new Set(
      (await as(admin).get('/api/renewals')).body.map((r: { id: string }) => r.id),
    );
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({
      assignedCaller: caller.userId,
      medicines: [{ name: 'Atorva', days: 1 }],
    }));
    await as(admin).post(`/api/leads/${lead.id}/convert`, convertPayload());
    const [renewal] = (await as(admin).get('/api/renewals')).body
      .filter((r: { id: string }) => !before.has(r.id));

    const product = (await as(admin).get('/api/medicines')).body
      .find((m: { name: string }) => m.name === 'Atorva');
    await setStock('Atorva', 999);

    const renewed = await as(admin).post(`/api/renewals/${renewal.id}/renew`, {
      items: [{ name: 'Atorva', days: 45 }],
      paymentScreenshot: 'data:image/png;base64,AAA',
    });
    expect(renewed.status).toBe(200);
    // Days are units: 45 days is 45 units, billed at 45 x the unit price.
    expect(renewed.body.order.medicines[0].quantity).toBe(45);
    expect(renewed.body.order.totalAmount).toBe(product.unitPrice * 45);

    const next = (await as(admin).get('/api/renewals')).body
      .filter((r: { id: string }) => !before.has(r.id))
      .find((r: { status: string }) => r.status !== 'renewed');
    const supplyDays = Math.round(
      (new Date(next.renewalDate).getTime() - new Date(next.orderDate).getTime()) / 86_400_000,
    );
    expect(supplyDays).toBe(45);
  });

  it('the reorder is editable — extra medicines reach the order, priced by their days', async () => {
    // A renewal is raised per medicine, but the reorder it triggers is a conversation: the
    // customer renewing this may as well add that. Each line bills its days as units.
    const before = new Set(
      (await as(admin).get('/api/renewals')).body.map((r: { id: string }) => r.id),
    );
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({
      assignedCaller: caller.userId,
      medicines: [{ name: 'Atorva', days: 1 }],
    }));
    await as(admin).post(`/api/leads/${lead.id}/convert`, convertPayload());
    const [renewal] = (await as(admin).get('/api/renewals')).body
      .filter((r: { id: string }) => !before.has(r.id));

    await setStock('Atorva', 999);
    await setStock('Sansamrit', 999);
    const renewed = await as(admin).post(`/api/renewals/${renewal.id}/renew`, {
      items: [
        { name: 'Atorva', days: 30 },
        { name: 'Sansamrit', days: 15 },
      ],
      paymentScreenshot: 'data:image/png;base64,AAA',
    });
    expect(renewed.status).toBe(200);

    const lines = renewed.body.order.medicines;
    expect(lines).toHaveLength(2);
    // Quantity equals the days on each line.
    expect(Object.fromEntries(lines.map((m: { name: string; quantity: number }) => [m.name, m.quantity])))
      .toEqual({ Atorva: 30, Sansamrit: 15 });
    // Total is each medicine's price times its days.
    const expected = lines.reduce((n: number, m: { price: number; quantity: number }) => n + m.price * m.quantity, 0);
    expect(renewed.body.order.totalAmount).toBe(expected);
  });

  it('a reminder defaults to the renewal date, and pressing again moves it', async () => {
    // It used to hardcode now(), so a renewal three weeks out put a task on the caller's list
    // today — and it had no guard, so pressing twice left two identical tasks to complete
    // separately.
    const before = new Set(
      (await as(admin).get('/api/renewals')).body.map((r: { id: string }) => r.id),
    );
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));
    await as(admin).post(`/api/leads/${lead.id}/convert`, convertPayload());
    const [renewal] = (await as(admin).get('/api/renewals')).body
      .filter((r: { id: string }) => !before.has(r.id));

    const countReminders = async () =>
      (await as(admin).get('/api/follow-ups')).body
        .filter((f: { type: string; customerName: string }) => f.type === 'reminder').length;

    const start = await countReminders();
    const first = await as(admin).post(`/api/renewals/${renewal.id}/remind`, {});
    expect(first.status).toBe(201);
    expect(first.body.scheduledDate).toBe(renewal.renewalDate);
    expect(await countReminders()).toBe(start + 1);

    // Same task moved, not a second one raised.
    const again = await as(admin).post(`/api/renewals/${renewal.id}/remind`, { scheduledDate: '2026-12-24' });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(again.body.scheduledDate).toBe('2026-12-24');
    expect(await countReminders()).toBe(start + 1);
  });

  it('refuses a reorder line with a nonsense day count', async () => {
    const before = new Set(
      (await as(admin).get('/api/renewals')).body.map((r: { id: string }) => r.id),
    );
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));
    await as(admin).post(`/api/leads/${lead.id}/convert`, convertPayload());
    const [renewal] = (await as(admin).get('/api/renewals')).body
      .filter((r: { id: string }) => !before.has(r.id));

    const res = await as(admin).post(`/api/renewals/${renewal.id}/renew`, {
      items: [{ name: 'Atorva', days: -5 }],
      paymentScreenshot: 'data:image/png;base64,AAA',
    });
    expect(res.status).toBe(400);
    // Refused whole: the renewal is still open, so nothing was half-applied.
    const stillOpen = (await as(admin).get('/api/renewals')).body
      .find((r: { id: string }) => r.id === renewal.id);
    expect(stillOpen.status).not.toBe('renewed');
  });

  it('logging an activity returns { activity, medicine } and actually saves the medicine', async () => {
    // Same shape bug, third instance: this returned the activity alone while the client
    // destructured { activity, medicine }, and the medicine in the body was read and dropped.
    // Nothing threw — an undefined activity went into the store and the medicine vanished.
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));

    const res = await as(admin).post(`/api/leads/${lead.id}/activities`, {
      description: 'called, also wants Sansamrit',
      medicine: { name: 'Sansamrit', days: 30 },
    });
    expect(res.status).toBe(201);
    expect(res.body.activity.description).toMatch(/Sansamrit/);
    expect(res.body.medicine.name).toBe('Sansamrit');

    const after = await as(admin).get(`/api/leads/${lead.id}`);
    expect(after.body.medicines.map((m: { name: string }) => m.name)).toContain('Sansamrit');
  });

  it('completing returns { followUp, lead }, which is what the UI destructures', async () => {
    // The shape, not just the status code. This endpoint returned the follow-up alone while
    // both callers destructured { followUp, lead } — so `lead.id` threw AFTER the write had
    // committed: the row changed and the screen did not. Every test here passed throughout,
    // because they all re-fetch the lead instead of reading the response.
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));
    await as(admin).patch(`/api/leads/${lead.id}`, { nextFollowUp: '2026-10-01' });
    const [followUp] = (await as(admin).get('/api/follow-ups')).body.filter(
      (f: { leadId?: string }) => f.leadId === lead.id,
    );

    const res = await as(admin).patch(`/api/follow-ups/${followUp.id}`, { status: 'completed' });
    expect(res.status).toBe(200);
    expect(res.body.followUp.status).toBe('completed');
    expect(res.body.lead.id).toBe(lead.id);
    // The lead travels back already updated, so the client need not re-fetch to stay honest.
    expect(res.body.lead.nextFollowUp).toBe('');
  });

  it('completing the next follow-up advances the lead to the one after it', async () => {
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));
    const first = await as(admin).post(`/api/leads/${lead.id}/follow-ups`, { scheduledDate: '2026-10-05' });
    await as(admin).post(`/api/leads/${lead.id}/follow-ups`, { scheduledDate: '2026-11-05' });

    expect((await as(admin).get(`/api/leads/${lead.id}`)).body.nextFollowUp).toBe('2026-10-05');

    await as(admin).patch(`/api/follow-ups/${first.body.id}`, { status: 'completed' });
    // Recomputed, not merely blanked: the later follow-up is now the next one.
    expect((await as(admin).get(`/api/leads/${lead.id}`)).body.nextFollowUp).toBe('2026-11-05');
  });
});

describe('payment mode', () => {
  it('an offline sale converts without a screenshot; an online one still cannot', async () => {
    await setStock('Atorva', 999);

    // Cash over the counter leaves no image, so demanding one meant inventing a picture to
    // record a sale that plainly happened.
    const { body: cashLead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));
    const offline = await as(admin).post(`/api/leads/${cashLead.id}/convert`, convertPayload({
      paymentMode: 'offline',
      paymentScreenshot: '',
    }));
    expect(offline.status).toBe(200);
    expect(offline.body.order.paymentMode).toBe('offline');
    expect(offline.body.order.paymentScreenshot).toBeUndefined();
    // Still a completed sale, just without the picture.
    expect(offline.body.order.paymentStatus).toBe('paid');

    // A transfer does leave one, so the proof is still demanded.
    const { body: onlineLead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));
    const online = await as(admin).post(`/api/leads/${onlineLead.id}/convert`, convertPayload({
      paymentMode: 'online',
      paymentScreenshot: '',
    }));
    expect(online.status).toBe(400);
    expect(String(online.body.error)).toMatch(/screenshot/i);
  });

  it('a renewal follows the same rule — cash reorders without a screenshot', async () => {
    await setStock('Atorva', 999);
    const before = new Set((await as(admin).get('/api/renewals')).body.map((r: { id: string }) => r.id));
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));
    await as(admin).post(`/api/leads/${lead.id}/convert`, convertPayload());
    const [renewal] = (await as(admin).get('/api/renewals')).body.filter((r: { id: string }) => !before.has(r.id));

    // Online still demands the proof.
    const online = await as(admin).post(`/api/renewals/${renewal.id}/renew`, {
      items: [{ name: 'Atorva', days: 30 }],
      paymentMode: 'online',
      paymentScreenshot: '',
    });
    expect(online.status).toBe(400);
    expect(String(online.body.error)).toMatch(/screenshot/i);

    // Cash does not, and the order records how it was paid.
    const offline = await as(admin).post(`/api/renewals/${renewal.id}/renew`, {
      items: [{ name: 'Atorva', days: 30 }],
      paymentMode: 'offline',
      paymentScreenshot: '',
    });
    expect(offline.status).toBe(200);
    expect(offline.body.order.paymentMode).toBe('offline');
    expect(offline.body.order.paymentScreenshot).toBeUndefined();
    expect(offline.body.order.paymentStatus).toBe('paid');
  });

  it('defaults to online, so an unspecified mode still demands proof', async () => {
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));
    const res = await as(admin).post(`/api/leads/${lead.id}/convert`, convertPayload({ paymentScreenshot: '' }));
    expect(res.status).toBe(400);
  });
});

describe('pincode', () => {
  it('is optional everywhere — a lead records and sells without one', async () => {
    // Taken down over the phone, a pincode often is not known yet. Refusing the lead for it
    // lost leads that were otherwise complete, and refusing the sale for it blocked a sale
    // that had already happened.
    const payload = leadPayload({ assignedCaller: caller.userId });
    delete (payload as Record<string, unknown>).pincode;
    const created = await as(admin).post('/api/leads', payload);
    expect(created.status).toBe(201);
    expect(created.body.pincode ?? '').toBe('');

    const sold = await as(admin).patch(`/api/leads/${created.body.id}`, {
      status: 'sold',
      paymentScreenshot: 'data:image/png;base64,iVBORw0KGgo=',
    });
    expect(sold.status).toBe(200);
    expect(sold.body.status).toBe('sold');
  });

  it('still refuses a sale with no address, which pincode does not stand in for', async () => {
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));
    const res = await as(admin).patch(`/api/leads/${lead.id}`, {
      status: 'sold',
      address: '',
      paymentScreenshot: 'data:image/png;base64,iVBORw0KGgo=',
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/address/i);
  });
});

describe('a write reports what it caused', () => {
  it('converting returns the renewal it opened for the order', async () => {
    await setStock('Atorva', 999);
    await setStock('Sansamrit', 999);
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({
      assignedCaller: caller.userId,
      medicines: [{ name: 'Atorva', days: 30 }, { name: 'Sansamrit', days: 15 }],
    }));

    const res = await as(admin).post(`/api/leads/${lead.id}/convert`, convertPayload({
      items: [{ name: 'Atorva', days: 30 }, { name: 'Sansamrit', days: 15 }],
    }));
    expect(res.status).toBe(200);
    // Without these the client is told an order exists but never that the sale opened any
    // renewals, so the Renewals page ignores the sale until the data is fetched again.
    expect(res.body.renewals).toHaveLength(1);
    expect(res.body.renewals[0].medicineName).toBe('Atorva, Sansamrit');
    // They are the real rows, not echoes of the request.
    const listed = (await as(admin).get('/api/renewals')).body.map((r: { id: string }) => r.id);
    for (const r of res.body.renewals) expect(listed).toContain(r.id);
  });

  it('renewing returns the cycle it opened, not just the one it closed', async () => {
    await setStock('Atorva', 999);
    const before = new Set((await as(admin).get('/api/renewals')).body.map((r: { id: string }) => r.id));
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));
    await as(admin).post(`/api/leads/${lead.id}/convert`, convertPayload());
    const [renewal] = (await as(admin).get('/api/renewals')).body.filter((r: { id: string }) => !before.has(r.id));

    const res = await as(admin).post(`/api/renewals/${renewal.id}/renew`, {
      items: [{ name: 'Atorva', days: 30 }],
      paymentScreenshot: 'data:image/png;base64,AAA',
    });
    expect(res.status).toBe(200);
    expect(res.body.renewal.id).toBe(renewal.id);          // the cycle just closed
    expect(res.body.nextRenewal).toBeTruthy();             // the cycle that replaces it
    expect(res.body.nextRenewal.id).not.toBe(renewal.id);
    expect(res.body.nextRenewal.previousRenewalId).toBe(renewal.id);
    expect(res.body.nextRenewal.status).not.toBe('renewed');
  });
});

describe('follow-up time slot', () => {
  it('is set from the lead form, moves with it, and clears', async () => {
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));

    // Setting the date and a slot together, which is how the form sends it.
    await as(admin).patch(`/api/leads/${lead.id}`, { nextFollowUp: '2026-11-03', followUpSlot: 'evening' });
    const first = (await as(admin).get('/api/follow-ups')).body.find((f: { leadId?: string }) => f.leadId === lead.id);
    expect(first.slot).toBe('evening');

    // Changing it moves the same follow-up rather than leaving the old slot behind.
    await as(admin).patch(`/api/leads/${lead.id}`, { nextFollowUp: '2026-11-03', followUpSlot: 'morning' });
    const moved = (await as(admin).get('/api/follow-ups')).body.find((f: { id: string }) => f.id === first.id);
    expect(moved.slot).toBe('morning');

    // "Any time" is a real answer, not a missing one.
    await as(admin).patch(`/api/leads/${lead.id}`, { nextFollowUp: '2026-11-03', followUpSlot: '' });
    const cleared = (await as(admin).get('/api/follow-ups')).body.find((f: { id: string }) => f.id === first.id);
    expect(cleared.slot).toBeUndefined();
  });

  it('refuses a slot the app does not offer', async () => {
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));
    const res = await as(admin).patch(`/api/leads/${lead.id}`, {
      nextFollowUp: '2026-11-04',
      followUpSlot: 'midnight',
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/morning, afternoon, evening/i);
  });

  it('a renewal reminder carries one too', async () => {
    await setStock('Atorva', 999);
    const before = new Set((await as(admin).get('/api/renewals')).body.map((r: { id: string }) => r.id));
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));
    await as(admin).post(`/api/leads/${lead.id}/convert`, convertPayload());
    const [renewal] = (await as(admin).get('/api/renewals')).body.filter((r: { id: string }) => !before.has(r.id));

    const res = await as(admin).post(`/api/renewals/${renewal.id}/remind`, {
      scheduledDate: '2026-11-10',
      slot: 'afternoon',
    });
    expect(res.body.slot).toBe('afternoon');
  });
});

describe('a follow-up carries the number to ring', () => {
  it('from the lead, and from the customer for a renewal reminder', async () => {
    await setStock('Atorva', 999);
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({
      assignedCaller: caller.userId,
      mobile: '9000000456',
    }));

    // A lead's own follow-up takes the lead's number.
    const created = await as(admin).post(`/api/leads/${lead.id}/follow-ups`, { scheduledDate: '2026-12-02' });
    expect(created.body.mobile).toBe('9000000456');
    // And it survives the round trip through the list, which is what the Calendar reads.
    const listed = (await as(admin).get('/api/follow-ups')).body.find((f: { id: string }) => f.id === created.body.id);
    expect(listed.mobile).toBe('9000000456');

    // A renewal reminder has no lead, so it falls back to the customer record.
    const before = new Set((await as(admin).get('/api/renewals')).body.map((r: { id: string }) => r.id));
    await as(admin).post(`/api/leads/${lead.id}/convert`, convertPayload());
    const [renewal] = (await as(admin).get('/api/renewals')).body.filter((r: { id: string }) => !before.has(r.id));
    const reminder = await as(admin).post(`/api/renewals/${renewal.id}/remind`, { scheduledDate: '2026-12-09' });
    expect(reminder.body.leadId).toBeUndefined();
    expect(reminder.body.mobile).toBe('9000000456');
  });
});

describe('renewal reminders', () => {
  it('moves the existing reminder to the new date and says which renewal it is for', async () => {
    await setStock('Atorva', 999);
    const before = new Set((await as(admin).get('/api/renewals')).body.map((r: { id: string }) => r.id));
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));
    await as(admin).post(`/api/leads/${lead.id}/convert`, convertPayload());
    const [renewal] = (await as(admin).get('/api/renewals')).body.filter((r: { id: string }) => !before.has(r.id));

    // First reminder, on a date of its own rather than the renewal date.
    const first = await as(admin).post(`/api/renewals/${renewal.id}/remind`, { scheduledDate: '2026-09-05' });
    expect(first.body.scheduledDate).toBe('2026-09-05');
    // renewalId is what lets the client find this reminder again; without it the dialog can
    // only offer the renewal date back and a moved reminder looks like it never saved.
    expect(first.body.renewalId).toBe(renewal.id);

    // Moving it edits that same reminder rather than stacking a second one.
    const moved = await as(admin).post(`/api/renewals/${renewal.id}/remind`, { scheduledDate: '2026-09-20' });
    expect(moved.body.id).toBe(first.body.id);
    expect(moved.body.scheduledDate).toBe('2026-09-20');

    const reminders = (await as(admin).get('/api/follow-ups')).body
      .filter((f: { renewalId?: string }) => f.renewalId === renewal.id);
    expect(reminders).toHaveLength(1);
    expect(reminders[0].scheduledDate).toBe('2026-09-20');
  });
});

describe('conversion is dated', () => {
  it('stamps convertedDate when a lead converts, and leaves it blank before', async () => {
    await setStock('Atorva', 999);
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));
    // A live lead has not sold, so it carries no date.
    expect(lead.convertedDate).toBe('');

    await as(admin).post(`/api/leads/${lead.id}/convert`, convertPayload());
    const { body: after } = await as(admin).get(`/api/leads/${lead.id}`);
    expect(after.status).toBe('converted');
    // Dated the day it converted — not merely non-empty, which a stray createdAt would satisfy.
    expect(after.convertedDate).toBe(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }));
  });

  it('stamps a lead marked sold by hand, and clears it if the status is taken back', async () => {
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));
    const sold = await as(admin).patch(`/api/leads/${lead.id}`, {
      status: 'sold',
      address: '1 Test Street',
      pincode: '400001',
      paymentScreenshot: 'data:image/png;base64,iVBORw0KGgo=',
    });
    expect(sold.status).toBe(200);
    expect(sold.body.convertedDate).not.toBe('');

    // Set in error and taken back: the date must not linger, or the lead would keep counting
    // as a customer that never was.
    const undone = await as(admin).patch(`/api/leads/${lead.id}`, { status: 'interested' });
    expect(undone.body.convertedDate).toBe('');
  });
});

describe('location deletion', () => {
  it('deletes an empty location, and it drops out of the list', async () => {
    const { body: loc } = await as(admin).post('/api/locations', { name: `Empty ${nextId()}` });
    expect((await as(admin).delete(`/api/locations/${loc.id}`)).status).toBe(204);
    const names = (await as(admin).get('/api/locations')).body.map((l: { id: string }) => l.id);
    expect(names).not.toContain(loc.id);
  });

  it('refuses to delete a location that still holds stock, and keeps it', async () => {
    const { body: loc } = await as(admin).post('/api/locations', { name: `Stocked ${nextId()}` });
    const atorva = (await as(admin).get('/api/medicines')).body.find((m: { name: string }) => m.name === 'Atorva');
    await as(admin).post(`/api/medicines/${atorva.id}/stock`, { mode: 'set', quantity: 5, locationId: loc.id });

    const res = await as(admin).delete(`/api/locations/${loc.id}`);
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/still holds stock/i);
    // Still there, and still convertible to a delete once zeroed.
    expect((await as(admin).get('/api/locations')).body.map((l: { id: string }) => l.id)).toContain(loc.id);

    // Zero it, and now it goes.
    await as(admin).post(`/api/medicines/${atorva.id}/stock`, { mode: 'set', quantity: 0, locationId: loc.id });
    expect((await as(admin).delete(`/api/locations/${loc.id}`)).status).toBe(204);
  });

  it('refuses to delete a location a caller is assigned to, and keeps it', async () => {
    const { body: loc } = await as(admin).post('/api/locations', { name: `Manned ${nextId()}` });
    await as(admin).post('/api/users', {
      name: 'Manned Caller', employeeId: `MC${nextId()}`, phone: '9000000333',
      email: `manned${nextId()}@medicrm.in`, role: 'caller', locationId: loc.id,
    });

    const res = await as(admin).delete(`/api/locations/${loc.id}`);
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/caller/i);
    expect((await as(admin).get('/api/locations')).body.map((l: { id: string }) => l.id)).toContain(loc.id);
  });

  it('refuses a caller — deletion is admin-only, and the location survives', async () => {
    const { body: loc } = await as(admin).post('/api/locations', { name: `Guarded ${nextId()}` });
    expect((await as(caller).delete(`/api/locations/${loc.id}`)).status).toBe(403);
    expect((await as(admin).get('/api/locations')).body.map((l: { id: string }) => l.id)).toContain(loc.id);
  });
});

describe('authorization', () => {
  it('admin-only endpoints refuse a caller with 403, and write nothing', async () => {
    const med = (await as(admin).get('/api/medicines')).body[0];
    expect((await as(caller).post('/api/medicines', { name: 'nope', unitPrice: 1 })).status).toBe(403);

    const res = await as(caller).patch(`/api/medicines/${med.id}`, { unitPrice: 9999 });
    expect(res.status).toBe(403);
    const after = await prisma.product.findUniqueOrThrow({ where: { id: med.id } });
    expect(Number(after.unitPrice)).not.toBe(9999);
  });

  it('a caller may not escalate their own role, and stays a caller', async () => {
    const res = await as(caller).patch(`/api/users/${caller.userId}`, { role: 'admin' });
    expect(res.status).toBe(403);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: caller.userId } });
    expect(after.role).toBe('caller');
  });

  it('a caller may still edit their own ordinary fields', async () => {
    expect((await as(caller).patch(`/api/users/${caller.userId}`, { phone: '9812345678' })).status).toBe(200);
  });

  it('a caller may not delete a lead, even their own', async () => {
    const own = await prisma.lead.findFirstOrThrow({ where: { deletedAt: null, assignedCallerId: caller.userId } });
    expect((await as(caller).delete(`/api/leads/${own.id}`)).status).toBe(403);
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: own.id } });
    expect(after.deletedAt).toBeNull();
  });

  it('out-of-scope rows answer 404, not 403', async () => {
    // Saying "forbidden" would confirm the row exists. This matches the row-filtering the
    // previous system used, where a caller's query simply matched nothing.
    const foreign = await prisma.lead.findFirstOrThrow({
      where: { deletedAt: null, assignedCallerId: other.userId },
    });
    expect((await as(caller).get(`/api/leads/${foreign.id}`)).status).toBe(404);

    const patch = await as(caller).patch(`/api/leads/${foreign.id}`, { notes: 'BREACH' });
    expect(patch.status).toBe(404);
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: foreign.id } });
    expect(after.notes).not.toBe('BREACH');
  });

  it('a caller cannot assign a lead away from themselves', async () => {
    const own = await prisma.lead.findFirstOrThrow({ where: { deletedAt: null, assignedCallerId: caller.userId } });
    expect((await as(caller).patch(`/api/leads/${own.id}`, { assignedCaller: other.userId })).status).toBe(403);
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: own.id } });
    expect(after.assignedCallerId).toBe(caller.userId);
  });

  it('a caller’s new lead is force-assigned to themselves', async () => {
    const res = await as(caller).post('/api/leads', leadPayload({ assignedCaller: other.userId }));
    expect(res.status).toBe(201);
    expect(res.body.assignedCaller).toBe(caller.userId);
  });
});

describe('stock and orders', () => {
  it('a caller updating an order is told why for their own, and nothing for anyone else’s', async () => {
    // The refusal used to be a flat 404, so a caller clicking an order visible on their own
    // screen was told it did not exist. Explaining it is only safe for orders already in
    // their scope — for the rest, 404 is what keeps the existence of an order private.
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));
    const { body: converted } = await as(admin).post(`/api/leads/${lead.id}/convert`, convertPayload());

    const own = await as(caller).patch(`/api/orders/${converted.order.id}`, { stage: 'packed' });
    expect(own.status).toBe(403);
    expect(own.body.error).toBe("You don't have permission to update this order.");

    // Someone else's, and one that does not exist, must be indistinguishable.
    const { body: foreignLead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: other.userId }));
    const { body: foreign } = await as(admin).post(`/api/leads/${foreignLead.id}/convert`, convertPayload());

    const notMine = await as(caller).patch(`/api/orders/${foreign.order.id}`, { stage: 'packed' });
    const missing = await as(caller).patch('/api/orders/00000000-0000-0000-0000-000000000000', { stage: 'packed' });
    expect(notMine.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(notMine.body.error).toBe(missing.body.error);

    // And the refusal actually refused.
    const after = await as(admin).get('/api/orders');
    expect(after.body.find((o: { id: string }) => o.id === converted.order.id).stage).not.toBe('packed');
  });

  it('adds and sets stock, and refuses nonsense quantities', async () => {
    const created = await as(admin).post('/api/medicines', { name: `T Med ${nextId()}`, unitPrice: 10, stockQuantity: 5 });
    expect(created.status).toBe(201);
    const id = created.body.id;

    expect((await as(admin).post(`/api/medicines/${id}/stock`, { mode: 'add', quantity: 7 })).body.stockQuantity).toBe(12);
    expect((await as(admin).post(`/api/medicines/${id}/stock`, { mode: 'set', quantity: 3 })).body.stockQuantity).toBe(3);

    for (const body of [
      { mode: 'add', quantity: 0 }, { mode: 'add', quantity: -5 },
      { mode: 'set', quantity: -1 }, { mode: 'sideways', quantity: 5 },
    ]) {
      expect((await as(admin).post(`/api/medicines/${id}/stock`, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await as(admin).delete(`/api/medicines/${id}`)).status).toBe(204);
  });

  it('a discount recomputes the payable amount', async () => {
    const lead = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));
    const { body } = await as(admin).post(`/api/leads/${lead.body.id}/convert`, convertPayload());
    const total = body.order.totalAmount;

    const flat = await as(admin).patch(`/api/orders/${body.order.id}`, { discountType: 'flat', discountValue: 20 });
    expect(flat.body.payableAmount).toBe(total - 20);

    const pct = await as(admin).patch(`/api/orders/${body.order.id}`, { discountType: 'percentage', discountValue: 10 });
    expect(pct.body.payableAmount).toBeCloseTo(total * 0.9, 2);

    // A discount larger than the order floors at zero rather than going negative.
    const huge = await as(admin).patch(`/api/orders/${body.order.id}`, { discountType: 'flat', discountValue: 999999 });
    expect(huge.body.payableAmount).toBe(0);
  });
});

describe('error mapping', () => {
  it('missing fields -> 400 naming the field', async () => {
    const res = await as(admin).post('/api/leads', { mobile: '9000000001' });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/required/i);
  });

  it('a lead with no medicines is fine — the sale is composed at conversion', async () => {
    const res = await as(admin).post('/api/leads', leadPayload({ medicines: [] }));
    expect(res.status).toBe(201);
  });

  it('converting with nothing chosen -> 400', async () => {
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));
    const res = await as(admin).post(`/api/leads/${lead.id}/convert`, convertPayload({ items: [] }));
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/at least one medicine/i);
  });

  it('a duplicate email -> 409 with a readable message', async () => {
    const payload = { name: 'Dup', employeeId: `D${nextId()}`, phone: '9000000009', email: 'aarav.sharma@medicrm.in' };
    const res = await as(admin).post('/api/users', payload);
    expect(res.status).toBe(409);
    expect(String(res.body.error)).toMatch(/already exists/i);
  });

  it('an unknown id -> 404', async () => {
    const missing = '00000000-0000-0000-0000-000000000000';
    expect((await as(admin).get(`/api/leads/${missing}`)).status).toBe(404);
    expect((await as(admin).patch(`/api/leads/${missing}`, { notes: 'x' })).status).toBe(404);
    expect((await as(admin).delete(`/api/leads/${missing}`)).status).toBe(404);
  });

  it('malformed JSON -> 400, not 500', async () => {
    // express.json() throws a SyntaxError; without explicit handling a client's bad request
    // is reported as a server fault.
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{oops');
    expect(res.status).toBe(400);
  });

  it('an id that is not a UUID -> 400, not 500', async () => {
    // Prisma raises P2007 for this. It was in none of the mapped codes, so a typo in a URL
    // came back as a server fault.
    const res = await as(admin).get('/api/leads/not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('an unusable date is rejected by the route, before Prisma', async () => {
    const { body: lead } = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));
    const created = await as(admin).post(`/api/leads/${lead.id}/follow-ups`, {
      scheduledDate: '2026-12-01',
      type: 'call',
    });

    const res = await as(admin).patch(`/api/follow-ups/${created.body.id}`, { scheduledDate: 'garbage' });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/YYYY-MM-DD/);
  });

  it('a value Prisma rejects -> 400 naming the field, not 500', async () => {
    // Exercised directly rather than through a route. The routes that used to reach Prisma
    // with an unconverted value now validate first, which is the better place for it — but
    // the mapping still has to hold for any value that slips past a route in future.
    const { errorMiddleware } = await import('../src/lib/errors.js');
    const wrongType = Object.assign(
      new Error('Invalid value for argument `scheduledAt`: premature end of input. Expected ISO-8601 DateTime.'),
      { name: 'PrismaClientValidationError' },
    );

    let status = 0;
    let payload: { error?: string } = {};
    const res = {
      status(code: number) { status = code; return this; },
      json(body: { error?: string }) { payload = body; return this; },
    };
    errorMiddleware(wrongType, {} as never, res as never, (() => {}) as never);
    expect(status).toBe(400);
    expect(String(payload.error)).toMatch(/scheduledAt/);
  });

  it('a query fault of our own still -> 500, not a 400 blaming the caller', async () => {
    // The guard on the rule above. Prisma raises PrismaClientValidationError both for a value
    // the client got wrong and for an argument this codebase got wrong, so the downgrade to
    // 400 keys on "Invalid value for argument" specifically. If it were applied to the whole
    // error class, our own bugs would be reported as the caller's fault and would vanish from
    // the error rate. This asserts the second kind is still a 500.
    const { errorMiddleware } = await import('../src/lib/errors.js');
    const unknownArgument = Object.assign(
      new Error('Unknown argument `noSuchColumn`. Available options are marked with ?.'),
      { name: 'PrismaClientValidationError' },
    );

    let status = 0;
    const res = {
      status(code: number) { status = code; return this; },
      json() { return this; },
    };
    errorMiddleware(unknownArgument, {} as never, res as never, (() => {}) as never);
    expect(status).toBe(500);
  });

  it('an unknown route -> 404 JSON, not an HTML page', async () => {
    const res = await as(admin).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toBeTruthy();
  });
});

describe('audit trail', () => {
  it('records the acting user, not a session variable', async () => {
    // The previous implementation read the actor from a session GUC that was NULL on
    // connections where it had not been set, and silently wrote no attribution at all.
    const lead = await as(admin).post('/api/leads', leadPayload());
    const entry = await prisma.auditLog.findFirst({
      where: { tableName: 'leads', recordId: lead.body.id },
      orderBy: { changedAt: 'desc' },
    });
    expect(entry).not.toBeNull();
    expect(entry!.changedBy).toBe(admin.userId);
    expect(entry!.action).toBe('INSERT');
  });

  it('an update records only what changed', async () => {
    const lead = await as(admin).post('/api/leads', leadPayload());
    await as(admin).patch(`/api/leads/${lead.body.id}`, { notes: 'a new note' });
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { tableName: 'leads', recordId: lead.body.id, action: 'UPDATE' },
      orderBy: { changedAt: 'desc' },
    });
    expect(Object.keys(entry.newData as object)).toContain('notes');
    expect(Object.keys(entry.newData as object)).not.toContain('city');
  });
});
