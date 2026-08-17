import type {
  serializeFollowUp,
  serializeLead,
  serializeLeadActivity,
  serializeLeadMedicine,
  serializeOrder,
  serializeRenewal,
  serializeUser,
} from './serialize.js';

/**
 * Response shapes for the endpoints that return more than one thing.
 *
 * These exist because the same bug happened three times: a route returned a bare record while
 * the client destructured a wrapper, so `lead.id` read off undefined — after the write had
 * already committed. The row changed, the screen did not, and the caller saw an error for
 * something that had actually worked. The suite never noticed, because every test asserted a
 * status code and then re-fetched the record instead of reading the response.
 *
 * TypeScript cannot check this on its own: `api.patch<T>()` in the client is an unverified
 * claim about another process. Naming the shape once and having both sides import it is what
 * turns a drift into a compile error rather than a runtime surprise.
 *
 * Endpoints returning a single serialized record are not listed — there is nothing to compose
 * and nothing to get wrong. Add to this file only when a response wraps more than one value.
 */

type Serialized<F extends (...args: never[]) => unknown> = ReturnType<F>;

export type ApiUser = Serialized<typeof serializeUser>;
export type ApiLead = Serialized<typeof serializeLead>;
export type ApiOrder = Serialized<typeof serializeOrder>;
export type ApiRenewal = Serialized<typeof serializeRenewal>;
export type ApiFollowUp = Serialized<typeof serializeFollowUp>;
export type ApiLeadActivity = Serialized<typeof serializeLeadActivity>;
export type ApiLeadMedicine = Serialized<typeof serializeLeadMedicine>;

/** POST /api/auth/login */
export type LoginResponse = { token: string; user: ApiUser };

/** GET /api/auth/me */
export type MeResponse = { user: ApiUser };

/** PATCH /api/follow-ups/:id — the lead's last- and next-follow-up dates change with it. */
export type FollowUpUpdateResponse = { followUp: ApiFollowUp; lead: ApiLead | null };

/** POST /api/leads/:id/activities — the medicine is optional and only present when supplied. */
export type ActivityCreateResponse = { activity: ApiLeadActivity; medicine: ApiLeadMedicine | null };

/** POST /api/leads/:id/convert — `renewals` is the cycle opened for each medicine sold. */
export type ConvertResponse = { order: ApiOrder; lead: ApiLead | null; renewals: ApiRenewal[] };

/**
 * POST /api/renewals/:id/renew — renewing places a repeat order and opens the next cycle.
 * `renewal` is the cycle just closed, `nextRenewal` the one that succeeds it.
 */
export type RenewResponse = { renewal: ApiRenewal; order: ApiOrder; nextRenewal: ApiRenewal };
