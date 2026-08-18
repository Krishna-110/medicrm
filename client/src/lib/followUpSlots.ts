import type { FollowUpSlot } from '@/types'

/**
 * The two-hour windows a customer can ask to be called in, across the 10–6 calling day.
 *
 * Buckets rather than a clock time: nobody agrees to be rung at 14:05, they agree to a
 * window. The wording is the label's business, not the data's — the stored value is the
 * 24-hour range, so rephrasing a window changes a string here and nothing already saved.
 */
export const FOLLOW_UP_SLOTS: { value: FollowUpSlot; label: string; short: string }[] = [
  { value: '10-12', label: '10 AM – 12 PM', short: '10–12' },
  { value: '12-14', label: '12 PM – 2 PM', short: '12–2' },
  { value: '14-16', label: '2 PM – 4 PM', short: '2–4' },
  { value: '16-18', label: '4 PM – 6 PM', short: '4–6' },
]

export const slotLabel = (slot?: FollowUpSlot): string | null =>
  FOLLOW_UP_SLOTS.find(s => s.value === slot)?.short ?? null
