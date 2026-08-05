import type { ActivityCreateResponse, ConvertResponse } from '../../../server/src/lib/contract.js';
import { api } from './client';
import type { Lead, LeadActivity, LeadMedicineItem, Order, FollowUp } from '@/types';

export type ConversionPreviewItem = {
  name: string
  quantity: number
  unitPrice: number
  lineTotal: number
  /** False when no catalogue product matched the name, which is why the line is priced at 0. */
  inCatalogue: boolean
}

export type ConversionPreview = {
  items: ConversionPreviewItem[]
  totalAmount: number
}

export type ConvertPayload = {
  paymentScreenshot: string
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
