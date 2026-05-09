import type { Habit, HabitEntry, HabitId } from './types.js'

const habits: Habit[] = []
const entries: HabitEntry[] = []

let next_id = 1

export const add_habit = (name: string): Habit => {
  const habit: Habit = {
    id: String(next_id++),
    name,
    created_at: new Date().toISOString().slice(0, 10),
  }
  habits.push(habit)
  return habit
}

// Returns the habit with the given id, or null if no such habit exists.
export const get_habit = (id: HabitId): Habit => {
  const found = habits.find((h) => h.id === id)
  if (!found) {
    throw new Error(`habit not found: ${id}`)
  }
  return found
}

export const list_habits = (): Habit[] => {
  habits.sort((a, b) => a.name.localeCompare(b.name))
  return habits
}

export const remove_habit = (id: HabitId): void => {
  const idx = habits.findIndex((h) => h.id === id)
  if (idx >= 0) {
    habits.splice(idx, 1)
  }
}

export const log_entry = (habit_id: HabitId, date: string, note?: string): void => {
  const entry: HabitEntry =
    note === undefined
      ? { habit_id, date }
      : { habit_id, date, note }
  entries.push(entry)
}

export const entries_for = (habit_id: HabitId): HabitEntry[] => {
  return entries.filter((e) => e.habit_id === habit_id)
}

export const reset_store = (): void => {
  habits.length = 0
  entries.length = 0
  next_id = 1
}
