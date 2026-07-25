/**
 * Caps shared by every sandbox tool.
 *
 * Interpolated into the tool descriptions the model sees, so the numbers it is
 * told cannot drift from the numbers that are enforced.
 */

export const MAX_FILE_BYTES = 100_000
export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000
export const MAX_GREP_MATCHES = 200

/**
 * Truncate `text` to `max` bytes, appending a note about what was dropped.
 */
export function clip(text: string, max = MAX_FILE_BYTES): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…[truncated ${String(text.length - max)} bytes]`
}
