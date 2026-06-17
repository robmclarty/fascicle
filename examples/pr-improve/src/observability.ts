/**
 * stdout_logger: minimal TrajectoryLogger that prints each event as one
 * JSON line on stdout.
 *
 * Designed for Fargate's awslogs driver: stdout is shipped to CloudWatch
 * automatically, and CloudWatch Logs Insights parses each line as
 * structured JSON. Pair with `filesystem_logger` via `tee_logger` to keep
 * one source of truth for the events that goes to two destinations.
 */

import type { TrajectoryLogger } from 'fascicle'

let span_seq = 0

function write_event(payload: Record<string, unknown>): void {
  try {
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...payload })}\n`)
  } catch {
    // best-effort: never throw from a logger
  }
}

export function stdout_logger(): TrajectoryLogger {
  return {
    record: (event) => {
      write_event({ kind: 'record', event })
    },
    start_span: (name, meta) => {
      span_seq += 1
      const id = `span-${String(span_seq)}`
      write_event({ kind: 'span_start', id, name, meta })
      return id
    },
    end_span: (id, meta) => {
      write_event({ kind: 'span_end', id, meta })
    },
  }
}
