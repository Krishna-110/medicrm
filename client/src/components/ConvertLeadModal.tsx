import { useEffect, useId, useState } from 'react'
import { AlertTriangle, Upload, X } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { leadsApi, type ConversionPreview, type ConvertPayload } from '@/api/leads'
import { emitToast } from '@/lib/toast'
import type { Lead } from '@/types'

type DiscountType = ConvertPayload['discountType']

const money = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/**
 * Confirming a conversion: what it will cost, what discount applies, and proof of payment.
 *
 * Shared by the leads list and the lead detail page. Both used to open their own one-line
 * "are you sure?" dialog, so a rule added to one would have silently missed the other.
 *
 * Prices are read-only and come from the server's own quote rather than being recomputed
 * here — the figure shown is produced by the code that goes on to bill it.
 */
export function ConvertLeadModal({
  lead,
  onClose,
  onConverted,
}: {
  lead: Lead | null
  onClose: () => void
  onConverted: (result: Awaited<ReturnType<typeof leadsApi.convert>>) => void
}) {
  const id = useId()
  const [preview, setPreview] = useState<ConversionPreview | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [discountType, setDiscountType] = useState<DiscountType>('none')
  const [discountValue, setDiscountValue] = useState('')
  const [screenshot, setScreenshot] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Reset per lead, so a discount typed for one is never carried into the next.
  useEffect(() => {
    if (!lead) return
    setPreview(null)
    setLoadError(null)
    setDiscountType('none')
    setDiscountValue('')
    setScreenshot('')

    let cancelled = false
    leadsApi
      .convertPreview(lead.id)
      .then(p => { if (!cancelled) setPreview(p) })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Could not price this lead')
      })
    return () => { cancelled = true }
  }, [lead])

  const raw = Number(discountValue) || 0
  const total = preview?.totalAmount ?? 0
  const discountAmount =
    discountType === 'flat' ? Math.min(raw, total)
    : discountType === 'percentage' ? (total * Math.min(raw, 100)) / 100
    : 0
  const payable = Math.max(total - discountAmount, 0)

  const discountInvalid =
    discountType !== 'none' && (raw < 0 || (discountType === 'percentage' && raw > 100))
  // Keyed on the price, not on catalogue membership: a medicine can be in the catalogue and
  // still have no unit price set, which bills exactly as badly as one that is missing.
  const unpriced = preview?.items.filter(i => i.lineTotal === 0) ?? []
  const notListed = unpriced.filter(i => !i.inCatalogue)
  const canSubmit = !!preview && !!screenshot && !discountInvalid && !submitting

  async function handleConfirm() {
    if (!lead || !canSubmit) return
    setSubmitting(true)
    try {
      onConverted(await leadsApi.convert(lead.id, {
        paymentScreenshot: screenshot,
        discountType,
        discountValue: discountType === 'none' ? 0 : raw,
      }))
    } catch (err) {
      emitToast(err instanceof Error ? err.message : 'Failed to convert lead')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal isOpen={!!lead} onClose={onClose} title="Convert Lead to Order" size="md">
      <div className="space-y-5">
        <p className="text-sm text-ink-600">
          Converting <span className="font-semibold text-ink-900">{lead?.customerName}</span> creates
          an order, deducts stock and closes the lead.
        </p>

        {loadError && (
          <p className="rounded-lg bg-danger-50 px-3 py-2 text-sm text-danger-700">{loadError}</p>
        )}

        {/* Order lines — priced by the catalogue, not editable here. */}
        <div>
          <span className="field-label">Order summary</span>
          <div className="overflow-hidden rounded-xl border border-ink-100">
            {!preview && !loadError && (
              <p className="px-3 py-4 text-center text-sm text-ink-400">Pricing…</p>
            )}
            {preview?.items.map((item, i) => (
              <div
                key={`${item.name}-${i}`}
                className="flex items-start justify-between gap-3 border-b border-ink-100 px-3 py-2.5 last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink-800">{item.name}</p>
                  <p className="text-xs text-ink-400">
                    {item.quantity} × {money(item.unitPrice)}
                    {!item.inCatalogue && ' · not in catalogue'}
                  </p>
                </div>
                <span className="shrink-0 text-sm font-medium text-ink-800">{money(item.lineTotal)}</span>
              </div>
            ))}
          </div>
          {unpriced.length > 0 && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-warning-700">
              <AlertTriangle size={14} className="mt-px shrink-0" />
              <span>
                {unpriced.length === 1 ? 'One medicine has' : `${unpriced.length} medicines have`} no
                price, so this order will bill{' '}
                {unpriced.length === preview?.items.length ? 'nothing' : 'less than expected'}.
                {notListed.length > 0
                  ? ` Not in the catalogue: ${notListed.map(i => i.name).join(', ')}.`
                  : ' Set a unit price under Stock.'}
              </span>
            </p>
          )}
        </div>

        {/* Discount */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="field-label" htmlFor={`${id}-discount-type`}>Discount</label>
            <select
              id={`${id}-discount-type`}
              className="field-input"
              value={discountType}
              onChange={e => setDiscountType(e.target.value as DiscountType)}
            >
              <option value="none">No discount</option>
              <option value="flat">Flat (₹)</option>
              <option value="percentage">Percentage (%)</option>
            </select>
          </div>
          {discountType !== 'none' && (
            <div>
              <label className="field-label" htmlFor={`${id}-discount-value`}>
                {discountType === 'flat' ? 'Amount (₹)' : 'Percent (%)'}
              </label>
              <input
                id={`${id}-discount-value`}
                type="number"
                min={0}
                max={discountType === 'percentage' ? 100 : undefined}
                step="0.01"
                className="field-input"
                value={discountValue}
                onChange={e => setDiscountValue(e.target.value)}
                placeholder="0"
              />
            </div>
          )}
        </div>

        {/* Totals */}
        <div className="space-y-1.5 rounded-xl bg-ink-50 px-3.5 py-3 text-sm">
          <div className="flex justify-between text-ink-600">
            <span>Total</span><span>{money(total)}</span>
          </div>
          {discountAmount > 0 && (
            <div className="flex justify-between text-success-700">
              <span>Discount</span><span>− {money(discountAmount)}</span>
            </div>
          )}
          <div className="flex justify-between border-t border-ink-200 pt-1.5 text-base font-semibold text-ink-900">
            <span>Payable</span><span>{money(payable)}</span>
          </div>
        </div>

        {/* Payment proof — the conversion is refused without it, server-side too. */}
        <div>
          <label className="field-label" htmlFor={`${id}-screenshot`}>
            Payment Screenshot <span className="text-danger-500">*</span>
          </label>
          {screenshot ? (
            <div className="flex items-center gap-3 rounded-xl border border-ink-100 p-2">
              <img src={screenshot} alt="Payment screenshot preview" className="h-16 w-16 rounded-lg object-cover" />
              <span className="flex-1 text-sm text-ink-600">Attached</span>
              <button
                type="button"
                onClick={() => setScreenshot('')}
                aria-label="Remove payment screenshot"
                className="rounded-lg p-2 text-ink-400 transition-colors hover:bg-danger-50 hover:text-danger-600"
              >
                <X size={16} />
              </button>
            </div>
          ) : (
            <input
              id={`${id}-screenshot`}
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
          )}
          {!screenshot && (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-ink-400">
              <Upload size={12} /> Required — the order is recorded as paid.
            </p>
          )}
        </div>

        <div className="flex flex-col-reverse gap-3 border-t border-ink-100 pt-3 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="success" onClick={handleConfirm} disabled={!canSubmit}>
            {submitting ? 'Converting…' : `Confirm — ${money(payable)}`}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
