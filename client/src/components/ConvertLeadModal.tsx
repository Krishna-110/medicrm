import { useEffect, useId, useMemo, useState } from 'react'
import { AlertTriangle, Plus, Trash2, Upload, X } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { SearchableSelect } from '@/components/ui/SearchableSelect'
import { leadsApi, type ConversionPreview, type ConvertPayload } from '@/api/leads'
import { useApp } from '@/context/AppContext'
import { emitToast } from '@/lib/toast'
import type { Lead } from '@/types'

type DiscountType = ConvertPayload['discountType']

/** The tenures sold. One unit per day, so tenure is both the supply period and the quantity. */
const TENURES = [15, 30, 60, 90] as const
const DEFAULT_TENURE = 30

const money = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

type SaleLine = { id: string; name: string; days: number }

let lineSeq = 0
const emptyLine = (): SaleLine => ({ id: `sale-${++lineSeq}`, name: '', days: DEFAULT_TENURE })

/**
 * Composing a sale: which medicines, for how long, what it costs, and proof of payment.
 *
 * The medicines are chosen here rather than on the lead. A lead is a conversation — what the
 * customer ends up buying is settled at the point of sale, with the catalogue and its prices
 * in front of the caller, so asking for it at capture meant guessing.
 *
 * Pricing is computed here from the catalogue already in the store, which is what makes the
 * total move as lines are added. The server re-prices from its own copy before billing, so
 * this figure is a faithful preview rather than the authority.
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
  const { state } = useApp()
  const [preview, setPreview] = useState<ConversionPreview | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [lines, setLines] = useState<SaleLine[]>([emptyLine()])
  const [discountType, setDiscountType] = useState<DiscountType>('none')
  const [discountValue, setDiscountValue] = useState('')
  const [screenshot, setScreenshot] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Reset per lead, so a sale composed for one is never carried into the next.
  useEffect(() => {
    if (!lead) return
    setPreview(null)
    setLoadError(null)
    setLines([emptyLine()])
    setDiscountType('none')
    setDiscountValue('')
    setScreenshot('')

    let cancelled = false
    leadsApi
      .convertPreview(lead.id)
      .then(p => { if (!cancelled) setPreview(p) })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Could not open this lead for conversion')
      })
    return () => { cancelled = true }
  }, [lead])

  const medicineOptions = useMemo(
    () => state.medicines
      .filter(m => m.isActive)
      .map(m => ({ id: m.id, label: m.name, sublabel: money(m.unitPrice) })),
    [state.medicines],
  )

  const setLine = (lineId: string, patch: Partial<SaleLine>) =>
    setLines(rows => rows.map(r => (r.id === lineId ? { ...r, ...patch } : r)))

  /*
   * Each line priced against the catalogue, and checked against the seller's location — the
   * lead's caller's, which the preview named. Stock is per location, so the global total
   * would happily approve a sale the shelf cannot cover.
   */
  const priced = useMemo(() => lines.map(line => {
    const medicine = state.medicines.find(m => m.name.toLowerCase() === line.name.trim().toLowerCase())
    const unitPrice = medicine?.unitPrice ?? 0
    const stock = medicine && preview?.locationName
      ? medicine.locations?.find(l => l.locationName === preview.locationName)?.quantity ?? 0
      : null
    return {
      ...line,
      medicine,
      unitPrice,
      lineTotal: unitPrice * line.days,
      stock,
      covered: stock === null ? false : stock >= line.days,
    }
  }), [lines, state.medicines, preview])

  const chosen = priced.filter(p => p.name.trim())
  const total = chosen.reduce((sum, p) => sum + p.lineTotal, 0)

  const raw = Number(discountValue) || 0
  const discountAmount =
    discountType === 'flat' ? Math.min(raw, total)
    : discountType === 'percentage' ? (total * Math.min(raw, 100)) / 100
    : 0
  const payable = Math.max(total - discountAmount, 0)

  const discountInvalid =
    discountType !== 'none' && (raw < 0 || (discountType === 'percentage' && raw > 100))
  const noLocation = !!preview && preview.locationName === null
  const unknown = chosen.filter(p => !p.medicine)
  const short = noLocation ? [] : chosen.filter(p => p.medicine && !p.covered)
  const canSubmit =
    !!preview && !noLocation && chosen.length > 0 && unknown.length === 0 &&
    !!screenshot && !discountInvalid && short.length === 0 && !submitting

  async function handleConfirm() {
    if (!lead || !canSubmit) return
    setSubmitting(true)
    try {
      onConverted(await leadsApi.convert(lead.id, {
        paymentScreenshot: screenshot,
        items: chosen.map(p => ({ name: p.name.trim(), days: p.days })),
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

        {/* The sale itself. */}
        <div>
          <span className="field-label">Medicines</span>
          <div className="space-y-2">
            {priced.map((line, idx) => (
              <div key={line.id} className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="w-full min-w-0 sm:flex-1">
                  <span className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-ink-400">Medicine</span>
                  <SearchableSelect
                    value={line.name}
                    onChange={name => setLine(line.id, { name })}
                    options={medicineOptions}
                    placeholder="Search medicines..."
                    ariaLabel={`Medicine ${idx + 1}`}
                    emptyText="No medicines found"
                  />
                </div>
                <div className="flex w-full items-stretch gap-2 sm:w-auto">
                  <div className="flex flex-1 flex-col sm:w-24 sm:flex-none">
                    <label className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-ink-400" htmlFor={`${id}-tenure-${line.id}`}>Tenure</label>
                    <select
                      id={`${id}-tenure-${line.id}`}
                      value={line.days}
                      onChange={e => setLine(line.id, { days: Number(e.target.value) })}
                      aria-label={`Tenure for medicine ${idx + 1}`}
                      className="field-input"
                    >
                      {TENURES.map(t => <option key={t} value={t}>{t} days</option>)}
                    </select>
                  </div>
                  {/* Invisible labels keep these level with the two above at every width. */}
                  <div className="flex flex-col">
                    <span aria-hidden className="mb-0.5 block text-[10px] uppercase tracking-wide opacity-0">.</span>
                    <span className="field-input flex min-w-[92px] items-center justify-end border-transparent bg-transparent font-medium text-ink-800">
                      {money(line.lineTotal)}
                    </span>
                  </div>
                  <div className="flex flex-col">
                    <span aria-hidden className="mb-0.5 block text-[10px] uppercase tracking-wide opacity-0">.</span>
                    <button
                      type="button"
                      onClick={() => setLines(rows => (rows.length === 1 ? [emptyLine()] : rows.filter(r => r.id !== line.id)))}
                      aria-label={`Remove medicine ${idx + 1}`}
                      className="field-input flex items-center justify-center border-transparent bg-transparent px-2 text-ink-400 transition-colors hover:text-danger-600"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setLines(rows => [...rows, emptyLine()])}
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700"
          >
            <Plus size={14} /> Add another medicine
          </button>

          {noLocation && (
            <p className="mt-2 flex items-start gap-1.5 text-xs font-medium text-danger-600">
              <AlertTriangle size={14} className="mt-px shrink-0" />
              <span>
                This lead’s caller has no location, so there is nowhere to sell from. An admin
                must assign one before converting.
              </span>
            </p>
          )}
          {unknown.length > 0 && (
            <p className="mt-2 flex items-start gap-1.5 text-xs font-medium text-danger-600">
              <AlertTriangle size={14} className="mt-px shrink-0" />
              <span>Pick {unknown.length === 1 ? 'a medicine' : 'medicines'} from the catalogue — {unknown.map(i => i.name).join(', ')} {unknown.length === 1 ? 'is' : 'are'} not in it.</span>
            </p>
          )}
          {short.length > 0 && (
            <p className="mt-2 flex items-start gap-1.5 text-xs font-medium text-danger-600">
              <AlertTriangle size={14} className="mt-px shrink-0" />
              <span>
                Not enough stock at <span className="font-semibold">{preview?.locationName}</span> for{' '}
                {short.map(i => `${i.name} (${i.stock} left, ${i.days} needed)`).join(', ')}. Ask an
                admin to update the stock before converting.
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
