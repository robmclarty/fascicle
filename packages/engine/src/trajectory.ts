/**
 * Trajectory span and record helpers for the engine.
 *
 * When a TrajectoryLogger is supplied to generate, these helpers emit the
 * documented engine events (spec §5.3, §6.2). When undefined, every helper
 * is a no-op. Higher-level orchestration (phase 2) drives span lifecycle;
 * these helpers capture the event shape and keep dispatch consistent.
 */

import type { TrajectoryLogger } from '@repo/core'
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

export function start_generate_span(
  trajectory: TrajectoryLogger | undefined,
  meta: GenerateSpanStartMeta,
): string | undefined {
  if (trajectory === undefined) return undefined
  return trajectory.start_span('engine.generate', { ...meta })
}

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

export function start_step_span(
  trajectory: TrajectoryLogger | undefined,
  index: number,
): string | undefined {
  if (trajectory === undefined) return undefined
  return trajectory.start_span('engine.generate.step', { index })
}

export function end_step_span(
  trajectory: TrajectoryLogger | undefined,
  span_id: string | undefined,
  meta: { usage?: UsageTotals; finish_reason?: FinishReason; error?: string },
): void {
  if (trajectory === undefined || span_id === undefined) return
  trajectory.end_span(span_id, { ...meta })
}

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
 * Wrap a logger so engine events carry a `ts` (epoch milliseconds) even when
 * generate is called directly with a caller-supplied logger rather than through
 * the core runner. When the logger is already runner-decorated, the existing
 * `ts` is preserved. Private to the engine to avoid widening the public surface.
 */
function stamp_ts(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...meta }
  if (!('ts' in out)) out['ts'] = Date.now()
  return out
}

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
 * Deduplication helper for `pricing_missing`. The spec requires emission at
 * most once per generate call per {provider, model_id}. Callers thread a
 * single instance through the per-call orchestration.
 */
export type PricingMissingDedup = {
  emit: (provider: string, model_id: string) => void
}

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
 * without needing stdout. Spec §6.5.
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

export type ToolApprovalEventKind =
  | 'tool_approval_requested'
  | 'tool_approval_granted'
  | 'tool_approval_denied'

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
 * Deduplication helper for `option_ignored`. Spec constraints §5.3 / taste
 * principle 12 require emission at most once per generate call per option
 * key. Subprocess adapters whose transports do not honor a caller-supplied
 * option (max_steps, tool_error_policy, on_tool_approval) route the emit
 * through this dedup.
 */
export type OptionIgnoredDedup = {
  emit: (option: string, provider: string) => void
}

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
