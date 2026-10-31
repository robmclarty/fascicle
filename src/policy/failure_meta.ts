/**
 * The trajectory fields that say how a provider call failed.
 *
 * The engine's typed provider errors carry the response status, the attempt
 * count, the cause kind, and a server's `Retry-After` as fields. Core's
 * `run_end` and composer `span_end`, and the engine's own spans, copy them
 * onto the event beside `error`, so a dashboard can count a 503 that outlasted
 * its retries without parsing the message. Core can't import the engine's
 * error classes and the engine's spans end outside core's runner, so this
 * zone holds the one reader both layers share.
 *
 * The fields are read by name rather than by class, each only when it holds a
 * primitive of the expected type. Each is prefixed `error_`, like core's
 * `error_name` and `error_kind`, which also keeps `error_status` apart from a
 * `run_end`'s own `status`.
 */

export type FailureMeta = {
  error_status?: number
  error_attempts?: number
  error_cause_kind?: string
  error_retry_after_ms?: number
}

/**
 * Read `status`, `attempts`, `cause_kind`, and `retry_after_ms` off `err`
 * into their `error_` fields, keeping each only when it is present.
 */
export function failure_meta(err: unknown): FailureMeta {
  const meta: FailureMeta = {}
  if (err === null || typeof err !== 'object') return meta
  const status: unknown = Reflect.get(err, 'status')
  if (typeof status === 'number') meta.error_status = status
  const attempts: unknown = Reflect.get(err, 'attempts')
  if (typeof attempts === 'number') meta.error_attempts = attempts
  const cause_kind: unknown = Reflect.get(err, 'cause_kind')
  if (typeof cause_kind === 'string') meta.error_cause_kind = cause_kind
  const retry_after_ms: unknown = Reflect.get(err, 'retry_after_ms')
  if (typeof retry_after_ms === 'number') meta.error_retry_after_ms = retry_after_ms
  return meta
}
