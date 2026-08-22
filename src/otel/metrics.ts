/**
 * Opt-in OpenTelemetry metrics derived from the trajectory stream.
 *
 * The bridge's spans answer "what happened on this run"; SRE dashboards ask
 * aggregate questions ("p95 latency by model", "429s per minute", "tokens per
 * hour"), which want real OTel metric instruments rather than a
 * spans-to-metrics pipeline. This recorder listens to the same trajectory
 * events the span bridge mirrors and records the GenAI semantic-convention
 * client histograms, plus two Fascicle-named instruments for the data the
 * conventions do not cover yet (cost, absorbed retries).
 *
 * Instruments and sources:
 * - `gen_ai.client.token.usage` ({token}) from `response_received`, one
 *   point per direction via `gen_ai.token.type`.
 * - `gen_ai.client.operation.duration` (s) from `response_received`
 *   `duration_ms`, the model-only round trip.
 * - `gen_ai.client.operation.time_to_first_chunk` (s) from
 *   `first_chunk_ms` on streamed turns.
 * - `gen_ai.execute_tool.duration` (s) from `tool_result`, tagged
 *   `gen_ai.tool.name`.
 * - `fascicle.client.operation.cost` (usd) from the `cost` event's
 *   `total_usd`.
 * - `fascicle.client.turn_retries` ({retry}) counter from `turn_retry`,
 *   tagged `error.type` with the classified failure kind.
 *
 * Provider and model attributes come from the enclosing `engine.generate`
 * span's start meta, tracked on a stack with the same documented
 * approximation as the span bridge: concurrent generates sharing one logger
 * attribute to the innermost open call. The semantic conventions are still
 * experimental (mid-2026), so a semconv revision may rename instruments;
 * this module tracks the names at implementation time.
 */

import {
  metrics as otel_metrics,
  type Attributes,
  type Counter,
  type Histogram,
  type Meter,
} from '@opentelemetry/api'
import type { TrajectoryEvent } from '#core'

export type OtelMetricsOptions = {
  /**
   * Meter to create instruments on. Defaults to
   * `metrics.getMeter('fascicle')`, which resolves against the global
   * MeterProvider the host has registered.
   */
  readonly meter?: Meter
}

/**
 * The span-lifecycle + event listener the trajectory logger drives when
 * metrics are enabled.
 */
export type MetricsRecorder = {
  readonly on_start_span: (
    id: string,
    name: string,
    meta: Record<string, unknown> | undefined,
  ) => void
  readonly on_end_span: (id: string) => void
  readonly on_record: (event: TrajectoryEvent) => void
}

/** Semconv-suggested boundaries for the duration histograms, in seconds. */
const DURATION_BOUNDARIES = [
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48,
  40.96, 81.92,
]

/** Semconv-suggested boundaries for the token-usage histogram. */
const TOKEN_BOUNDARIES = [
  1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304,
]

/**
 * Read `key` off the loose event and return it only when it is a number.
 */
function event_number(event: TrajectoryEvent, key: string): number | undefined {
  const value = event[key]
  return typeof value === 'number' ? value : undefined
}

/**
 * Read `key` off the loose event and return it only when it is a string.
 */
function event_string(event: TrajectoryEvent, key: string): string | undefined {
  const value = event[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Create the metrics recorder: instruments are created once here, and every
 * recording stamps the provider/model of the innermost open generate call.
 */
export function create_metrics_recorder(options: OtelMetricsOptions): MetricsRecorder {
  const meter = options.meter ?? otel_metrics.getMeter('fascicle')

  const token_usage: Histogram = meter.createHistogram('gen_ai.client.token.usage', {
    unit: '{token}',
    description: 'Number of input and output tokens used per model turn',
    advice: { explicitBucketBoundaries: TOKEN_BOUNDARIES },
  })
  const operation_duration: Histogram = meter.createHistogram(
    'gen_ai.client.operation.duration',
    {
      unit: 's',
      description: 'Model round-trip duration of the successful turn attempt',
      advice: { explicitBucketBoundaries: DURATION_BOUNDARIES },
    },
  )
  const time_to_first_chunk: Histogram = meter.createHistogram(
    'gen_ai.client.operation.time_to_first_chunk',
    {
      unit: 's',
      description: 'Time from turn start to the first streamed chunk',
      advice: { explicitBucketBoundaries: DURATION_BOUNDARIES },
    },
  )
  const tool_duration: Histogram = meter.createHistogram('gen_ai.execute_tool.duration', {
    unit: 's',
    description: 'Tool execution duration',
    advice: { explicitBucketBoundaries: DURATION_BOUNDARIES },
  })
  const cost: Histogram = meter.createHistogram('fascicle.client.operation.cost', {
    unit: 'usd',
    description: 'Estimated cost per model turn',
  })
  const retries: Counter = meter.createCounter('fascicle.client.turn_retries', {
    unit: '{retry}',
    description: 'Provider turn attempts that failed and were retried',
  })

  // Innermost open engine.generate call's identity, for metric attributes.
  const generate_ids = new Set<string>()
  const context_stack: Array<{ provider?: string; model?: string }> = []

  const base_attributes = (): Attributes => {
    const attrs: Attributes = { 'gen_ai.operation.name': 'chat' }
    const top = context_stack[context_stack.length - 1]
    if (top?.provider !== undefined) attrs['gen_ai.provider.name'] = top.provider
    if (top?.model !== undefined) attrs['gen_ai.request.model'] = top.model
    return attrs
  }

  const on_response_received = (event: TrajectoryEvent): void => {
    const base = base_attributes()
    const input = event_number(event, 'input_tokens')
    if (input !== undefined) {
      token_usage.record(input, { ...base, 'gen_ai.token.type': 'input' })
    }
    const output = event_number(event, 'output_tokens')
    if (output !== undefined) {
      token_usage.record(output, { ...base, 'gen_ai.token.type': 'output' })
    }
    const duration_ms = event_number(event, 'duration_ms')
    if (duration_ms !== undefined) operation_duration.record(duration_ms / 1000, base)
    const first_chunk_ms = event_number(event, 'first_chunk_ms')
    if (first_chunk_ms !== undefined) {
      time_to_first_chunk.record(first_chunk_ms / 1000, base)
    }
  }

  return {
    on_start_span(id, name, meta) {
      if (name !== 'engine.generate') return
      generate_ids.add(id)
      const provider = meta?.['provider']
      const model = meta?.['model_id']
      context_stack.push({
        ...(typeof provider === 'string' ? { provider } : {}),
        ...(typeof model === 'string' ? { model } : {}),
      })
    },
    on_end_span(id) {
      if (!generate_ids.delete(id)) return
      context_stack.pop()
    },
    on_record(event) {
      if (event.kind === 'response_received') {
        on_response_received(event)
        return
      }
      if (event.kind === 'tool_result') {
        const duration_ms = event_number(event, 'duration_ms')
        if (duration_ms === undefined) return
        const name = event_string(event, 'name')
        tool_duration.record(duration_ms / 1000, {
          ...base_attributes(),
          ...(name !== undefined ? { 'gen_ai.tool.name': name } : {}),
        })
        return
      }
      if (event.kind === 'cost') {
        const total_usd = event_number(event, 'total_usd')
        if (total_usd !== undefined) cost.record(total_usd, base_attributes())
        return
      }
      if (event.kind === 'turn_retry') {
        const failure_kind = event_string(event, 'failure_kind')
        retries.add(1, {
          ...base_attributes(),
          ...(failure_kind !== undefined ? { 'error.type': failure_kind } : {}),
        })
      }
    },
  }
}
