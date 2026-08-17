import { Routes, Route, Navigate } from 'react-router-dom'
import { useApp } from '@/context/AppContext'
import { Layout } from '@/components/layout/Layout'
import { Login } from '@/pages/Login'
import { Dashboard } from '@/pages/Dashboard'
import { Leads } from '@/pages/Leads'
import { LeadDetailPage } from '@/pages/LeadDetailPage'
import { Users } from '@/pages/Users'
import { Calendar } from '@/pages/Calendar'
import { Orders } from '@/pages/Orders'
import { Renewals } from '@/pages/Renewals'
import { Stock } from '@/pages/Stock'
import { LoadingState } from '@/components/ui/LoadingState'
import { ToastContainer } from '@/components/ui/Toast'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { state } = useApp()
  if (state.booting) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f5f7fb] px-6">
        <div className="w-full max-w-sm">
          <LoadingState rows={4} />
        </div>
      </div>
    )
  }
  if (!state.currentUser) return <Navigate to="/login" replace />
  return <>{children}</>
}

/**
 * An admin-only page.
 *
 * Hiding the link in the sidebar was never enough on its own — the route stayed reachable by
 * typing the address, which showed a caller a page of controls that answer 403. Sent to the
 * dashboard rather than shown a refusal: nothing here is theirs to act on, so there is
 * nothing to explain.
 */
function AdminRoute({ children }: { children: React.ReactNode }) {
  const { state } = useApp()
  if (state.booting) return null
  return state.currentUser?.role === 'admin' ? <>{children}</> : <Navigate to="/" replace />
}

export function App() {
  return (
    <>
      <ToastContainer />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route path="/" element={<Dashboard />} />
          <Route path="/leads" element={<Leads />} />
          <Route path="/leads/:id" element={<LeadDetailPage />} />
          <Route path="/users" element={<AdminRoute><Users /></AdminRoute>} />
          <Route path="/calendar" element={<Calendar />} />
          <Route path="/orders" element={<Orders />} />
          <Route path="/renewals" element={<Renewals />} />
          {/* The catalogue is an admin's to keep; a caller only ever reads prices and stock
              through the conversion dialog, which needs no page of its own. */}
          <Route path="/stock" element={<AdminRoute><Stock /></AdminRoute>} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  )
}
