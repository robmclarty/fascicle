/**
 * Wire-format schema for trajectory events.
 *
 * `TrajectoryEvent` (in `types.ts`) is the loose internal type — any code that
 * calls `trajectory.record(event)` or `start_span(name, meta)` produces values
 * conforming to it. This file defines the *narrower* shapes that the studio
 * (and any other downstream consumer) can parse out of the wire stream:
 *
 *   span_start  — composer span open
 *   span_end    — composer span close
 *   emit        — user-emitted event from inside a step (ctx.emit)
 *   <other>     — falls through `custom_event_schema`, which only requires a
 *                 string `kind` and tolerates any extra fields
 *
 * The discriminated union is **ordered**: well-known shapes are tried before
 * the permissive `custom` schema, so a `{ kind: 'span_start', ... }` event
 * always parses as `SpanStartEvent`, never as `CustomTrajectoryEvent`.
 *
 * Every well-known schema and `custom_event_schema` use `.passthrough()` so
 * additional fields (e.g. `run_id`, `id`, provider-specific metadata) survive
 * a parse / re-serialize round-trip without loss.
 */

import { z } from 'zod'

export const span_start_event_schema = z
  .object({
    kind: z.literal('span_start'),
    span_id: z.string(),
    name: z.string(),
  })
  .passthrough()

export const span_end_event_schema = z
  .object({
    kind: z.literal('span_end'),
    span_id: z.string(),
  })
  .passthrough()

export const emit_event_schema = z
  .object({
    kind: z.literal('emit'),
  })
  .passthrough()

export const custom_event_schema = z
  .object({
    kind: z.string(),
  })
  .passthrough()

export const trajectory_event_schema = z.union([
  span_start_event_schema,
  span_end_event_schema,
  emit_event_schema,
  custom_event_schema,
])

export type SpanStartEvent = z.infer<typeof span_start_event_schema>
export type SpanEndEvent = z.infer<typeof span_end_event_schema>
export type EmitEvent = z.infer<typeof emit_event_schema>
export type CustomTrajectoryEvent = z.infer<typeof custom_event_schema>
export type ParsedTrajectoryEvent = z.infer<typeof trajectory_event_schema>
