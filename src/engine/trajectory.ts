/**
 * Trajectory span and record helpers for the engine.
 *
 * When a TrajectoryLogger is supplied to generate, these helpers emit the
 * engine's event vocabulary. When it is undefined, every helper is a no-op,
 * so call sites never need to branch on whether tracing is on. The tool loop
 * drives span lifecycle; these helpers capture the event shape and keep
 * dispatch consistent.
 */

import type { TrajectoryLogger } from '#core'
import type {
  CostBreakdown,
  FinishReason,
  UsageTotals,
} from './types.js'

export type GenerateSpanStartMeta = {
  model: string
  provider: string
  model_id: string
  has_tools: boolean
  has_schema: boolean
  streaming: boolean
}

/**
 * Open the `engine.generate` span that brackets one whole generate call.
 */
export function start_generate_span(
  trajectory: TrajectoryLogger | undefined,
  meta: GenerateSpanStartMeta,
): string | undefined {
  if (trajectory === undefined) return undefined
  return trajectory.start_span('engine.generate', { ...meta })
}

/**
 * Close the `engine.generate` span with usage, finish reason, resolved model,
 * or the error message on failure.
 */
export function end_generate_span(
  trajectory: TrajectoryLogger | undefined,
  span_id: string | undefined,
  meta: {
    usage?: UsageTotals
    finish_reason?: FinishReason
    model_resolved?: { provider: string; model_id: string }
    error?: string
  },
): void {
  if (trajectory === undefined || span_id === undefined) return
  trajectory.end_span(span_id, { ...meta })
}

/**
 * Open an `engine.generate.step` span for one model turn in the tool loop.
 */
export function start_step_span(
  trajectory: TrajectoryLogger | undefined,
  index: number,
): string | undefined {
  if (trajectory === undefined) return undefined
  return trajectory.start_span('engine.generate.step', { index })
}

/**
 * Close an `engine.generate.step` span with per-step usage or error.
 */
export function end_step_span(
  trajectory: TrajectoryLogger | undefined,
  span_id: string | undefined,
  meta: { usage?: UsageTotals; finish_reason?: FinishReason; error?: string },
): void {
  if (trajectory === undefined || span_id === undefined) return
  trajectory.end_span(span_id, { ...meta })
}

/**
 * Record that a provider request went out, with an optional prompt-token
 * estimate for providers that report one before the response arrives.
 */
export function record_request_sent(
  trajectory: TrajectoryLogger | undefined,
  step_index: number,
  prompt_tokens_estimated: number | undefined,
): void {
  if (trajectory === undefined) return
  const event: Record<string, unknown> = {
    kind: 'request_sent',
    step_index,
  }
  if (prompt_tokens_estimated !== undefined) {
    event['prompt_tokens_estimated'] = prompt_tokens_estimated
  }
  trajectory.record({ kind: 'request_sent', ...event })
}

/**
 * Record a provider response with its finish reason and output token count.
 */
export function record_response_received(
  trajectory: TrajectoryLogger | undefined,
  step_index: number,
  output_tokens: number | undefined,
  finish_reason: FinishReason,
): void {
  if (trajectory === undefined) return
  const event: Record<string, unknown> = {
    kind: 'response_received',
    step_index,
    finish_reason,
  }
  if (output_tokens !== undefined) event['output_tokens'] = output_tokens
  trajectory.record({ kind: 'response_received', ...event })
}

export type ToolCallRecordEvent = {
  step_index: number
  name: string
  tool_call_id: string
  input: unknown
  duration_ms: number
  error?: { message: string }
}

/**
 * Record a tool invocation request: name, call id, input, and duration.
 */
export function record_tool_call(
  trajectory: TrajectoryLogger | undefined,
  meta: ToolCallRecordEvent,
): void {
  if (trajectory === undefined) return
  const event: Record<string, unknown> = {
    kind: 'tool_call',
    step_index: meta.step_index,
    name: meta.name,
    tool_call_id: meta.tool_call_id,
    input: meta.input,
    duration_ms: meta.duration_ms,
  }
  if (meta.error !== undefined) event['error'] = meta.error
  trajectory.record({ kind: 'tool_call', ...event })
}

export type ToolResultRecordEvent = {
  step_index: number
  name: string
  tool_call_id: string
  duration_ms: number
  output?: unknown
  error?: { message: string }
}

/**
 * Record a resolved tool call's result. `record_tool_call` captures the request
 * (input); without this event a successful tool's output never reaches the
 * trajectory, leaving the run record blind to what tools actually returned.
 */
export function record_tool_result(
  trajectory: TrajectoryLogger | undefined,
  meta: ToolResultRecordEvent,
): void {
  if (trajectory === undefined) return
  const event: Record<string, unknown> = {
    kind: 'tool_result',
    step_index: meta.step_index,
    name: meta.name,
    tool_call_id: meta.tool_call_id,
    duration_ms: meta.duration_ms,
  }
  if (meta.error !== undefined) event['error'] = meta.error
  else event['output'] = meta.output
  trajectory.record({ kind: 'tool_result', ...event })
}

/**
 * Add a `ts` (epoch milliseconds) to span meta unless one is already set.
 */
function stamp_ts(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...meta }
  if (!('ts' in out)) out['ts'] = Date.now()
  return out
}

/**
 * Wrap a logger so engine events carry a `ts` (epoch milliseconds) even when
 * generate is called directly with a caller-supplied logger rather than
 * through the core runner. When the logger is already runner-decorated, the
 * existing `ts` is preserved.
 */
export function with_timestamps(
  inner: TrajectoryLogger | undefined,
): TrajectoryLogger | undefined {
  if (inner === undefined) return undefined
  return {
    record: (event) => {
      if ('ts' in event) {
        inner.record(event)
        return
      }
      inner.record({ ...event, ts: Date.now() })
    },
    start_span: (name, meta) => inner.start_span(name, stamp_ts(meta)),
    end_span: (id, meta) => {
      inner.end_span(id, stamp_ts(meta))
    },
  }
}

export type CostEventSource = 'engine_derived' | 'provider_reported'

/**
 * Record a per-step cost breakdown, tagged with whether the engine derived it
 * from pricing tables or the provider reported it directly.
 */
export function record_cost(
  trajectory: TrajectoryLogger | undefined,
  step_index: number,
  cost: CostBreakdown,
  source: CostEventSource,
): void {
  if (trajectory === undefined) return
  const event: Record<string, unknown> = {
    kind: 'cost',
    step_index,
    source,
    total_usd: cost.total_usd,
    input_usd: cost.input_usd,
    output_usd: cost.output_usd,
  }
  if (cost.cached_input_usd !== undefined) event['cached_input_usd'] = cost.cached_input_usd
  if (cost.cache_write_usd !== undefined) event['cache_write_usd'] = cost.cache_write_usd
  if (cost.reasoning_usd !== undefined) event['reasoning_usd'] = cost.reasoning_usd
  trajectory.record({ kind: 'cost', ...event })
}

/**
 * Deduplication helper for `pricing_missing`. The event fires at most once
 * per generate call per {provider, model_id}. Callers thread a single
 * instance through the per-call orchestration.
 */
export type PricingMissingDedup = {
  emit: (provider: string, model_id: string) => void
}

/**
 * Build the per-call dedup that emits `pricing_missing` once per model.
 */
export function create_pricing_missing_dedup(
  trajectory: TrajectoryLogger | undefined,
): PricingMissingDedup {
  const seen = new Set<string>()
  return {
    emit(provider: string, model_id: string): void {
      if (trajectory === undefined) return
      const key = `${provider}:${model_id}`
      if (seen.has(key)) return
      seen.add(key)
      trajectory.record({ kind: 'pricing_missing', provider, model_id })
    },
  }
}

/**
 * Record that a requested reasoning-effort setting was ignored because the
 * model does not support it.
 */
export function record_effort_ignored(
  trajectory: TrajectoryLogger | undefined,
  model_id: string,
): void {
  if (trajectory === undefined) return
  trajectory.record({ kind: 'effort_ignored', model_id })
}

export type SchemaValidationFailedAttempt = 'initial' | 'repair'

export type SchemaValidationFailedEvent = {
  attempt: SchemaValidationFailedAttempt
  zod_issues: string
  raw_text: string
}

/**
 * Emit a structured event when a schema-driven generate call returns text
 * that fails parse + zod validation. Persists the raw model output and a
 * formatted zod issues summary to the trajectory so the failure is debuggable
 * without needing stdout.
 */
export function record_schema_validation_failed(
  trajectory: TrajectoryLogger | undefined,
  meta: SchemaValidationFailedEvent,
): void {
  if (trajectory === undefined) return
  trajectory.record({
    kind: 'schema_validation_failed',
    attempt: meta.attempt,
    zod_issues: meta.zod_issues,
    raw_text: meta.raw_text,
  })
}

export type SalvagedCallEventEntry = {
  tool_call_id: string
  name: string
  format: 'hermes' | 'json' | 'qwen_xml'
}

/**
 * Emitted once per step whose tool calls were recovered from assistant text
 * rather than returned structurally (tool_call_repair_attempts). The per-call
 * tool_call/tool_result events still fire for each salvaged call; this event
 * answers why the step has calls the provider never emitted, and persists the
 * raw text for debugging (precedent: schema_validation_failed).
 */
export function record_tool_call_salvaged(
  trajectory: TrajectoryLogger | undefined,
  meta: {
    step_index: number
    calls: ReadonlyArray<SalvagedCallEventEntry>
    raw_text: string
  },
): void {
  if (trajectory === undefined) return
  trajectory.record({
    kind: 'tool_call_salvaged',
    step_index: meta.step_index,
    calls: meta.calls,
    raw_text: meta.raw_text,
  })
}

/**
 * Emitted when max_tool_calls_per_step drops calls beyond the cap. Dropped
 * calls also get ToolCallRecords with an error, but only this event carries
 * the configured cap alongside what was kept.
 */
export function record_tool_calls_dropped(
  trajectory: TrajectoryLogger | undefined,
  meta: {
    step_index: number
    max_tool_calls_per_step: number
    kept: number
    dropped: ReadonlyArray<{ tool_call_id: string; name: string }>
  },
): void {
  if (trajectory === undefined) return
  trajectory.record({
    kind: 'tool_calls_dropped',
    step_index: meta.step_index,
    max_tool_calls_per_step: meta.max_tool_calls_per_step,
    kept: meta.kept,
    dropped: meta.dropped,
  })
}

export type ToolApprovalEventKind =
  | 'tool_approval_requested'
  | 'tool_approval_granted'
  | 'tool_approval_denied'

/**
 * Record one stage of the tool-approval handshake (requested, granted, or
 * denied) for a specific tool call.
 */
export function record_tool_approval(
  trajectory: TrajectoryLogger | undefined,
  kind: ToolApprovalEventKind,
  meta: { tool_name: string; step_index: number; tool_call_id: string },
): void {
  if (trajectory === undefined) return
  trajectory.record({
    kind,
    tool_name: meta.tool_name,
    step_index: meta.step_index,
    tool_call_id: meta.tool_call_id,
  })
}

/**
 * Deduplication helper for `option_ignored`. The event fires at most once per
 * generate call per option key. External adapters whose transports do not
 * honor a caller-supplied option (max_steps, tool_error_policy,
 * on_tool_approval) route the emit through this dedup.
 */
export type OptionIgnoredDedup = {
  emit: (option: string, provider: string) => void
}

/**
 * Build the per-call dedup that emits `option_ignored` once per option key.
 */
export function create_option_ignored_dedup(
  trajectory: TrajectoryLogger | undefined,
): OptionIgnoredDedup {
  const seen = new Set<string>()
  return {
    emit(option: string, provider: string): void {
      if (trajectory === undefined) return
      if (seen.has(option)) return
      seen.add(option)
      trajectory.record({ kind: 'option_ignored', option, provider })
    },
  }
}
