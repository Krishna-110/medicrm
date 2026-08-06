import { useEffect, useState } from 'react'
import { Plus, Trash2, Upload } from 'lucide-react'
import { useApp } from '@/context/AppContext'
import { renewalsApi } from '@/api/renewals'
import { emitToast } from '@/lib/toast'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { SearchableSelect } from '@/components/ui/SearchableSelect'
import type { DiscountType, Renewal } from '@/types'
import type { RenewResponse } from '../../../server/src/lib/contract.js'

/**
 * Confirming a renewal, which is a repeat sale: how much of the medicine, what it costs,
 * what discount applies, and proof of payment.
 *
 * Renewing used to be a single unconfirmed click that recorded no sale at all. The quantity
 * lives here because it is the one thing that genuinely varies between cycles — a customer
 * reordering three months at once is the normal case this had no way to express.
 */
type Row = { id: string; name: string; quantity: string; days: string }

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
  const [screenshot, setScreenshot] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Reset per renewal, so lines typed for one are never carried into the next. The renewal's
  // own medicine is the starting point, its Days prefilled from the current cycle's length —
  // everything else is added deliberately.
  useEffect(() => {
    setRows(
      renewal
        ? [{
            id: crypto.randomUUID(),
            name: renewal.medicineName,
            quantity: '1',
            days: String(daysBetween(renewal.orderDate, renewal.renewalDate)),
          }]
        : [],
    )
    setDiscountType('none')
    setDiscountValue('')
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

  const priceOf = (name: string) =>
    state.medicines.find(m => m.name.toLowerCase() === name.trim().toLowerCase())?.unitPrice ?? 0

  const lines = rows.map(r => {
    const qty = Number(r.quantity)
    const days = Number(r.days)
    const invalid =
      !r.name.trim() ||
      !Number.isInteger(qty) || qty < 1 ||
      !Number.isInteger(days) || days < 1
    const unitPrice = priceOf(r.name)
    return { ...r, qty, days, invalid, unitPrice, amount: invalid ? 0 : unitPrice * qty }
  })
  const rowsInvalid = lines.some(l => l.invalid)
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
  const canSubmit = rows.length > 0 && !rowsInvalid && !discountInvalid && !!screenshot && !submitting

  const setRow = (id: string, patch: Partial<Row>) =>
    setRows(rs => rs.map(r => (r.id === id ? { ...r, ...patch } : r)))

  async function handleConfirm() {
    if (!renewal || !canSubmit) return
    setSubmitting(true)
    try {
      const result = await renewalsApi.renew(renewal.id, {
        items: lines.map(l => ({ name: l.name.trim(), quantity: l.qty, days: l.days })),
        paymentScreenshot: screenshot,
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
    <Modal isOpen={!!renewal} onClose={onClose} title="Renew and reorder" size="sm">
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
              <div key={line.id} className="flex flex-wrap items-start gap-2">
                {/* Same picker the lead form uses, so an added medicine links to the catalogue
                    by the same name match the server will apply. */}
                <div className="w-full min-w-0 sm:flex-1">
                  <SearchableSelect
                    value={line.name}
                    onChange={name => setRow(line.id, { name })}
                    options={medicineOptions}
                    placeholder="Search medicines..."
                    ariaLabel={`Medicine ${idx + 1}`}
                    emptyText="No medicines found"
                  />
                </div>
                {/*
                 * Qty and Days are labelled because they were the whole confusion: one box of
                 * numbers read as "days" when it billed quantity. Qty is units sold; Days is
                 * how long the supply lasts, which sets when the next renewal falls due.
                 */}
                <div className="flex w-full items-end gap-2 sm:w-auto">
                  <div className="flex-1 sm:w-16 sm:flex-none">
                    <label className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-ink-400">Qty</label>
                    <input
                      type="number"
                      min={1}
                      value={line.quantity}
                      onChange={e => setRow(line.id, { quantity: e.target.value })}
                      aria-label={`Quantity for medicine ${idx + 1}`}
                      className="field-input"
                    />
                  </div>
                  <div className="flex-1 sm:w-16 sm:flex-none">
                    <label className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-ink-400">Days</label>
                    <input
                      type="number"
                      min={1}
                      value={line.days}
                      onChange={e => setRow(line.id, { days: e.target.value })}
                      aria-label={`Days of supply for medicine ${idx + 1}`}
                      className="field-input"
                    />
                  </div>
                  <span className="w-20 pb-2 text-right text-sm tabular-nums text-ink-600">
                    {money(line.amount)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setRows(rs => rs.filter(r => r.id !== line.id))}
                    disabled={rows.length === 1}
                    title="Remove line"
                    aria-label={`Remove medicine ${idx + 1}`}
                    className="mb-0.5 shrink-0 rounded-lg p-2.5 text-ink-400 transition-colors hover:bg-danger-50 hover:text-danger-600 disabled:pointer-events-none disabled:opacity-30 sm:p-2"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
                {line.name.trim() && line.unitPrice === 0 && (
                  // Says why rather than showing a free medicine and leaving the user to wonder.
                  <p className="w-full text-xs text-warning-700">
                    {line.name} is not in the catalogue, so it has no price.
                  </p>
                )}
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setRows(rs => [...rs, { id: crypto.randomUUID(), name: '', quantity: '1', days: '30' }])}
            className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-primary-600 hover:text-primary-700"
          >
            <Plus size={15} /> Add another medicine
          </button>
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

        <div>
          <label className="field-label" htmlFor="renew-screenshot">
            Payment Screenshot <span className="text-danger-500">*</span>
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
              <Upload size={12} /> Required — the order is recorded as paid.
            </p>
          )}
        </div>

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
