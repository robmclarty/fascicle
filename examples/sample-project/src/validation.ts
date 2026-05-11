const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/

export const is_valid_date_string = (value: string): boolean => {
  return DATE_REGEX.test(value)
}

export const is_valid_habit_name = (name: string): boolean => {
  if (name.length < 1) return false
  if (name.length > 80) return false
  return true
}

export const normalize_date = (value: string): string => {
  return value.trim().slice(0, 10)
}
