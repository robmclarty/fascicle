/**
 * fallback: primary-or-backup.
 *
 * `fallback(primary, backup)` runs `primary`. If it throws an application
 * error, runs `backup` with the same input, or with `handoff(input, err)`
 * when the `handoff` option is set, so the backup can be told why it is
 * running. If `backup` also throws, the `backup` error propagates with the
 * primary's error attached as its `cause` (unless it already carries one),
 * so the original failure stays diagnosable from the escaping error.
 * Control-flow signals (`suspended_error`, `aborted_error`) are not
 * failures: they propagate instead of triggering the backup, so a
 * human-approval gate is never silently bypassed and the backup never runs
 * under an aborted context. `handoff` is never called for them. The `when`
 * option narrows the set further: a primary error it rejects propagates the
 * same way, untouched.
 *
 * `project` maps the `{ value, source, primary_error }` envelope into the
 * step's output, so a caller can tell a backup's value from the primary's
 * without a mutable closure. Omitted, the value is the output.
 */

import { is_control_flow_error } from './errors.js'
import { dispatch_step, register_traced_kind } from './runner.js'
import type { RunContext, Step } from './types.js'

let fallback_counter = 0

/**
 * Generate a unique step id of the form `fallback_<n>`.
 */
function next_id(): string {
  fallback_counter += 1
  return `fallback_${fallback_counter}`
}

/**
 * Which leg produced a fallback's value. `primary_error` is the error that
 * sent the run to the backup, present only when `source` is `'backup'`.
 */
export type FallbackOutcome<o> =
  | { readonly value: o; readonly source: 'primary'; readonly primary_error?: undefined }
  | { readonly value: o; readonly source: 'backup'; readonly primary_error: unknown }

export type FallbackOptions<i = unknown> = {
  readonly name?: string
  /**
   * Decide whether a primary error sends the run to the backup. Returning
   * false propagates the error untouched, the way a control-flow signal
   * does. Omitted, every application error does.
   */
  readonly when?: (err: unknown) => boolean
  readonly handoff?: (input: i, err: unknown) => i
}

/**
 * The `project` option `fallback` accepts beside `FallbackOptions`. It sits
 * outside `FallbackOptions` so options annotated as `FallbackOptions` leave
 * the output type to be inferred from the two legs.
 */
export type FallbackProjection<o, projected> = {
  /**
   * Map the `FallbackOutcome` envelope into the step's output inside the
   * fallback step itself, so `describe` and the trajectory gain no wrapper
   * node. Omitted, the value is the output.
   */
  readonly project?: (outcome: FallbackOutcome<o>) => projected
}

/**
 * Build a primary-or-backup step.
 *
 * Runs `primary`; on an application error `when` accepts, runs `backup` with
 * the same input, or with `handoff(input, err)` when the option is set.
 * Control-flow signals and errors `when` rejects propagate without
 * triggering the backup or the handoff. `project` maps the outcome envelope
 * into the output.
 */
export function fallback<i, o, projected = o>(
  primary: Step<i, o>,
  backup: Step<i, o>,
  options?: FallbackOptions<i> & FallbackProjection<o, projected>,
): Step<i, projected> {
  const id = next_id()
  const when = options?.when
  const handoff = options?.handoff
  // When `project` is omitted, `projected` defaults to `o`, so handing back
  // the bare value is sound; the cast records that default.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const project = options?.project ?? ((r: FallbackOutcome<o>) => r.value as unknown as projected)

  const run_backup = async (input: i, primary_error: unknown, ctx: RunContext): Promise<o> => {
    const backup_input = handoff === undefined ? input : handoff(input, primary_error)
    try {
      return await dispatch_step(backup, backup_input, ctx)
    } catch (backup_err) {
      // When both legs fail, only the backup's error escapes; without this
      // the primary's failure would be lost entirely. Control-flow signals
      // are not failures and pass through unmodified, and an existing cause
      // is never clobbered.
      if (
        !is_control_flow_error(backup_err) &&
        backup_err instanceof Error &&
        !('cause' in backup_err)
      ) {
        backup_err.cause = primary_error
      }
      throw backup_err
    }
  }

  // Each leg's value is projected outside its try, so an error thrown by
  // `project` is the caller's bug surfacing once rather than a primary
  // failure that sends the run to the backup.
  const run_fn = async (input: i, ctx: RunContext): Promise<projected> => {
    let value: o
    try {
      value = await dispatch_step(primary, input, ctx)
    } catch (err) {
      if (is_control_flow_error(err)) throw err
      if (when !== undefined && !when(err)) throw err
      const backup_value = await run_backup(input, err, ctx)
      return project({ value: backup_value, source: 'backup', primary_error: err })
    }
    return project({ value, source: 'primary' })
  }

  const config_meta: Record<string, unknown> = {}
  if (when) config_meta['when'] = when
  if (options?.project) config_meta['project'] = options.project
  if (options?.name !== undefined) config_meta['display_name'] = options.name

  return {
    id,
    kind: 'fallback',
    children: [primary, backup],
    ...(Object.keys(config_meta).length > 0 ? { config: config_meta } : {}),
    run: run_fn,
  }
}

register_traced_kind('fallback')
