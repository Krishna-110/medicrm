import { api } from './client';
import type { Location } from '@/types';

export const locationsApi = {
  list: () => api.get<Location[]>('/locations'),
  create: (name: string) => api.post<Location>('/locations', { name }),
  rename: (id: string, name: string) => api.patch<Location>(`/locations/${id}`, { name }),
};
