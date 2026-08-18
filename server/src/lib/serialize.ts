import type {
  DiscountType, DosageForm, FollowUpStatus, FollowUpType, LeadActivityType, LeadSource,
  FollowUpSlot, LeadStatus, NotificationType, OrderStage, PaymentMode, PaymentStatus, UserRole, UserStatus,
} from './vocab.js';
import { Prisma } from '@prisma/client';
import { APP_TIMEZONE, daysRemaining, renewalStatus } from './dates.js';

/**
 * Database rows to API responses.
 *
 * The API shape is fixed by the existing frontend and must not drift — these functions are
 * the contract. They are thinner than their predecessors because the models are already
 * camelCase, so most fields pass straight through; what remains is genuine translation:
 * dates to display strings, Decimals to numbers, and the few names where the API word
 * differs from the column (`assignedCaller`, `name` for a product's brand).
 */

const dateOnly = new Intl.DateTimeFormat('en-CA', {
  timeZone: APP_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** YYYY-MM-DD in IST, or '' — the frontend renders empty for a missing date. */
const d10 = (d: Date | null | undefined): string => (d ? dateOnly.format(d) : '');

/** Decimal columns arrive as Prisma.Decimal; the API sends plain numbers. */
const num = (v: Prisma.Decimal | number | null | undefined): number => (v == null ? 0 : Number(v));

type LocationRow = { id: string; name: string };
export const serializeLocation = (l: LocationRow) => ({ id: l.id, name: l.name });

type User = {
  id: string; name: string; employeeId: string; phone: string; email: string;
  role: string; status: string; assignedLeadsCount: number;
  lastLoginAt: Date | null; avatarUrl: string | null;
  locationId: string | null; location?: LocationRow | null;
};

export const serializeUser = (u: User) => ({
  id: u.id,
  name: u.name,
  employeeId: u.employeeId,
  phone: u.phone,
  email: u.email,
  role: u.role as UserRole,
  status: u.status as UserStatus,
  assignedLeads: u.assignedLeadsCount,
  lastLogin: d10(u.lastLoginAt),
  avatar: u.avatarUrl ?? undefined,
  locationId: u.locationId ?? undefined,
  // Present only when the caller included the relation; the name saves the client a lookup.
  locationName: u.location?.name ?? undefined,
});

type LeadMedicine = { id: string; medicineName: string; days: number };
export const serializeLeadMedicine = (m: LeadMedicine) => ({
  id: m.id,
  name: m.medicineName,
  days: m.days,
});

type LeadActivity = {
  id: string; leadId: string; activityType: string; description: string;
  createdAt: Date; createdBy: string | null;
};
export const serializeLeadActivity = (a: LeadActivity) => ({
  id: a.id,
  leadId: a.leadId,
  type: a.activityType as LeadActivityType,
  description: a.description,
  createdAt: a.createdAt.toISOString(),
  createdBy: a.createdBy,
});

type Lead = {
  id: string; customerName: string; mobile: string; alternateNumber: string | null;
  address: string; city: string; state: string; pincode: string;
  doctorName: string | null; disease: string; assignedCallerId: string | null;
  leadSource: string; status: string; createdAt: Date;
  lastFollowUpAt: Date | null; nextFollowUpAt: Date | null;
  convertedAt: Date | null;
  notes: string | null; paymentScreenshot: string | null;
  medicines?: LeadMedicine[]; activities?: LeadActivity[];
};

export const serializeLead = (l: Lead) => ({
  id: l.id,
  customerName: l.customerName,
  mobile: l.mobile,
  alternateNumber: l.alternateNumber ?? undefined,
  address: l.address,
  city: l.city,
  state: l.state,
  pincode: l.pincode,
  medicines: (l.medicines ?? []).map(serializeLeadMedicine),
  doctorName: l.doctorName ?? undefined,
  disease: l.disease ?? undefined,
  assignedCaller: l.assignedCallerId ?? undefined,
  leadSource: l.leadSource as LeadSource,
  status: l.status as LeadStatus,
  createdDate: d10(l.createdAt),
  lastFollowUp: d10(l.lastFollowUpAt),
  nextFollowUp: d10(l.nextFollowUpAt),
  // '' until the lead sells, matching how every other optional date here renders.
  convertedDate: d10(l.convertedAt),
  notes: l.notes ?? undefined,
  paymentScreenshot: l.paymentScreenshot ?? undefined,
  activities: (l.activities ?? []).map(serializeLeadActivity),
});

type ProductLocationStock = {
  locationId: string; quantity: number; location?: LocationRow;
};
type Product = {
  id: string; brandName: string | null; genericName: string; dosageForm: string | null;
  unitPrice: Prisma.Decimal; stockQuantity: number; isActive: boolean; createdAt: Date;
  locationStocks?: ProductLocationStock[];
};
/** The API calls a product a "medicine", and its brand name is the display name. */
export const serializeMedicine = (p: Product) => {
  const breakdown = p.locationStocks ?? [];
  return {
    id: p.id,
    name: p.brandName ?? p.genericName,
    genericName: p.genericName ?? undefined,
    dosageForm: (p.dosageForm ?? undefined) as DosageForm | undefined,
    unitPrice: num(p.unitPrice),
    // The column is still the total the app reads for pricing and coverage; the per-location
    // rows are exposed alongside it and become the source of truth in the next phase, when the
    // write path and deduction move to them together.
    stockQuantity: p.stockQuantity,
    // Per-location detail for the Stock page's expandable view; empty when not requested.
    locations: breakdown.map((s) => ({
      locationId: s.locationId,
      locationName: s.location?.name ?? '',
      quantity: s.quantity,
    })),
    isActive: p.isActive,
    createdDate: d10(p.createdAt),
  };
};

type OrderItem = { medicineNameSnapshot: string; quantity: number; unitPriceSnapshot: Prisma.Decimal };
export const serializeOrderItem = (i: OrderItem) => ({
  name: i.medicineNameSnapshot,
  quantity: i.quantity,
  price: num(i.unitPriceSnapshot),
});

type Order = {
  id: string; orderNumber: string; leadId: string | null; customerName: string;
  shippingAddress: string; totalAmount: Prisma.Decimal; discountType: string;
  discountValue: Prisma.Decimal; payableAmount: Prisma.Decimal; paymentStatus: string;
  paymentMode: string; stage: string; paymentScreenshot: string | null;
  createdAt: Date; updatedAt: Date; items?: OrderItem[];
};
export const serializeOrder = (o: Order) => ({
  id: o.id,
  orderNumber: o.orderNumber,
  leadId: o.leadId,
  customerName: o.customerName,
  address: o.shippingAddress,
  medicines: (o.items ?? []).map(serializeOrderItem),
  totalAmount: num(o.totalAmount),
  discountType: o.discountType as DiscountType,
  discountValue: num(o.discountValue),
  payableAmount: num(o.payableAmount),
  paymentStatus: o.paymentStatus as PaymentStatus,
  // How it was paid; an offline sale carries no screenshot, which is not an omission.
  paymentMode: o.paymentMode as PaymentMode,
  // Proof of payment for this order. It was stored and never exposed, so every renewal
  // demanded a screenshot that nobody could then look at.
  paymentScreenshot: o.paymentScreenshot ?? undefined,
  stage: o.stage as OrderStage,
  createdDate: d10(o.createdAt),
  updatedDate: d10(o.updatedAt),
});

type Renewal = {
  id: string; customerId: string; customerName: string; medicineName: string;
  orderDate: Date; renewalDate: Date; expiryDate: Date;
  assignedCallerId: string | null; renewedAt: Date | null;
  orderId: string | null; previousRenewalId: string | null;
};
/**
 * `daysRemaining` and `status` are derived, not stored — see lib/dates.ts. Storing them
 * would need a nightly job and would be wrong for a day whenever that job failed.
 */
export const serializeRenewal = (r: Renewal) => ({
  id: r.id,
  customerId: r.customerId,
  customerName: r.customerName,
  medicineName: r.medicineName,
  orderDate: d10(r.orderDate),
  renewalDate: d10(r.renewalDate),
  expiryDate: d10(r.expiryDate),
  daysRemaining: daysRemaining(r.expiryDate),
  assignedCaller: r.assignedCallerId ?? undefined,
  // The order this cycle belongs to, and whether it descends from an earlier one. Together
  // they are what lets a payment be traced back to the renewal that produced it: an order
  // whose renewal has a predecessor was a reorder, not a first sale.
  orderId: r.orderId ?? undefined,
  previousRenewalId: r.previousRenewalId ?? undefined,
  status: renewalStatus(r.renewalDate, r.expiryDate, r.renewedAt),
});

/**
 * The relations serializeFollowUp reads a phone number from.
 *
 * Kept beside the serializer rather than written out at each of the four places follow-ups
 * are returned: a site that forgot one would silently hand back a task with no number to
 * ring, which looks like data missing rather than a query missing.
 */
export const FOLLOW_UP_CONTACT = {
  lead: { select: { mobile: true } },
  customer: { select: { primaryMobile: true } },
} as const;

type FollowUp = {
  id: string; leadId: string | null; renewalId: string | null; customerName: string;
  scheduledAt: Date; type: string; status: string; notes: string | null; slot: string | null;
  lead?: { mobile: string } | null;
  customer?: { primaryMobile: string } | null;
};
export const serializeFollowUp = (f: FollowUp) => ({
  id: f.id,
  leadId: f.leadId ?? undefined,
  // Which renewal this reminder belongs to. Without it the client cannot tell that a renewal
  // already has a reminder, so the dialog could only ever offer the renewal date back.
  renewalId: f.renewalId ?? undefined,
  // The number to ring. The lead's is preferred — that is the copy a caller has been editing
  // — with the customer record standing in for a renewal reminder, which has no lead.
  mobile: f.lead?.mobile ?? f.customer?.primaryMobile ?? undefined,
  customerName: f.customerName,
  scheduledDate: d10(f.scheduledAt),
  // The part of the day agreed with the customer; absent on anything scheduled before slots
  // existed, and on a call nobody pinned to one.
  slot: (f.slot ?? undefined) as FollowUpSlot | undefined,
  type: f.type as FollowUpType,
  status: f.status as FollowUpStatus,
  notes: f.notes ?? undefined,
});

type Notification = {
  id: string; title: string; message: string; type: string; isRead: boolean; createdAt: Date;
};
export const serializeNotification = (n: Notification) => ({
  id: n.id,
  title: n.title,
  message: n.message,
  type: n.type as NotificationType,
  read: n.isRead,
  createdAt: n.createdAt.toISOString(),
});
