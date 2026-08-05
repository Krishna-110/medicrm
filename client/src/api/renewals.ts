import type { RenewResponse } from '../../../server/src/lib/contract.js';

type RenewPayload = {
  quantity: number;
  paymentScreenshot: string;
  discountType: 'none' | 'flat' | 'percentage';
  discountValue: number;
};

import { api } from './client';
import type { Renewal, FollowUp } from '@/types';

export const renewalsApi = {
  list: () => api.get<Renewal[]>('/renewals'),
  renew: (id: string, payload: RenewPayload) => api.post<RenewResponse>(`/renewals/${id}/renew`, payload),
  remind: (id: string, data?: { notes?: string }) => api.post<FollowUp>(`/renewals/${id}/remind`, data),
  cancel: (id: string) => api.delete<void>(`/renewals/${id}`),
};
