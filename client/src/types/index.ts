/**
 * Entity shapes for the UI. The closed value sets below are re-exported from the server,
 * which owns them — see server/src/lib/vocab.ts. They used to be declared here, so the
 * narrowing was a hope rather than a fact.
 */
export type {
  DiscountType, DosageForm, FollowUpStatus, FollowUpType, LeadActivityType, LeadSource,
  LeadStatus, NotificationType, OrderStage, PaymentStatus, RenewalStatus, UserRole, UserStatus,
} from '../../../server/src/lib/vocab.js';
import type {
  DiscountType, DosageForm, FollowUpStatus, FollowUpType, LeadActivityType, LeadSource,
  LeadStatus, NotificationType, OrderStage, PaymentStatus, RenewalStatus, UserRole,
} from '../../../server/src/lib/vocab.js';


export type Location = {
  id: string;
  name: string;
};

export type User = {
  id: string;
  name: string;
  employeeId: string;
  phone: string;
  email: string;
  role: UserRole;
  status: 'active' | 'inactive';
  assignedLeads: number;
  lastLogin: string;
  avatar?: string;
  password?: string;
  /** The location a caller sells from; unset for admins and unassigned callers. */
  locationId?: string;
  locationName?: string;
};



export type LeadActivity = {
  id: string;
  leadId: string;
  type: LeadActivityType;
  description: string;
  createdAt: string;
  // Nullable: seeded and system-generated activities have no author. This was declared as a
  // plain string, which the server never guaranteed — the contract is what surfaced it.
  createdBy: string | null;
};

export type LeadMedicineItem = {
  id: string;
  name: string;
  days: number;
};

export type Lead = {
  id: string;
  customerName: string;
  mobile: string;
  alternateNumber?: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
  medicines: LeadMedicineItem[];
  doctorName?: string;
  disease?: string;
  assignedCaller?: string;
  leadSource: LeadSource;
  status: LeadStatus;
  createdDate: string;
  lastFollowUp?: string;
  nextFollowUp?: string;
  notes?: string;
  paymentScreenshot?: string;
  activities: LeadActivity[];
};


export type MedicineLocationStock = {
  locationId: string;
  locationName: string;
  quantity: number;
};

export type Medicine = {
  id: string;
  name: string;
  genericName?: string;
  dosageForm?: DosageForm;
  unitPrice: number;
  /** Total across all locations. */
  stockQuantity: number;
  /** Per-location breakdown; present when the list is loaded, empty otherwise. */
  locations?: MedicineLocationStock[];
  isActive: boolean;
  createdDate: string;
};




export type Order = {
  id: string;
  orderNumber: string;
  leadId: string | null;
  customerName: string;
  address: string;
  medicines: { name: string; quantity: number; price: number }[];
  totalAmount: number;
  discountType: DiscountType;
  discountValue: number;
  payableAmount: number;
  paymentStatus: PaymentStatus;
  paymentScreenshot?: string;
  stage: OrderStage;
  createdDate: string;
  updatedDate: string;
};


export type Renewal = {
  id: string;
  customerId: string;
  customerName: string;
  medicineName: string;
  orderDate: string;
  renewalDate: string;
  expiryDate: string;
  daysRemaining: number;
  assignedCaller?: string;
  status: RenewalStatus;
  orderId?: string;
  previousRenewalId?: string;
};

export type FollowUp = {
  id: string;
  leadId?: string;
  customerName: string;
  scheduledDate: string;
  type: 'call' | 'reminder' | 'callback';
  status: 'pending' | 'completed' | 'missed';
  notes?: string;
};

export type Notification = {
  id: string;
  title: string;
  message: string;
  type: 'info' | 'warning' | 'success' | 'error';
  read: boolean;
  createdAt: string;
};

export type DashboardStats = {
  totalLeads: number;
  todaysCalls: number;
  pendingFollowUps: number;
  totalOrders: number;
  renewalsDue: number;
  leadStatusBreakdown: { status: LeadStatus; count: number }[];
  callerPerformance: {
    id: string;
    name: string;
    assignedCount: number;
    convertedCount: number;
    conversionRate: number;
  }[];
  leadsByPeriod: { today: number; thisWeek: number; thisMonth: number };
  salesByPeriod: { today: number; thisWeek: number; thisMonth: number };
  salesByCaller: { callerId: string; callerName: string; totalSales: number }[];
};

export type AppState = {
  currentUser: User | null;
  users: User[];
  leads: Lead[];
  orders: Order[];
  renewals: Renewal[];
  followUps: FollowUp[];
  notifications: Notification[];
  medicines: Medicine[];
  dashboard: DashboardStats | null;
  locations: Location[];
  searchQuery: string;
  booting: boolean;
};

export type HydratePayload = {
  users: User[];
  leads: Lead[];
  orders: Order[];
  renewals: Renewal[];
  followUps: FollowUp[];
  notifications: Notification[];
  medicines: Medicine[];
  locations: Location[];
  dashboard: DashboardStats;
};

export type AppAction =
  | { type: 'LOGIN'; payload: { user: User } }
  | { type: 'LOGOUT' }
  | { type: 'HYDRATE'; payload: HydratePayload }
  | { type: 'SET_BOOTING'; payload: { booting: boolean } }
  | { type: 'ADD_LEAD'; payload: { lead: Lead } }
  | { type: 'UPDATE_LEAD'; payload: { id: string; updates: Partial<Lead> } }
  | { type: 'DELETE_LEAD'; payload: { id: string } }
  | { type: 'ASSIGN_LEAD'; payload: { leadId: string; callerId: string } }
  | { type: 'ADD_USER'; payload: { user: User } }
  | { type: 'UPDATE_USER'; payload: { id: string; updates: Partial<User> } }
  | { type: 'DELETE_USER'; payload: { id: string } }
  | { type: 'ADD_ORDER'; payload: { order: Order } }
  | { type: 'UPDATE_ORDER'; payload: { id: string; updates: Partial<Order> } }
  | { type: 'ADD_RENEWAL'; payload: { renewal: Renewal } }
  | { type: 'UPDATE_RENEWAL'; payload: { id: string; updates: Partial<Renewal> } }
  | { type: 'DELETE_RENEWAL'; payload: { id: string } }
  | { type: 'ADD_FOLLOW_UP'; payload: { followUp: FollowUp } }
  | { type: 'UPDATE_FOLLOW_UP'; payload: { id: string; updates: Partial<FollowUp> } }
  | { type: 'ADD_NOTIFICATION'; payload: { notification: Notification } }
  | { type: 'MARK_NOTIFICATION_READ'; payload: { id: string } }
  | { type: 'SET_SEARCH_QUERY'; payload: { query: string } }
  | { type: 'ADD_LEAD_ACTIVITY'; payload: { leadId: string; activity: LeadActivity } }
  | { type: 'ADD_LEAD_MEDICINE'; payload: { leadId: string; medicine: LeadMedicineItem } }
  | { type: 'ADD_LOCATION'; payload: { location: Location } }
  | { type: 'UPDATE_LOCATION'; payload: { id: string; updates: Partial<Location> } }
  | { type: 'DELETE_LOCATION'; payload: { id: string } }
  | { type: 'ADD_MEDICINE'; payload: { medicine: Medicine } }
  | { type: 'UPDATE_MEDICINE'; payload: { id: string; updates: Partial<Medicine> } }
  | { type: 'DELETE_MEDICINE'; payload: { id: string } };
