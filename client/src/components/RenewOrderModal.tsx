import { useEffect, useState } from 'react'
import { Upload } from 'lucide-react'
import { useApp } from '@/context/AppContext'
import { renewalsApi } from '@/api/renewals'
import { emitToast } from '@/lib/toast'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
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
  const [quantity, setQuantity] = useState('1')
  const [discountType, setDiscountType] = useState<DiscountType>('none')
  const [discountValue, setDiscountValue] = useState('')
  const [screenshot, setScreenshot] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Reset per renewal, so a quantity typed for one is never carried into the next.
  useEffect(() => {
    setQuantity('1')
    setDiscountType('none')
    setDiscountValue('')
    setScreenshot('')
    setSubmitting(false)
  }, [renewal?.id])

  if (!renewal) return null

  // Priced from the catalogue already in memory rather than a preview round-trip. The server
  // prices it again from the same products when it writes the order, so this is a display
  // figure, never the billed one.
  const product = state.medicines.find(
    m => m.name.toLowerCase() === renewal.medicineName.toLowerCase(),
  )
  const unitPrice = product?.unitPrice ?? 0
  const qty = Number(quantity)
  const qtyInvalid = !Number.isInteger(qty) || qty < 1
  const total = qtyInvalid ? 0 : unitPrice * qty

  const raw = Number(discountValue) || 0
  const discountAmount =
    discountType === 'flat' ? Math.min(raw, total)
    : discountType === 'percentage' ? (total * Math.min(raw, 100)) / 100
    : 0
  const payable = Math.max(total - discountAmount, 0)
  const discountInvalid =
    discountType !== 'none' && (raw < 0 || (discountType === 'percentage' && raw > 100))

  const money = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const canSubmit = !qtyInvalid && !discountInvalid && !!screenshot && !submitting

  async function handleConfirm() {
    if (!renewal || !canSubmit) return
    setSubmitting(true)
    try {
      const result = await renewalsApi.renew(renewal.id, {
        quantity: qty,
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
          <label className="field-label" htmlFor="renew-quantity">Quantity</label>
          <input
            id="renew-quantity"
            type="number"
            min={1}
            value={quantity}
            onChange={e => setQuantity(e.target.value)}
            className="field-input"
          />
          {qtyInvalid && (
            <p className="mt-1.5 text-xs text-danger-600">Enter a whole number of 1 or more.</p>
          )}
        </div>

        <div className="rounded-xl border border-ink-100 bg-ink-50/40 p-3 text-sm">
          <div className="flex justify-between text-ink-600">
            <span>
              {money(unitPrice)} × {qtyInvalid ? '—' : qty}
            </span>
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
          {!product && (
            // Says why rather than showing a free medicine and leaving the user to wonder.
            <p className="mt-2 text-xs text-warning-700">
              {renewal.medicineName} is not in the catalogue, so it has no price.
            </p>
          )}
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
