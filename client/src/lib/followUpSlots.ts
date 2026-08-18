import type { FollowUpSlot } from '@/types'

/**
 * The parts of the day a customer can ask to be called in.
 *
 * Buckets rather than a clock time: nobody agrees to be rung at 14:05, they agree to an
 * afternoon. The hours are the label's business, not the data's — widening a window later
 * changes a string here and nothing stored.
 */
export const FOLLOW_UP_SLOTS: { value: FollowUpSlot; label: string; short: string }[] = [
  { value: 'morning', label: 'Morning (9 AM – 12 PM)', short: 'Morning' },
  { value: 'afternoon', label: 'Afternoon (12 – 4 PM)', short: 'Afternoon' },
  { value: 'evening', label: 'Evening (4 – 8 PM)', short: 'Evening' },
]

export const slotLabel = (slot?: FollowUpSlot): string | null =>
  FOLLOW_UP_SLOTS.find(s => s.value === slot)?.short ?? null
