/**
 * Collapse a leading run of system messages into a single joined string,
 * returning the remaining messages.
 *
 * Both message paths hoist a leading system run out of their list the same way:
 * the engine-Message side (generate.ts split_leading_system_messages) hands the
 * run to a native adapter's TurnRequest.system, and the AI SDK side
 * (providers/ai_sdk/invoke.ts split_leading_system) hands it to the SDK's
 * top-level `instructions` option. Same guard, same '\n\n' join, and the same
 * "return the list untouched when hoisting would leave `messages` empty" rule,
 * since provider APIs reject an empty messages array. They differ only in the
 * element type and how a system message's text is read, so each caller supplies
 * `system_text`; the traversal and its guards live here once.
 */
export function split_leading_system_run<T extends { readonly role: string }>(
  messages: ReadonlyArray<T>,
  system_text: (message: Extract<T, { role: 'system' }>) => string,
): { system?: string; messages: T[] } {
  let run_end = 0
  const system_parts: string[] = []
  while (run_end < messages.length) {
    const m = messages[run_end]
    if (!is_leading_system(m)) break
    system_parts.push(system_text(m))
    run_end += 1
  }
  const rest = messages.slice(run_end)
  if (system_parts.length === 0 || rest.length === 0) {
    return { messages: [...messages] }
  }
  return { system: system_parts.join('\n\n'), messages: rest }
}

/**
 * Narrow a possibly-undefined message to the system member of its union.
 *
 * A cast-free type guard so `split_leading_system_run` can hand the narrowed
 * message straight to `system_text` without a `T`-eroding assertion; the
 * optional chain covers the out-of-bounds `undefined` the index access yields.
 */
function is_leading_system<T extends { readonly role: string }>(
  m: T | undefined,
): m is Extract<T, { role: 'system' }> {
  // Stryker disable next-line OptionalChaining: within the loop guard run_end < messages.length, m is always an in-bounds (defined) message, so m.role and m?.role read identically.
  return m?.role === 'system'
}
