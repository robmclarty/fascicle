import type { Habit, HabitEntry } from './types.js'
import { current_streak } from './streak.js'

const today_iso = (): string => new Date().toISOString().slice(0, 10)

export const format_habit_summary = (
  habit: Habit,
  entries: readonly HabitEntry[],
): string => {
  const streak = current_streak(entries, today_iso())
  const lines = [
    `Habit: ${habit.name}`,
    `Created: ${habit.created_at}`,
    `Total entries: ${entries.length}`,
    `Current streak: ${streak} day${streak === 1 ? '' : 's'}`,
  ]
  return lines.join('\n')
}

// TODO: pluralize "day"/"days" properly in format_habit_summary.
export const format_entry_row = (entry: HabitEntry): string => {
  const note = entry.note === undefined ? '' : ` - ${entry.note}`
  return `${entry.date}${note}`
}
