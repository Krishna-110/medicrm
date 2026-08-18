import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Package,
  Eye,
  ArrowLeft,
  ArrowRight,
  Check,
} from 'lucide-react'
import { useApp } from '@/context/AppContext'
import { ordersApi } from '@/api/orders'
import { emitToast } from '@/lib/toast'
import { formatIndianDate } from '@/lib/dateUtils'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Badge } from '@/components/ui/Badge'
import { SearchInput } from '@/components/ui/SearchInput'
import { Tabs } from '@/components/ui/Tabs'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageHeader } from '@/components/ui/PageHeader'
import { OrderStageBadge } from '@/components/ui/StatusBadge'
import type { DiscountType, Order, OrderStage, PaymentStatus } from '@/types'

const DISCOUNT_LABEL: Record<DiscountType, string> = {
  none: 'No discount',
  flat: 'Flat ₹ off',
  percentage: '% off',
}

const STAGES: { key: OrderStage; label: string; dot: string; accent: string }[] = [
  { key: 'lead', label: 'Lead', dot: 'bg-ink-400', accent: 'bg-ink-400' },
  { key: 'confirmed', label: 'Confirmed', dot: 'bg-primary-500', accent: 'bg-primary-500' },
  { key: 'medicine_prepared', label: 'Medicine Prepared', dot: 'bg-sky-500', accent: 'bg-sky-500' },
  { key: 'packed', label: 'Packed', dot: 'bg-warning-500', accent: 'bg-warning-500' },
  { key: 'shipped', label: 'Shipped', dot: 'bg-teal-500', accent: 'bg-teal-500' },
  { key: 'delivered', label: 'Delivered', dot: 'bg-success-500', accent: 'bg-success-500' },
]

const STAGE_ORDER: OrderStage[] = ['lead', 'confirmed', 'medicine_prepared', 'packed', 'shipped', 'delivered']

function formatIndianCurrency(amount: number): string {
  const formatted = amount.toLocaleString('en-IN', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })
  return `₹${formatted}`
}

function getPaymentBadgeVariant(status: PaymentStatus) {
  switch (status) {
    case 'pending':
      return 'warning' as const
    case 'partial':
      return 'info' as const
    case 'paid':
      return 'success' as const
    case 'refunded':
      return 'danger' as const
    default:
      return 'default' as const
  }
}

function getNextStage(current: OrderStage): OrderStage | null {
  const idx = STAGE_ORDER.indexOf(current)
  if (idx < 0 || idx >= STAGE_ORDER.length - 1) return null
  return STAGE_ORDER[idx + 1]
}

/** The stage before this one, for undoing an advance clicked by mistake. */
function getPreviousStage(current: OrderStage): OrderStage | null {
  const idx = STAGE_ORDER.indexOf(current)
  if (idx <= 0) return null
  return STAGE_ORDER[idx - 1]
}

export function Orders() {
  const { state, dispatch } = useApp()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [activeTab, setActiveTab] = useState('all')
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [discountForm, setDiscountForm] = useState<{ type: DiscountType; value: string }>({ type: 'none', value: '0' })
  const [savingDiscount, setSavingDiscount] = useState(false)

  const orders = state.orders ?? []

  /**
   * The renewal an order came from, if any.
   *
   * Derived rather than stored: renewing writes the next cycle pointing at the order it just
   * placed, so an order whose renewal has a predecessor was a reorder. A first sale gets a
   * renewal too, but that one has no predecessor.
   */
  const sourceRenewal = (order: Order) =>
    (state.renewals ?? []).find(r => r.orderId === order.id && !!r.previousRenewalId)

  const stageCounts = useMemo(() => {
    const counts: Record<string, number> = { all: orders.length }
    for (const stage of STAGE_ORDER) {
      counts[stage] = orders.filter((o) => o.stage === stage).length
    }
    return counts
  }, [orders])

  /**
   * Payment history: every order that has been paid, newest first.
   *
   * Reads from orders rather than a payments table, because an order currently holds exactly
   * one payment. If part-payments or refunds against a single order ever need recording,
   * this is the view that stops being able to express it.
   */
  const payments = useMemo(
    () =>
      orders
        .filter((o) => o.paymentStatus === 'paid')
        .sort((a, b) => b.createdDate.localeCompare(a.createdDate)),
    [orders],
  )

  const filteredOrders = useMemo(() => {
    let result = orders
    if (activeTab === 'payments') {
      result = payments
    } else if (activeTab !== 'all') {
      result = result.filter((o) => o.stage === activeTab)
    }
    if (search.trim()) {
      const q = search.toLowerCase()
      result = result.filter(
        (o) =>
          o.orderNumber.toLowerCase().includes(q) ||
          o.customerName.toLowerCase().includes(q) ||
          o.medicines.some((m) => m.name.toLowerCase().includes(q)),
      )
    }
    return result
  }, [orders, activeTab, search, payments])

  const tabs = [
    { id: 'all', label: 'All', count: stageCounts.all },
    { id: 'confirmed', label: 'Confirmed', count: stageCounts.confirmed },
    { id: 'medicine_prepared', label: 'Prepared', count: stageCounts.medicine_prepared },
    { id: 'packed', label: 'Packed', count: stageCounts.packed },
    { id: 'shipped', label: 'Shipped', count: stageCounts.shipped },
    { id: 'delivered', label: 'Delivered', count: stageCounts.delivered },
    // Payment history lives beside the stages rather than on its own page: it is the same
    // orders, read as money received rather than as work in progress.
    { id: 'payments', label: 'Payments', count: payments.length },
  ]

  /** Moves an order one step along the pipeline, either way. */
  async function handleMoveStage(order: Order, to: OrderStage | null) {
    if (!to) return
    try {
      const updated = await ordersApi.update(order.id, { stage: to })
      dispatch({ type: 'UPDATE_ORDER', payload: { id: updated.id, updates: updated } })
      if (selectedOrder?.id === order.id) setSelectedOrder(updated)
    } catch (err) {
      emitToast(err instanceof Error ? err.message : 'Failed to change order stage')
    }
  }

  async function handlePaymentChange(order: Order, status: PaymentStatus) {
    try {
      const updated = await ordersApi.update(order.id, { paymentStatus: status })
      dispatch({ type: 'UPDATE_ORDER', payload: { id: updated.id, updates: updated } })
      if (selectedOrder?.id === order.id) setSelectedOrder(updated)
    } catch (err) {
      emitToast(err instanceof Error ? err.message : 'Failed to update payment status')
    }
  }

  function openDetail(order: Order) {
    setSelectedOrder(order)
    setDiscountForm({ type: order.discountType, value: String(order.discountValue) })
    setDetailOpen(true)
  }

  async function handleApplyDiscount() {
    if (!selectedOrder) return
    const value = Number(discountForm.value)
    if (discountForm.type !== 'none' && (!Number.isFinite(value) || value < 0)) {
      emitToast('Enter a discount value of 0 or more')
      return
    }
    if (discountForm.type === 'percentage' && value > 100) {
      emitToast('A percentage discount cannot exceed 100')
      return
    }
    setSavingDiscount(true)
    try {
      const updated = await ordersApi.update(selectedOrder.id, {
        discountType: discountForm.type,
        discountValue: discountForm.type === 'none' ? 0 : value,
      })
      dispatch({ type: 'UPDATE_ORDER', payload: { id: updated.id, updates: updated } })
      setSelectedOrder(updated)
      setDiscountForm({ type: updated.discountType, value: String(updated.discountValue) })
      emitToast('Discount applied', 'success')
    } catch (err) {
      emitToast(err instanceof Error ? err.message : 'Failed to apply discount')
    } finally {
      setSavingDiscount(false)
    }
  }

  function closeDetail() {
    setDetailOpen(false)
    setSelectedOrder(null)
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Orders" description={`${orders.length} total orders`} />

      {/* Pipeline */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        {STAGES.map((stage) => {
          const count = stageCounts[stage.key] ?? 0
          const isActive = activeTab === stage.key
          return (
            <button
              key={stage.key}
              type="button"
              onClick={() => setActiveTab(stage.key)}
              className={`relative overflow-hidden rounded-xl border bg-white p-4 text-left transition-all ${
                isActive
                  ? 'border-primary-300 ring-2 ring-primary-100'
                  : 'border-ink-200 hover:border-ink-300 hover:shadow-[var(--shadow-card)]'
              }`}
            >
              <div className={`absolute inset-x-0 top-0 h-1 ${stage.accent}`} />
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${stage.dot}`} />
                <span className="truncate text-sm font-medium text-ink-700">{stage.label}</span>
              </div>
              <div className="mt-2 text-2xl font-bold text-ink-900">{count}</div>
            </button>
          )
        })}
      </div>

      {/* Tabs and Search */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="flex-1 overflow-x-auto">
          <Tabs tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />
        </div>
        <div className="w-full sm:w-72">
          <SearchInput value={search} onChange={setSearch} ariaLabel="Filter orders" placeholder="Search orders..." />
        </div>
      </div>

      {/*
       * Payment history. Same orders, read as money received: when, from whom, how much, what
       * it was for, and the proof. Clicking a row opens the order it belongs to.
       */}
      {activeTab === 'payments' ? (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-100 bg-ink-50/50">
                  <th className="pl-5 pr-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Date</th>
                  <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Order #</th>
                  <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Customer</th>
                  <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">For</th>
                  <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Discount</th>
                  <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Received</th>
                  <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Proof</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {filteredOrders.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-5 py-10">
                      <EmptyState
                        icon={<Package size={28} />}
                        title="No payments yet"
                        description="A payment appears here once an order is marked paid — conversions and renewals both do that on confirmation."
                      />
                    </td>
                  </tr>
                )}
                {filteredOrders.map((order) => {
                  const renewal = sourceRenewal(order)
                  return (
                    <tr
                      key={order.id}
                      onClick={() => openDetail(order)}
                      className="cursor-pointer transition-colors hover:bg-ink-50/60"
                    >
                      <td className="pl-5 pr-3 py-3.5 whitespace-nowrap text-xs text-ink-500">
                        {formatIndianDate(order.createdDate)}
                      </td>
                      <td className="px-3 py-3.5 font-medium text-ink-900">{order.orderNumber}</td>
                      <td className="px-3 py-3.5 text-ink-700">{order.customerName}</td>
                      <td className="px-3 py-3.5 text-xs text-ink-600">
                        {renewal ? (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); navigate('/renewals') }}
                            className="font-medium text-primary-600 hover:text-primary-700"
                          >
                            Renewal — {renewal.medicineName}
                          </button>
                        ) : (
                          <span className="text-ink-500">First order</span>
                        )}
                      </td>
                      <td className="px-3 py-3.5 text-xs text-ink-500">
                        {order.discountType === 'none'
                          ? '—'
                          : order.discountType === 'flat'
                            ? `${formatIndianCurrency(order.discountValue)} off`
                            : `${order.discountValue}% off`}
                      </td>
                      <td className="px-3 py-3.5 font-semibold tabular-nums text-ink-900">
                        {formatIndianCurrency(order.payableAmount)}
                      </td>
                      <td className="px-3 py-3.5">
                        {order.paymentScreenshot ? (
                          <a
                            href={order.paymentScreenshot}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="inline-block rounded border border-ink-200 p-0.5 hover:border-primary-400"
                          >
                            <img
                              src={order.paymentScreenshot}
                              alt={`Payment proof for ${order.orderNumber}`}
                              className="h-8 w-12 rounded-sm object-cover"
                            />
                          </a>
                        ) : (
                          <span className="text-xs text-ink-400">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 bg-ink-50/50">
                <th className="pl-5 pr-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Order #</th>
                <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Customer</th>
                <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Medicines</th>
                <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Total</th>
                <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Payment</th>
                <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Stage</th>
                <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Created</th>
                <th className="px-3 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredOrders.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <EmptyState
                      icon={<Package size={26} />}
                      title="No orders found"
                      description="Try adjusting your search or filters to find what you're looking for."
                    />
                  </td>
                </tr>
              ) : (
                filteredOrders.map((order) => {
                  const firstMed = order.medicines[0]
                  const extraCount = order.medicines.length - 1
                  const nextStage = getNextStage(order.stage)
                  return (
                    <tr key={order.id} className="border-b border-ink-50 last:border-0 hover:bg-primary-50/30 transition-colors">
                      <td className="pl-5 pr-3 py-3.5">
                        <span className="font-mono text-xs font-medium text-ink-900">{order.orderNumber}</span>
                      </td>
                      <td className="px-3 py-3.5 font-medium text-ink-900">{order.customerName}</td>
                      <td className="px-3 py-3.5 text-ink-600">
                        {firstMed ? (
                          <span>
                            {firstMed.name}
                            {extraCount > 0 && (
                              <span className="ml-1 text-xs text-ink-500">+{extraCount} more</span>
                            )}
                          </span>
                        ) : (
                          <span className="text-ink-400">--</span>
                        )}
                      </td>
                      <td className="px-3 py-3.5 whitespace-nowrap">
                        <div className="font-semibold text-ink-900">{formatIndianCurrency(order.payableAmount)}</div>
                        {order.discountType !== 'none' && (
                          <div className="text-[11px] text-ink-400 line-through">{formatIndianCurrency(order.totalAmount)}</div>
                        )}
                      </td>
                      <td className="px-3 py-3.5">
                        <Badge variant={getPaymentBadgeVariant(order.paymentStatus)}>
                          {order.paymentStatus.charAt(0).toUpperCase() + order.paymentStatus.slice(1)}
                        </Badge>
                      </td>
                      <td className="px-3 py-3.5">
                        <OrderStageBadge stage={order.stage} />
                      </td>
                      <td className="px-3 py-3.5 whitespace-nowrap text-xs text-ink-500">
                        {formatIndianDate(order.createdDate)}
                      </td>
                      <td className="px-3 py-3.5">
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            title="View details"
                            onClick={() => openDetail(order)}
                            className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700 transition-colors"
                          >
                            <Eye className="h-4 w-4" />
                          </button>
                          {/* Stages are clicked through by hand, so one clicked too far needs
                              a way back — otherwise a packed order marked shipped is stuck. */}
                          {getPreviousStage(order.stage) && (
                            <button
                              type="button"
                              title="Back to previous stage"
                              aria-label={`Move ${order.orderNumber} back a stage`}
                              onClick={() => handleMoveStage(order, getPreviousStage(order.stage))}
                              className="rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-ink-100 hover:text-ink-700"
                            >
                              <ArrowLeft className="h-4 w-4" />
                            </button>
                          )}
                          {nextStage && (
                            <button
                              type="button"
                              title="Advance to next stage"
                              aria-label={`Advance ${order.orderNumber} a stage`}
                              onClick={() => handleMoveStage(order, nextStage)}
                              className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700 transition-colors"
                            >
                              <ArrowRight className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>
      )}

      {/* Order Detail Modal */}
      <Modal isOpen={detailOpen} onClose={closeDetail} title={`Order ${selectedOrder?.orderNumber ?? ''}`} size="lg">
        {selectedOrder && (
          <div className="space-y-6">
            {/* Customer Info */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <p className="text-xs uppercase tracking-wide text-ink-500">Customer</p>
                <p className="mt-1 text-sm font-medium text-ink-900">{selectedOrder.customerName}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-ink-500">Address</p>
                <p className="mt-1 text-sm text-ink-700">{selectedOrder.address || '--'}</p>
              </div>
            </div>

            {/* Stage Stepper */}
            <div>
              <p className="mb-4 text-xs uppercase tracking-wide text-ink-500">Order Progress</p>
              {/*
               * Six labelled steps do not fit a phone — the w-16 labels alone are wider than
               * the modal, which is what let the whole dialog pan sideways. So the labels are
               * desktop-only; on mobile the circles fit on their own and the current step is
               * named once, below.
               */}
              <div className="flex items-start">
                {STAGES.map((stage, i) => {
                  const currentIdx = STAGE_ORDER.indexOf(selectedOrder.stage)
                  const isCompleted = i < currentIdx
                  const isCurrent = i === currentIdx
                  const isLast = i === STAGES.length - 1
                  const reached = i <= currentIdx
                  const circleClass = isCompleted || (isCurrent && isLast)
                    ? 'bg-primary-500 text-white'
                    : isCurrent
                      ? 'bg-primary-500 text-white ring-4 ring-primary-100'
                      : 'bg-ink-100 text-ink-400'
                  return (
                    <div key={stage.key} className="flex flex-1 items-center last:flex-none">
                      <div className="flex flex-col items-center">
                        <div
                          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors ${circleClass}`}
                        >
                          {isCompleted || (isCurrent && isLast) ? <Check className="h-4 w-4" /> : i + 1}
                        </div>
                        <p
                          className={`mt-1.5 hidden w-16 text-center text-[10px] leading-tight sm:block ${
                            isCurrent ? 'font-bold text-primary-700' : reached ? 'text-primary-600' : 'text-ink-400'
                          }`}
                        >
                          {stage.label}
                        </p>
                      </div>
                      {!isLast && (
                        <div className={`mx-1 h-0.5 flex-1 rounded-full sm:mb-6 ${i < currentIdx ? 'bg-primary-500' : 'bg-ink-200'}`} />
                      )}
                    </div>
                  )
                })}
              </div>
              <p className="mt-3 text-center text-sm font-semibold text-primary-700 sm:hidden">
                {STAGES.find((s) => s.key === selectedOrder.stage)?.label ?? selectedOrder.stage}
              </p>
            </div>

            {/* Medicines */}
            <div>
              <p className="mb-2 text-xs uppercase tracking-wide text-ink-500">Medicines</p>

              {/*
               * Cards on a phone, table on desktop. A four-column table on 375px forced the
               * name to scroll out of view — "Sansamrit" read as "samrit". A card gives the
               * name a full line and puts qty × price beside the subtotal, no sideways scroll.
               */}
              <div className="space-y-2 sm:hidden">
                {selectedOrder.medicines.map((med, i) => (
                  <div key={i} className="flex items-start justify-between gap-3 rounded-xl border border-ink-200 p-3">
                    <div className="min-w-0">
                      <p className="break-words font-medium text-ink-900">{med.name}</p>
                      <p className="mt-0.5 text-xs text-ink-500">
                        {med.quantity} × {formatIndianCurrency(med.price)}
                      </p>
                    </div>
                    <p className="shrink-0 font-semibold text-ink-900">
                      {formatIndianCurrency(med.quantity * med.price)}
                    </p>
                  </div>
                ))}
                <div className="space-y-1.5 rounded-xl border border-ink-200 bg-ink-50/50 p-3 text-sm">
                  <div className="flex justify-between text-ink-600">
                    <span>Subtotal</span>
                    <span className="font-medium text-ink-800">{formatIndianCurrency(selectedOrder.totalAmount)}</span>
                  </div>
                  {selectedOrder.discountType !== 'none' && (
                    <div className="flex justify-between text-danger-600">
                      <span>
                        Discount ({selectedOrder.discountType === 'percentage' ? `${selectedOrder.discountValue}%` : formatIndianCurrency(selectedOrder.discountValue)})
                      </span>
                      <span>-{formatIndianCurrency(selectedOrder.totalAmount - selectedOrder.payableAmount)}</span>
                    </div>
                  )}
                  <div className="flex justify-between border-t border-ink-200 pt-1.5 font-bold text-ink-900">
                    <span>Payable Total</span>
                    <span>{formatIndianCurrency(selectedOrder.payableAmount)}</span>
                  </div>
                </div>
              </div>

              <div className="hidden overflow-x-auto rounded-xl border border-ink-200 sm:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-ink-100 bg-ink-50/50">
                      <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400">Name</th>
                      <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-400">Qty</th>
                      <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-400">Price</th>
                      <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-400">Subtotal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedOrder.medicines.map((med, i) => (
                      <tr key={i} className="border-b border-ink-50 last:border-0">
                        <td className="px-3 py-2.5 font-medium text-ink-900">{med.name}</td>
                        <td className="px-3 py-2.5 text-right text-ink-600">{med.quantity}</td>
                        <td className="px-3 py-2.5 text-right text-ink-600">{formatIndianCurrency(med.price)}</td>
                        <td className="px-3 py-2.5 text-right font-semibold text-ink-900">
                          {formatIndianCurrency(med.quantity * med.price)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-ink-200 bg-ink-50/50">
                      <td colSpan={3} className="px-3 py-2 text-right text-ink-600">
                        Subtotal
                      </td>
                      <td className="px-3 py-2 text-right font-medium text-ink-800">
                        {formatIndianCurrency(selectedOrder.totalAmount)}
                      </td>
                    </tr>
                    {selectedOrder.discountType !== 'none' && (
                      <tr className="bg-ink-50/50">
                        <td colSpan={3} className="px-3 py-2 text-right text-danger-600">
                          Discount ({selectedOrder.discountType === 'percentage' ? `${selectedOrder.discountValue}%` : formatIndianCurrency(selectedOrder.discountValue)})
                        </td>
                        <td className="px-3 py-2 text-right font-medium text-danger-600">
                          -{formatIndianCurrency(selectedOrder.totalAmount - selectedOrder.payableAmount)}
                        </td>
                      </tr>
                    )}
                    <tr className="border-t border-ink-200 bg-ink-50/50">
                      <td colSpan={3} className="px-3 py-2.5 text-right font-medium text-ink-700">
                        Payable Total
                      </td>
                      <td className="px-3 py-2.5 text-right font-bold text-ink-900">
                        {formatIndianCurrency(selectedOrder.payableAmount)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            {/* Discount */}
            <div className="border-t border-ink-200 pt-4">
              <p className="mb-2 text-xs uppercase tracking-wide text-ink-500">Discount</p>
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label className="field-label" htmlFor="orders-type">Type</label>
                  <select
                    id="orders-type"
                    value={discountForm.type}
                    onChange={(e) => setDiscountForm((f) => ({ ...f, type: e.target.value as DiscountType }))}
                    className="field-input w-auto"
                  >
                    {(Object.keys(DISCOUNT_LABEL) as DiscountType[]).map((type) => (
                      <option key={type} value={type}>{DISCOUNT_LABEL[type]}</option>
                    ))}
                  </select>
                </div>
                {discountForm.type !== 'none' && (
                  <div>
                    <label className="field-label" htmlFor="orders-discountform-type-percentage-percent-0-100-amount">{discountForm.type === 'percentage' ? 'Percent (0-100)' : 'Amount (₹)'}</label>
                    <input
                      id="orders-discountform-type-percentage-percent-0-100-amount"
                      type="number"
                      min={0}
                      max={discountForm.type === 'percentage' ? 100 : undefined}
                      step="0.01"
                      value={discountForm.value}
                      onChange={(e) => setDiscountForm((f) => ({ ...f, value: e.target.value }))}
                      className="field-input w-32"
                    />
                  </div>
                )}
                <Button variant="secondary" loading={savingDiscount} onClick={handleApplyDiscount}>
                  Apply Discount
                </Button>
              </div>
            </div>

            {/*
             * Proof of payment. Every conversion and renewal demands one, and until now it was
             * stored and never shown — evidence collected that nobody could look at.
             */}
            <div className="border-t border-ink-200 pt-4">
              <p className="text-sm font-medium text-ink-700">Payment proof</p>
              {selectedOrder.paymentScreenshot ? (
                <a
                  href={selectedOrder.paymentScreenshot}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-block rounded-lg border border-ink-200 p-1 hover:border-primary-400"
                >
                  <img
                    src={selectedOrder.paymentScreenshot}
                    alt={`Payment proof for ${selectedOrder.orderNumber}`}
                    className="h-28 max-w-full rounded-md object-contain"
                  />
                </a>
              ) : (
                <p className="mt-1 text-sm text-ink-400">
                  None on file — this order predates proof being kept per order.
                </p>
              )}
              {sourceRenewal(selectedOrder) && (
                <p className="mt-2 text-sm text-ink-600">
                  Reorder of{' '}
                  <span className="font-medium text-ink-900">{sourceRenewal(selectedOrder)!.medicineName}</span>.{' '}
                  <button
                    type="button"
                    onClick={() => navigate('/renewals')}
                    className="font-medium text-primary-600 hover:text-primary-700"
                  >
                    View renewals
                  </button>
                </p>
              )}
            </div>

            {/* Payment + Advance */}
            <div className="flex flex-col items-start gap-4 border-t border-ink-200 pt-4 sm:flex-row sm:items-center">
              <div className="flex items-center gap-2">
                <label className="text-sm text-ink-600" htmlFor="order-payment-status">Payment:</label>
                <select
                  id="order-payment-status"
                  value={selectedOrder.paymentStatus}
                  onChange={(e) => handlePaymentChange(selectedOrder, e.target.value as PaymentStatus)}
                  className="field-input w-auto"
                >
                  <option value="pending">Pending</option>
                  <option value="partial">Partial</option>
                  <option value="paid">Paid</option>
                  <option value="refunded">Refunded</option>
                </select>
              </div>
              <div className="flex-1" />
              {/* Both directions, so an advance clicked one step too far is undone here rather
                  than leaving the order sitting in a stage it never reached. */}
              {getPreviousStage(selectedOrder.stage) && (
                <Button
                  variant="secondary"
                  icon={<ArrowLeft className="h-4 w-4" />}
                  onClick={() => handleMoveStage(selectedOrder, getPreviousStage(selectedOrder.stage))}
                >
                  Back to {STAGES.find((s) => s.key === getPreviousStage(selectedOrder.stage))?.label}
                </Button>
              )}
              {getNextStage(selectedOrder.stage) && (
                <Button
                  variant="primary"
                  icon={<ArrowRight className="h-4 w-4" />}
                  onClick={() => handleMoveStage(selectedOrder, getNextStage(selectedOrder.stage))}
                >
                  Advance to {STAGES.find((s) => s.key === getNextStage(selectedOrder.stage))?.label}
                </Button>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
