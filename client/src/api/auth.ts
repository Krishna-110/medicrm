import type { LoginResponse, MeResponse } from '../../../server/src/lib/contract.js';
import { api } from './client';
import type { User } from '@/types';

export const authApi = {
  login: (email: string, password: string) =>
    api.post<LoginResponse>('/auth/login', { email, password }),
  logout: () => api.post<void>('/auth/logout'),
  me: () => api.get<MeResponse>('/auth/me'),
  changePassword: (currentPassword: string, newPassword: string) =>
    api.patch<void>('/auth/password', { currentPassword, newPassword }),
};
