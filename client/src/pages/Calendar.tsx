import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Phone, Bell, RotateCcw, Eye, CheckCircle2, Clock, CalendarDays } from 'lucide-react'
import { useApp } from '@/context/AppContext'
import { followUpsApi } from '@/api/followUps'
import { emitToast } from '@/lib/toast'
import { formatIndianDate, istToday } from '@/lib/dateUtils'
import { slotLabel } from '@/lib/followUpSlots'
import { PageHeader } from '@/components/ui/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import type { FollowUp, Renewal } from '@/types'

/**
 * Dials the customer.
 *
 * An anchor with a tel: href rather than a button, because that is what hands the number to
 * the phone's own dialer — a click handler could only copy it somewhere. Styled to match the
 * Button beside it. On a desktop browser this opens whatever is registered for tel:, which
 * may be nothing; on the phone the callers actually use, it opens the keypad ready to dial.
 */
function CallButton({ mobile, name }: { mobile: string; name: string }) {
  return (
    <a
      href={`tel:${mobile.replace(/[^\d+]/g, '')}`}
      aria-label={`Call ${name} on ${mobile}`}
      className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-success-600 px-3 py-1.5 text-[13px] font-medium text-white shadow-sm transition-colors hover:bg-success-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success-500 focus-visible:ring-offset-2"
    >
      <Phone className="h-3.5 w-3.5" />
      Call
    </a>
  )
}

const TODAY = istToday()
const DAYS_OF_WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

type ViewMode = 'daily' | 'weekly' | 'monthly'

function formatDate(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function parseDate(dateStr: string): { year: number; month: number; day: number } {
  const [y, m, d] = dateStr.split('-').map(Number)
  return { year: y, month: m - 1, day: d }
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

function getFirstDayOfMonth(year: number, month: number): number {
  const day = new Date(year, month, 1).getDay()
  // Convert Sunday=0 to Monday-based (Mon=0 ... Sun=6)
  return day === 0 ? 6 : day - 1
}

function isToday(dateStr: string): boolean {
  return dateStr === TODAY
}

function isSameDay(a: string, b: string): boolean {
  return a === b
}

function getMonthName(month: number): string {
  return ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'][month]
}

/**
 * The four states the calendar paints, shared by follow-ups and renewals.
 *
 * Both are work with a date on it, so both are shown on the day they fall due and coloured by
 * the same rule — a caller planning their day should not have to learn two colour schemes.
 */
type DayState = 'overdue' | 'completed' | 'upcoming' | 'today'

function getFollowUpStatus(f: FollowUp): DayState {
  if (f.status === 'completed') return 'completed'
  if (isToday(f.scheduledDate) && f.status === 'pending') return 'today'
  if (f.scheduledDate < TODAY && (f.status === 'pending' || f.status === 'missed')) return 'overdue'
  return 'upcoming'
}

/**
 * A renewal's own status already says which of the four it is, so it is mapped rather than
 * recomputed from the date — the server decides what counts as due, and the calendar agreeing
 * with the Renewals page matters more than deriving it twice.
 */
function getRenewalState(r: Renewal): DayState {
  if (r.status === 'renewed') return 'completed'
  if (r.status === 'due_today') return 'today'
  if (r.status === 'overdue') return 'overdue'
  return 'upcoming'
}

const DOT_COLOR: Record<DayState, string> = {
  overdue: 'bg-danger-500',
  completed: 'bg-success-500',
  today: 'bg-warning-500',
  upcoming: 'bg-primary-500',
}

const CHIP_CLASSES: Record<DayState, string> = {
  overdue: 'bg-danger-50 text-danger-700',
  completed: 'bg-success-50 text-success-700',
  today: 'bg-warning-50 text-warning-700',
  upcoming: 'bg-primary-50 text-primary-700',
}

const BADGE_VARIANT: Record<DayState, 'danger' | 'success' | 'warning' | 'info'> = {
  overdue: 'danger',
  completed: 'success',
  today: 'warning',
  upcoming: 'info',
}

function getWeekDates(dateStr: string): string[] {
  const { year, month, day } = parseDate(dateStr)
  const d = new Date(year, month, day)
  const dow = d.getDay()
  const mondayOffset = dow === 0 ? -6 : 1 - dow
  const monday = new Date(year, month, day + mondayOffset)
  const dates: string[] = []
  for (let i = 0; i < 7; i++) {
    const current = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i)
    dates.push(formatDate(current.getFullYear(), current.getMonth(), current.getDate()))
  }
  return dates
}

const TYPE_ICON: Record<FollowUp['type'], typeof Phone> = {
  call: Phone,
  reminder: Bell,
  callback: RotateCcw,
}

const TYPE_BADGE_VARIANT: Record<FollowUp['type'], 'primary' | 'info' | 'warning'> = {
  call: 'primary',
  reminder: 'info',
  callback: 'warning',
}

export function Calendar() {
  const { state, dispatch } = useApp()
  const navigate = useNavigate()
  // Opens on today's calls. A month grid answers "when is everything", which is the rarer
  // question — the page is opened to find out who to ring now.
  const [viewMode, setViewMode] = useState<ViewMode>('daily')
  const [currentDate, setCurrentDate] = useState(TODAY)
  const [selectedDay, setSelectedDay] = useState<string | null>(null)

  const { year, month, day } = parseDate(currentDate)

  const followUpsByDate = useMemo(() => {
    const map: Record<string, FollowUp[]> = {}
    for (const f of state.followUps) {
      if (!map[f.scheduledDate]) map[f.scheduledDate] = []
      map[f.scheduledDate].push(f)
    }
    return map
  }, [state.followUps])

  /*
   * Renewals sit on the day the customer's supply runs out.
   *
   * They are already loaded with the app and already scoped, so this is a regrouping rather
   * than a fetch. A renewal that has its own reminder follow-up appears twice on purpose:
   * the reminder is the day you agreed to ring, the renewal is the day they run out, and
   * those are different appointments that can fall in different weeks.
   */
  const renewalsByDate = useMemo(() => {
    const map: Record<string, Renewal[]> = {}
    for (const r of state.renewals) {
      if (!r.renewalDate) continue
      if (!map[r.renewalDate]) map[r.renewalDate] = []
      map[r.renewalDate].push(r)
    }
    return map
  }, [state.renewals])

  /** Everything due on a day, renewals after the calls, so the day reads in the order it is worked. */
  const entriesOn = (date: string) => ({
    followUps: followUpsByDate[date] ?? [],
    renewals: renewalsByDate[date] ?? [],
  })
  const countOn = (date: string) => (followUpsByDate[date]?.length ?? 0) + (renewalsByDate[date]?.length ?? 0)

  // Calendar grid for monthly view
  const calendarGrid = useMemo(() => {
    const daysInMonth = getDaysInMonth(year, month)
    const firstDay = getFirstDayOfMonth(year, month)
    const cells: (string | null)[] = []

    // Leading empty cells
    for (let i = 0; i < firstDay; i++) cells.push(null)
    // Day cells
    for (let d = 1; d <= daysInMonth; d++) cells.push(formatDate(year, month, d))
    // Trailing empty cells to fill 6 rows
    while (cells.length < 42) cells.push(null)

    return cells
  }, [year, month])

  const weekDates = useMemo(() => getWeekDates(currentDate), [currentDate])

  // Summary stats. Renewals count alongside follow-ups: the panel answers "how much is on me
  // this week", and a week with four renewals falling due is not a quiet one.
  const todayFollowUps = followUpsByDate[TODAY] ?? []
  const todayRenewals = renewalsByDate[TODAY] ?? []
  const overdueFollowUps = useMemo(
    () => state.followUps.filter(f => f.scheduledDate < TODAY && (f.status === 'pending' || f.status === 'missed')),
    [state.followUps]
  )
  const overdueRenewals = useMemo(
    () => state.renewals.filter(r => r.status === 'overdue'),
    [state.renewals]
  )
  const nextWeekStr = useMemo(() => {
    const { year: ty, month: tm, day: td } = parseDate(TODAY)
    const nextWeek = new Date(ty, tm, td + 7)
    return formatDate(nextWeek.getFullYear(), nextWeek.getMonth(), nextWeek.getDate())
  }, [])
  const upcomingFollowUps = useMemo(
    () => state.followUps.filter(f => f.scheduledDate > TODAY && f.scheduledDate <= nextWeekStr && f.status === 'pending'),
    [state.followUps, nextWeekStr]
  )
  const upcomingRenewals = useMemo(
    () => state.renewals.filter(r => r.renewalDate > TODAY && r.renewalDate <= nextWeekStr && r.status !== 'renewed'),
    [state.renewals, nextWeekStr]
  )

  const summary = {
    today: todayFollowUps.length + todayRenewals.length,
    upcoming: upcomingFollowUps.length + upcomingRenewals.length,
    overdue: overdueFollowUps.length + overdueRenewals.length,
  }

  function navigateMonth(offset: number) {
    const d = new Date(year, month + offset, 1)
    setCurrentDate(formatDate(d.getFullYear(), d.getMonth(), 1))
    setSelectedDay(null)
  }

  function navigateWeek(offset: number) {
    const { year: y, month: m, day: d } = parseDate(currentDate)
    const newDate = new Date(y, m, d + offset * 7)
    setCurrentDate(formatDate(newDate.getFullYear(), newDate.getMonth(), newDate.getDate()))
  }

  function navigateDay(offset: number) {
    const { year: y, month: m, day: d } = parseDate(currentDate)
    const newDate = new Date(y, m, d + offset)
    setCurrentDate(formatDate(newDate.getFullYear(), newDate.getMonth(), newDate.getDate()))
  }

  function goToToday() {
    setCurrentDate(TODAY)
    setSelectedDay(null)
  }

  async function markComplete(id: string) {
    try {
      const { followUp, lead } = await followUpsApi.updateStatus(id, 'completed')
      dispatch({ type: 'UPDATE_FOLLOW_UP', payload: { id: followUp.id, updates: followUp } })
      if (lead) dispatch({ type: 'UPDATE_LEAD', payload: { id: lead.id, updates: lead } })
    } catch (err) {
      emitToast(err instanceof Error ? err.message : 'Failed to mark follow-up complete')
    }
  }

  const getDotColor = (f: FollowUp) => DOT_COLOR[getFollowUpStatus(f)]
  const getChipClasses = (f: FollowUp) => CHIP_CLASSES[getFollowUpStatus(f)]
  const getStatusBadgeVariant = (f: FollowUp) => BADGE_VARIANT[getFollowUpStatus(f)]

  // ---- Render helpers ----

  function renderTypeBadge(type: FollowUp['type']) {
    return <Badge variant={TYPE_BADGE_VARIANT[type]}>{type}</Badge>
  }

  function renderFollowUpCard(f: FollowUp, showActions = false) {
    const status = getFollowUpStatus(f)
    const borderColor =
      status === 'overdue' ? 'border-l-danger-500' :
      status === 'completed' ? 'border-l-success-500' :
      status === 'today' ? 'border-l-warning-500' :
      'border-l-primary-500'

    return (
      <div
        key={f.id}
        className={`border-l-4 ${borderColor} rounded-lg border border-ink-100 bg-white p-3 shadow-sm space-y-2`}
      >
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-ink-900">{f.customerName}</span>
          {renderTypeBadge(f.type)}
        </div>
        {f.notes && (
          <p className="text-xs text-ink-500 line-clamp-2">{f.notes}</p>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={getStatusBadgeVariant(f)}>
            {status}
          </Badge>
          {slotLabel(f.slot) && (
            <span className="inline-flex items-center gap-1 rounded-full bg-ink-100 px-2 py-0.5 text-[11px] font-medium text-ink-600">
              <Clock className="h-3 w-3" />
              {slotLabel(f.slot)}
            </span>
          )}
        </div>
        {(f.mobile || (showActions && f.status !== 'completed')) && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {showActions && f.status !== 'completed' && (
              <Button size="sm" variant="soft" icon={<CheckCircle2 className="w-3.5 h-3.5" />} onClick={() => markComplete(f.id)}>
                Complete
              </Button>
            )}
            {f.mobile && <CallButton mobile={f.mobile} name={f.customerName} />}
            {showActions && f.leadId && (
              <Button size="sm" variant="secondary" icon={<Eye className="w-3.5 h-3.5" />} onClick={() => navigate(`/leads/${f.leadId}`)}>
                View Lead
              </Button>
            )}
          </div>
        )}
      </div>
    )
  }

  /**
   * A renewal on a day list.
   *
   * Deliberately shaped like the follow-up card beside it but labelled "renewal", because the
   * two are worked the same way and the only thing a caller needs to tell apart at a glance is
   * which one it is. There is no Complete here — a renewal is closed by reordering, on the
   * Renewals page, which is where the button goes.
   */
  function renderRenewalCard(r: Renewal) {
    const state_ = getRenewalState(r)
    const borderColor =
      state_ === 'overdue' ? 'border-l-danger-500' :
      state_ === 'completed' ? 'border-l-success-500' :
      state_ === 'today' ? 'border-l-warning-500' :
      'border-l-primary-500'

    return (
      <div
        key={`renewal-${r.id}`}
        className={`border-l-4 ${borderColor} rounded-lg border border-ink-100 bg-white p-3 shadow-sm space-y-2`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-ink-900 truncate">{r.customerName}</span>
          <Badge variant="info">renewal</Badge>
        </div>
        {r.medicineName && <p className="text-xs text-ink-500 line-clamp-2">{r.medicineName}</p>}
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={BADGE_VARIANT[state_]}>{state_}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {r.mobile && <CallButton mobile={r.mobile} name={r.customerName} />}
          <Button size="sm" variant="secondary" icon={<RotateCcw className="w-3.5 h-3.5" />} onClick={() => navigate('/renewals')}>
            Open renewal
          </Button>
        </div>
      </div>
    )
  }

  // ---- Views ----

  function renderMonthlyView() {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Calendar Grid */}
        <div className="lg:col-span-3">
          <Card>
            <CardBody className="p-3 sm:p-4">
              {/* Day headers */}
              <div className="grid grid-cols-7">
                {DAYS_OF_WEEK.map(d => (
                  <div key={d} className="py-2 text-center text-[11px] font-semibold uppercase tracking-wider text-ink-400">
                    {d}
                  </div>
                ))}
              </div>
              {/* Day cells */}
              {/*
               * Cell height is per-breakpoint, not fixed. Seven columns on a 375px screen
               * leaves each one about 40px wide, so the old flat min-h-[104px] drew a grid of
               * tall, near-empty slots that pushed the month well past a screenful.
               */}
              <div className="grid grid-cols-7 gap-1 sm:gap-1.5">
                {calendarGrid.map((dateStr, i) => {
                  if (!dateStr) {
                    return <div key={`empty-${i}`} className="min-h-[52px] rounded-lg border border-ink-100 bg-ink-50/30 sm:min-h-[104px]" />
                  }
                  const dayNum = parseDate(dateStr).day
                  const { followUps: dayFollowUps, renewals: dayRenewals } = entriesOn(dateStr)
                  const dayTotal = dayFollowUps.length + dayRenewals.length
                  const today = isToday(dateStr)
                  const selected = selectedDay === dateStr

                  return (
                    <div
                      key={dateStr}
                      onClick={() => setSelectedDay(dateStr)}
                      className={`min-h-[52px] rounded-lg border border-ink-100 p-1 cursor-pointer transition-colors hover:bg-ink-50 hover:border-ink-200 sm:min-h-[104px] sm:p-2
                        ${today ? 'ring-2 ring-primary-500/40 bg-primary-50/40' : ''}
                        ${selected ? 'ring-2 ring-primary-500' : ''}`}
                    >
                      <span className={`text-sm font-medium
                        ${today ? 'text-primary-700' : 'text-ink-700'}`}>
                        {dayNum}
                      </span>
                      {dayTotal > 0 && (
                        <>
                          {/*
                           * Phones get dots. A name chip inside a 40px cell renders as one
                           * letter and an ellipsis, which tells you less than a dot does —
                           * and tapping the day already opens the full list underneath.
                           */}
                          <div className="mt-1 flex flex-wrap gap-0.5 sm:hidden">
                            {dayFollowUps.slice(0, 4).map(f => (
                              <span key={f.id} className={`h-1.5 w-1.5 rounded-full ${getDotColor(f)}`} />
                            ))}
                            {dayRenewals.slice(0, Math.max(0, 4 - dayFollowUps.length)).map(r => (
                              // Hollow, so a renewal is distinguishable from a call at dot size,
                              // where there is no room for a label to say which it is.
                              <span
                                key={`r-${r.id}`}
                                className={`h-1.5 w-1.5 rounded-full ring-1 ring-inset bg-white ${DOT_COLOR[getRenewalState(r)].replace('bg-', 'ring-')}`}
                              />
                            ))}
                            {dayTotal > 4 && (
                              <span className="text-[9px] leading-none text-ink-400">+</span>
                            )}
                          </div>
                          <div className="mt-1.5 hidden space-y-1 sm:block">
                            {dayFollowUps.slice(0, 3).map(f => (
                              <div
                                key={f.id}
                                title={f.customerName}
                                className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium truncate ${getChipClasses(f)}`}
                              >
                                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${getDotColor(f)}`} />
                                <span className="truncate">{f.customerName}</span>
                              </div>
                            ))}
                            {dayRenewals.slice(0, Math.max(0, 3 - dayFollowUps.length)).map(r => (
                              <div
                                key={`r-${r.id}`}
                                title={`Renewal due — ${r.customerName}${r.medicineName ? ` (${r.medicineName})` : ''}`}
                                className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium truncate ${CHIP_CLASSES[getRenewalState(r)]}`}
                              >
                                <RotateCcw className="h-2.5 w-2.5 shrink-0" />
                                <span className="truncate">{r.customerName}</span>
                              </div>
                            ))}
                            {dayTotal > 3 && (
                              <span className="block px-1.5 text-[10px] text-ink-400">+{dayTotal - 3} more</span>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            </CardBody>
          </Card>

          {/* Selected day detail */}
          {selectedDay && (
            <div className="mt-4">
              <Card>
                <CardBody>
                  <h3 className="text-sm font-semibold text-ink-900 mb-3">
                    {formatIndianDate(selectedDay)}
                  </h3>
                  {countOn(selectedDay) === 0 ? (
                    <EmptyState
                      icon={<CalendarDays size={26} />}
                      title="Nothing due"
                      description="No follow-ups or renewals for this day."
                    />
                  ) : (
                    <div className="space-y-3">
                      {entriesOn(selectedDay).followUps.map(f => renderFollowUpCard(f, true))}
                      {entriesOn(selectedDay).renewals.map(renderRenewalCard)}
                    </div>
                  )}
                </CardBody>
              </Card>
            </div>
          )}
        </div>

        {/* Right Sidebar */}
        <div className="space-y-4">
          <Card>
            <CardBody>
              <h3 className="text-sm font-semibold text-ink-900 mb-4">Summary</h3>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-ink-600">Today</span>
                  <span className="inline-flex min-w-7 items-center justify-center rounded-full bg-warning-50 px-2 py-0.5 text-sm font-semibold text-warning-700">{summary.today}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-ink-600">Upcoming (7d)</span>
                  <span className="inline-flex min-w-7 items-center justify-center rounded-full bg-primary-50 px-2 py-0.5 text-sm font-semibold text-primary-700">{summary.upcoming}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-ink-600">Overdue</span>
                  <span className="inline-flex min-w-7 items-center justify-center rounded-full bg-danger-50 px-2 py-0.5 text-sm font-semibold text-danger-700">{summary.overdue}</span>
                </div>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <h3 className="text-sm font-semibold text-ink-900 mb-3">Due Today</h3>
              {summary.today === 0 ? (
                <EmptyState
                  icon={<Clock size={26} />}
                  title="All clear"
                  description="No follow-ups or renewals due today."
                />
              ) : (
                <div className="space-y-2">
                  {todayRenewals.map(r => (
                    <div key={`r-${r.id}`} className="flex items-center justify-between gap-2 rounded-lg border border-ink-100 p-3 transition-colors hover:border-ink-200">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-ink-900 truncate">{r.customerName}</p>
                        <div className="flex items-center gap-1 mt-1">
                          <Badge variant="info">renewal</Badge>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {r.mobile && <CallButton mobile={r.mobile} name={r.customerName} />}
                        <Button size="sm" variant="secondary" icon={<RotateCcw className="w-3.5 h-3.5" />} onClick={() => navigate('/renewals')} />
                      </div>
                    </div>
                  ))}
                  {todayFollowUps.map(f => (
                    <div key={f.id} className="flex items-center justify-between gap-2 rounded-lg border border-ink-100 p-3 transition-colors hover:border-ink-200">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-ink-900 truncate">{f.customerName}</p>
                        <div className="flex items-center gap-1 mt-1">
                          {renderTypeBadge(f.type)}
                        </div>
                      </div>
                      {f.status !== 'completed' ? (
                        <Button size="sm" variant="soft" icon={<CheckCircle2 className="w-3.5 h-3.5" />} onClick={() => markComplete(f.id)} />
                      ) : (
                        <Badge variant="success">done</Badge>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    )
  }

  function renderWeeklyView() {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {weekDates.map((dateStr, i) => {
          const { followUps: dayFollowUps, renewals: dayRenewals } = entriesOn(dateStr)
          const today = isToday(dateStr)
          const { day: d } = parseDate(dateStr)

          return (
            <div key={dateStr} className="min-w-0 rounded-xl border border-ink-100 bg-white">
              <div className={`flex items-center justify-between rounded-t-xl border-b border-ink-100 px-3 py-2
                ${today ? 'bg-primary-50/50' : ''}`}>
                <span className={`text-[11px] font-semibold uppercase tracking-wider ${today ? 'text-primary-600' : 'text-ink-400'}`}>{DAYS_OF_WEEK[i]}</span>
                <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-sm font-semibold
                  ${today ? 'bg-primary-600 text-white' : 'text-ink-700'}`}>{d}</span>
              </div>
              <div className="min-h-48 space-y-1.5 p-2">
                {dayFollowUps.length + dayRenewals.length === 0 && (
                  <p className="mt-4 text-center text-[11px] text-ink-300">No events</p>
                )}
                {dayFollowUps.map(f => (
                  <div
                    key={f.id}
                    className={`rounded-md p-2 text-xs cursor-pointer transition-shadow hover:shadow-sm ${getChipClasses(f)}`}
                    onClick={() => { setCurrentDate(dateStr); setViewMode('daily') }}
                  >
                    <p className="font-medium truncate">{f.customerName}</p>
                    <div className="mt-1">{renderTypeBadge(f.type)}</div>
                  </div>
                ))}
                {dayRenewals.map(r => (
                  <div
                    key={`r-${r.id}`}
                    className={`rounded-md p-2 text-xs cursor-pointer transition-shadow hover:shadow-sm ${CHIP_CLASSES[getRenewalState(r)]}`}
                    onClick={() => { setCurrentDate(dateStr); setViewMode('daily') }}
                  >
                    <p className="font-medium truncate">{r.customerName}</p>
                    <div className="mt-1"><Badge variant="info">renewal</Badge></div>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  function renderDailyView() {
    const { followUps: dayFollowUps, renewals: dayRenewals } = entriesOn(currentDate)
    const dayTotal = dayFollowUps.length + dayRenewals.length
    const today = isToday(currentDate)

    return (
      <div className="max-w-2xl mx-auto space-y-4">
        <div className={`rounded-xl border p-4 text-center
          ${today ? 'border-primary-200 bg-primary-50/50' : 'border-ink-200 bg-ink-50/50'}`}>
          <p className="text-lg font-semibold text-ink-900">{formatIndianDate(currentDate, 'full')}</p>
          <p className="text-sm text-ink-500">
            {dayTotal} item{dayTotal !== 1 ? 's' : ''}
            {dayRenewals.length > 0 && ` · ${dayRenewals.length} renewal${dayRenewals.length !== 1 ? 's' : ''}`}
          </p>
        </div>

        {dayTotal === 0 ? (
          <Card>
            <CardBody>
              <EmptyState
                icon={<Clock size={26} />}
                title="Nothing due"
                description="No follow-ups or renewals for this day."
              />
            </CardBody>
          </Card>
        ) : (
          <div className="space-y-3">
            {dayFollowUps.map(f => {
              const status = getFollowUpStatus(f)
              const accentBorder =
                status === 'overdue' ? 'border-l-danger-500' :
                status === 'completed' ? 'border-l-success-500' :
                status === 'today' ? 'border-l-warning-500' :
                'border-l-primary-500'
              return (
                <Card key={f.id} className={`border-l-4 ${accentBorder}`}>
                  <CardBody>
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="flex items-center gap-2">
                          {(() => { const Icon = TYPE_ICON[f.type]; return <Icon className="w-4 h-4 text-ink-400" /> })()}
                          <span className="text-base font-semibold text-ink-900">{f.customerName}</span>
                        </div>
                        <div className="flex items-center gap-2 flex-wrap">
                          {renderTypeBadge(f.type)}
                          <Badge variant={getStatusBadgeVariant(f)}>
                            {status}
                          </Badge>
                          {/* The slot agreed with the customer, beside the status so the two
                              read together: what state the call is in, and when to make it. */}
                          {slotLabel(f.slot) && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-ink-100 px-2 py-0.5 text-xs font-medium text-ink-600">
                              <Clock className="h-3 w-3" />
                              {slotLabel(f.slot)}
                            </span>
                          )}
                        </div>
                        {f.notes && (
                          <p className="text-sm text-ink-500">{f.notes}</p>
                        )}
                        <p className="text-xs text-ink-400">Scheduled: {formatIndianDate(f.scheduledDate)}</p>
                      </div>
                    </div>
                    {(f.mobile || f.status !== 'completed') && (
                      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-ink-100 pt-3">
                        {f.status !== 'completed' && (
                          <Button size="sm" variant="soft" icon={<CheckCircle2 className="w-3.5 h-3.5" />} onClick={() => markComplete(f.id)}>
                            Mark Complete
                          </Button>
                        )}
                        {f.mobile && <CallButton mobile={f.mobile} name={f.customerName} />}
                        {f.leadId && (
                          <Button size="sm" variant="secondary" icon={<Eye className="w-3.5 h-3.5" />} onClick={() => navigate(`/leads/${f.leadId}`)}>
                            View Lead
                          </Button>
                        )}
                      </div>
                    )}
                  </CardBody>
                </Card>
              )
            })}
            {dayRenewals.map(renderRenewalCard)}
          </div>
        )}
      </div>
    )
  }

  // ---- Main Layout ----

  const monthLabel = `${getMonthName(month)} ${year}`

  const viewSwitcher = (
    <div className="inline-flex items-center gap-1 rounded-xl border border-ink-200 bg-white p-1 shadow-sm">
      {(['daily', 'weekly', 'monthly'] as const).map(mode => (
        <button
          key={mode}
          onClick={() => setViewMode(mode)}
          className={`rounded-lg px-3 py-1.5 text-[13px] font-medium capitalize transition-colors
            ${viewMode === mode
              ? 'bg-primary-600 text-white shadow-sm'
              : 'text-ink-500 hover:bg-ink-100'}`}
        >
          {mode}
        </button>
      ))}
    </div>
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        title="Calendar"
        description="Follow-ups and renewals, on the day they fall due"
        actions={viewSwitcher}
      />

      {/* Navigation */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            className="rounded-lg border border-ink-200 p-2 text-ink-500 transition-colors hover:bg-ink-100"
            onClick={() =>
              viewMode === 'monthly' ? navigateMonth(-1) :
              viewMode === 'weekly' ? navigateWeek(-1) :
              navigateDay(-1)
            }
            aria-label={`Previous ${viewMode === 'monthly' ? 'month' : viewMode === 'weekly' ? 'week' : 'day'}`}
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <h2 className="min-w-48 text-center text-lg font-semibold text-ink-900">
            {viewMode === 'monthly' ? monthLabel :
             viewMode === 'weekly' ? `Week of ${formatIndianDate(weekDates[0])}` :
             formatIndianDate(currentDate)}
          </h2>
          <button
            className="rounded-lg border border-ink-200 p-2 text-ink-500 transition-colors hover:bg-ink-100"
            onClick={() =>
              viewMode === 'monthly' ? navigateMonth(1) :
              viewMode === 'weekly' ? navigateWeek(1) :
              navigateDay(1)
            }
            aria-label={`Next ${viewMode === 'monthly' ? 'month' : viewMode === 'weekly' ? 'week' : 'day'}`}
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
        <Button size="sm" variant="secondary" onClick={goToToday}>
          Today
        </Button>
      </div>

      {/* View Content */}
      {viewMode === 'monthly' && renderMonthlyView()}
      {viewMode === 'weekly' && renderWeeklyView()}
      {viewMode === 'daily' && renderDailyView()}
    </div>
  )
}
