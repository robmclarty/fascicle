import { describe, expect, it } from 'vitest'
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricData,
} from '@opentelemetry/sdk-metrics'
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'
import { metrics as otel_metrics, type Meter } from '@opentelemetry/api'
import { create_otel_trajectory_logger } from '../trajectory_logger.js'

function harness(): {
  meter: Meter
  flush: () => Promise<MetricData[]>
} {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 3_600_000,
  })
  const provider = new MeterProvider({ readers: [reader] })
  return {
    meter: provider.getMeter('test'),
    flush: async () => {
      await provider.forceFlush()
      const collected = exporter.getMetrics()
      const last = collected[collected.length - 1]
      return last?.scopeMetrics.flatMap((s) => s.metrics) ?? []
    },
  }
}

function tracer(): ReturnType<BasicTracerProvider['getTracer']> {
  return new BasicTracerProvider().getTracer('test')
}

function by_name(metrics: MetricData[], name: string): MetricData {
  const found = metrics.find((m) => m.descriptor.name === name)
  if (found === undefined) throw new Error(`no metric named ${name}`)
  return found
}

/** A histogram data point's sum, typed structurally off the SDK's union. */
function point_sum(
  point: { value: number | { sum?: number | null } } | undefined,
): number | null | undefined {
  if (point === undefined) throw new Error('no data point')
  if (typeof point.value === 'number') throw new Error('not a histogram point')
  return point.value.sum
}

/** The first data point's histogram sum for the named metric. */
function histogram_sum(metric: MetricData): number | null | undefined {
  return point_sum(metric.dataPoints[0])
}

describe('create_otel_trajectory_logger metrics option', () => {
  it('records the gen_ai client instruments from one generate flow', async () => {
    const { meter, flush } = harness()
    const logger = create_otel_trajectory_logger({ tracer: tracer(), metrics: { meter } })

    const g = logger.start_span('engine.generate', {
      model: 'gpt-x',
      provider: 'openai',
      model_id: 'gpt-x',
      streaming: true,
    })
    const s = logger.start_span('engine.generate.step', { index: 0 })
    logger.record({
      kind: 'response_received',
      step_index: 0,
      input_tokens: 100,
      output_tokens: 40,
      finish_reason: 'stop',
      started_at: 1,
      duration_ms: 2000,
      first_chunk_ms: 100,
    })
    logger.record({
      kind: 'tool_result',
      step_index: 0,
      name: 'search',
      tool_call_id: 't1',
      duration_ms: 50,
    })
    logger.record({
      kind: 'cost',
      step_index: 0,
      source: 'engine_derived',
      total_usd: 0.5,
      input_usd: 0.3,
      output_usd: 0.2,
    })
    logger.record({
      kind: 'turn_retry',
      step_index: 0,
      attempt: 1,
      failure_kind: 'rate_limit',
      delay_ms: 5,
      status: 429,
    })
    logger.end_span(s, {})
    logger.end_span(g, {})

    const collected = await flush()

    const tokens = by_name(collected, 'gen_ai.client.token.usage')
    expect(tokens.descriptor.unit).toBe('{token}')
    const input_point = tokens.dataPoints.find(
      (p) => p.attributes['gen_ai.token.type'] === 'input',
    )
    const output_point = tokens.dataPoints.find(
      (p) => p.attributes['gen_ai.token.type'] === 'output',
    )
    expect(input_point?.attributes).toEqual({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'openai',
      'gen_ai.request.model': 'gpt-x',
      'gen_ai.token.type': 'input',
    })
    expect(point_sum(input_point)).toBe(100)
    expect(point_sum(output_point)).toBe(40)

    // Durations convert ms to the semconv's seconds.
    expect(histogram_sum(by_name(collected, 'gen_ai.client.operation.duration'))).toBe(2)
    expect(
      histogram_sum(by_name(collected, 'gen_ai.client.operation.time_to_first_chunk')),
    ).toBe(0.1)

    const tool = by_name(collected, 'gen_ai.execute_tool.duration')
    expect(histogram_sum(tool)).toBe(0.05)
    expect(tool.dataPoints[0]?.attributes['gen_ai.tool.name']).toBe('search')

    expect(histogram_sum(by_name(collected, 'fascicle.client.operation.cost'))).toBe(0.5)

    const retries = by_name(collected, 'fascicle.client.turn_retries')
    expect(retries.dataPoints[0]?.value).toBe(1)
    expect(retries.dataPoints[0]?.attributes['error.type']).toBe('rate_limit')
    expect(retries.dataPoints[0]?.attributes['gen_ai.provider.name']).toBe('openai')
  })

  it('drops provider/model attributes outside an open engine.generate span', async () => {
    const { meter, flush } = harness()
    const logger = create_otel_trajectory_logger({ tracer: tracer(), metrics: { meter } })

    // A non-generate span must NOT contribute provider/model context.
    const root = logger.start_span('sequence', { provider: 'nope', model_id: 'nope' })
    logger.record({
      kind: 'response_received',
      step_index: 0,
      input_tokens: 7,
      output_tokens: 3,
      finish_reason: 'stop',
    })
    logger.end_span(root, {})

    const collected = await flush()
    const tokens = by_name(collected, 'gen_ai.client.token.usage')
    expect(tokens.dataPoints[0]?.attributes).toEqual({
      'gen_ai.operation.name': 'chat',
      'gen_ai.token.type': 'input',
    })
  })

  it('pops the generate context when the span ends', async () => {
    const { meter, flush } = harness()
    const logger = create_otel_trajectory_logger({ tracer: tracer(), metrics: { meter } })

    const g = logger.start_span('engine.generate', { provider: 'openai', model_id: 'gpt-x' })
    logger.end_span(g, {})
    logger.record({
      kind: 'response_received',
      step_index: 0,
      input_tokens: 1,
      output_tokens: 1,
      finish_reason: 'stop',
      duration_ms: 100,
    })

    const collected = await flush()
    const duration = by_name(collected, 'gen_ai.client.operation.duration')
    expect(duration.dataPoints[0]?.attributes).toEqual({ 'gen_ai.operation.name': 'chat' })
  })

  it('metrics: true resolves the global MeterProvider fascicle meter', async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 3_600_000,
    })
    const provider = new MeterProvider({ readers: [reader] })
    otel_metrics.setGlobalMeterProvider(provider)
    try {
      const logger = create_otel_trajectory_logger({ tracer: tracer(), metrics: true })
      logger.record({
        kind: 'response_received',
        step_index: 0,
        input_tokens: 1,
        output_tokens: 1,
        finish_reason: 'stop',
      })
      await provider.forceFlush()
      const scopes = exporter.getMetrics().at(-1)?.scopeMetrics ?? []
      expect(scopes.map((s) => s.scope.name)).toEqual(['fascicle'])
    } finally {
      otel_metrics.disable()
    }
  })
})
