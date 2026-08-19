/**
 * Step id validation.
 *
 * Every id in the system is constrained to a valid JavaScript identifier
 * rather than an arbitrary string, because ids are read back as property
 * names: `chain` merges each binding into a typed record under its name, and
 * a name you cannot destructure is a name the record cannot offer. Holding
 * one rule across `step`, `chain`, and the agent surface means a user learns
 * it once instead of discovering per-primitive exceptions.
 *
 * Prose is not constrained, because prose has its own channel: `meta.name`
 * on a step, `name` on a chain binding or composer.
 *
 * Nothing normalizes an id on the caller's behalf. A silent transformation
 * would map several distinct names onto one key ('my-id', 'my.id', and
 * 'my_id' all reduce to 'my_id') and would have to stay bug-for-bug in sync
 * with the equivalent type-level transformation. The suggestion in the
 * failure message is a courtesy for the reader, never a contract.
 */

// `$` sits outside ID_Continue, so both classes name it explicitly.
const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$]*$/u

/**
 * Report whether `id` can be read back as a property name.
 */
export function is_valid_step_id(id: string): boolean {
  return IDENTIFIER.test(id)
}

/**
 * Render the closest identifier-shaped spelling of `raw`, for failure
 * messages only. Prefixes an underscore when the swap alone still leaves an
 * illegal leading character, so the suggestion is always usable as written.
 */
export function suggest_step_id(raw: string): string {
  const swapped = raw.replace(/[^\p{ID_Continue}$]/gu, '_')
  return IDENTIFIER.test(swapped) ? swapped : `_${swapped}`
}

/**
 * Throw when `id` is not identifier-shaped. `subject` names the failing
 * surface so the message points at the call the reader actually wrote, and
 * `remedy` says where the prose spelling belongs instead.
 */
export function assert_valid_step_id(id: string, subject: string, remedy: string): void {
  if (is_valid_step_id(id)) return
  throw new TypeError(
    `${subject} ${JSON.stringify(id)} is not a valid identifier: ids are read back as property names, so use ${suggest_step_id(id)} and ${remedy}`,
  )
}
