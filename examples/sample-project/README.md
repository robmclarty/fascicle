# sample-project

A small in-memory habit tracker used as a target for `pr-improve` testing.

It is **not** a real package — there are no tests run against it and it is excluded from fallow's entry list. The point is to provide a representative multi-file diff that `pr-improve` can review end to end.

## Layout

```
src/
  types.ts        Habit / HabitEntry / HabitId
  storage.ts      in-memory CRUD over habits and entries
  validation.ts   name and date validators
  streak.ts       current and longest streak calculations
  format.ts       string rendering helpers
  index.ts        public surface
```

## Usage

```ts
import {
  add_habit,
  log_entry,
  entries_for,
  format_habit_summary,
} from './src/index.js'

const habit = add_habit('Read for 20 minutes')
log_entry(habit.id, '2026-05-06')
log_entry(habit.id, '2026-05-07')
log_entry(habit.id, '2026-05-08')

console.log(format_habit_summary(habit, entries_for(habit.id)))
```
