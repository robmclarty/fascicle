import { describe, expect, it } from 'vitest'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base'
import { SpanStatusCode, trace, type Tracer } from '@opentelemetry/api'
import type { TrajectoryEvent } from '#core'
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

// A function value has no JSON representation, forcing `safe_json`'s
// String()-fallback branch when used as an event field.
const unserializable_fn = (): number => 1

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
    // `kind` is bridge plumbing (the event name), never leaked as an attribute.
    expect(events[0]?.attributes?.['fascicle.kind']).toBeUndefined()
    expect(events[1]?.attributes?.['fascicle.kind']).toBeUndefined()
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
    // JSON.stringify throws on the cycle, so `safe_json` falls back to
    // `String(value)`, which yields the object's default string tag.
    expect(span?.events[0]?.attributes?.['fascicle.blob']).toBe('[object Object]')
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
      // A boolean mixed with a non-boolean: uniform only under `some`, not the
      // required `every`, so it must stringify rather than pass through.
      bool_mixed: [true, 1],
      absent: null,
    })
    logger.end_span(g, {})

    const [span] = exporter.getFinishedSpans()
    expect(span?.attributes['fascicle.tags']).toEqual(['a', 'b'])
    expect(span?.attributes['fascicle.sizes']).toEqual([1, 2, 3])
    expect(span?.attributes['fascicle.flags']).toEqual([true, false])
    // A non-uniform array is not a valid OTel attribute value, so it is JSON'd.
    expect(span?.attributes['fascicle.mixed']).toBe('[1,"two"]')
    expect(span?.attributes['fascicle.bool_mixed']).toBe('[true,1]')
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
    // span_id is routing plumbing, not a span-event attribute.
    expect(gen.events[0]?.attributes?.['fascicle.span_id']).toBeUndefined()
    expect(step.events).toHaveLength(0)
  })

  it('opens spans on the default fascicle tracer when constructed without options', () => {
    const exporter = new InMemorySpanExporter()
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    })
    trace.setGlobalTracerProvider(provider)
    try {
      const logger = create_otel_trajectory_logger()
      const g = logger.start_span('engine.generate', { model: 'm' })
      logger.end_span(g, {})

      const [span] = exporter.getFinishedSpans()
      // The default tracer is `trace.getTracer('fascicle')`, so the span's
      // instrumentation scope carries that exact name.
      expect(span?.instrumentationScope.name).toBe('fascicle')
      expect(span?.attributes['fascicle.model']).toBe('m')
    } finally {
      trace.disable()
    }
  })

  it('stringifies a function-valued field via String() when JSON.stringify yields nothing', () => {
    const { tracer, exporter } = harness()
    const logger = create_otel_trajectory_logger({ tracer })

    const g = logger.start_span('engine.generate', {})
    logger.record({ kind: 'tool_result', step_index: 0, fn: unserializable_fn })
    logger.end_span(g, {})

    const [span] = exporter.getFinishedSpans()
    // JSON.stringify(fn) is `undefined`, so `safe_json` falls back to String(fn).
    expect(span?.events[0]?.attributes?.['fascicle.fn']).toBe(String(unserializable_fn))
  })

  it('drops an explicitly-undefined field rather than stringifying it', () => {
    const { tracer, exporter } = harness()
    const logger = create_otel_trajectory_logger({ tracer })

    const g = logger.start_span('engine.generate', { u: undefined, model: 'm' })
    logger.end_span(g, {})

    const [span] = exporter.getFinishedSpans()
    expect(span?.attributes['fascicle.u']).toBeUndefined()
    // A sibling key still lands, proving the undefined value alone was skipped.
    expect(span?.attributes['fascicle.model']).toBe('m')
  })

  it('accepts spans opened and closed with no metadata', () => {
    const { tracer, exporter } = harness()
    const logger = create_otel_trajectory_logger({ tracer })

    expect(() => {
      const g = logger.start_span('engine.generate')
      logger.end_span(g)
    }).not.toThrow()

    const [span] = exporter.getFinishedSpans()
    expect(span?.name).toBe('engine.generate')
    expect(span?.status.code).toBe(SpanStatusCode.UNSET)
  })

  it('falls back to stack order when an explicit parent_span_id is unknown', () => {
    const { tracer, exporter } = harness()
    const logger = create_otel_trajectory_logger({ tracer })

    const root = logger.start_span('sequence', {})
    // A string parent_span_id that was never opened cannot be resolved, so the
    // span nests under the current stack top (root) instead.
    const child = logger.start_span('engine.generate', { parent_span_id: 'never-opened' })
    logger.end_span(child, {})
    logger.end_span(root, {})

    const spans = exporter.getFinishedSpans()
    const root_span = by_name(spans, 'sequence')
    const child_span = by_name(spans, 'engine.generate')
    expect(child_span.parentSpanContext?.spanId).toBe(root_span.spanContext().spanId)
  })

  it('routes to the stack top when an event span_id is unknown', () => {
    const { tracer, exporter } = harness()
    const logger = create_otel_trajectory_logger({ tracer })

    const g = logger.start_span('engine.generate', {})
    const s0 = logger.start_span('engine.generate.step', { index: 0 })
    // An unopened span_id cannot be targeted, so the event lands on the stack top.
    logger.record({ kind: 'cost', span_id: 'never-opened', total_usd: 0.2 })
    logger.end_span(s0, {})
    logger.end_span(g, {})

    const spans = exporter.getFinishedSpans()
    const gen = by_name(spans, 'engine.generate')
    const step = by_name(spans, 'engine.generate.step')
    expect(step.events.map((e) => e.name)).toEqual(['cost'])
    expect(gen.events).toHaveLength(0)
  })

  it('names an event span "event" when the record carries no string kind', () => {
    const { tracer, exporter } = harness()
    const logger = create_otel_trajectory_logger({ tracer })

    const g = logger.start_span('engine.generate', {})
    // TrajectoryEvent is the loose internal contract; an external logger may hand
    // us a record with no `kind`, which falls back to the generic event name.
    logger.record({ step_index: 0 } as unknown as TrajectoryEvent)
    logger.end_span(g, {})

    const [span] = exporter.getFinishedSpans()
    expect(span?.events.map((e) => e.name)).toEqual(['event'])
  })
})
