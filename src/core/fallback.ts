/**
 * fallback: primary-or-backup.
 *
 * `fallback(primary, backup)` runs `primary`. If it throws an application
 * error, runs `backup` with the same input, or with `handoff(input, err)`
 * when the `handoff` option is set, so the backup can be told why it is
 * running. If `backup` also throws, the `backup` error propagates.
 * Control-flow signals (`suspended_error`, `aborted_error`) are not
 * failures: they propagate instead of triggering the backup, so a
 * human-approval gate is never silently bypassed and the backup never runs
 * under an aborted context. `handoff` is never called for them.
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

export type FallbackOptions<i = unknown> = {
  readonly name?: string
  readonly handoff?: (input: i, err: unknown) => i
}

/**
 * Build a primary-or-backup step.
 *
 * Runs `primary`; on an application error runs `backup` with the same input,
 * or with `handoff(input, err)` when the option is set. Control-flow signals
 * propagate without triggering the backup or the handoff.
 */
export function fallback<i, o>(
  primary: Step<i, o>,
  backup: Step<i, o>,
  options?: FallbackOptions<i>,
): Step<i, o> {
  const id = next_id()
  const handoff = options?.handoff

  const run_fn = async (input: i, ctx: RunContext): Promise<o> => {
    try {
      return await dispatch_step(primary, input, ctx)
    } catch (err) {
      if (is_control_flow_error(err)) throw err
      const backup_input = handoff === undefined ? input : handoff(input, err)
      return dispatch_step(backup, backup_input, ctx)
    }
  }

  const config_meta: Record<string, unknown> | undefined =
    options?.name === undefined ? undefined : { display_name: options.name }

  return {
    id,
    kind: 'fallback',
    children: [primary, backup],
    ...(config_meta ? { config: config_meta } : {}),
    run: run_fn,
  }
}

register_traced_kind('fallback')
