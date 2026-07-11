import { describe, expect, it } from 'vitest'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base'
import { SpanStatusCode, type Tracer } from '@opentelemetry/api'
import { create_otel_trajectory_logger } from '../trajectory_logger.js'

function harness(tracer_name = 'test'): {
  tracer: Tracer
  exporter: InMemorySpanExporter
} {
  const exporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  })
  return { tracer: provider.getTracer(tracer_name), exporter }
}

function by_name(spans: ReadonlyArray<ReadableSpan>, name: string): ReadableSpan {
  const found = spans.filter((s) => s.name === name)
  if (found.length !== 1) throw new Error(`expected exactly one ${name}, got ${found.length}`)
  const span = found[0]
  if (span === undefined) throw new Error(`no ${name}`)
  return span
}

describe('create_otel_trajectory_logger', () => {
  it('maps a generate/step/tool-call trajectory to a nested span tree', () => {
    const { tracer, exporter } = harness()
    const logger = create_otel_trajectory_logger({ tracer })

    const g = logger.start_span('engine.generate', {
      model: 'gpt-x',
      provider: 'openai',
      streaming: false,
    })
    const s0 = logger.start_span('engine.generate.step', { index: 0 })
    logger.record({
      kind: 'tool_call',
      step_index: 0,
      name: 'search',
      tool_call_id: 't1',
      input: { q: 'hi' },
      duration_ms: 5,
    })
    logger.record({
      kind: 'tool_result',
      step_index: 0,
      name: 'search',
      tool_call_id: 't1',
      output: { hits: 2 },
      duration_ms: 5,
    })
    logger.end_span(s0, { finish_reason: 'tool_calls' })
    const s1 = logger.start_span('engine.generate.step', { index: 1 })
    logger.end_span(s1, { finish_reason: 'stop' })
    logger.end_span(g, { finish_reason: 'stop' })

    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(3)

    const gen = by_name(spans, 'engine.generate')
    const steps = spans.filter((s) => s.name === 'engine.generate.step')
    expect(steps).toHaveLength(2)

    // Both step spans are children of the generate span, in the same trace.
    for (const step of steps) {
      expect(step.parentSpanContext?.spanId).toBe(gen.spanContext().spanId)
      expect(step.spanContext().traceId).toBe(gen.spanContext().traceId)
    }

    // Start-meta becomes prefixed attributes; end-meta merges onto the span.
    expect(gen.attributes['fascicle.model']).toBe('gpt-x')
    expect(gen.attributes['fascicle.provider']).toBe('openai')
    expect(gen.attributes['fascicle.streaming']).toBe(false)
    expect(gen.attributes['fascicle.finish_reason']).toBe('stop')

    // Disambiguate the two step spans by their index attribute.
    const first = steps.find((s) => s.attributes['fascicle.index'] === 0)
    expect(first).toBeDefined()
    expect(steps.find((s) => s.attributes['fascicle.index'] === 1)).toBeDefined()

    // Tool call/result land as span events on the step span they occurred in.
    const events = first?.events ?? []
    expect(events.map((e) => e.name)).toEqual(['tool_call', 'tool_result'])
    expect(events[0]?.attributes?.['fascicle.name']).toBe('search')
    expect(events[0]?.attributes?.['fascicle.tool_call_id']).toBe('t1')
    // Non-primitive event fields are JSON-stringified, not dropped.
    expect(events[0]?.attributes?.['fascicle.input']).toBe('{"q":"hi"}')
    expect(events[1]?.attributes?.['fascicle.output']).toBe('{"hits":2}')
  })

  it('sets ERROR status when a span ends with an error', () => {
    const { tracer, exporter } = harness()
    const logger = create_otel_trajectory_logger({ tracer })

    const g = logger.start_span('engine.generate', {})
    logger.end_span(g, { error: 'provider exploded' })

    const [span] = exporter.getFinishedSpans()
    expect(span?.status.code).toBe(SpanStatusCode.ERROR)
    expect(span?.status.message).toBe('provider exploded')
    expect(span?.attributes['fascicle.error']).toBe('provider exploded')
  })

  it('honors an explicit parent_span_id over stack order without leaking it as an attribute', () => {
    const { tracer, exporter } = harness()
    const logger = create_otel_trajectory_logger({ tracer })

    const root = logger.start_span('sequence', {})
    const sibling = logger.start_span('parallel', { parent_span_id: root })
    // A span opened while `sibling` is on top of the stack, but explicitly
    // parented to `root`, must nest under root, not sibling.
    const child = logger.start_span('engine.generate', { parent_span_id: root })
    logger.end_span(child, {})
    logger.end_span(sibling, {})
    logger.end_span(root, {})

    const spans = exporter.getFinishedSpans()
    const root_span = by_name(spans, 'sequence')
    const child_span = by_name(spans, 'engine.generate')
    expect(child_span.parentSpanContext?.spanId).toBe(root_span.spanContext().spanId)
    // parent_span_id is nesting plumbing, not a span attribute.
    expect(child_span.attributes['fascicle.parent_span_id']).toBeUndefined()
  })

  it('treats an empty error string as no error', () => {
    const { tracer, exporter } = harness()
    const logger = create_otel_trajectory_logger({ tracer })

    const g = logger.start_span('engine.generate', {})
    logger.end_span(g, { error: '' })

    const [span] = exporter.getFinishedSpans()
    expect(span?.status.code).toBe(SpanStatusCode.UNSET)
    expect(span?.status.message).toBeUndefined()
  })

  it('stringifies a circular event field instead of throwing', () => {
    const { tracer, exporter } = harness()
    const logger = create_otel_trajectory_logger({ tracer })

    const g = logger.start_span('engine.generate', {})
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    expect(() => {
      logger.record({ kind: 'tool_result', step_index: 0, blob: circular })
    }).not.toThrow()
    logger.end_span(g, {})

    const [span] = exporter.getFinishedSpans()
    expect(typeof span?.events[0]?.attributes?.['fascicle.blob']).toBe('string')
  })

  it('applies a custom attribute prefix', () => {
    const { tracer, exporter } = harness()
    const logger = create_otel_trajectory_logger({ tracer, attribute_prefix: 'fx.' })

    const g = logger.start_span('engine.generate', { model: 'm' })
    logger.end_span(g, {})

    const [span] = exporter.getFinishedSpans()
    expect(span?.attributes['fx.model']).toBe('m')
    expect(span?.attributes['fascicle.model']).toBeUndefined()
  })

  it('drops records when no span is open and never throws', () => {
    const { tracer, exporter } = harness()
    const logger = create_otel_trajectory_logger({ tracer })

    expect(() => {
      logger.record({ kind: 'tool_call', step_index: 0 })
      logger.end_span('never-opened', {})
    }).not.toThrow()
    expect(exporter.getFinishedSpans()).toHaveLength(0)
  })

  it('preserves primitive arrays as attributes, stringifies mixed ones, and skips null', () => {
    const { tracer, exporter } = harness()
    const logger = create_otel_trajectory_logger({ tracer })

    const g = logger.start_span('engine.generate', {
      tags: ['a', 'b'],
      sizes: [1, 2, 3],
      flags: [true, false],
      mixed: [1, 'two'],
      absent: null,
    })
    logger.end_span(g, {})

    const [span] = exporter.getFinishedSpans()
    expect(span?.attributes['fascicle.tags']).toEqual(['a', 'b'])
    expect(span?.attributes['fascicle.sizes']).toEqual([1, 2, 3])
    expect(span?.attributes['fascicle.flags']).toEqual([true, false])
    // A non-uniform array is not a valid OTel attribute value, so it is JSON'd.
    expect(span?.attributes['fascicle.mixed']).toBe('[1,"two"]')
    // null-valued keys are dropped entirely rather than emitted.
    expect(span?.attributes['fascicle.absent']).toBeUndefined()
  })

  it('routes an event to the span named by its span_id when present', () => {
    const { tracer, exporter } = harness()
    const logger = create_otel_trajectory_logger({ tracer })

    const g = logger.start_span('engine.generate', {})
    const s0 = logger.start_span('engine.generate.step', { index: 0 })
    // Event addressed to the generate span while a step span is on top.
    logger.record({ kind: 'cost', span_id: g, total_usd: 0.1 })
    logger.end_span(s0, {})
    logger.end_span(g, {})

    const spans = exporter.getFinishedSpans()
    const gen = by_name(spans, 'engine.generate')
    const step = by_name(spans, 'engine.generate.step')
    expect(gen.events.map((e) => e.name)).toEqual(['cost'])
    expect(gen.events[0]?.attributes?.['fascicle.total_usd']).toBe(0.1)
    expect(step.events).toHaveLength(0)
  })
})
