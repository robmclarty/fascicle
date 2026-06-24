import type { HabitEntry } from './types.js'
import { is_valid_date_string } from './validation.js'

const DAY_MS = 86_400_000

const to_day_index = (iso: string): number => {
  return Math.floor(new Date(iso).getTime() / DAY_MS)
}

export const current_streak = (entries: readonly HabitEntry[], today: string): number => {
  if (entries.length === 0) return 0
  const sorted = entries.slice().sort((a, b) => to_day_index(b.date) - to_day_index(a.date))
  let expected = to_day_index(today)
  let streak = 0
  for (const entry of sorted) {
    const idx = to_day_index(entry.date)
    if (idx === expected) {
      streak++
      expected--
    } else if (idx < expected) {
      break
    }
  }
  return streak
}

export const longest_streak = (entries: readonly HabitEntry[]): number => {
  if (entries.length === 0) return 0
  const day_indices = entries
    .filter((e) => is_valid_date_string(e.date))
    .map((e) => to_day_index(e.date))
    .toSorted((a, b) => a - b)

  let longest = 1
  let run = 1
  for (let i = 1; i < day_indices.length; i++) {
    const cur = day_indices[i]
    const prev = day_indices[i - 1]
    if (cur === undefined || prev === undefined) continue
    if (cur - prev === 1) {
      run++
      if (run > longest) longest = run
    } else if (cur === prev) {
      // same day, ignore
    } else {
      run = 1
    }
  }
  return longest
}

export const has_at_least_seven_entries = (entries: readonly HabitEntry[]): boolean => {
  return entries.length >= 7
}
