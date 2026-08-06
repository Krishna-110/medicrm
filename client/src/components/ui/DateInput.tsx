import { Calendar } from 'lucide-react'
import { formatIndianDate } from '@/lib/dateUtils'

/**
 * A date field that reads dd/mm/yyyy while keeping the browser's native picker.
 *
 * A native <input type="date"> renders its text in the device's locale — mm/dd/yyyy on a
 * US-set phone — and a web page cannot override that. So the native input is kept for the
 * picker (a real calendar on mobile) but made transparent, with our own dd/mm/yyyy text drawn
 * on top. The value stays ISO YYYY-MM-DD, which is what the form and server already exchange,
 * so nothing downstream changes.
 */
export function DateInput({
  id,
  value,
  onChange,
  ariaLabel,
}: {
  id?: string
  value: string
  onChange: (value: string) => void
  ariaLabel?: string
}) {
  return (
    <div className="relative">
      <div className="field-input flex items-center justify-between">
        <span className={value ? 'text-ink-900' : 'text-ink-400'}>
          {value ? formatIndianDate(value) : 'dd/mm/yyyy'}
        </span>
        <Calendar size={16} className="pointer-events-none text-ink-400" />
      </div>
      <input
        id={id}
        type="date"
        value={value}
        aria-label={ariaLabel}
        onChange={e => onChange(e.target.value)}
        // showPicker opens the calendar on a plain tap; without it, desktop only focuses the
        // (invisible) field. Optional-chained so an older browser just falls back to focus.
        onClick={e => (e.currentTarget as HTMLInputElement).showPicker?.()}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      />
    </div>
  )
}
