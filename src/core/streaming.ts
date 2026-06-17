/**
 * Streaming observation channel.
 *
 * `run.stream(flow, input)` is a secondary entry point returning
 * `{ events, result }`. Events are observed via an async iterable; the result
 * promise resolves once the flow completes. Streaming is purely
 * observational — composers do not know it exists, and `run` and `run.stream`
 * produce identical final results (spec.md §6.7).
 *
 * The event buffer has a default high-water mark of 10,000. When the consumer
 * never iterates, emissions past the mark drop the oldest events and record a
 * single `events_dropped` marker. The `result` promise resolves regardless of
 * buffer pressure.
 */

import type { TrajectoryEvent, TrajectoryLogger } from './types.js'

export const STREAMING_HIGH_WATER_MARK = 10_000

export type StreamingChannel = {
  readonly logger: TrajectoryLogger
  readonly events: AsyncIterable<TrajectoryEvent>
  readonly close: () => void
}

export function create_streaming_channel(
  base: TrajectoryLogger,
  high_water_mark = STREAMING_HIGH_WATER_MARK,
): StreamingChannel {
  const buffer: TrajectoryEvent[] = []
  let dropped = 0
  let closed = false
  let marker_emitted = false
  let waiter: ((value: IteratorResult<TrajectoryEvent>) => void) | null = null

  function enqueue(event: TrajectoryEvent): void {
    if (closed) return
    if (waiter) {
      const resolve = waiter
      waiter = null
      resolve({ value: event, done: false })
      return
    }
    if (buffer.length >= high_water_mark) {
      buffer.shift()
      dropped += 1
      return
    }
    buffer.push(event)
  }

  function close(): void {
    if (closed) return
    closed = true
    if (dropped > 0 && !marker_emitted) {
      marker_emitted = true
      buffer.push({ kind: 'events_dropped', count: dropped })
    }
    if (waiter) {
      const resolve = waiter
      waiter = null
      resolve({ value: undefined, done: true })
    }
  }

  const logger: TrajectoryLogger = {
    record: (event) => {
      base.record(event)
      enqueue(event)
    },
    start_span: (name, meta) => {
      const id = base.start_span(name, meta)
      enqueue({ kind: 'span_start', span_id: id, name, ...meta })
      return id
    },
    end_span: (id, meta) => {
      base.end_span(id, meta)
      enqueue({ kind: 'span_end', span_id: id, ...meta })
    },
  }

  const events: AsyncIterable<TrajectoryEvent> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<TrajectoryEvent>> {
          if (buffer.length > 0) {
            const next_event = buffer.shift()
            if (next_event !== undefined) {
              return Promise.resolve({ value: next_event, done: false })
            }
          }
          if (closed) {
            return Promise.resolve({ value: undefined, done: true })
          }
          return new Promise<IteratorResult<TrajectoryEvent>>((resolve) => {
            waiter = resolve
          })
        },
        return(): Promise<IteratorResult<TrajectoryEvent>> {
          close()
          return Promise.resolve({ value: undefined, done: true })
        },
      }
    },
  }

  return { logger, events, close }
}
