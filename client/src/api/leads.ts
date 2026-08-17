import type { ActivityCreateResponse, ConvertResponse } from '../../../server/src/lib/contract.js';
import { api } from './client';
import type { Lead, LeadActivity, LeadMedicineItem, Order, FollowUp } from '@/types';

/**
 * What the dialog needs before the sale is composed: where the stock would leave from.
 *
 * That follows the lead's assigned caller rather than whoever is looking, so it cannot be
 * worked out client-side. Prices and per-location stock come from the catalogue already in
 * the store, and the server re-prices from its own copy when it bills.
 */
export type ConversionPreview = {
  /** The caller's location the sale draws from, or null when none is assigned. */
  locationName: string | null
}

export type ConvertPayload = {
  /** 'online' carries a screenshot as proof; 'offline' is cash in hand and has none. */
  paymentMode: 'online' | 'offline'
  paymentScreenshot: string
  /** The sale itself: medicine and tenure per line, chosen in the dialog. */
  items: { name: string; days: number }[]
  discountType: 'none' | 'flat' | 'percentage'
  discountValue: number
}

export const leadsApi = {
  list: () => api.get<Lead[]>('/leads'),
  create: (data: Partial<Lead>) => api.post<Lead>('/leads', data),
  update: (id: string, updates: Partial<Lead>) => api.patch<Lead>(`/leads/${id}`, updates),
  remove: (id: string) => api.delete<void>(`/leads/${id}`),
  addActivity: (id: string, description: string, medicine?: { name: string; days: number }) =>
    api.post<ActivityCreateResponse>(`/leads/${id}/activities`, {
      description,
      medicine,
    }),
  convertPreview: (id: string) => api.get<ConversionPreview>(`/leads/${id}/convert-preview`),
  convert: (id: string, payload: ConvertPayload) =>
    api.post<ConvertResponse>(`/leads/${id}/convert`, payload),
};
