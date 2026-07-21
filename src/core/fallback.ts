/**
 * fallback: primary-or-backup.
 *
 * `fallback(primary, backup)` runs `primary`. If it throws an application
 * error, runs `backup` with the same input. If `backup` also throws, the
 * `backup` error propagates. Control-flow signals (`suspended_error`,
 * `aborted_error`) are not failures: they propagate instead of triggering the
 * backup, so a human-approval gate is never silently bypassed and the backup
 * never runs under an aborted context.
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

export type FallbackOptions = {
  readonly name?: string
}

/**
 * Build a primary-or-backup step.
 *
 * Runs `primary`; on an application error runs `backup` with the same input.
 * Control-flow signals propagate without triggering the backup.
 */
export function fallback<i, o>(
  primary: Step<i, o>,
  backup: Step<i, o>,
  options?: FallbackOptions,
): Step<i, o> {
  const id = next_id()

  const run_fn = async (input: i, ctx: RunContext): Promise<o> => {
    try {
      return await dispatch_step(primary, input, ctx)
    } catch (err) {
      if (is_control_flow_error(err)) throw err
      return dispatch_step(backup, input, ctx)
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
