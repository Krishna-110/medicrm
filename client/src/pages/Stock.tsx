import { Fragment, useState } from 'react'
import { useApp } from '@/context/AppContext'
import { medicinesApi } from '@/api/medicines'
import { locationsApi } from '@/api/locations'
import { emitToast } from '@/lib/toast'
import type { Medicine, DosageForm } from '@/types'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { SearchInput } from '@/components/ui/SearchInput'
import { PageHeader } from '@/components/ui/PageHeader'
import { EmptyState } from '@/components/ui/EmptyState'
import { Plus, Edit2, Trash2, Package, ChevronDown, ChevronRight } from 'lucide-react'

const dosageFormOptions: { value: DosageForm; label: string }[] = [
  { value: 'tablet', label: 'Tablet' },
  { value: 'capsule', label: 'Capsule' },
  { value: 'syrup', label: 'Syrup' },
  { value: 'injection', label: 'Injection' },
  { value: 'other', label: 'Other' },
]

const dosageFormLabel: Record<DosageForm, string> = {
  tablet: 'Tablet',
  capsule: 'Capsule',
  syrup: 'Syrup',
  injection: 'Injection',
  other: 'Other',
}

const LOW_STOCK_THRESHOLD = 10

function formatPrice(price: number) {
  return `₹${price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function stockBadgeVariant(stock: number): 'danger' | 'warning' | 'success' {
  if (stock <= 0) return 'danger'
  if (stock < LOW_STOCK_THRESHOLD) return 'warning'
  return 'success'
}

type MedicineForm = {
  name: string
  genericName: string
  dosageForm: DosageForm
  unitPrice: string
  openingStock: string
  /** Units to add to stock, edited alongside the catalogue fields. Blank leaves stock alone. */
  addStock: string
  /** The location the added stock (or opening stock) lands at. */
  locationId: string
}

const emptyForm: MedicineForm = {
  name: '',
  genericName: '',
  dosageForm: 'tablet',
  unitPrice: '',
  openingStock: '0',
  addStock: '',
  locationId: '',
}

export function Stock() {
  const { state, dispatch } = useApp()
  const [search, setSearch] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [editingMedicine, setEditingMedicine] = useState<Medicine | null>(null)
  const [form, setForm] = useState<MedicineForm>(emptyForm)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [newLocation, setNewLocation] = useState('')
  const [addingLocation, setAddingLocation] = useState(false) // showing the "new location" input
  const [savingLocation, setSavingLocation] = useState(false) // create request in flight

  // Default a stock target to the first location, so the picker is never blank when one exists.
  const defaultLocationId = state.locations[0]?.id ?? ''

  const filtered = state.medicines.filter(
    m =>
      m.name.toLowerCase().includes(search.toLowerCase()) ||
      (m.genericName ?? '').toLowerCase().includes(search.toLowerCase()),
  )

  const activeCount = state.medicines.filter(m => m.isActive).length
  const lowStockCount = state.medicines.filter(m => m.stockQuantity < LOW_STOCK_THRESHOLD).length

  function openCreate() {
    setEditingMedicine(null)
    setForm({ ...emptyForm, locationId: defaultLocationId })
    setNewLocation('')
    setAddingLocation(false)
    setShowModal(true)
  }

  function openEdit(medicine: Medicine) {
    setEditingMedicine(medicine)
    setForm({
      name: medicine.name,
      genericName: medicine.genericName ?? '',
      dosageForm: medicine.dosageForm ?? 'tablet',
      unitPrice: String(medicine.unitPrice),
      openingStock: String(medicine.stockQuantity),
      addStock: '',
      locationId: defaultLocationId,
    })
    setNewLocation('')
    setAddingLocation(false)
    setShowModal(true)
  }

  async function handleCreateLocation() {
    const name = newLocation.trim()
    if (!name) return
    setSavingLocation(true)
    try {
      const location = await locationsApi.create(name)
      dispatch({ type: 'ADD_LOCATION', payload: { location } })
      setForm(f => ({ ...f, locationId: location.id })) // select the one just made
      setNewLocation('')
      setAddingLocation(false)
      emitToast(`Location "${location.name}" added`, 'success')
    } catch (err) {
      emitToast(err instanceof Error ? err.message : 'Failed to add location')
    } finally {
      setSavingLocation(false)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const updates = {
      name: form.name,
      genericName: form.genericName || undefined,
      dosageForm: form.dosageForm,
      unitPrice: Number(form.unitPrice) || 0,
    }
    // Adding stock is only ever an increment now — the "set exact amount" mode is gone. Blank
    // leaves stock untouched.
    const toAdd = Number(form.addStock)
    if (form.addStock.trim() && (!Number.isInteger(toAdd) || toAdd <= 0)) {
      emitToast('Units to add must be a whole number greater than 0')
      return
    }
    try {
      if (editingMedicine) {
        let medicine = await medicinesApi.update(editingMedicine.id, updates)
        if (toAdd > 0) medicine = await medicinesApi.adjustStock(editingMedicine.id, 'add', toAdd, form.locationId || undefined)
        dispatch({ type: 'UPDATE_MEDICINE', payload: { id: medicine.id, updates: medicine } })
      } else {
        const medicine = await medicinesApi.create({ ...updates, stockQuantity: Number(form.openingStock) || 0, locationId: form.locationId || undefined })
        dispatch({ type: 'ADD_MEDICINE', payload: { medicine } })
      }
      setShowModal(false)
    } catch (err) {
      emitToast(err instanceof Error ? err.message : 'Failed to save medicine')
    }
  }

  async function toggleStatus(medicine: Medicine) {
    try {
      const updated = await medicinesApi.update(medicine.id, { isActive: !medicine.isActive })
      dispatch({ type: 'UPDATE_MEDICINE', payload: { id: updated.id, updates: updated } })
    } catch (err) {
      emitToast(err instanceof Error ? err.message : 'Failed to update medicine status')
    }
  }

  async function deleteMedicine(id: string) {
    try {
      await medicinesApi.remove(id)
      dispatch({ type: 'DELETE_MEDICINE', payload: { id } })
    } catch (err) {
      emitToast(err instanceof Error ? err.message : 'Failed to delete medicine')
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Stock"
        description={`${state.medicines.length} items · ${activeCount} active · ${lowStockCount} low on stock`}
        actions={<Button icon={<Plus size={16} />} onClick={openCreate}>Add Medicine</Button>}
      />

      <SearchInput value={search} onChange={setSearch} ariaLabel="Filter medicines" placeholder="Search by medicine or generic name..." className="max-w-md" />

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 bg-ink-50/50">
                {['Medicine', 'Generic Name', 'Dosage Form', 'Unit Price', 'Stock', 'Status', ''].map((h, i) => (
                  <th key={i} className={`py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-400 ${i === 0 ? 'pl-5 pr-3' : 'px-3'}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(medicine => {
                const expanded = expandedId === medicine.id
                const breakdown = medicine.locations ?? []
                return (
                <Fragment key={medicine.id}>
                <tr className="border-b border-ink-50 transition-colors last:border-0 hover:bg-primary-50/30">
                  <td className="py-3 pl-5 pr-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-teal-500 to-teal-600 text-white">
                        <Package size={16} />
                      </div>
                      <div className="font-medium text-ink-900">{medicine.name}</div>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-ink-600">{medicine.genericName || '-'}</td>
                  <td className="px-3 py-3">
                    <Badge variant="default">{medicine.dosageForm ? dosageFormLabel[medicine.dosageForm] : '-'}</Badge>
                  </td>
                  <td className="px-3 py-3 font-medium text-ink-900">{formatPrice(medicine.unitPrice)}</td>
                  <td className="px-3 py-3">
                    {/* Total across locations; tap to reveal the per-location split. */}
                    <button
                      onClick={() => setExpandedId(expanded ? null : medicine.id)}
                      title="Show location breakdown"
                      className="flex items-center gap-1 rounded-lg p-0.5 transition-colors hover:bg-ink-100"
                    >
                      {expanded ? <ChevronDown size={14} className="text-ink-400" /> : <ChevronRight size={14} className="text-ink-400" />}
                      <Badge variant={stockBadgeVariant(medicine.stockQuantity)} dot>
                        {medicine.stockQuantity} units
                      </Badge>
                    </button>
                  </td>
                  <td className="px-3 py-3">
                    <button onClick={() => toggleStatus(medicine)} title="Toggle status">
                      <Badge variant={medicine.isActive ? 'success' : 'default'} dot>
                        {medicine.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </button>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-1">
                      <button onClick={() => openEdit(medicine)} title="Edit medicine" className="rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-ink-100 hover:text-ink-700"><Edit2 size={15} /></button>
                      <button onClick={() => deleteMedicine(medicine.id)} title="Delete medicine" className="rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-danger-50 hover:text-danger-600"><Trash2 size={15} /></button>
                    </div>
                  </td>
                </tr>
                {expanded && (
                  <tr className="border-b border-ink-50 bg-ink-50/40">
                    <td colSpan={7} className="px-5 py-3">
                      {breakdown.length === 0 ? (
                        <span className="text-xs text-ink-400">No location breakdown for this item.</span>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {breakdown.map(loc => (
                            <span key={loc.locationId} className="inline-flex items-center gap-1.5 rounded-lg bg-white px-2.5 py-1 text-xs text-ink-600 ring-1 ring-ink-100">
                              {loc.locationName}
                              <strong className="font-semibold text-ink-900">{loc.quantity}</strong>
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                )}
                </Fragment>
                )
              })}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <EmptyState icon={<Package size={26} />} title="No medicines found" description="Try adjusting your search or add a new medicine to the catalog." />
          )}
        </div>
      </Card>

      <Modal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        title={editingMedicine ? 'Edit Medicine' : 'Add Medicine'}
        description={editingMedicine ? 'Update this medicine’s catalog details.' : 'Add a new medicine to the catalog.'}
        size="md"
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="field-label" htmlFor="stock-medicine-name">Medicine Name</label>
            <input
               id="stock-medicine-name" type="text" required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="field-input" placeholder="e.g. Metformin 500mg" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="field-label" htmlFor="stock-generic-name">Generic Name</label>
              <input
                 id="stock-generic-name" type="text" value={form.genericName} onChange={e => setForm(f => ({ ...f, genericName: e.target.value }))} className="field-input" placeholder="e.g. Metformin" />
            </div>
            <div>
              <label className="field-label" htmlFor="stock-dosage-form">Dosage Form</label>
              <select
                 id="stock-dosage-form" value={form.dosageForm} onChange={e => setForm(f => ({ ...f, dosageForm: e.target.value as DosageForm }))} className="field-input">
                {dosageFormOptions.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="field-label" htmlFor="stock-unit-price">Unit Price (₹)</label>
              <input
                 id="stock-unit-price" type="number" min={0} step="0.01" required value={form.unitPrice} onChange={e => setForm(f => ({ ...f, unitPrice: e.target.value }))} className="field-input" placeholder="0.00" />
            </div>
            {!editingMedicine && (
              <div>
                <label className="field-label" htmlFor="stock-opening-stock">Opening Stock</label>
                <input
                   id="stock-opening-stock" type="number" min={0} step="1" value={form.openingStock} onChange={e => setForm(f => ({ ...f, openingStock: e.target.value }))} className="field-input" placeholder="0" />
              </div>
            )}
          </div>
          {/*
            * Stock lives here now, add-only: the standalone Adjust Stock dialog and its
            * set-exact-amount mode are gone. Shows the current count, and a blank box to add
            * to it — a restock is always "received N more", never "the number is now N".
            */}
          {editingMedicine && (
            <div className="border-t border-ink-100 pt-4">
              <label className="field-label" htmlFor="stock-add">
                Add stock <span className="font-normal text-ink-400">· {editingMedicine.stockQuantity} in stock</span>
              </label>
              <input
                id="stock-add"
                type="number"
                min={1}
                step="1"
                value={form.addStock}
                onChange={e => setForm(f => ({ ...f, addStock: e.target.value }))}
                className="field-input"
                placeholder="Units received — leave blank to keep the current count"
              />
            </div>
          )}
          {/* Which location the stock lands at — opening stock on create, received units on edit. */}
          <div>
            <label className="field-label" htmlFor="stock-location">
              {editingMedicine ? 'Add stock to location' : 'Opening stock location'}
            </label>
            {addingLocation || state.locations.length === 0 ? (
              <div className="flex gap-2">
                <input
                  id="stock-new-location"
                  type="text"
                  value={newLocation}
                  onChange={e => setNewLocation(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleCreateLocation() } }}
                  className="field-input"
                  placeholder="New location name"
                />
                <Button type="button" onClick={handleCreateLocation} disabled={savingLocation}>Add</Button>
                {state.locations.length > 0 && (
                  <Button type="button" variant="secondary" onClick={() => { setAddingLocation(false); setNewLocation('') }}>Cancel</Button>
                )}
              </div>
            ) : (
              <div className="flex gap-2">
                <select
                  id="stock-location"
                  value={form.locationId}
                  onChange={e => setForm(f => ({ ...f, locationId: e.target.value }))}
                  className="field-input"
                >
                  {state.locations.map(l => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </select>
                <Button type="button" variant="secondary" onClick={() => setAddingLocation(true)}>+ New</Button>
              </div>
            )}
          </div>
          <div className="flex justify-end gap-3 border-t border-ink-100 pt-4">
            <Button type="button" variant="secondary" onClick={() => setShowModal(false)}>Cancel</Button>
            <Button type="submit">{editingMedicine ? 'Save Changes' : 'Add Medicine'}</Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
