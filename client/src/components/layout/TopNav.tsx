import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Menu, LogOut, ChevronDown } from 'lucide-react'
import { useApp } from '@/context/AppContext'
import { logout } from '@/context/AppContext'

type TopNavProps = {
  title: string
  onMenuClick: () => void
}

function getInitials(name: string): string {
  return name.split(' ').map((p) => p[0]).join('').toUpperCase().slice(0, 2)
}

function getGreeting(date = new Date()): { greeting: string; day: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    hourCycle: 'h23',
    weekday: 'long',
  }).formatToParts(date)

  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 12)
  const day = parts.find((p) => p.type === 'weekday')?.value ?? 'Today'

  let greeting = 'Good Evening'
  if (hour < 12) greeting = 'Good Morning'
  else if (hour < 17) greeting = 'Good Afternoon'

  return { greeting, day }
}

export function TopNav({ title, onMenuClick }: TopNavProps) {
  const { state, dispatch } = useApp()
  const navigate = useNavigate()
  const { currentUser } = state

  const [showProfileMenu, setShowProfileMenu] = useState(false)
  const profileRef = useRef<HTMLDivElement>(null)

  const { greeting, day } = getGreeting()
  const rawName = currentUser?.name?.trim().split(' ')[0] ?? 'there'
  const firstName = rawName.charAt(0).toUpperCase() + rawName.slice(1)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) {
        setShowProfileMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  async function handleLogout() {
    await logout(dispatch)
    navigate('/login')
  }

  return (
    <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center justify-between border-b border-ink-200/80 bg-white/85 px-4 backdrop-blur-lg sm:px-6">
      {/* Left section: mobile hamburger/title + desktop greeting */}
      <div className="flex items-center gap-3">
        <button
          onClick={onMenuClick}
          className="rounded-lg p-2 text-ink-500 hover:bg-ink-100 hover:text-ink-700 lg:hidden"
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" />
        </button>

        <h1 className="text-lg font-semibold text-ink-900 md:hidden">{title}</h1>

        {/* Personalized Greeting (Shifted left, themed, clean typography without card) */}
        <div className="hidden items-center gap-2 text-sm md:flex">
          <span className="font-medium text-ink-700">
            {greeting},{' '}
            <span className="font-semibold text-ink-900">{firstName}</span>!
          </span>
          <span className="select-none text-ink-300">•</span>
          <span className="text-ink-500">Wishing you a productive {day}</span>
        </div>
      </div>

      {/* Right section: profile menu */}
      <div className="flex items-center gap-1.5">
        <div className="relative" ref={profileRef}>
          <button
            onClick={() => setShowProfileMenu((p) => !p)}
            className="flex items-center gap-2 rounded-xl py-1.5 pl-1.5 pr-2 transition-colors hover:bg-ink-100"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-primary-500 to-primary-700 text-[13px] font-semibold text-white">
              {currentUser ? getInitials(currentUser.name) : '??'}
            </div>
            <span className="hidden text-sm font-medium text-ink-800 sm:block">{currentUser?.name ?? 'User'}</span>
            <ChevronDown className="hidden h-4 w-4 text-ink-400 sm:block" />
          </button>

          {showProfileMenu && (
            <div className="absolute right-0 top-full z-50 mt-2 w-56 origin-top-right animate-pop-in overflow-hidden rounded-2xl border border-ink-200/80 bg-white shadow-[var(--shadow-pop)]">
              <div className="border-b border-ink-100 px-4 py-3">
                <p className="text-sm font-semibold text-ink-900">{currentUser?.name}</p>
                <p className="truncate text-xs text-ink-500">{currentUser?.email}</p>
              </div>
              <div className="p-1.5">
                <button
                  onClick={handleLogout}
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-danger-600 transition-colors hover:bg-danger-50"
                >
                  <LogOut className="h-4 w-4" />
                  Sign out
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
