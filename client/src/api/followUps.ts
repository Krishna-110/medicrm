import type { FollowUpUpdateResponse } from '../../../server/src/lib/contract.js';
import { api } from './client';
import type { FollowUp, Lead } from '@/types';

export const followUpsApi = {
  list: () => api.get<FollowUp[]>('/follow-ups'),
  updateStatus: (id: string, status: FollowUp['status']) =>
    api.patch<FollowUpUpdateResponse>(`/follow-ups/${id}`, { status }),
};
