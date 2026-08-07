import { api } from './client';
import type { User } from '@/types';

// locationId accepts null to clear a caller's location, which Partial<User> alone cannot
// express — the field is omitted and re-added so the null widens rather than intersects away.
type UserWrite = Omit<Partial<User>, 'locationId'> & { locationId?: string | null };

export const usersApi = {
  list: () => api.get<User[]>('/users'),
  create: (data: UserWrite) => api.post<User>('/users', data),
  update: (id: string, updates: UserWrite) => api.patch<User>(`/users/${id}`, updates),
  remove: (id: string) => api.delete<void>(`/users/${id}`),
};
