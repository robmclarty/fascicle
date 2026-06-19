/**
 * Small shared guards for the MCP adapter. Kept in one place so the client,
 * schema bridge, and result mapping do not each carry a copy.
 */

export function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function as_record(value: unknown): Record<string, unknown> | undefined {
  return is_record(value) ? value : undefined
}
