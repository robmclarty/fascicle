/**
 * Wire-format guards for trajectory events.
 *
 * `TrajectoryEvent` (in `types.ts`) is the loose internal type — any code that
 * calls `trajectory.record(event)` or `start_span(name, meta)` produces values
 * conforming to it. This file defines the *narrower* shapes that the studio
 * (and any other downstream consumer) can recognize in the wire stream:
 *
 *   span_start  — composer span open
 *   span_end    — composer span close
 *   emit        — user-emitted event from inside a step (ctx.emit)
 *   <other>     — anything else, recognized by `is_custom_trajectory_event`,
 *                 which only requires a string `kind`
 *
 * `parse_trajectory_event` is the wire gate, and it is deliberately permissive:
 * a value is a trajectory event iff it is a non-array object carrying a string
 * `kind`. The well-known guards layered on top are *recognizers*, not gates — a
 * `{ kind: 'span_start' }` line missing its `span_id` is still a valid event on
 * the wire, just not a `SpanStartEvent`. Anything stricter would have a viewer
 * drop lines a newer producer emits, which is the opposite of what a
 * forward-compatible wire format is for. `is_custom_trajectory_event` therefore
 * answers `true` for well-known kinds too: it is the fallback shape, not a
 * fifth disjoint case.
 *
 * Extra fields (`run_id`, `id`, provider-specific metadata) are neither
 * required nor stripped: a successful parse hands the value straight back, so a
 * parse / re-serialize round trip is lossless.
 */

export type SpanStartEvent = {
  readonly kind: 'span_start'
  readonly span_id: string
  readonly name: string
} & { readonly [key: string]: unknown }

export type SpanEndEvent = {
  readonly kind: 'span_end'
  readonly span_id: string
} & { readonly [key: string]: unknown }

export type EmitEvent = {
  readonly kind: 'emit'
} & { readonly [key: string]: unknown }

export type CustomTrajectoryEvent = {
  readonly kind: string
} & { readonly [key: string]: unknown }

export type ParsedTrajectoryEvent =
  | SpanStartEvent
  | SpanEndEvent
  | EmitEvent
  | CustomTrajectoryEvent

export type TrajectoryParseResult =
  | { readonly success: true; readonly data: ParsedTrajectoryEvent }
  | { readonly success: false; readonly error: Error }

/**
 * The wire gate: a non-array object carrying a string `kind`.
 *
 * True for every well-known kind as well, since `custom` is the fallback shape
 * rather than a disjoint case.
 */
export function is_custom_trajectory_event(value: unknown): value is CustomTrajectoryEvent {
  if (typeof value !== 'object' || value === null) return false
  if (Array.isArray(value)) return false
  return typeof (value as { kind?: unknown }).kind === 'string'
}

/** A composer span open: both `span_id` and `name` must be present as strings. */
export function is_span_start_event(value: unknown): value is SpanStartEvent {
  if (!is_custom_trajectory_event(value)) return false
  if (value.kind !== 'span_start') return false
  return typeof value['span_id'] === 'string' && typeof value['name'] === 'string'
}

/** A composer span close: `span_id` must be present as a string, `name` need not be. */
export function is_span_end_event(value: unknown): value is SpanEndEvent {
  if (!is_custom_trajectory_event(value)) return false
  return value.kind === 'span_end' && typeof value['span_id'] === 'string'
}

/** A `ctx.emit` event: the kind alone identifies it, the payload is the caller's. */
export function is_emit_event(value: unknown): value is EmitEvent {
  return is_custom_trajectory_event(value) && value.kind === 'emit'
}

/**
 * Parse one wire value into a trajectory event, `safeParse`-shaped.
 *
 * On success `data` is the value itself, not a copy, so nothing on the line is
 * dropped or reordered on the way through.
 */
export function parse_trajectory_event(value: unknown): TrajectoryParseResult {
  if (!is_custom_trajectory_event(value)) {
    return {
      success: false,
      error: new Error("not a trajectory event: expected an object with a string 'kind'"),
    }
  }
  return { success: true, data: value }
}
