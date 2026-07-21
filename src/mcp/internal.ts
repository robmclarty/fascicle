/**
 * Small shared guards for the MCP adapter. Kept in one place so the client,
 * schema bridge, and result mapping do not each carry a copy.
 */

/**
 * Narrows a value to a plain object: non-null, `typeof` object, not an array.
 */
export function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Returns the value when it is a plain object, otherwise `undefined`.
 */
export function as_record(value: unknown): Record<string, unknown> | undefined {
  return is_record(value) ? value : undefined
}
