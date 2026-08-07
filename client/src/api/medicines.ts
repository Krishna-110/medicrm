import { api } from './client';
import type { Medicine } from '@/types';

// Create carries an opening stock and the location it lands at, neither of which is a Medicine field.
type MedicineCreate = Partial<Medicine> & { stockQuantity?: number; locationId?: string };

export const medicinesApi = {
  list: () => api.get<Medicine[]>('/medicines'),
  create: (data: MedicineCreate) => api.post<Medicine>('/medicines', data),
  update: (id: string, updates: Partial<Medicine>) => api.patch<Medicine>(`/medicines/${id}`, updates),
  remove: (id: string) => api.delete<void>(`/medicines/${id}`),
  // locationId targets which location the change lands at; omitted, the server uses Main Store.
  adjustStock: (id: string, mode: 'add' | 'set', quantity: number, locationId?: string) =>
    api.post<Medicine>(`/medicines/${id}/stock`, { mode, quantity, locationId }),
};
