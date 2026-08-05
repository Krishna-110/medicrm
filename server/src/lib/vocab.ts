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
  | 'converted'
  | 'sold';

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
export type DiscountType = 'none' | 'flat' | 'percentage';

export type RenewalStatus = 'upcoming' | 'due_today' | 'overdue' | 'renewed';

export type FollowUpType = 'call' | 'reminder' | 'callback';
export type FollowUpStatus = 'pending' | 'completed' | 'missed';

export type NotificationType = 'info' | 'warning' | 'success' | 'error';
