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
 * Confirming a renewal, which is a repeat sale: which medicines, for how many days, what it
 * costs, what discount applies, and proof of payment.
 *
 * Renewing used to be a single unconfirmed click that recorded no sale at all. It is by days
 * of supply, not units — the same model as a lead — because the duration is what varies
 * between cycles and what decides when the next renewal falls due.
 */
type Row = { id: string; name: string; days: string }

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
  // everything else is added deliberately.
  useEffect(() => {
    setRows(
      renewal
        ? [{
            id: crypto.randomUUID(),
            name: renewal.medicineName,
            days: String(daysBetween(renewal.orderDate, renewal.renewalDate)),
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
    const invalidDays = !r.name.trim() || !Number.isInteger(days) || days < 1
    const med = medicineOf(r.name)
    const unitPrice = med?.unitPrice ?? 0
    // One unit per day of supply: days is the quantity, so the line bills days × unit price
    // and needs `days` units in stock. A catalogue medicine without the stock blocks the sale.
    const stock = med ? med.stockQuantity : null
    const short = stock !== null && !invalidDays && stock < days
    return { ...r, days, invalidDays, short, invalid: invalidDays || short, unitPrice, stock, amount: invalidDays ? 0 : unitPrice * days }
  })
  const rowsInvalid = lines.some(l => l.invalidDays)
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
        items: lines.map(l => ({ name: l.name.trim(), days: l.days })),
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
              <div key={line.id} className="flex flex-wrap items-end gap-2">
                {/*
                 * Medicine and Days both carry a label so their inputs sit on the same line —
                 * without one, the labelled Days box dropped below the label-less picker. The
                 * row bottom-aligns, so the price and remove control line up with the inputs.
                 *
                 * Days, not quantity: a reorder is sold by supply duration, the same model as a
                 * lead. The price is the medicine's, once, regardless of days.
                 */}
                <div className="w-full min-w-0 sm:flex-1">
                  <label className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-ink-400">Medicine</label>
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
                 * Each trailing column carries a label — a real one for Days, an invisible
                 * spacer for the price and the remove button — so every control starts on the
                 * same line under an equal-height label. The price and remove button reuse the
                 * field-input box (transparent) so their height matches the input at every
                 * breakpoint; the input is taller on phones, which a fixed padding could not
                 * have tracked.
                 */}
                <div className="flex w-full items-stretch gap-2 sm:w-auto">
                  <div className="flex flex-1 flex-col sm:w-24 sm:flex-none sm:grow-0">
                    <label className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-ink-400" htmlFor={`tenure-${line.id}`}>Tenure</label>
                    {/* The same bundles the conversion dialog sells, so a reorder cannot run
                        for a period the business does not offer. A cycle carried over from an
                        older free-typed value stays selectable until it is changed. */}
                    <select
                      id={`tenure-${line.id}`}
                      value={line.days}
                      onChange={e => setRow(line.id, { days: e.target.value })}
                      aria-label={`Tenure for medicine ${idx + 1}`}
                      className="field-input"
                    >
                      {!TENURES.some(t => t === line.days) && (
                        <option value={line.days}>{line.days} days</option>
                      )}
                      {TENURES.map(t => <option key={t} value={String(t)}>{t} days</option>)}
                    </select>
                  </div>
                  <div className="flex w-24 flex-col">
                    <span aria-hidden className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-transparent">₹</span>
                    <div className="flex flex-1 items-center justify-end text-sm tabular-nums text-ink-600">
                      {money(line.amount)}
                    </div>
                  </div>
                  <div className="flex flex-col">
                    <span aria-hidden className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-transparent">·</span>
                    <button
                      type="button"
                      onClick={() => setRows(rs => rs.filter(r => r.id !== line.id))}
                      disabled={rows.length === 1}
                      title="Remove line"
                      aria-label={`Remove medicine ${idx + 1}`}
                      className="flex flex-1 items-center justify-center rounded-lg px-2.5 text-ink-400 transition-colors hover:bg-danger-50 hover:text-danger-600 disabled:pointer-events-none disabled:opacity-30"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
                {line.name.trim() && line.unitPrice === 0 && (
                  // Says why rather than showing a free medicine and leaving the user to wonder.
                  <p className="w-full text-xs text-warning-700">
                    {line.name} is not in the catalogue, so it has no price.
                  </p>
                )}
                {line.short && (
                  <p className="w-full text-xs font-medium text-danger-600">
                    Only {line.stock} of {line.name} in stock, {line.days} needed.
                  </p>
                )}
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setRows(rs => [...rs, { id: crypto.randomUUID(), name: '', days: '30' }])}
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
