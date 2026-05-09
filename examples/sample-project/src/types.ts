export type HabitId = string

export type Habit = {
  id: HabitId
  name: string
  created_at: string
}

export type HabitEntry = {
  habit_id: HabitId
  date: string
  note?: string
}
