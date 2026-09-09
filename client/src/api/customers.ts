import { api } from './client'
import type { Customer } from '@/types'

export const customersApi = {
  list: () => api.get<Customer[]>('/customers'),
}
