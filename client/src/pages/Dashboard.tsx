import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Users,
  UserCheck,
  Phone,
  Clock,
  CalendarClock,
  ShoppingCart,
  RefreshCw,
  ArrowUpRight,
  CalendarRange,
  IndianRupee,
  BarChart3,
  CheckCircle2,
} from 'lucide-react'
import { useApp } from '@/context/AppContext'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { LeadStatusBadge } from '@/components/ui/StatusBadge'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { followUpsApi } from '@/api/followUps'
import { renewalsApi } from '@/api/renewals'
import { miscApi } from '@/api/misc'
import { emitToast } from '@/lib/toast'
import { formatIndianDate, formatIndianDateTime, formatIndianTime, istToday, istWeekStart } from '@/lib/dateUtils'
import type { Lead, LeadStatus } from '@/types'

function formatRupees(amount: number) {
  return `₹${amount.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

// Reused for both the Leads and Sales period breakdown cards below — same shape (Today /
// This Week / This Month), differing only in icon/tint/value-formatting.
function PeriodBreakdown({
  icon: Icon,
  tint,
  title,
  today,
  thisWeek,
  thisMonth,
  format = String,
}: {
  icon: typeof Users
  tint: string
  title: string
  today: number
  thisWeek: number
  thisMonth: number
  format?: (n: number) => string
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2.5 px-5 pt-4">
        <div className={`flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br ${tint}`}>
          <Icon className="h-4 w-4 text-white" />
        </div>
        <h2 className="text-[15px] font-semibold text-ink-900">{title}</h2>
      </div>
      <div className="grid grid-cols-3 divide-x divide-ink-100 px-5 py-4">
        {[
          { label: 'Today', value: today },
          { label: 'This Week', value: thisWeek },
          { label: 'This Month', value: thisMonth },
        ].map((row) => (
          <div key={row.label} className="px-2 text-center first:pl-0 last:pr-0">
            <p className="truncate text-xl font-bold tracking-tight text-ink-900">{format(row.value)}</p>
            <p className="mt-0.5 text-[11px] text-ink-500">{row.label}</p>
          </div>
        ))}
      </div>
    </Card>
  )
}

const STATUS_BAR: Record<LeadStatus, string> = {
  new: 'bg-sky-500',
  contacted: 'bg-primary-500',
  follow_up_pending: 'bg-warning-500',
  interested: 'bg-teal-500',
  call_back_later: 'bg-amber-400',
  no_response: 'bg-ink-400',
  not_interested: 'bg-danger-500',
  converted: 'bg-success-500',
}

const STATUS_LABELS: Record<LeadStatus, string> = {
  new: 'New',
  contacted: 'Contacted',
  follow_up_pending: 'Follow-up Pending',
  interested: 'Interested',
  call_back_later: 'Call Back Later',
  no_response: 'No Response',
  not_interested: 'Not Interested',
  converted: 'Converted',
}

export function Dashboard() {
  const { state, dispatch } = useApp()
  const navigate = useNavigate()
  const [showCustomers, setShowCustomers] = useState(false)
  const [showRenewalReminders, setShowRenewalReminders] = useState(false)
  const [showCallsDoneToday, setShowCallsDoneToday] = useState(false)

  const dashboard = state.dashboard

  /*
   * Keep the server-computed figures current.
   *
   * They are fetched once at sign-in, so every one of them went stale the moment anything
   * changed: converting a lead left "Converted Orders" on its old value, and completing a
   * follow-up left "Pending Follow-ups" untouched, until a full page reload. Refetching when
   * the underlying collections change costs one request per action and makes every card on
   * this page agree with the rest of the app — including on arriving here from another page.
   */
  useEffect(() => {
    if (state.booting) return
    let cancelled = false
    miscApi
      .dashboard()
      .then((fresh) => {
        if (!cancelled) dispatch({ type: 'SET_DASHBOARD', payload: { dashboard: fresh } })
      })
      // Silent: the figures on screen are merely stale, which is not worth a toast on every
      // dropped request — the next change refetches anyway.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [state.booting, state.leads, state.orders, state.followUps, state.renewals, dispatch])

  /*
   * A customer is a lead that actually bought — which means 'converted', and only that.
   *
   * 'converted' is written in one place only: the conversion transaction that also writes the
   * order, moves the stock and opens the renewal. So it cannot be set without a sale behind
   * it, and Total Customers can always be reconciled against Total Orders. A hand-picked
   * status never counts here — there would be nothing to say money ever changed hands.
   *
   * One person, one row: a repeat buyer has a converted lead per purchase, so the rows are
   * deduplicated by mobile — normalised on write, which is what makes it usable as an
   * identity. Leads arrive newest-first, so the first match kept is that person's most
   * recent record, and their address and alternate number are the current ones.
   *
   * Derived from the leads already in the store rather than a new endpoint — they arrive
   * with the app and are already scoped, so a caller counts their own customers and an admin
   * counts everyone's, with no extra request.
   */
  /*
   * The customer records themselves, written by the conversion that took the money.
   *
   * This was derived from leads with status 'converted' and deduped by mobile, which tied a
   * customer's existence to their lead still being around. Remove the lead and the customer
   * vanished while the order and the revenue stayed — three paid orders and nought customers
   * on the same screen, which is exactly as broken as it reads. The rows outlive the lead, so
   * no dedupe is needed either: the conversion already reuses an existing customer when the
   * mobile matches.
   */
  const customers = state.customers

  /*
   * How many customers converted today / this week / this month.
   *
   * convertedDate is stamped by the server the moment a lead becomes a customer, so this
   * reads the fact rather than inferring it. createdDate is only a fallback for a row that
   * predates the column and somehow escaped the backfill; it is the wrong date to count on
   * — capture can precede the sale by months — which is exactly why the column exists.
   *
   * Counted per person, not per purchase — someone who bought twice this week is one
   * customer — and the boundaries mirror the server's periodBoundaries(): IST, week from
   * Monday, month from the 1st. Dates are IST YYYY-MM-DD on both sides, so they compare
   * directly as strings.
   */
  // New customers won in each period, by the day the customer record was created. Counted off
  // the same rows as the card above, so the two can never disagree.
  const convertedByPeriod = useMemo(() => {
    const today = istToday()
    const weekStart = istWeekStart()
    const thisMonth = today.slice(0, 7)
    let inToday = 0
    let inWeek = 0
    let inMonth = 0
    for (const c of state.customers) {
      const on = c.createdDate
      if (!on) continue
      if (on === today) inToday += 1
      if (on >= weekStart) inWeek += 1
      if (on.slice(0, 7) === thisMonth) inMonth += 1
    }
    return { today: inToday, thisWeek: inWeek, thisMonth: inMonth }
  }, [state.customers])

  // Pending lead follow-ups only (renewal reminders separated to avoid confusion)
  const leadFollowUps = useMemo(() => {
    return state.followUps.filter((f) => !f.renewalId && f.status === 'pending')
  }, [state.followUps])

  // Active renewal reminders:
  // Combines active renewals (which have renewalDate) with any custom scheduled reminder followUps
  const renewalRemindersList = useMemo(() => {
    const activeRenewals = state.renewals.filter((r) => r.status !== 'renewed')
    return activeRenewals.map((r) => {
      const customFollowUp = state.followUps.find(
        (f) => f.renewalId === r.id && f.status === 'pending',
      )
      return {
        id: customFollowUp?.id || `ren-${r.id}`,
        renewalId: r.id,
        customerName: r.customerName,
        medicineName: r.medicineName,
        scheduledDate: customFollowUp?.scheduledDate || r.renewalDate,
        slot: customFollowUp?.slot,
        mobile: r.mobile,
        status: (customFollowUp?.status || 'pending') as 'pending' | 'completed' | 'missed',
        isCustom: !!customFollowUp,
        daysRemaining: r.daysRemaining,
        renewalStatus: r.status,
      }
    })
  }, [state.renewals, state.followUps])

  // Lead follow-up tasks due today or overdue
  const myLeadTasks = useMemo(() => {
    const today = istToday()
    return leadFollowUps
      .filter((f) => f.scheduledDate <= today)
      .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate))
  }, [leadFollowUps])

  // Renewal reminder tasks due today or overdue
  const myRenewalTasks = useMemo(() => {
    const today = istToday()
    return renewalRemindersList
      .filter((f) => f.scheduledDate <= today)
      .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate))
  }, [renewalRemindersList])

  // Calls completed today (based on completedDate or completedAt in IST)
  const completedCallsToday = useMemo(() => {
    const today = istToday()
    return state.followUps
      .filter(
        (f) =>
          f.status === 'completed' &&
          (f.completedDate === today || (!f.completedDate && f.scheduledDate === today)),
      )
      .sort((a, b) => {
        const timeA = a.completedAt || a.completedDate || a.scheduledDate
        const timeB = b.completedAt || b.completedDate || b.scheduledDate
        return timeB.localeCompare(timeA)
      })
  }, [state.followUps])

  async function completeTask(id: string) {
    try {
      if (id.startsWith('ren-')) {
        const renewalId = id.replace('ren-', '')
        const renewal = state.renewals.find((r) => r.id === renewalId)
        if (renewal) {
          const followUp = await renewalsApi.remind(renewal.id, {
            scheduledDate: istToday(),
            notes: `Reminder call for ${renewal.medicineName}`,
          })
          const { followUp: completed } = await followUpsApi.updateStatus(followUp.id, 'completed')
          dispatch({ type: 'UPDATE_FOLLOW_UP', payload: { id: completed.id, updates: completed } })
        }
      } else {
        const { followUp, lead } = await followUpsApi.updateStatus(id, 'completed')
        dispatch({ type: 'UPDATE_FOLLOW_UP', payload: { id: followUp.id, updates: followUp } })
        if (lead) dispatch({ type: 'UPDATE_LEAD', payload: { id: lead.id, updates: lead } })
      }
      emitToast('Task marked as completed', 'success')
    } catch (err) {
      emitToast(err instanceof Error ? err.message : 'Failed to mark task complete')
    }
  }

  const leadStatusCounts = useMemo(() => {
    const counts: Partial<Record<LeadStatus, number>> = {}
    for (const row of dashboard?.leadStatusBreakdown ?? []) counts[row.status] = row.count
    return counts
  }, [dashboard])

  const recentLeads = useMemo(() => state.leads.slice(0, 6), [state.leads])

  const callerPerformance = useMemo(
    () => [...(dashboard?.callerPerformance ?? [])].sort((a, b) => b.assignedCount - a.assignedCount),
    [dashboard],
  )

  const statusCountValues = Object.values(leadStatusCounts)
  const maxStatusCount = statusCountValues.length ? Math.max(...statusCountValues) : 1

  const salesByCaller = dashboard?.salesByCaller ?? []
  const maxCallerSales = Math.max(...salesByCaller.map((c) => c.totalSales), 1)

  type StatCard = {
    label: string
    value: number
    icon: typeof Users
    tint: string
    /** Present on cards that open a detail view; those render as a button. */
    onClick?: () => void
  }

  /*
   * No trend badges. They were hardcoded strings — every card claimed a fixed "+12%" or
   * "-5%" that never moved whatever the data did. A number nobody computed is worse than
   * no number, so they are gone rather than faked; a real one needs the previous period
   * stored to compare against.
   */
  const statCards: StatCard[] = [
    { label: 'Total Leads', value: dashboard?.totalLeads ?? 0, icon: Users, tint: 'from-primary-500 to-primary-600', onClick: () => navigate('/leads') },
    { label: 'Total Customers', value: customers.length, icon: UserCheck, tint: 'from-emerald-500 to-emerald-600', onClick: () => setShowCustomers(true) },
    {
      label: 'Calls Done Today',
      value: dashboard?.callsDoneToday ?? completedCallsToday.length,
      icon: Phone,
      tint: 'from-teal-500 to-teal-600',
      onClick: () => setShowCallsDoneToday(true),
    },
    { label: 'Pending Follow-ups', value: dashboard?.pendingFollowUps ?? leadFollowUps.length, icon: Clock, tint: 'from-warning-500 to-warning-600' },
    { label: 'Renewal Reminders', value: dashboard?.renewalReminders ?? renewalRemindersList.length, icon: CalendarClock, tint: 'from-amber-500 to-amber-600', onClick: () => setShowRenewalReminders(true) },
    { label: 'Total Orders', value: dashboard?.totalOrders ?? 0, icon: ShoppingCart, tint: 'from-success-500 to-success-600', onClick: () => navigate('/orders') },
    { label: 'Renewals Due', value: dashboard?.renewalsDue ?? 0, icon: RefreshCw, tint: 'from-danger-500 to-danger-600', onClick: () => navigate('/renewals') },
  ]

  const getUserName = (userId?: string) => {
    if (!userId) return '—'
    return state.users.find((u) => u.id === userId)?.name ?? '—'
  }

  // Bar chart geometry — Sales by Caller
  const barChartW = 480
  const barChartH = 170
  const barGap = 12
  const barCount = Math.max(salesByCaller.length, 1)
  const barSlot = (barChartW - barGap * (barCount - 1)) / barCount
  const barWidth = Math.min(barSlot, 56)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="Welcome back — here's what's happening across your pipeline today."
      />

      {/*
       * Follow-up and renewal reminder tasks for today.
       * Separated into distinct cards so callers never mix prospective lead calls
       * with existing customer medicine refills.
       */}
      {(state.currentUser?.role === 'caller' || myLeadTasks.length > 0 || myRenewalTasks.length > 0) && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {/* Card 1: Lead Follow-ups */}
          <Card>
            <div className="p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-warning-100 text-warning-700">
                    <Clock className="h-4 w-4" />
                  </div>
                  <h2 className="text-base font-semibold text-ink-900">Lead Follow-ups Today</h2>
                </div>
                <Badge variant={myLeadTasks.length ? 'warning' : 'success'}>
                  {myLeadTasks.length ? `${myLeadTasks.length} to do` : 'All clear'}
                </Badge>
              </div>

              {myLeadTasks.length === 0 ? (
                <p className="mt-3 text-sm text-ink-500">No lead follow-ups due today. Overdue calls will appear here too.</p>
              ) : (
                <ul className="mt-3 max-h-64 divide-y divide-ink-100 overflow-y-auto pr-1">
                  {myLeadTasks.map((task) => {
                    const overdue = task.scheduledDate < istToday()
                    return (
                      <li key={task.id} className="flex flex-wrap items-center gap-2 py-2.5">
                        <button
                          type="button"
                          onClick={() => task.leadId && navigate(`/leads/${task.leadId}`)}
                          disabled={!task.leadId}
                          className="min-w-0 flex-1 text-left text-sm font-medium text-ink-900 hover:text-primary-700 disabled:hover:text-ink-900"
                        >
                          <span className="block truncate">{task.customerName}</span>
                          <span className="text-xs font-normal text-ink-500">
                            {task.type}
                            {task.slot && ` · ${task.slot}`}
                            {overdue ? ` · overdue since ${task.scheduledDate}` : ` · due ${task.scheduledDate}`}
                          </span>
                        </button>
                        {overdue && <Badge variant="danger">Overdue</Badge>}
                        <Button size="sm" variant="secondary" onClick={() => completeTask(task.id)}>
                          Done
                        </Button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </Card>

          {/* Card 2: Renewal Reminders */}
          <Card>
            <div className="p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-100 text-amber-700">
                    <CalendarClock className="h-4 w-4" />
                  </div>
                  <h2 className="text-base font-semibold text-ink-900">Renewal Reminders</h2>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={myRenewalTasks.length ? 'warning' : 'success'}>
                    {myRenewalTasks.length ? `${myRenewalTasks.length} to do` : 'All clear'}
                  </Badge>
                  {renewalRemindersList.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowRenewalReminders(true)}
                      className="text-xs font-medium text-amber-600 hover:text-amber-700"
                    >
                      View all ({renewalRemindersList.length}) →
                    </button>
                  )}
                </div>
              </div>

              {myRenewalTasks.length === 0 ? (
                <div className="mt-3">
                  <p className="text-sm text-ink-500">
                    {renewalRemindersList.length > 0
                      ? `No reminders due today. You have ${renewalRemindersList.length} upcoming renewal reminder${renewalRemindersList.length === 1 ? '' : 's'} scheduled.`
                      : 'No renewal reminders scheduled. Reminders can be set directly from the Renewals page.'}
                  </p>
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => navigate('/renewals')}>
                      Go to Renewals
                    </Button>
                    {renewalRemindersList.length > 0 && (
                      <Button size="sm" variant="secondary" onClick={() => setShowRenewalReminders(true)}>
                        View upcoming reminders
                      </Button>
                    )}
                  </div>
                </div>
              ) : (
                <ul className="mt-3 max-h-64 divide-y divide-ink-100 overflow-y-auto pr-1">
                  {myRenewalTasks.map((task) => {
                    const overdue = task.scheduledDate < istToday()
                    const medicine =
                      task.medicineName || state.renewals.find((r) => r.id === task.renewalId)?.medicineName
                    return (
                      <li key={task.id} className="flex flex-wrap items-center gap-2 py-2.5">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium text-ink-900">{task.customerName}</span>
                            {medicine && (
                              <span className="inline-flex items-center rounded-md bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-700">
                                {medicine}
                              </span>
                            )}
                          </div>
                          <span className="text-xs font-normal text-ink-500">
                            {task.slot ? `Slot: ${task.slot}` : 'Reminder'}
                            {overdue ? ` · overdue since ${formatIndianDate(task.scheduledDate)}` : ` · due ${formatIndianDate(task.scheduledDate)}`}
                            {task.mobile && (
                              <a href={`tel:${task.mobile}`} className="ml-1 text-primary-600 hover:underline">
                                · {task.mobile}
                              </a>
                            )}
                          </span>
                        </div>
                        {overdue && <Badge variant="danger">Overdue</Badge>}
                        <Button size="sm" variant="secondary" onClick={() => navigate('/renewals')}>
                          Renew →
                        </Button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </Card>
        </div>
      )}

      {/* Stat Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
        {statCards.map((card) => {
          const Icon = card.icon
          const base = 'group relative overflow-hidden rounded-2xl border border-ink-200/80 bg-white p-5 shadow-[var(--shadow-card)] transition-all duration-200 hover:shadow-[var(--shadow-card-hover)]'
          const inner = (
            <>
              <div className={`flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br ${card.tint} shadow-sm`}>
                <Icon className="h-[22px] w-[22px] text-white" />
              </div>
              <p className="mt-4 text-3xl font-bold tracking-tight text-ink-900">{card.value}</p>
              <p className="mt-0.5 text-sm text-ink-500">{card.label}</p>
            </>
          )
          // A real button when it opens something, so it is reachable by keyboard.
          return card.onClick ? (
            <button
              key={card.label}
              type="button"
              onClick={card.onClick}
              className={`${base} cursor-pointer text-left hover:border-emerald-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2`}
            >
              {inner}
              <span className="mt-1 block text-[11px] font-medium text-emerald-600">View all →</span>
            </button>
          ) : (
            <div key={card.label} className={base}>
              {inner}
            </div>
          )
        })}
      </div>

      {/* Leads / Customers / Sales period breakdown */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <PeriodBreakdown
          icon={CalendarRange}
          tint="from-primary-500 to-primary-600"
          title="Leads"
          today={dashboard?.leadsByPeriod.today ?? 0}
          thisWeek={dashboard?.leadsByPeriod.thisWeek ?? 0}
          thisMonth={dashboard?.leadsByPeriod.thisMonth ?? 0}
        />
        <PeriodBreakdown
          icon={UserCheck}
          tint="from-emerald-500 to-emerald-600"
          title="Customers Converted"
          today={convertedByPeriod.today}
          thisWeek={convertedByPeriod.thisWeek}
          thisMonth={convertedByPeriod.thisMonth}
        />
        <PeriodBreakdown
          icon={IndianRupee}
          tint="from-success-500 to-success-600"
          title="Sales"
          today={dashboard?.salesByPeriod.today ?? 0}
          thisWeek={dashboard?.salesByPeriod.thisWeek ?? 0}
          thisMonth={dashboard?.salesByPeriod.thisMonth ?? 0}
          format={formatRupees}
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-5">
        {/* Lead Status Breakdown */}
        <Card className="lg:col-span-3">
          <div className="flex items-center justify-between px-5 pt-5">
            <div>
              <h2 className="text-[15px] font-semibold text-ink-900">Lead Status Breakdown</h2>
              <p className="text-xs text-ink-500">Distribution across the pipeline</p>
            </div>
            <button onClick={() => navigate('/leads')} className="text-xs font-medium text-primary-600 hover:text-primary-700">
              View all
            </button>
          </div>
          <div className="space-y-2.5 px-5 pb-5 pt-4">
            {(Object.entries(leadStatusCounts) as [LeadStatus, number][])
              .sort((a, b) => b[1] - a[1])
              .map(([status, count]) => (
                <div key={status} className="flex items-center gap-3">
                  <span className="w-32 shrink-0 text-[13px] text-ink-600">{STATUS_LABELS[status]}</span>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-ink-100">
                    <div
                      className={`h-full rounded-full ${STATUS_BAR[status]} transition-all duration-500`}
                      style={{ width: `${(count / maxStatusCount) * 100}%` }}
                    />
                  </div>
                  <span className="w-6 text-right text-[13px] font-semibold text-ink-700">{count}</span>
                </div>
              ))}
          </div>
        </Card>

        {/* Sales by Caller - SVG bar chart (admin only, mirrors Caller Performance's gating) */}
        <Card className="lg:col-span-2">
          <div className="flex items-center gap-2 px-5 pt-5">
            <BarChart3 className="h-4 w-4 text-ink-400" />
            <div>
              <h2 className="text-[15px] font-semibold text-ink-900">Sales by Caller</h2>
              <p className="text-xs text-ink-500">Total order value per caller</p>
            </div>
          </div>
          <div className="px-2 pb-3 pt-4">
            {salesByCaller.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-ink-400">
                {state.currentUser?.role === 'admin' ? 'No sales recorded yet' : 'Visible to admins only'}
              </p>
            ) : (
              <>
                <svg viewBox={`0 0 ${barChartW} ${barChartH}`} className="w-full" preserveAspectRatio="none" style={{ height: 180 }}>
                  {salesByCaller.map((caller, i) => {
                    const x = i * (barSlot + barGap) + (barSlot - barWidth) / 2
                    const height = (caller.totalSales / maxCallerSales) * (barChartH - 26)
                    const y = barChartH - height
                    const r = Math.min(4, barWidth / 2, height)
                    const path = height <= 0 ? '' : `M ${x} ${barChartH} L ${x} ${y + r} Q ${x} ${y} ${x + r} ${y} L ${x + barWidth - r} ${y} Q ${x + barWidth} ${y} ${x + barWidth} ${y + r} L ${x + barWidth} ${barChartH} Z`
                    return (
                      <g key={caller.callerId}>
                        <title>{caller.callerName}: {formatRupees(caller.totalSales)}</title>
                        <path d={path} fill="#3b6df5" />
                        <text
                          x={x + barWidth / 2}
                          y={y - 6}
                          textAnchor="middle"
                          className="fill-ink-600"
                          style={{ fontSize: 10, fontWeight: 600 }}
                        >
                          {formatRupees(caller.totalSales)}
                        </text>
                      </g>
                    )
                  })}
                </svg>
                <div className="flex px-2">
                  {salesByCaller.map((caller, i) => (
                    <span
                      key={caller.callerId}
                      title={caller.callerName}
                      className="truncate text-center text-[11px] font-medium text-ink-400"
                      style={{ width: barSlot, marginRight: i === salesByCaller.length - 1 ? 0 : barGap }}
                    >
                      {caller.callerName.split(' ')[0]}
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
        </Card>
      </div>

      {/* Recent Leads + Caller Performance */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card className="overflow-hidden lg:col-span-2">
          <div className="flex items-center justify-between border-b border-ink-100 px-5 py-4">
            <h2 className="text-[15px] font-semibold text-ink-900">Recent Leads</h2>
            <button onClick={() => navigate('/leads')} className="flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700">
              View all <ArrowUpRight className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-100 bg-ink-50/50">
                  <th className="px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Customer</th>
                  <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Medicine</th>
                  <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Status</th>
                  <th className="px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Assigned</th>
                </tr>
              </thead>
              <tbody>
                {recentLeads.map((lead) => (
                  <tr
                    key={lead.id}
                    onClick={() => navigate(`/leads/${lead.id}`)}
                    className="cursor-pointer border-b border-ink-50 transition-colors last:border-0 hover:bg-primary-50/30"
                  >
                    <td className="px-5 py-3 font-medium text-ink-900">{lead.customerName}</td>
                    <td className="px-3 py-3 text-ink-600">
                      {lead.medicines[0]?.name ?? '-'}
                      {lead.medicines.length > 1 && (
                        <span className="ml-1 text-xs text-ink-500">+{lead.medicines.length - 1} more</span>
                      )}
                    </td>
                    <td className="px-3 py-3"><LeadStatusBadge status={lead.status} /></td>
                    <td className="px-5 py-3 text-ink-600">{getUserName(lead.assignedCaller)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="overflow-hidden">
          <div className="border-b border-ink-100 px-5 py-4">
            <h2 className="text-[15px] font-semibold text-ink-900">Caller Performance</h2>
          </div>
          <div className="divide-y divide-ink-50">
            {callerPerformance.map((caller) => (
              <div key={caller.id} className="flex items-center gap-3 px-5 py-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink-100 text-xs font-semibold text-ink-600">
                  {caller.name.split(' ').map((n) => n[0]).join('').slice(0, 2)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink-900">{caller.name}</p>
                  <p className="text-xs text-ink-500">{caller.assignedCount} leads · {caller.convertedCount} converted</p>
                </div>
                <Badge variant={caller.conversionRate >= 50 ? 'success' : caller.conversionRate >= 25 ? 'warning' : 'default'}>
                  {caller.conversionRate}%
                </Badge>
              </div>
            ))}
            {callerPerformance.length === 0 && (
              <p className="px-5 py-8 text-center text-sm text-ink-400">No callers found</p>
            )}
          </div>
        </Card>
      </div>

      {/* The customer list behind the Total Customers card. Rows open the full lead record. */}
      <Modal
        isOpen={showCustomers}
        onClose={() => setShowCustomers(false)}
        title="Customers"
        description={`${customers.length} unique customer${customers.length === 1 ? '' : 's'} — repeat purchases counted once`}
        size="xl"
      >
        {customers.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-400">
            No customers yet. A lead becomes one when it is converted to an order.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-100 bg-ink-50/50">
                  {['Name', 'Mobile', 'Alternate', 'Address', 'City', 'State', 'Pincode'].map((h, i) => (
                    <th
                      key={h}
                      className={`whitespace-nowrap py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400 ${i === 0 ? 'pl-1 pr-3' : 'px-3'}`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              {/* Rows are not clickable: a customer outlives the lead they came from, so for
                  one whose lead has since been removed there is no lead record to open. */}
              <tbody>
                {customers.map((c) => (
                  <tr key={c.id} className="border-b border-ink-50 last:border-0">
                    <td className="py-3 pl-1 pr-3 font-medium text-ink-900">{c.customerName}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-ink-600">{c.mobile}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-ink-600">{c.alternateNumber || '-'}</td>
                    <td className="px-3 py-3 text-ink-600">{c.address || '-'}</td>
                    <td className="px-3 py-3 text-ink-600">{c.city || '-'}</td>
                    <td className="px-3 py-3 text-ink-600">{c.state || '-'}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-ink-600">{c.pincode || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>

      {/* Renewal Reminders Modal — details behind the Renewal Reminders stat card and View All */}
      <Modal
        isOpen={showRenewalReminders}
        onClose={() => setShowRenewalReminders(false)}
        title="Renewal Reminders"
        description={`${renewalRemindersList.length} active renewal reminder${renewalRemindersList.length === 1 ? '' : 's'} scheduled`}
        size="xl"
      >
        {renewalRemindersList.length === 0 ? (
          <div className="py-8 text-center text-sm text-ink-400">
            <p>No renewal reminders scheduled. Schedule reminders directly from the Renewals table.</p>
            <Button
              size="sm"
              variant="primary"
              className="mt-3"
              onClick={() => {
                setShowRenewalReminders(false)
                navigate('/renewals')
              }}
            >
              Go to Renewals Page
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-100 bg-ink-50/50">
                    {['Customer', 'Medicine', 'Remind Date', 'Slot', 'Mobile', 'Status'].map((h, i) => (
                      <th
                        key={h}
                        className={`whitespace-nowrap py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400 ${i === 0 ? 'pl-1 pr-3' : 'px-3'}`}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {renewalRemindersList.map((r) => {
                    const medicine =
                      r.medicineName || state.renewals.find((ren) => ren.id === r.renewalId)?.medicineName || '—'
                    const today = istToday()
                    const isOverdue = r.scheduledDate < today
                    const isTodayDue = r.scheduledDate === today
                    return (
                      <tr key={r.id} className="border-b border-ink-50 last:border-0 hover:bg-ink-50/30">
                        <td className="py-3 pl-1 pr-3 font-medium text-ink-900">{r.customerName}</td>
                        <td className="whitespace-nowrap px-3 py-3 text-ink-700">
                          <span className="inline-flex items-center rounded-md bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
                            {medicine}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 font-medium text-ink-600">
                          {formatIndianDate(r.scheduledDate)}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-ink-500">{r.slot || 'Any time'}</td>
                        <td className="whitespace-nowrap px-3 py-3 text-ink-600">
                          {r.mobile ? (
                            <a href={`tel:${r.mobile}`} className="text-primary-600 hover:underline">
                              {r.mobile}
                            </a>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3">
                          {isOverdue ? (
                            <Badge variant="danger">Overdue</Badge>
                          ) : isTodayDue ? (
                            <Badge variant="warning">Due Today</Badge>
                          ) : (
                            <Badge variant="default">Upcoming</Badge>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t border-ink-100 pt-3">
              <span className="text-xs text-ink-500">Reminders are scheduled from the Renewals page.</span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setShowRenewalReminders(false)
                  navigate('/renewals')
                }}
              >
                Open Renewals Page →
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Calls Completed Today Modal */}
      <Modal
        isOpen={showCallsDoneToday}
        onClose={() => setShowCallsDoneToday(false)}
        title="Calls Completed Today"
        description={`${completedCallsToday.length} call${completedCallsToday.length === 1 ? '' : 's'} completed today`}
        size="lg"
      >
        {completedCallsToday.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-400">
            No calls marked as completed today yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-100 bg-ink-50/50">
                  {['Customer', 'Mobile', 'Scheduled', 'Completed'].map((h, i) => (
                    <th
                      key={h}
                      className={`whitespace-nowrap py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400 ${
                        i === 0 ? 'pl-1 pr-3' : 'px-3'
                      }`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {completedCallsToday.map((c) => {
                  const medicine = c.medicineName
                  const completedDisplay = c.completedAt
                    ? formatIndianDateTime(c.completedAt)
                    : c.completedDate
                    ? formatIndianDate(c.completedDate)
                    : formatIndianDate(c.scheduledDate)

                  return (
                    <tr key={c.id} className="border-b border-ink-50 last:border-0 hover:bg-ink-50/30">
                      <td className="py-3 pl-1 pr-3 font-medium text-ink-900">
                        {c.leadId ? (
                          <button
                            type="button"
                            onClick={() => {
                              setShowCallsDoneToday(false)
                              navigate(`/leads/${c.leadId}`)
                            }}
                            className="text-left font-medium text-ink-900 hover:text-primary-600 hover:underline"
                          >
                            {c.customerName}
                          </button>
                        ) : (
                          c.customerName
                        )}
                        {medicine && (
                          <span className="ml-2 inline-flex items-center rounded-md bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-700">
                            {medicine}
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-ink-600">
                        {c.mobile ? (
                          <a href={`tel:${c.mobile}`} className="font-medium text-primary-600 hover:underline">
                            {c.mobile}
                          </a>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-ink-600">
                        {formatIndianDate(c.scheduledDate)}
                        {c.slot && <span className="ml-1 text-xs text-ink-400">({c.slot})</span>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 font-medium text-teal-700">
                        <span className="inline-flex items-center gap-1 rounded bg-teal-50 px-2 py-0.5 text-xs">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          {completedDisplay}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </div>
  )
}
