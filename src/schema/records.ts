/**
 * Small shared guards for reading untyped JSON. They live beside the JSON
 * Schema bridge that needs them and are exported, so MCP's client and result
 * mapping read payloads through the same copy rather than carrying their own.
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
