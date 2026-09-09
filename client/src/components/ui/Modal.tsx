import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

type ModalProps = {
  isOpen: boolean
  onClose: () => void
  title: string
  description?: string
  children: ReactNode
  /**
   * Actions pinned below the scrolling body, outside it.
   *
   * A form that puts its own buttons at the end of `children` loses them off the bottom on a
   * phone, where the fields stack into far more height than the viewport. Making that row
   * `sticky` inside the body only traded one fault for two: the fields scrolled underneath an
   * opaque bar and read as cut in half, and its background overran the panel's rounded bottom
   * corner. As a sibling of the body it is simply always there, and the body's scrollbar stops
   * above it.
   */
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
}

const sizeClasses = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
}

export function Modal({ isOpen, onClose, title, description, children, footer, size = 'md' }: ModalProps) {
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden'
      const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
      document.addEventListener('keydown', handler)
      return () => {
        document.body.style.overflow = ''
        document.removeEventListener('keydown', handler)
      }
    }
  }, [isOpen, onClose])

  if (!isOpen) return null

  /*
   * Rendered into <body>, not where it is written. `position: fixed` is relative to the
   * viewport only while no ancestor establishes a containing block — and transform, filter,
   * backdrop-filter and will-change all do. The top bar carries backdrop-blur, so the Profile
   * and Change Password dialogs, which live inside it, had their full-screen overlay clamped
   * to the 64px height of the header: a sliver of white across the top and nothing else.
   * A portal puts every modal at the top of the DOM, out of reach of whatever wraps its owner.
   */
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-6 overflow-y-auto">
      <div className="fixed inset-0 bg-ink-900/40 backdrop-blur-[2px] animate-fade-in" onClick={onClose} />
      <div
        className={`relative bg-white rounded-2xl shadow-[var(--shadow-pop)] w-full ${sizeClasses[size]} my-auto mt-[6vh] flex flex-col max-h-[88vh] animate-pop-in ring-1 ring-ink-900/5`}
      >
        <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-4 border-b border-ink-100">
          <div>
            <h2 className="text-lg font-semibold text-ink-900">{title}</h2>
            {description && <p className="text-sm text-ink-500 mt-0.5">{description}</p>}
          </div>
          <button
            onClick={onClose}
            className="p-1.5 -mr-1.5 rounded-lg hover:bg-ink-100 text-ink-400 hover:text-ink-600 transition-colors shrink-0"
          >
            <X size={18} />
          </button>
        </div>
        <div className="overflow-y-auto px-6 py-5">{children}</div>
        {footer && (
          // Rounded to match the panel: a square-cornered bar would cut the corner off.
          <div className="shrink-0 rounded-b-2xl border-t border-ink-200 bg-white px-6 py-4">{footer}</div>
        )}
      </div>
    </div>,
    document.body,
  )
}
