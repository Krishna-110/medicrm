/**
 * The API's closed value sets, in one place.
 *
 * These lived only in the client, which meant the narrowing was a hope rather than a fact:
 * the client declared `role: 'admin' | 'caller'` while the server promised nothing better
 * than `string`. Nothing checked the two against each other, so a new lead status added
 * server-side would have reached a UI whose switch statements did not know it existed.
 *
 * Several of these are lookup tables rather than database enums, so the column really is a
 * string and the serializers assert the narrowing. That assertion is the point: it is one
 * reviewed line per field, in the one place values cross the wire, instead of an assumption
 * repeated silently across the client.
 */

export type UserRole = 'admin' | 'caller';
export type UserStatus = 'active' | 'inactive';

export type LeadStatus =
  | 'new'
  | 'contacted'
  | 'follow_up_pending'
  | 'interested'
  | 'call_back_later'
  | 'no_response'
  | 'not_interested'
  | 'converted';

export type LeadSource =
  | 'website'
  | 'referral'
  | 'walk_in'
  | 'phone'
  | 'social_media'
  | 'advertisement'
  | 'other';

export type LeadActivityType =
  | 'call'
  | 'comment'
  | 'status_change'
  | 'follow_up'
  | 'assignment'
  | 'created';

export type DosageForm = 'tablet' | 'capsule' | 'syrup' | 'injection' | 'other';

export type OrderStage =
  | 'lead'
  | 'confirmed'
  | 'medicine_prepared'
  | 'packed'
  | 'shipped'
  | 'delivered';

export type PaymentStatus = 'pending' | 'partial' | 'paid' | 'refunded';
/** How the money arrived. Only an online transfer leaves a screenshot to be required. */
export type PaymentMode = 'online' | 'offline';
export type DiscountType = 'none' | 'flat' | 'percentage';

export type RenewalStatus = 'upcoming' | 'due_today' | 'overdue' | 'renewed';

export type FollowUpType = 'call' | 'reminder' | 'callback';
export type FollowUpStatus = 'pending' | 'completed' | 'missed';

/**
 * The two-hour window a customer asked to be called in, across the 10–6 calling day.
 *
 * Buckets rather than a clock time: nobody agrees to be rung at 14:05, they agree to a
 * window. Named on the 24-hour clock so they sort in the order they happen — '9-11' would
 * fall after '16-18' as text, which a list of the day's calls would show as out of order.
 */
export const FOLLOW_UP_SLOTS = ['10-12', '12-14', '14-16', '16-18'] as const;
export type FollowUpSlot = (typeof FOLLOW_UP_SLOTS)[number];

/** The slot as sent by a client, or null. Anything unrecognised is refused rather than kept. */
export function parseFollowUpSlot(value: unknown): FollowUpSlot | null {
  if (value == null || value === '') return null;
  const slot = String(value);
  if ((FOLLOW_UP_SLOTS as readonly string[]).includes(slot)) return slot as FollowUpSlot;
  throw new Error(`slot must be one of ${FOLLOW_UP_SLOTS.join(', ')}`);
}

export type NotificationType = 'info' | 'warning' | 'success' | 'error';
