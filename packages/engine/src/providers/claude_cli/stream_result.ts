/**
 * Build a GenerateResult from a parsed CLI stream (spec §5.4, §7.3, §10).
 *
 * Given a completed ParsedStream and the call's resolved alias, this module
 * synthesizes:
 *   - per-turn StepRecord entries with output-weighted cost
 *   - aggregate GenerateResult with CLI-reported total_cost_usd
 *   - provider_reported.claude_cli with session_id + duration_ms
 *
 * When no turns were collected (a `result` event arrived without any
 * assistant messages), the adapter synthesizes a single step whose text
 * equals the `result.result` field and whose usage equals the top-level
 * usage.
 */

import type { z } from 'zod'
import type {
  AliasTarget,
  CostBreakdown,
  FinishReason,
  GenerateResult,
  StepRecord,
  ToolCallRecord,
  UsageTotals,
} from '../../types.js'
import type { ClaudeCliProviderReported } from './types.js'
import type { ParsedStream, TurnCollected } from './stream_parse.js'
import { allocate_cost_across_turns, type TurnUsage } from './cost.js'

function sum_usage(totals: ReadonlyArray<UsageTotals>): UsageTotals {
  let input = 0
  let output = 0
  let cached: number | undefined
  let cache_write: number | undefined
  let reasoning: number | undefined
  for (const u of totals) {
    input += u.input_tokens
    output += u.output_tokens
    if (u.cached_input_tokens !== undefined) cached = (cached ?? 0) + u.cached_input_tokens
    if (u.cache_write_tokens !== undefined) cache_write = (cache_write ?? 0) + u.cache_write_tokens
    if (u.reasoning_tokens !== undefined) reasoning = (reasoning ?? 0) + u.reasoning_tokens
  }
  const out: UsageTotals = { input_tokens: input, output_tokens: output }
  if (cached !== undefined) out.cached_input_tokens = cached
  if (cache_write !== undefined) out.cache_write_tokens = cache_write
  if (reasoning !== undefined) out.reasoning_tokens = reasoning
  return out
}

function aggregate_cost_breakdowns(
  breakdowns: ReadonlyArray<CostBreakdown>,
): CostBreakdown | undefined {
  if (breakdowns.length === 0) return undefined
  let total = 0
  let input = 0
  let output = 0
  let cached_present = false
  let cached = 0
  let cache_write_present = false
  let cache_write = 0
  for (const b of breakdowns) {
    total += b.total_usd
    input += b.input_usd
    output += b.output_usd
    if (b.cached_input_usd !== undefined) {
      cached_present = true
      cached += b.cached_input_usd
    }
    if (b.cache_write_usd !== undefined) {
      cache_write_present = true
      cache_write += b.cache_write_usd
    }
  }
  const agg: CostBreakdown = {
    total_usd: total,
    input_usd: input,
    output_usd: output,
    currency: 'USD',
    is_estimate: true,
  }
  if (cached_present) agg.cached_input_usd = cached
  if (cache_write_present) agg.cache_write_usd = cache_write
  return agg
}

function normalize_turns(parsed: ParsedStream): ReadonlyArray<TurnCollected> {
  if (parsed.turns.length > 0) return parsed.turns
  const synth: TurnCollected = {
    step_index: 0,
    text: parsed.final_text,
    tool_calls: [],
    tool_results: [],
    usage: parsed.final_usage,
  }
  return [synth]
}

function tool_call_record(
  step_index: number,
  call: { id: string; name: string; input: unknown },
  results: ReadonlyArray<{
    id: string
    output?: unknown
    error?: { message: string }
  }>,
  now: number,
): ToolCallRecord {
  const rec: ToolCallRecord = {
    id: call.id,
    name: call.name,
    input: call.input,
    duration_ms: 0,
    started_at: now,
  }
  const matched = results.find((r) => r.id === call.id)
  if (matched !== undefined) {
    if (matched.output !== undefined) rec.output = matched.output
    if (matched.error !== undefined) rec.error = matched.error
  }
  return rec
}

export type BuildResultInput<T> = {
  readonly parsed: ParsedStream
  readonly resolved: AliasTarget
  readonly schema?: z.ZodType<T>
  readonly parsed_content?: T
}

export function build_generate_result<T>(input: BuildResultInput<T>): GenerateResult<T> {
  const { parsed, resolved } = input
  const turns = normalize_turns(parsed)
  const now = Date.now()

  const turn_usages: TurnUsage[] = turns.map((t) => ({
    output_tokens: t.usage.output_tokens,
    usage: t.usage,
  }))

  const total_cost_usd = parsed.total_cost_usd ?? 0
  const has_cost = parsed.total_cost_usd !== undefined
  const cost_per_turn: ReadonlyArray<CostBreakdown> = has_cost
    ? allocate_cost_across_turns(total_cost_usd, turn_usages)
    : []

  const finish_reason: FinishReason = 'stop'

  const steps: StepRecord[] = []
  const tool_calls_accum: ToolCallRecord[] = []
  turns.forEach((turn, i) => {
    const step_tool_calls: ToolCallRecord[] = turn.tool_calls.map((call) =>
      tool_call_record(turn.step_index, call, turn.tool_results, now),
    )
    for (const tc of step_tool_calls) tool_calls_accum.push(tc)
    const record: StepRecord = {
      index: turn.step_index,
      text: turn.text,
      tool_calls: step_tool_calls,
      usage: turn.usage,
      finish_reason: i === turns.length - 1 ? finish_reason : 'tool_calls',
    }
    if (has_cost) {
      const cost = cost_per_turn[i]
      if (cost !== undefined) record.cost = cost
    }
    steps.push(record)
  })

  const total_usage = sum_usage(steps.map((s) => s.usage))
  const total_cost = has_cost ? aggregate_cost_breakdowns(cost_per_turn) : undefined

  const provider_reported: Record<string, unknown> = {}
  if (parsed.session_id !== undefined || parsed.duration_ms !== undefined) {
    const reported: ClaudeCliProviderReported = {
      session_id: parsed.session_id ?? '',
      duration_ms: parsed.duration_ms ?? 0,
    }
    provider_reported['claude_cli'] = reported
  }

  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const content_raw = input.parsed_content ?? (parsed.final_text as T)

  const result: GenerateResult<T> = {
    content: content_raw,
    tool_calls: tool_calls_accum,
    steps,
    usage: total_usage,
    finish_reason,
    model_resolved: { provider: resolved.provider, model_id: resolved.model_id },
  }
  if (total_cost !== undefined) result.cost = total_cost
  if (Object.keys(provider_reported).length > 0) {
    result.provider_reported = provider_reported
  }
  return result
}
