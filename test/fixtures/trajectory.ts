import type { TrajectoryEvent, TrajectoryLogger } from '#core'

// A TrajectoryLogger that appends every event to an array, so a suite can assert
// on the exact span/record stream a flow emits. Span ids are the deterministic
// `span_${n}` sequence the suites were written against.
export function recording_logger(): {
  logger: TrajectoryLogger
  events: TrajectoryEvent[]
} {
  const events: TrajectoryEvent[] = []
  let id = 0
  const logger: TrajectoryLogger = {
    record: (event) => {
      events.push(event)
    },
    start_span: (name, meta) => {
      id += 1
      const span_id = `span_${id}`
      events.push({ kind: 'span_start', span_id, name, ...meta })
      return span_id
    },
    end_span: (span_id, meta) => {
      events.push({ kind: 'span_end', span_id, ...meta })
    },
  }
  return { logger, events }
}
