/**
 * OpenTelemetry bridge for Fascicle trajectory events.
 *
 * `create_otel_trajectory_logger` returns a plain TrajectoryLogger that turns
 * the engine's own span + event stream into OpenTelemetry spans: the
 * `engine.generate` span becomes an OTel root span, each `engine.generate.step`
 * a child span, and every `record`ed event (tool_call, tool_result, cost, ...)
 * an OTel span event on the currently open span. It is transport-neutral: the
 * spans come from events the engine already emits, so native and external
 * transports get traces without any AI-SDK involvement.
 *
 * `@opentelemetry/api` is imported ONLY under `src/otel/` (this module and
 * metrics.ts), outside `src/engine/` on purpose: the engine's `ai + zod`
 * npm-dep invariant holds unmodified, and an app that never imports
 * `fascicle/otel` pulls in zero OTel packages at runtime.
 *
 * Nesting is resolved two ways, in order: an explicit `parent_span_id` on the
 * start meta (how the composition runner threads composer-span parenthood) wins;
 * otherwise the currently open span (top of the open stack) is the parent. This
 * is exact for the sequential engine flow (generate → step → step) and for
 * runner-nested spans; genuinely interleaved sibling spans that carry no
 * `parent_span_id` (concurrent branches sharing one logger) fall back to stack
 * order, which is this bridge's one documented approximation.
 */

import {
  context as otel_context,
  trace,
  SpanStatusCode,
  type AttributeValue,
  type Attributes,
  type Context,
  type Span,
  type Tracer,
} from '@opentelemetry/api'
import type { TrajectoryEvent, TrajectoryLogger } from '#core'
import { create_metrics_recorder, type OtelMetricsOptions } from './metrics.js'

export type OtelTrajectoryLoggerOptions = {
  /**
   * Tracer to open spans on. Defaults to `trace.getTracer('fascicle')`, which
   * resolves against whatever global TracerProvider the host has registered.
   */
  readonly tracer?: Tracer
  /**
   * Prefix for span + event attributes derived from event metadata, keeping
   * them out of the OTel semantic-convention namespace. Defaults to `fascicle.`.
   */
  readonly attribute_prefix?: string
  /**
   * Opt-in metric instruments recorded from the same trajectory stream the
   * spans mirror (GenAI semconv client histograms plus Fascicle's cost and
   * retry instruments; see metrics.ts). `true` uses the global MeterProvider's
   * `fascicle` meter; an object supplies a custom Meter. Off by default so the
   * bridge stays a pure tracer for hosts without a metrics pipeline.
   */
  readonly metrics?: boolean | OtelMetricsOptions
}

// Event/meta keys that are bridge plumbing, not span attributes.
const INTERNAL_KEYS: ReadonlySet<string> = new Set(['kind', 'span_id', 'parent_span_id'])

/**
 * JSON-stringify `value`, falling back to `String(value)` when `stringify`
 * throws or returns `undefined`, as it does for functions and symbols.
 */
function safe_json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * Convert a JS value into an OTel-compatible attribute value.
 *
 * Primitives and homogeneous primitive arrays pass through unchanged;
 * anything else falls back to `safe_json`; `null`/`undefined` drop out
 * entirely (returning `undefined`) so the caller can omit the attribute.
 */
function to_attribute_value(value: unknown): AttributeValue | undefined {
  if (value === null || value === undefined) return undefined
  const kind = typeof value
  if (kind === 'string' || kind === 'number' || kind === 'boolean') {
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    return value as AttributeValue
  }
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === 'string')) return value
    if (value.every((v) => typeof v === 'number')) return value
    if (value.every((v) => typeof v === 'boolean')) return value
    return safe_json(value)
  }
  return safe_json(value)
}

/**
 * True for a plain object value (not null, not an array): the shape span-meta
 * flattening applies to.
 */
function is_plain_object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Spread one object-valued span-meta field into dotted attribute keys
 * (`usage` + `input_tokens` becomes `<prefix>usage.input_tokens`), with
 * deeper nesting falling back to `to_attribute_value`'s JSON form.
 */
function flatten_into(
  attrs: Attributes,
  key: string,
  value: Record<string, unknown>,
  prefix: string,
): void {
  for (const [inner_key, inner_value] of Object.entries(value)) {
    const attr = to_attribute_value(inner_value)
    if (attr !== undefined) attrs[`${prefix}${key}.${inner_key}`] = attr
  }
}

/**
 * Build an OTel `Attributes` object from event/meta fields.
 *
 * Skips the bridge's internal plumbing keys (`kind`, `span_id`,
 * `parent_span_id`) and prefixes the rest with `prefix` so they stay out of
 * OTel's semantic-convention namespace.
 *
 * With `flatten`, an object-valued field spreads one level into dotted keys
 * (`usage: { input_tokens: 5 }` becomes `<prefix>usage.input_tokens = 5`), so
 * span metadata like usage and model_resolved lands as numeric attributes a
 * dashboard can aggregate rather than a JSON string it cannot query. Flattening
 * applies to span meta only, never to `record`ed events: an event may carry
 * arbitrary payloads (a tool call's input, a salvage blob) where
 * attribute-per-key would explode cardinality and leak structure, so those
 * keep the JSON-string fallback.
 */
function to_attributes(
  meta: Readonly<Record<string, unknown>> | undefined,
  prefix: string,
  flatten = false,
): Attributes {
  const attrs: Attributes = {}
  if (meta === undefined) return attrs
  for (const [key, value] of Object.entries(meta)) {
    if (INTERNAL_KEYS.has(key)) continue
    if (flatten && is_plain_object(value)) {
      flatten_into(attrs, key, value, prefix)
      continue
    }
    const attr = to_attribute_value(value)
    if (attr !== undefined) attrs[`${prefix}${key}`] = attr
  }
  return attrs
}

type OpenSpan = { readonly span: Span; readonly context: Context }

/**
 * Create a `TrajectoryLogger` that mirrors spans and events onto
 * OpenTelemetry, using `options.tracer` (or the global `fascicle` tracer).
 *
 * Parent resolution favors an explicit `parent_span_id` on the start meta;
 * otherwise it falls back to the currently open span on an internal stack.
 */
export function create_otel_trajectory_logger(
  options: OtelTrajectoryLoggerOptions = {},
): TrajectoryLogger {
  const tracer = options.tracer ?? trace.getTracer('fascicle')
  const prefix = options.attribute_prefix ?? 'fascicle.'
  const metrics_recorder =
    options.metrics === undefined || options.metrics === false
      ? undefined
      : create_metrics_recorder(options.metrics === true ? {} : options.metrics)
  const open = new Map<string, OpenSpan>()
  const stack: string[] = []
  let counter = 0

  const top_context = (): Context | undefined => {
    const top = stack[stack.length - 1]
    if (top === undefined) return undefined
    return open.get(top)?.context
  }

  const parent_context = (meta: Record<string, unknown> | undefined): Context => {
    const explicit = meta?.['parent_span_id']
    if (typeof explicit === 'string') {
      const parent = open.get(explicit)
      if (parent !== undefined) return parent.context
    }
    return top_context() ?? otel_context.active()
  }

  const target_for_event = (event: TrajectoryEvent): Span | undefined => {
    if (typeof event.span_id === 'string') {
      const target = open.get(event.span_id)
      if (target !== undefined) return target.span
    }
    const top = stack[stack.length - 1]
    return top !== undefined ? open.get(top)?.span : undefined
  }

  return {
    start_span(name, meta) {
      const parent = parent_context(meta)
      const span = tracer.startSpan(
        name,
        { attributes: to_attributes(meta, prefix, true) },
        parent,
      )
      counter += 1
      const id = `fascicle-otel-${counter}`
      open.set(id, { span, context: trace.setSpan(parent, span) })
      stack.push(id)
      metrics_recorder?.on_start_span(id, name, meta)
      return id
    },
    end_span(id, meta) {
      metrics_recorder?.on_end_span(id)
      const entry = open.get(id)
      if (entry === undefined) return
      const { span } = entry
      span.setAttributes(to_attributes(meta, prefix, true))
      const error = meta?.['error']
      if (typeof error === 'string' && error.length > 0) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error })
      }
      span.end()
      open.delete(id)
      const idx = stack.lastIndexOf(id)
      if (idx !== -1) stack.splice(idx, 1)
    },
    record(event) {
      metrics_recorder?.on_record(event)
      const span = target_for_event(event)
      if (span === undefined) return
      const name = typeof event.kind === 'string' ? event.kind : 'event'
      span.addEvent(name, to_attributes(event, prefix))
    },
  }
}
