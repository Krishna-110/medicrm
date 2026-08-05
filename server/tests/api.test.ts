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

const leadPayload = (over: Record<string, unknown> = {}) => ({
  customerName: `T Lead ${nextId()}`,
  mobile: '9000000001',
  address: '1 Test Street',
  city: 'Mumbai',
  state: 'Maharashtra',
  pincode: '400001',
  disease: 'Hypertension',
  medicines: [{ name: 'Atorva', days: 30 }],
  ...over,
});

beforeAll(async () => {
  [admin, caller, other] = await Promise.all([login(ADMIN), login(CALLER), login(OTHER)]);
});

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
      const res = await as(admin).post(`/api/leads/${lead.id}/convert`);
      return Number(res.body.order.totalAmount);
    };

    const untouched = await price(false);
    expect(untouched).toBeGreaterThan(0); // guards the comparison below from passing on 0 === 0
    expect(await price(true)).toBe(untouched);
  });

  it('converts to an order, deducting stock and closing the lead', async () => {
    const product = await prisma.product.findFirstOrThrow({ where: { brandName: 'Atorva' } });
    const stockBefore = product.stockQuantity;

    const lead = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));
    const res = await as(admin).post(`/api/leads/${lead.body.id}/convert`);
    expect(res.status).toBe(200);
    expect(res.body.order.orderNumber).toMatch(/^ORD-\d{4}-\d{4}$/);
    expect(res.body.order.medicines).toHaveLength(1);
    expect(res.body.lead.status).toBe('converted');

    const after = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.stockQuantity).toBe(stockBefore - 1);

    // A second conversion is refused rather than producing a duplicate order.
    expect((await as(admin).post(`/api/leads/${lead.body.id}/convert`)).status).toBe(400);
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

  it('PATCH /orders/:id is masked as 404 for a caller', async () => {
    const order = await prisma.order.findFirstOrThrow({ where: { deletedAt: null } });
    expect((await as(caller).patch(`/api/orders/${order.id}`, { stage: 'packed' })).status).toBe(404);
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
    const { body } = await as(admin).post(`/api/leads/${lead.body.id}/convert`);
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

  it('a lead with no medicines -> 400', async () => {
    const res = await as(admin).post('/api/leads', leadPayload({ medicines: [] }));
    expect(res.status).toBe(400);
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
