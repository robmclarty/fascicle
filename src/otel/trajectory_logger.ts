/**
 * OpenTelemetry bridge for fascicle trajectory events (D7, Layer 1).
 *
 * `create_otel_trajectory_logger` returns a plain TrajectoryLogger that turns
 * the engine's own span + event stream into OpenTelemetry spans: the
 * `engine.generate` span becomes an OTel root span, each `engine.generate.step`
 * a child span, and every `record`ed event (tool_call, tool_result, cost, ...)
 * an OTel span event on the currently-open span. It is transport-neutral: the
 * spans come from events the engine already emits, so native and external
 * transports get traces without any AI-SDK involvement.
 *
 * This module is the ONLY place `@opentelemetry/api` is imported, and it lives
 * outside `src/engine/` on purpose (C2): the engine's `ai + zod` npm-dep
 * invariant holds unmodified, and an app that never imports `fascicle/otel`
 * pulls in zero OTel packages at runtime.
 *
 * Nesting is resolved two ways, in order: an explicit `parent_span_id` on the
 * start meta (how the composition runner threads composer-span parenthood) wins;
 * otherwise the currently-open span (top of the open stack) is the parent. This
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
}

// Event/meta keys that are bridge plumbing, not span attributes.
const INTERNAL_KEYS: ReadonlySet<string> = new Set(['kind', 'span_id', 'parent_span_id'])

function safe_json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

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

function to_attributes(
  meta: Readonly<Record<string, unknown>> | undefined,
  prefix: string,
): Attributes {
  const attrs: Attributes = {}
  if (meta === undefined) return attrs
  for (const [key, value] of Object.entries(meta)) {
    if (INTERNAL_KEYS.has(key)) continue
    const attr = to_attribute_value(value)
    if (attr !== undefined) attrs[`${prefix}${key}`] = attr
  }
  return attrs
}

type OpenSpan = { readonly span: Span; readonly context: Context }

export function create_otel_trajectory_logger(
  options: OtelTrajectoryLoggerOptions = {},
): TrajectoryLogger {
  const tracer = options.tracer ?? trace.getTracer('fascicle')
  const prefix = options.attribute_prefix ?? 'fascicle.'
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
      const span = tracer.startSpan(name, { attributes: to_attributes(meta, prefix) }, parent)
      counter += 1
      const id = `fascicle-otel-${counter}`
      open.set(id, { span, context: trace.setSpan(parent, span) })
      stack.push(id)
      return id
    },
    end_span(id, meta) {
      const entry = open.get(id)
      if (entry === undefined) return
      const { span } = entry
      span.setAttributes(to_attributes(meta, prefix))
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
      const span = target_for_event(event)
      if (span === undefined) return
      const name = typeof event.kind === 'string' ? event.kind : 'event'
      span.addEvent(name, to_attributes(event, prefix))
    },
  }
}
