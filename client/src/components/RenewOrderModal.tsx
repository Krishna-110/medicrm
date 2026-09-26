import { useEffect, useState } from 'react'
import { Minus, Plus, Trash2, Upload } from 'lucide-react'
import { useApp } from '@/context/AppContext'
import { renewalsApi } from '@/api/renewals'
import { emitToast } from '@/lib/toast'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { SearchableSelect } from '@/components/ui/SearchableSelect'
import type { DiscountType, Renewal } from '@/types'
import type { RenewResponse } from '../../../server/src/lib/contract.js'

/**
 * Confirming a renewal, which is a repeat sale: which medicines, for how many days, what it
 * costs, what discount applies, and proof of payment.
 *
 * Renewing used to be a single unconfirmed click that recorded no sale at all. It is by days
 * of supply, not units — the same model as a lead — because the duration is what varies
 * between cycles and what decides when the next renewal falls due.
 */
type Row = { id: string; name: string; days: string; quantity: string }

/** The tenures sold, shared with the conversion dialog. */
const TENURES = [15, 30, 60, 90] as const

/** Whole days between two ISO dates — the supply period the renewal was built on. */
function daysBetween(fromIso: string, toIso: string): number {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime()
  return Math.max(Math.round(ms / 86_400_000), 1)
}

export function RenewOrderModal({
  renewal,
  onClose,
  onRenewed,
}: {
  renewal: Renewal | null
  onClose: () => void
  onRenewed: (result: RenewResponse) => void
}) {
  const { state } = useApp()
  const [rows, setRows] = useState<Row[]>([])
  const [discountType, setDiscountType] = useState<DiscountType>('none')
  const [discountValue, setDiscountValue] = useState('')
  const [paymentMode, setPaymentMode] = useState<'online' | 'offline'>('online')
  const [screenshot, setScreenshot] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Reset per renewal, so lines typed for one are never carried into the next. The renewal's
  // own medicine is the starting point, its Days prefilled from the current cycle's length —
  useEffect(() => {
    const prevDays = renewal ? daysBetween(renewal.orderDate, renewal.renewalDate) : 30
    const defaultDays = (TENURES as readonly number[]).includes(prevDays) && prevDays <= 30 ? String(prevDays) : '30'
    setRows(
      renewal
        ? [{
            id: crypto.randomUUID(),
            name: renewal.medicineName,
            days: defaultDays,
            quantity: '1',
          }]
        : [],
    )
    setDiscountType('none')
    setDiscountValue('')
    setPaymentMode('online')
    setScreenshot('')
    setSubmitting(false)
  }, [renewal?.id, renewal?.medicineName, renewal?.orderDate, renewal?.renewalDate])

  if (!renewal) return null

  // Priced from the catalogue already in memory rather than a preview round-trip. The server
  // prices it again from the same products when it writes the order, so these are display
  // figures, never the billed ones.
  const medicineOptions = state.medicines
    .filter(m => m.isActive)
    .map(m => ({ id: m.id, label: m.name, sublabel: m.genericName }))

  const medicineOf = (name: string) =>
    state.medicines.find(m => m.name.toLowerCase() === name.trim().toLowerCase())

  const lines = rows.map(r => {
    const days = Number(r.days)
    const qtyNum = parseInt(r.quantity, 10)
    const hasValidQty = Number.isInteger(qtyNum) && qtyNum > 0
    const quantity = hasValidQty ? qtyNum : 0
    const invalidDays = !r.name.trim() || !Number.isInteger(days) || days < 1
    const invalidQty = !hasValidQty
    const med = medicineOf(r.name)
    const unitPrice = med?.unitPrice ?? 0
    const stock = med ? med.stockQuantity : null
    const short = stock !== null && !invalidDays && hasValidQty && stock < quantity
    return {
      ...r,
      days,
      quantity,
      hasValidQty,
      invalidDays,
      invalidQty,
      short,
      invalid: invalidDays || invalidQty || short,
      unitPrice,
      stock,
      amount: invalidDays || invalidQty ? 0 : unitPrice * quantity,
    }
  })
  const rowsInvalid = lines.some(l => l.invalidDays || l.invalidQty)
  const short = lines.filter(l => l.short)
  const total = lines.reduce((n, l) => n + l.amount, 0)

  const raw = Number(discountValue) || 0
  const discountAmount =
    discountType === 'flat' ? Math.min(raw, total)
    : discountType === 'percentage' ? (total * Math.min(raw, 100)) / 100
    : 0
  const payable = Math.max(total - discountAmount, 0)
  const discountInvalid =
    discountType !== 'none' && (raw < 0 || (discountType === 'percentage' && raw > 100))

  const money = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const canSubmit =
    rows.length > 0 && !rowsInvalid && short.length === 0 && !discountInvalid && !submitting

  const setRow = (id: string, patch: Partial<Row>) =>
    setRows(rs => rs.map(r => (r.id === id ? { ...r, ...patch } : r)))

  async function handleConfirm() {
    if (!renewal || !canSubmit) return
    setSubmitting(true)
    try {
      const result = await renewalsApi.renew(renewal.id, {
        items: lines.map(l => ({ name: l.name.trim(), days: l.days, quantity: l.quantity })),
        paymentMode,
        // Deliberately blank for a cash sale rather than carrying a stale image across.
        paymentScreenshot: paymentMode === 'offline' ? '' : screenshot,
        discountType,
        discountValue: raw,
      })
      onRenewed(result)
      emitToast(`Renewed — order ${result.order.orderNumber}`, 'success')
      onClose()
    } catch (err) {
      emitToast(err instanceof Error ? err.message : 'Failed to renew')
      setSubmitting(false)
    }
  }

  return (
    <Modal isOpen={!!renewal} onClose={onClose} title="Renew and reorder" size="lg">
      <div className="space-y-4">
        <p className="text-sm text-ink-600">
          Placing a repeat order of{' '}
          <span className="font-semibold text-ink-900">{renewal.medicineName}</span> for{' '}
          <span className="font-semibold text-ink-900">{renewal.customerName}</span>.
        </p>

        <div>
          <span className="field-label" id="renew-items-label">Order</span>
          <div className="space-y-2" role="group" aria-labelledby="renew-items-label">
            {lines.map((line, idx) => (
              <div
                key={line.id}
                className="rounded-xl border border-ink-200/80 bg-ink-50/40 p-3 sm:p-3.5"
              >
                {/* 1. Medicine Name + Trash */}
                <div className="w-full min-w-0">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="block text-[10px] font-medium uppercase tracking-wide text-ink-400">
                      Medicine {rows.length > 1 ? `#${idx + 1}` : ''}
                    </span>
                    <button
                      type="button"
                      onClick={() => setRows(rs => rs.filter(r => r.id !== line.id))}
                      disabled={rows.length === 1}
                      title="Remove line"
                      aria-label={`Remove medicine ${idx + 1}`}
                      className="-mr-1 rounded-lg p-1 text-ink-400 transition-colors hover:bg-danger-50 hover:text-danger-600 disabled:pointer-events-none disabled:opacity-30"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                  <SearchableSelect
                    value={line.name}
                    onChange={name => {
                      const trimmed = name.trim()
                      setRow(line.id, {
                        name,
                        ...(trimmed && line.quantity <= 0 ? { quantity: '1' } : {}),
                        ...(!trimmed ? { quantity: '1' } : {}),
                      })
                    }}
                    options={medicineOptions}
                    placeholder="Search medicines..."
                    ariaLabel={`Medicine ${idx + 1}`}
                    emptyText="No medicines found"
                  />
                </div>

                {/* 2. Quantity (with - and + buttons, default 1) & Line Total */}
                <div className="mt-3 flex items-end justify-between gap-4">
                  <div>
                    <label
                      className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-ink-400"
                      htmlFor={`qty-${line.id}`}
                    >
                      Quantity
                    </label>
                    <div className={`inline-flex items-center rounded-xl border border-ink-200/90 bg-white shadow-sm transition-all ${
                      !line.name.trim() ? 'opacity-40 cursor-not-allowed bg-ink-100/60' : ''
                    }`}>
                      <button
                        type="button"
                        onClick={() => {
                          if (!line.name.trim()) return
                          const current = line.quantity || 1
                          const next = Math.max(1, current - 1)
                          setRow(line.id, { quantity: String(next) })
                        }}
                        disabled={!line.name.trim() || line.quantity <= 1}
                        aria-label={`Decrease quantity for medicine ${idx + 1}`}
                        className="flex h-9 w-9 items-center justify-center rounded-l-xl text-ink-500 transition-colors hover:bg-ink-100 hover:text-ink-900 active:bg-ink-200 disabled:opacity-30 disabled:pointer-events-none"
                      >
                        <Minus size={14} />
                      </button>
                      <input
                        id={`qty-${line.id}`}
                        type="number"
                        min={1}
                        placeholder="1"
                        value={line.quantity > 0 ? line.quantity : '1'}
                        disabled={!line.name.trim()}
                        onChange={e => {
                          if (!line.name.trim()) return
                          const val = e.target.value
                          if (val === '' || /^\d+$/.test(val)) {
                            setRow(line.id, { quantity: val })
                          }
                        }}
                        onFocus={e => e.target.select()}
                        aria-label={`Quantity for medicine ${idx + 1}`}
                        className="h-9 w-14 border-x border-ink-100 bg-transparent text-center text-sm font-semibold text-ink-900 placeholder:text-ink-300 focus:outline-none disabled:cursor-not-allowed [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          if (!line.name.trim()) return
                          const current = line.quantity || 1
                          const next = current + 1
                          setRow(line.id, { quantity: String(next) })
                        }}
                        disabled={!line.name.trim()}
                        aria-label={`Increase quantity for medicine ${idx + 1}`}
                        className="flex h-9 w-9 items-center justify-center rounded-r-xl text-ink-500 transition-colors hover:bg-ink-100 hover:text-ink-900 active:bg-ink-200 disabled:opacity-30 disabled:pointer-events-none"
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                  </div>

                  <div className="text-right">
                    <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-ink-400">
                      Total
                    </span>
                    <div className="flex h-9 items-center justify-end font-semibold text-ink-900 text-sm sm:text-base tabular-nums">
                      {money(line.amount)}
                    </div>
                  </div>
                </div>

                {/* 3. Tenure placed below so everything fits properly */}
                <div className="mt-3">
                  <label
                    className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-ink-400"
                    htmlFor={`tenure-${line.id}`}
                  >
                    Tenure
                  </label>
                  <select
                    id={`tenure-${line.id}`}
                    value={line.days}
                    onChange={e => setRow(line.id, { days: e.target.value })}
                    aria-label={`Tenure for medicine ${idx + 1}`}
                    className="field-input font-medium w-full sm:w-44 px-3"
                  >
                    {!TENURES.some(t => String(t) === String(line.days)) && (
                      <option value={line.days}>{line.days} days</option>
                    )}
                    {TENURES.map(t => (
                      <option key={t} value={String(t)}>
                        {t} days
                      </option>
                    ))}
                  </select>
                </div>

                {line.name.trim() && line.unitPrice === 0 && (
                  <p className="mt-2 text-xs text-warning-700">
                    {line.name} is not in the catalogue, so it has no price.
                  </p>
                )}
                {line.short && (
                  <p className="mt-2 text-xs font-medium text-danger-600">
                    Only {line.stock} of {line.name} in stock, {line.quantity} needed.
                  </p>
                )}
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setRows(rs => [...rs, { id: crypto.randomUUID(), name: '', days: '30', quantity: '1' }])}
            className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-primary-600 hover:text-primary-700"
          >
            <Plus size={15} /> Add another medicine
          </button>
          {short.length > 0 && (
            <p className="mt-2 text-xs font-medium text-danger-600">
              Not enough stock. Ask an admin to update it before renewing.
            </p>
          )}
        </div>

        <div className="rounded-xl border border-ink-100 bg-ink-50/40 p-3 text-sm">
          <div className="flex justify-between text-ink-600">
            <span>Subtotal</span>
            <span>{money(total)}</span>
          </div>
          {discountAmount > 0 && (
            <div className="mt-1 flex justify-between text-ink-600">
              <span>Discount</span>
              <span>− {money(discountAmount)}</span>
            </div>
          )}
          <div className="mt-2 flex justify-between border-t border-ink-100 pt-2 font-semibold text-ink-900">
            <span>Payable</span>
            <span>{money(payable)}</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="field-label" htmlFor="renew-discount-type">Discount</label>
            <select
              id="renew-discount-type"
              value={discountType}
              onChange={e => setDiscountType(e.target.value as DiscountType)}
              className="field-input"
            >
              <option value="none">None</option>
              <option value="flat">Flat (₹)</option>
              <option value="percentage">Percentage (%)</option>
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="renew-discount-value">Value</label>
            <input
              id="renew-discount-value"
              type="number"
              min={0}
              disabled={discountType === 'none'}
              value={discountValue}
              onChange={e => setDiscountValue(e.target.value)}
              className="field-input disabled:bg-ink-50 disabled:text-ink-400"
            />
          </div>
        </div>
        {discountInvalid && (
          <p className="text-xs text-danger-600">
            {discountType === 'percentage' ? 'A percentage discount cannot exceed 100.' : 'Discount cannot be negative.'}
          </p>
        )}

        {/* Same rule as a first sale: only a transfer has a screenshot to give. */}
        <div>
          <span className="field-label">Payment mode</span>
          <div className="grid grid-cols-2 gap-2">
            {([
              { value: 'online', label: 'Online', hint: 'Bank transfer or UPI' },
              { value: 'offline', label: 'Offline', hint: 'Cash or card in person' },
            ] as const).map(opt => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setPaymentMode(opt.value)}
                aria-pressed={paymentMode === opt.value}
                className={`rounded-xl border px-3 py-2 text-left transition-colors ${
                  paymentMode === opt.value
                    ? 'border-primary-500 bg-primary-50 text-primary-800'
                    : 'border-ink-200 text-ink-600 hover:bg-ink-50'
                }`}
              >
                <span className="block text-sm font-medium">{opt.label}</span>
                <span className="block text-[11px] text-ink-500">{opt.hint}</span>
              </button>
            ))}
          </div>
        </div>

        {paymentMode === 'online' && (
        <div>
          <label className="field-label" htmlFor="renew-screenshot">
            Payment Screenshot <span className="text-ink-400">(optional)</span>
          </label>
          <input
            id="renew-screenshot"
            type="file"
            accept="image/*"
            onChange={e => {
              const file = e.target.files?.[0]
              if (!file) return
              if (file.size > 5 * 1024 * 1024) {
                emitToast('Image size should be under 5MB')
                return
              }
              const reader = new FileReader()
              reader.onloadend = () => setScreenshot(reader.result as string)
              reader.readAsDataURL(file)
            }}
            className="field-input py-1.5 text-xs text-ink-600 file:mr-3 file:rounded-lg file:border-0 file:bg-primary-50 file:px-3 file:py-1 file:text-xs file:font-semibold file:text-primary-700 hover:file:bg-primary-100"
          />
          {!screenshot && (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-ink-400">
              <Upload size={12} /> Attach one if you have it — the order records as paid either way.
            </p>
          )}
        </div>
        )}

        <div className="flex justify-end gap-3 border-t border-ink-100 pt-3">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" variant="success" disabled={!canSubmit} onClick={handleConfirm}>
            {submitting ? 'Renewing…' : `Renew — ${money(payable)}`}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
