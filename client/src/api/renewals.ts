import { api } from './client';
import type { Renewal, FollowUp } from '@/types';
import type { RenewResponse } from '../../../server/src/lib/contract.js';

type RenewPayload = {
  items: { name: string; quantity: number }[];
  paymentScreenshot: string;
  discountType: 'none' | 'flat' | 'percentage';
  discountValue: number;
};

export const renewalsApi = {
  list: () => api.get<Renewal[]>('/renewals'),
  renew: (id: string, payload: RenewPayload) => api.post<RenewResponse>(`/renewals/${id}/renew`, payload),
  // Omitting scheduledDate lets the server default it to the renewal date, which is when the
  // call is actually worth making.
  remind: (id: string, data?: { scheduledDate?: string; notes?: string }) =>
    api.post<FollowUp>(`/renewals/${id}/remind`, data),
  cancel: (id: string) => api.delete<void>(`/renewals/${id}`),
};
